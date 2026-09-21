// Packages SPECTRA for Vercel using the Build Output API:
//   .vercel/output/static            the Vite frontend
//   .vercel/output/functions/api.func the Hono API, bundled into one file
// Bundling the function removes every runtime resolution problem: workspace
// packages that ship TypeScript source, extensionless ESM imports, and deps
// hoisted to the monorepo root.
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
// Hobby allows 300s; Pro can raise this without a code change.
const maxDuration = Number(process.env.SPECTRA_FUNCTION_MAX_DURATION || 300);

rmSync(out, { recursive: true, force: true });

console.log("> building frontend");
// Same-origin API on Vercel: an empty VITE_API_URL means requests go to /api.
execSync("npm run build -w @spectra/web", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_API_URL: process.env.VITE_API_URL ?? "" },
});
cpSync(join(root, "apps/web/dist"), join(out, "static"), { recursive: true });

console.log("> bundling api function");
const fn = join(out, "functions", "api.func");
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [join(root, "apps/api/src/vercel.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  define: {
    "process.env.SPECTRA_FUNCTION_MAX_DURATION": JSON.stringify(
      String(maxDuration),
    ),
  },
  // CommonJS dependencies call require() for Node builtins; an ESM bundle
  // needs a real require for that to work.
  banner: {
    js: [
      "import { createRequire as __spectraRequire } from 'node:module';",
      "const require = __spectraRequire(import.meta.url);",
    ].join("\n"),
  },
});

writeFileSync(
  join(fn, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration,
    },
    null,
    2,
  ),
);
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module" }));

writeFileSync(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // The API: /api/<anything> is forwarded to the single function.
        { src: "^/api/(.*)$", dest: "/api?__path=$1" },
        // Hashed assets never change, so cache them hard.
        {
          src: "^/assets/(.*)$",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
          continue: true,
        },
        { handle: "filesystem" },
        // Client-side routes such as /audits/<id> fall back to the app shell.
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

console.log(
  `> .vercel/output ready (function maxDuration ${maxDuration}s, streaming on)`,
);
