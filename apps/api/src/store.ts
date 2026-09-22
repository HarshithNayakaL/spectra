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

export async function saveAudit(a: Audit) {
  return save("audits", a.id, a.status, a);
}

/** Journeys share the audit store; the key prefix keeps the two apart. */
export async function saveJourney(j: Journey) {
  return save("journeys", j.id, j.status, j);
}

async function save(
  kind: "audits" | "journeys",
  id: string,
  status: string,
  record: unknown,
) {
  if (storeKind === "blob") return saveBlob(kind, id, status, record);
  await mkdir(dir, { recursive: true });
  const name = kind === "audits" ? id : `journey-${id}`;
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
  kind: "audits" | "journeys",
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

async function read(kind: "audits" | "journeys", id: string) {
  if (!ID.test(id)) return null;
  try {
    return storeKind === "blob"
      ? await readBlob(kind, id)
      : await readFile(
          join(dir, `${kind === "audits" ? id : `journey-${id}`}.json`),
          "utf8",
        );
  } catch {
    return null;
  }
}

async function readBlob(
  kind: "audits" | "journeys",
  id: string,
): Promise<string | null> {
  // useCache: false reads from origin, so a report opened straight after an
  // audit finishes never sees an earlier checkpoint.
  const result = await get(`${kind}/${id}.json`, {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode !== 200) return null;
  return new Response(result.stream).text();
}
