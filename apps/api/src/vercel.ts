import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { app } from "./app";

const listener = getRequestListener(app.fetch);

/**
 * Vercel entry. Routing sends /api/* here as /api?__path=<rest>; some Vercel
 * paths pass the original URL through instead. Either way the Hono app sees
 * the real /api/... path it was written for.
 */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://spectra.local");
  const forwarded = url.searchParams.get("__path");
  if (!url.pathname.startsWith("/api/") && forwarded !== null) {
    url.searchParams.delete("__path");
    const query = url.searchParams.toString();
    req.url = `/api/${forwarded.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;
  }
  return listener(req, res);
}
