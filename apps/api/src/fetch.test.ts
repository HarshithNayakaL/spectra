import { createServer, type Server } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  codingsOf,
  EncodingRefusedError,
  fetchValidated,
  validatePublicUrl,
} from "./net";

/**
 * A hostile server. It answers in whatever coding the path names, whether or
 * not the request asked for it, which is exactly what a site chosen by a user
 * can do.
 */
let server: Server;
let base = "";
let lastAcceptEncoding = "";
const PAGE = "<html><body>Acme pricing starts at $10.</body></html>";

beforeAll(async () => {
  server = createServer((request, response) => {
    lastAcceptEncoding = String(request.headers["accept-encoding"] ?? "");
    const path = request.url ?? "/";
    const send = (encoding: string, body: Buffer | string) => {
      response.writeHead(200, {
        "content-type": "text/html",
        ...(encoding ? { "content-encoding": encoding } : {}),
      });
      response.end(body);
    };
    if (path === "/br") return send("br", brotliCompressSync(PAGE));
    if (path === "/gzip-then-br")
      return send("gzip, br", brotliCompressSync(gzipSync(PAGE)));
    if (path === "/zstd") return send("zstd", Buffer.from("not decoded"));
    if (path === "/gzip") return send("gzip", gzipSync(PAGE));
    if (path === "/deflate") return send("deflate", deflateSync(PAGE));
    if (path === "/bomb")
      return send("gzip", gzipSync(Buffer.alloc(50_000_000, 97)));
    if (path === "/corrupt")
      return send("gzip", Buffer.from("not gzip at all"));
    if (path === "/redirect") {
      response.writeHead(302, { location: "/gzip" });
      return response.end();
    }
    send("", PAGE);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// The local server is private, which the real check rightly refuses.
const local = async (value: string) => ({
  url: new URL(value),
  addresses: ["127.0.0.1"],
});
const get = (path: string, maxBytes?: number) =>
  fetchValidated(`${base}${path}`, { maxBytes }, local);

describe("fetching hostile responses (CVE-2026-111497)", () => {
  it("asks only for gzip and deflate", async () => {
    await get("/");
    expect(lastAcceptEncoding).toBe("gzip, deflate");
  });

  it.each(["/br", "/gzip-then-br", "/zstd"])(
    "refuses %s without decoding it",
    async (path) => {
      const failure = await get(path).catch((error) => error);
      expect(failure).toBeInstanceOf(EncodingRefusedError);
      expect(failure.status).toBe(200);
      expect(failure.message).toMatch(/was not decoded/);
    },
  );

  it.each(["/gzip", "/deflate", "/"])("still reads %s", async (path) => {
    const page = await get(path);
    expect(page.status).toBe(200);
    expect(page.body).toBe(PAGE);
  });

  it("follows a redirect and decodes the target", async () => {
    const page = await get("/redirect");
    expect(page.url).toBe(`${base}/gzip`);
    expect(page.body).toBe(PAGE);
  });

  it("stops a gzip bomb at the byte limit", async () => {
    const page = await get("/bomb", 100_000);
    expect(page.bytes).toBe(100_000);
  });

  it("reports a body that will not decode instead of guessing", async () => {
    await expect(get("/corrupt")).rejects.toThrow(/could not be decoded/);
  });

  it("parses content-encoding lists", () => {
    expect(codingsOf("gzip, BR")).toEqual(["gzip", "br"]);
    expect(codingsOf("identity")).toEqual([]);
    expect(codingsOf(null)).toEqual([]);
  });
});

describe("the public check itself", () => {
  it("still refuses the local server", async () => {
    await expect(validatePublicUrl(`${base}/`)).rejects.toThrow(/non-public/);
  });

  // CVE-2026-105483 and -106069/-106072: TLS hostname checks were bypassed by
  // fullwidth digits and loose IPv4 forms. The URL parser canonicalises every
  // such host before it reaches TLS, and each of these is private anyway.
  it.each([
    "https://１２７.０.０.１/",
    "https://0x7f.1/",
    "https://2130706433/",
    "https://127.1/",
  ])("canonicalises and refuses %s", async (value) => {
    expect(new URL(value).hostname).toBe("127.0.0.1");
    await expect(validatePublicUrl(value)).rejects.toThrow(/non-public/);
  });

  // CVE-2026-105482: dns.resolve truncates names at a NUL. The URL parser
  // refuses such a host before any lookup, and the lookup used is getaddrinfo.
  it("refuses a hostname with a NUL in it", async () => {
    await expect(
      validatePublicUrl("https://example.com%00.internal/"),
    ).rejects.toThrow();
  });
});
