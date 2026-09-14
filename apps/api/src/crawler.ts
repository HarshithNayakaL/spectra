import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crawlOutputSchema, type CrawlOutput } from "@spectra/schemas";
import { crawlWithNode } from "./node-crawler";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export async function crawl(url: string): Promise<{ output: CrawlOutput; fallback: boolean }> {
  const executable = process.platform === "win32" ? "spectra-crawler.exe" : "spectra-crawler";
  const binary = process.env.SPECTRA_CRAWLER_BIN || resolve(root, "services", "crawler", "target", "release", executable);
  try {
    return { output: await run(binary, url), fallback: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { output: await crawlWithNode(url), fallback: false };
  }
}

function run(binary: string, url: string): Promise<CrawlOutput> {
  return new Promise((resolveResult, reject) => {
    const process = spawn(binary, [url], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    const timer = setTimeout(() => process.kill(), 120_000);
    process.stdout.on("data", (chunk) => output.push(chunk));
    process.stderr.on("data", (chunk) => errors.push(chunk));
    process.once("error", reject);
    process.once("close", (code) => {
      clearTimeout(timer);
      if (code) return reject(new Error(Buffer.concat(errors).toString() || `Crawler exited with code ${code}.`));
      try { resolveResult(crawlOutputSchema.parse(JSON.parse(Buffer.concat(output).toString()))); }
      catch (error) { reject(error); }
    });
  });
}
