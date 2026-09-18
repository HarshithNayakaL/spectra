import "./config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { runAudit } from "./pipeline";
import { getAudit } from "./store";

const app = new Hono();
const allowedOrigins = new Set(
  (
    process.env.SPECTRA_WEB_ORIGINS ||
    "http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const MAX_CONCURRENT_AUDITS = Number(
  process.env.SPECTRA_MAX_CONCURRENT_AUDITS || 3,
);
let running = 0;

app.use(
  "/api/*",
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
  }),
);
app.get("/api/health", (c) =>
  c.json({
    status: "ok",
    scoringVersion: "spectra-v0.1",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    runningAudits: running,
  }),
);
app.get("/api/audits/:id", async (c) => {
  const audit = await getAudit(c.req.param("id"));
  return audit ? c.json(audit) : c.json({ error: "Audit not found" }, 404);
});
app.post("/api/audits", async (c) => {
  const parsed = z
    .object({ url: z.string().min(1).max(2048) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "A URL is required" }, 400);
  const target = readableTarget(parsed.data.url);
  // Reject an unusable URL with a status code instead of opening a stream
  // whose only content is an error frame.
  if (!target.ok) return c.json({ error: target.error }, 400);
  if (running >= MAX_CONCURRENT_AUDITS)
    return c.json(
      { error: "Too many audits are already running. Try again shortly." },
      503,
    );

  running += 1;
  const stream = new ReadableStream({
    async start(controller) {
      // A disconnected client must not take the audit down with it: the record
      // is persisted progressively and stays reachable at /api/audits/:id.
      let open = true;
      const write = (payload: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(payload) + "\n"),
          );
        } catch {
          open = false;
        }
      };
      const send = (stage: string, message: string, auditId: string) =>
        write({ type: "progress", stage, message, auditId });
      try {
        write({ type: "result", audit: await runAudit(target.value, send) });
      } catch (error) {
        write({
          type: "error",
          message: error instanceof Error ? error.message : "The audit failed.",
          auditId: (error as { auditId?: string })?.auditId,
        });
      } finally {
        running -= 1;
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      }
    },
    cancel() {
      // The consumer walked away; the audit keeps running to completion.
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

function readableTarget(
  value: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = value.trim();
  if (!raw) return { ok: false, error: "A URL is required" };
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: "Enter a valid public HTTP or HTTPS URL." };
  }
  if (!["http:", "https:"].includes(url.protocol))
    return { ok: false, error: "Only HTTP and HTTPS URLs can be audited." };
  if (url.username || url.password)
    return {
      ok: false,
      error: "Remove the embedded credentials from the URL.",
    };
  if (!url.hostname)
    return { ok: false, error: "Enter a valid public HTTP or HTTPS URL." };
  return { ok: true, value: raw };
}

serve(
  { fetch: app.fetch, port: Number(process.env.SPECTRA_API_PORT || 8787) },
  (info) => console.log(`SPECTRA API listening on ${info.port}`),
);
