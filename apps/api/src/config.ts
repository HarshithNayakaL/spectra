import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

for (const name of [".env", "env"]) {
  const path = resolve(root, name);
  if (existsSync(path)) loadEnvFile(path);
}

// Throwing here would take /api/health and /api/models down with it. The
// pipeline already records an unconfigured model as a warning on the audit.
if (process.env.NODE_ENV === "production" && !process.env.GEMINI_API_KEY)
  console.warn(
    "GEMINI_API_KEY is not set: audits will run crawl-only measurements.",
  );
