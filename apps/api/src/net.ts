import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

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
 * Fetches a public URL and reports whatever status came back; only network
 * and safety failures throw. The redirect chain is re-validated at every hop
 * and the connection is pinned to addresses that were checked as public, so a
 * second DNS answer cannot rebind the request to a private address.
 */
export async function fetchPublic(
  target: string | URL,
  options: {
    userAgent?: string;
    accept?: string;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<Fetched> {
  const started = Date.now();
  let current = new URL(String(target));
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const { url, addresses } = await validatePublicUrl(current.href);
    current = url;
    const dispatcher = pinnedDispatcher(addresses);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        headers: {
          "user-agent": options.userAgent ?? SPECTRA_AGENT,
          accept:
            options.accept ??
            "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "accept-language": "en",
        },
        // @ts-expect-error -- undici extension, honoured by Node's global fetch
        dispatcher,
      });
    } catch (error) {
      await dispatcher.close().catch(() => {});
      throw error instanceof Error && error.name === "TimeoutError"
        ? new Error("Timed out after 10s")
        : error;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect without a location header.");
      try {
        current = new URL(location, current);
      } catch {
        throw new Error("Redirect to an unusable location.");
      }
      continue;
    }
    pending.set(response, dispatcher);
    const { text, bytes } = await readBounded(
      response,
      options.maxBytes ?? MAX_BYTES,
    );
    return {
      status: response.status,
      url: current.href,
      headers: response.headers,
      body: text,
      bytes,
      ms: Date.now() - started,
    };
  }
  throw new Error("Too many redirects.");
}

const pending = new WeakMap<Response, Agent>();

function pinnedDispatcher(addresses: string[]) {
  return new Agent({
    connect: {
      // Ignore the hostname entirely: only the addresses validated moments ago
      // are reachable, so a second DNS answer cannot redirect the connection.
      lookup(_hostname, options, callback) {
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
            // @ts-expect-error -- error path, no address to supply
            undefined,
            undefined,
          );
        return options.all
          ? callback(null, wanted as never)
          : callback(null, wanted[0].address as never, wanted[0].family);
      },
    },
  });
}

/** Reads at most `limit` bytes; a larger body is truncated, not rejected. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<{ text: string; bytes: number }> {
  const dispatcher = pending.get(response);
  pending.delete(response);
  try {
    if (!response.body) return { text: "", bytes: 0 };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - length;
      chunks.push(value.byteLength > room ? value.slice(0, room) : value);
      length += Math.min(value.byteLength, room);
      if (length >= limit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes), bytes: length };
  } finally {
    await dispatcher?.close().catch(() => {});
  }
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
