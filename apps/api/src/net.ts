import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createGunzip, createInflate } from "node:zlib";

const MAX_BYTES = 2_097_152;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

export const SPECTRA_AGENT =
  "Mozilla/5.0 (compatible; SPECTRA/2.0; +https://spectra-ai-aeo.vercel.app)";

export type Fetched = {
  status: number;
  url: string;
  headers: Headers;
  body: string;
  bytes: number;
  ms: number;
};

/**
 * The only content codings SPECTRA will decode. Brotli is deliberately absent:
 * CVE-2026-111497 (Node.js security release, 21 October 2026) is an
 * out-of-bounds write in the bundled Brotli decoder that permits remote code
 * execution, and every page this service fetches is chosen by whoever typed
 * the URL. Node's fetch() decodes Brotli whenever a server sends it, asked or
 * not, so this module does not use fetch() at all: it reads the raw bytes with
 * node:http and node:https, which never decompress anything, decodes gzip and
 * deflate itself under a size cap, and
 * refuses any other coding without handing a single byte to a decoder. That
 * holds whatever runtime version the host happens to be running.
 */
const ACCEPT_ENCODING = "gzip, deflate";
const DECODABLE = new Set(["gzip", "x-gzip", "deflate"]);

/** A server answered in a coding SPECTRA refuses to decode. */
export class EncodingRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly encoding: string,
  ) {
    super(
      `The server sent its response ${encoding}-encoded although only ${ACCEPT_ENCODING} was accepted, so it was not decoded.`,
    );
    this.name = "EncodingRefusedError";
  }
}

/**
 * Fetches a public URL and reports whatever status came back; only network
 * and safety failures throw. The redirect chain is re-validated at every hop
 * and the connection is pinned to addresses that were checked as public, so a
 * second DNS answer cannot rebind the request to a private address.
 */
export async function fetchPublic(
  target: string | URL,
  options: FetchOptions = {},
): Promise<Fetched> {
  return fetchValidated(target, options, validatePublicUrl);
}

type FetchOptions = {
  userAgent?: string;
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

/**
 * fetchPublic with the address check passed in. Exported for tests alone,
 * which need a local server the public check rightly refuses; production code
 * calls fetchPublic and never chooses its own validator.
 */
export async function fetchValidated(
  target: string | URL,
  options: FetchOptions,
  validate: typeof validatePublicUrl,
): Promise<Fetched> {
  const started = Date.now();
  const limit = options.maxBytes ?? MAX_BYTES;
  let current = new URL(String(target));
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const { url, addresses } = await validate(current.href);
    current = url;
    let response: IncomingMessage | null = null;
    try {
      response = await get(current, addresses, {
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        headers: {
          "user-agent": options.userAgent ?? SPECTRA_AGENT,
          accept:
            options.accept ??
            "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "accept-language": "en",
          "accept-encoding": ACCEPT_ENCODING,
        },
      });
      const headers = toHeaders(response.headers);
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        discard(response);
        const location = headers.get("location");
        if (!location) throw new Error("Redirect without a location header.");
        try {
          current = new URL(location, current);
        } catch {
          throw new Error("Redirect to an unusable location.");
        }
        continue;
      }
      const codings = codingsOf(headers.get("content-encoding"));
      const refused = codings.find((coding) => !DECODABLE.has(coding));
      if (refused) {
        // Discarded unread: these bytes never reach a decoder.
        discard(response);
        throw new EncodingRefusedError(status, refused);
      }
      const { text, bytes } = await readDecoded(response, codings, limit);
      return {
        status,
        url: current.href,
        headers,
        body: text,
        bytes,
        ms: Date.now() - started,
      };
    } catch (error) {
      throw isTimeout(error) ? new Error("Timed out after 10s") : error;
    } finally {
      // No keep-alive: every request is its own pinned connection, which also
      // keeps this clear of the keep-alive desync fixed in the same release.
      if (response && !response.destroyed) discard(response);
    }
  }
  throw new Error("Too many redirects.");
}

/**
 * Ignores the hostname entirely: only the addresses validated moments ago are
 * reachable, so a second DNS answer cannot redirect the connection. TLS still
 * verifies the certificate against the hostname in the URL.
 */
function pinnedLookup(addresses: string[]): LookupFunction {
  return (_hostname, options, callback) => {
    const resolved = addresses.map((address) => ({
      address,
      family: isIP(address),
    }));
    const wanted =
      options.family === 4 || options.family === 6
        ? resolved.filter((entry) => entry.family === options.family)
        : resolved;
    if (!wanted.length)
      return callback(
        new Error("No validated public address for this host."),
        "",
        0,
      );
    if (options.all) return (callback as never as AllCallback)(null, wanted);
    callback(null, wanted[0].address, wanted[0].family);
  };
}
type AllCallback = (
  error: Error | null,
  addresses: Array<{ address: string; family: number }>,
) => void;

/** One GET on a fresh, pinned connection; resolves once headers arrive. */
function get(
  url: URL,
  addresses: string[],
  options: { signal: AbortSignal; headers: Record<string, string> },
): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "GET",
      headers: options.headers,
      signal: options.signal,
      lookup: pinnedLookup(addresses),
      agent: false,
    });
    outgoing.on("response", resolve);
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/**
 * Destroys a body without reading it. Node reports the abort as an error
 * event, and an unhandled error event on a stream takes the process down, so
 * a listener goes on first: a hostile server must never be able to crash the
 * worker by sending something we decline to read.
 */
function discard(stream: Readable) {
  stream.on("error", () => {});
  stream.destroy();
}

/** "gzip, br" → ["gzip", "br"]: identity removed, in the order applied. */
export function codingsOf(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity");
}

function toHeaders(raw: IncomingMessage["headers"]) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      try {
        headers.append(name, item);
      } catch {
        // A value Headers will not hold is not one this crawler reads.
      }
  }
  return headers;
}

function isTimeout(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      (error as { code?: string }).code === "UND_ERR_ABORTED")
  );
}

/**
 * Decodes the codings in reverse order of application and keeps at most
 * `limit` decoded bytes; a larger body is truncated, not rejected. The cap is
 * on the output, so a small gzip bomb stops at the limit as well.
 */
async function readDecoded(
  body: Readable,
  codings: string[],
  limit: number,
): Promise<{ text: string; bytes: number }> {
  let stream: Readable = body;
  const stages: Readable[] = [body];
  for (const coding of [...codings].reverse()) {
    const decoder = coding === "deflate" ? createInflate() : createGunzip();
    const source = stream;
    source.on("error", (error) => decoder.destroy(error));
    stream = source.pipe(decoder);
    stages.push(decoder);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      const room = limit - length;
      chunks.push(buffer.byteLength > room ? buffer.subarray(0, room) : buffer);
      length += Math.min(buffer.byteLength, room);
      if (length >= limit) break;
    }
  } catch (error) {
    if (isTimeout(error)) throw error;
    // A body cut short mid-stream keeps the part that did arrive; a body that
    // never decoded at all is reported, not guessed at.
    if (!length)
      throw new Error(
        `The response could not be decoded (${error instanceof Error ? error.message : String(error)}).`,
      );
  } finally {
    for (const stage of stages) discard(stage);
  }
  const bytes = Buffer.concat(chunks, length);
  return { text: new TextDecoder().decode(bytes), bytes: length };
}

export async function validatePublicUrl(
  value: string,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The target is not a usable absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password)
    throw new Error("Embedded URL credentials are not allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname.toLowerCase() === "localhost" ||
    hostname.toLowerCase().endsWith(".localhost")
  )
    throw new Error("Local targets are blocked.");
  const resolved = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  const addresses = resolved.map(({ address }) => address);
  if (!addresses.length) throw new Error("Target hostname did not resolve.");
  if (!addresses.every(isPublicAddress))
    throw new Error("Target resolves to a non-public address.");
  return { url, addresses };
}

export function isPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  if (!value) return false;
  if (value.includes(":")) {
    const mapped = value.match(
      /^(?:::ffff:|0{1,4}(?::0{1,4}){0,4}:ffff:)(.+)$/,
    );
    // IPv4-mapped and IPv4-compatible forms must face the IPv4 rules, or
    // ::ffff:169.254.169.254 walks straight past an IPv6-only check.
    if (mapped) {
      const inner = mapped[1];
      if (isIP(inner) === 4) return isPublicAddress(inner);
      const packed = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (packed) {
        const high = Number.parseInt(packed[1], 16);
        const low = Number.parseInt(packed[2], 16);
        return isPublicAddress(
          `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
        );
      }
      return false;
    }
    const groups = expandIpv6(value);
    if (!groups) return false;
    const [first] = groups;
    if (groups.every((group) => group === 0)) return false; // ::
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1)
      return false; // ::1
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (first === 0x2002) return false; // 6to4, can encapsulate private v4
    if (first === 0x0064 && groups[1] === 0xff9b) return false; // NAT64
    return true;
  }
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function expandIpv6(value: string): number[] | null {
  if (isIP(value) !== 6) return null;
  const [head, tail] = value.split("::") as [string, string | undefined];
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return groups.map((group) => Number.parseInt(group, 16) || 0);
}
