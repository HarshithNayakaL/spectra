import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get, put } from "@vercel/blob";
import { auditSchema, type Audit } from "@spectra/schemas";

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
  if (storeKind === "blob") return saveBlob(a);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${a.id}.json`);
  const temporary = join(dir, `${a.id}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(a), "utf8");
  await rename(temporary, target);
}

/**
 * The pipeline checkpoints after every stage and every retrieval variant.
 * Each Blob write is a billed operation, so intermediate checkpoints are
 * throttled; terminal states are always written.
 */
async function saveBlob(a: Audit) {
  const now = Date.now();
  const previous = lastBlobWrite.get(a.id) ?? 0;
  if (!TERMINAL.has(a.status) && now - previous < 15_000) return;
  lastBlobWrite.set(a.id, now);
  await put(`audits/${a.id}.json`, JSON.stringify(a), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  if (TERMINAL.has(a.status)) lastBlobWrite.delete(a.id);
}

export async function getAudit(id: string) {
  if (!ID.test(id)) return null;
  try {
    const raw =
      storeKind === "blob"
        ? await readBlob(id)
        : await readFile(join(dir, `${id}.json`), "utf8");
    return raw ? auditSchema.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

async function readBlob(id: string): Promise<string | null> {
  // useCache: false reads from origin, so a report opened straight after an
  // audit finishes never sees an earlier checkpoint.
  const result = await get(`audits/${id}.json`, {
    access: "private",
    useCache: false,
  });
  if (!result || result.statusCode !== 200) return null;
  return new Response(result.stream).text();
}
