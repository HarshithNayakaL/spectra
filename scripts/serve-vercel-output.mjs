// Serves .vercel/output locally the way Vercel routes it, so the bundled
// function is exercised exactly as deployed: /api/* is rewritten to
// /api?__path=..., static files are served from disk, and everything else
// falls back to index.html.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.env.VERCEL ??= "1";
const root = resolve(".vercel/output");
const port = Number(process.env.PORT || 3900);
const { default: handler } = await import(
  pathToFileURL(join(root, "functions/api.func/index.mjs")).href
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const api = url.pathname.match(/^\/api\/(.*)$/);
  if (api) {
    url.searchParams.set("__path", api[1]);
    req.url = `/api?${url.searchParams.toString()}`;
    return handler(req, res);
  }
  let file = join(root, "static", decodeURIComponent(url.pathname));
  if (!existsSync(file) || statSync(file).isDirectory())
    file = join(root, "static", "index.html");
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
  });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`vercel output on http://localhost:${port}`));
