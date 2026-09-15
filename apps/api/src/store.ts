import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSchema, type Audit } from "@spectra/schemas";
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const configured = process.env.SPECTRA_DATA_DIR;
const dir = configured
  ? isAbsolute(configured)
    ? configured
    : resolve(root, configured)
  : join(root, ".spectra", "audits");
export async function saveAudit(a: Audit) {
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${a.id}.json`);
  const temporary = join(dir, `${a.id}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(a, null, 2), "utf8");
  await rename(temporary, target);
}
export async function getAudit(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  try {
    return auditSchema.parse(
      JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")),
    );
  } catch {
    return null;
  }
}
