import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlOutputSchema, type CrawlOutput } from "@spectra/schemas";
import { crawlWithNode } from "./node-crawler";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const CRAWLER_TIMEOUT_MS = 120_000;

export async function crawl(
  url: string,
): Promise<{ output: CrawlOutput; fallback: boolean }> {
  // Serverless functions cannot ship or spawn the Rust binary. The Node
  // crawler carries the same SSRF rules and pins DNS, so it runs directly.
  if (process.env.VERCEL && !process.env.SPECTRA_CRAWLER_BIN)
    return { output: await crawlWithNode(url), fallback: true };
  const executable =
    process.platform === "win32" ? "spectra-crawler.exe" : "spectra-crawler";
  const configured = process.env.SPECTRA_CRAWLER_BIN;
  let binary = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(root, configured)
    : resolve(root, "services", "crawler", "target", "release", executable);
  if (
    process.platform === "win32" &&
    !binary.endsWith(".exe") &&
    existsSync(`${binary}.exe`)
  )
    binary = `${binary}.exe`;
  try {
    return { output: await run(binary, url), fallback: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The Rust binary is missing, not broken. The caller needs to know the
    // audit ran on the compatibility crawler — reporting fallback: false here
    // hid that substitution from every audit record.
    return { output: await crawlWithNode(url), fallback: true };
  }
}

function run(binary: string, url: string): Promise<CrawlOutput> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, [url], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CRAWLER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      finish(() => {
        if (timedOut)
          return reject(
            new Error(
              `Crawler exceeded the ${CRAWLER_TIMEOUT_MS / 1000}s time limit.`,
            ),
          );
        // A signal kill reports code null, which the previous `if (code)` guard
        // treated as success and then failed with a confusing JSON parse error.
        if (signal)
          return reject(new Error(`Crawler terminated on signal ${signal}.`));
        if (code !== 0)
          return reject(
            new Error(
              Buffer.concat(errors).toString().trim() ||
                `Crawler exited with code ${code}.`,
            ),
          );
        try {
          resolveResult(
            crawlOutputSchema.parse(
              JSON.parse(Buffer.concat(output).toString()),
            ),
          );
        } catch (error) {
          reject(
            new Error(
              `Crawler produced unreadable output: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      });
    });
  });
}
