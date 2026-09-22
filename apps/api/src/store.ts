import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get, put } from "@vercel/blob";
import {
  auditSchema,
  journeySchema,
  type Audit,
  type Journey,
} from "@spectra/schemas";
import { historyEntryOf, type HistoryEntry } from "@spectra/evaluation";

const TERMINAL = new Set(["complete", "partial", "failed"]);
const ID = /^[a-f0-9-]{36}$/;

/**
 * Where audits live.
 *
 * - Vercel Blob when a store is connected (BLOB_READ_WRITE_TOKEN is injected by
 *   Vercel). Private, so an audit is only reachable through this API.
 * - The filesystem otherwise. Locally that is .spectra/audits; on a serverless
 *   host without Blob it is /tmp, which survives only as long as one instance.
 */
export const storeKind: "blob" | "filesystem" = process.env
  .BLOB_READ_WRITE_TOKEN
  ? "blob"
  : "filesystem";

const dir = (() => {
  const configured = process.env.SPECTRA_DATA_DIR;
  if (process.env.VERCEL) return "/tmp/spectra-audits";
  const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  if (!configured) return join(root, ".spectra", "audits");
  return isAbsolute(configured) ? configured : resolve(root, configured);
})();

const lastBlobWrite = new Map<string, number>();

type Kind = "audits" | "journeys" | "compares";
/** On disk everything shares one folder; the prefix keeps the kinds apart. */
const PREFIX: Record<Kind, string> = {
  audits: "",
  journeys: "journey-",
  compares: "compare-",
};

export async function saveAudit(a: Audit) {
  return save("audits", a.id, a.status, a);
}

/** Journeys share the audit store; the key prefix keeps the two apart. */
export async function saveJourney(j: Journey) {
  return save("journeys", j.id, j.status, j);
}

async function save(kind: Kind, id: string, status: string, record: unknown) {
  if (storeKind === "blob") return saveBlob(kind, id, status, record);
  await mkdir(dir, { recursive: true });
  const name = `${PREFIX[kind]}${id}`;
  const target = join(dir, `${name}.json`);
  const temporary = join(dir, `${name}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(record), "utf8");
  await rename(temporary, target);
}

/**
 * The pipeline checkpoints after every stage and every retrieval variant.
 * Each Blob write is a billed operation, so intermediate checkpoints are
 * throttled; terminal states are always written.
 */
async function saveBlob(
  kind: Kind,
  id: string,
  status: string,
  record: unknown,
) {
  const now = Date.now();
  const terminal = TERMINAL.has(status);
  const previous = lastBlobWrite.get(`${kind}/${id}`) ?? 0;
  if (!terminal && now - previous < 15_000) return;
  lastBlobWrite.set(`${kind}/${id}`, now);
  await put(`${kind}/${id}.json`, JSON.stringify(record), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  if (terminal) lastBlobWrite.delete(`${kind}/${id}`);
}

export async function getAudit(id: string) {
  const raw = await read("audits", id);
  return raw ? auditSchema.parse(JSON.parse(raw)) : null;
}

export async function getJourney(id: string) {
  const raw = await read("journeys", id);
  return raw ? journeySchema.parse(JSON.parse(raw)) : null;
}

async function read(kind: Kind, id: string) {
  if (!ID.test(id)) return null;
  try {
    return storeKind === "blob"
      ? await readBlob(kind, id)
      : await readFile(join(dir, `${PREFIX[kind]}${id}.json`), "utf8");
  } catch {
    return null;
  }
}

async function readBlob(kind: Kind, id: string): Promise<string | null> {
  // useCache: false reads from origin, so a report opened straight after an
  // audit finishes never sees an earlier checkpoint.
  const result = await get(`${kind}/${id}.json`, {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode !== 200) return null;
  return new Response(result.stream).text();
}

/** A comparison is stored once, when it is finished, and read back by id. */
export async function saveCompare(record: { id: string; status: string }) {
  return save("compares", record.id, record.status, record);
}

export async function getCompare(id: string): Promise<unknown | null> {
  const raw = await read("compares", id);
  return raw ? JSON.parse(raw) : null;
}

/* ============================================================ history */

const HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HISTORY_LIMIT = 60;

export function historyKey(host: string) {
  const clean = host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  return clean.length <= 253 && HOST.test(clean) ? clean : null;
}

/**
 * Appends a finished audit to its site's history, newest first. A read, an
 * insert and a write: two audits of one site finishing in the same instant can
 * lose one row, which costs a data point, never an audit — the audit itself is
 * stored separately and stays reachable by id.
 */
export async function recordHistory(audit: Audit) {
  const host = historyKey(audit.host);
  if (!host || !TERMINAL.has(audit.status) || audit.status === "failed") return;
  const entries = (await getHistory(host)).filter(
    (entry) => entry.id !== audit.id,
  );
  entries.unshift(historyEntryOf(audit));
  const body = JSON.stringify(entries.slice(0, HISTORY_LIMIT));
  if (storeKind === "blob") {
    await put(`history/${host}.json`, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    return;
  }
  await mkdir(dir, { recursive: true });
  const target = join(dir, `history-${host}.json`);
  const temporary = join(dir, `history-${host}.${process.pid}.tmp`);
  await writeFile(temporary, body, "utf8");
  await rename(temporary, target);
}

export async function getHistory(rawHost: string): Promise<HistoryEntry[]> {
  const host = historyKey(rawHost);
  if (!host) return [];
  try {
    let raw: string | null;
    if (storeKind === "blob") {
      const result = await get(`history/${host}.json`, {
        access: "private",
        useCache: false,
      });
      raw =
        result && result.statusCode === 200
          ? await new Response(result.stream).text()
          : null;
    } else raw = await readFile(join(dir, `history-${host}.json`), "utf8");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}
