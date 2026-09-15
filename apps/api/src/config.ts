import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

for (const name of [".env", "env"]) {
  const path = resolve(root, name);
  if (existsSync(path)) loadEnvFile(path);
}

if (process.env.NODE_ENV === "production" && !process.env.GEMINI_API_KEY)
  throw new Error("GEMINI_API_KEY is required in production.");
