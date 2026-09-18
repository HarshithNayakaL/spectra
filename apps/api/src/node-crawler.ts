import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import { Agent } from "undici";
import { crawlOutputSchema, type CrawlOutput } from "@spectra/schemas";

const limits = {
  maxPages: 20,
  maxDepth: 2,
  maxBytes: 2_097_152,
  timeoutMs: 10_000,
  maxRedirects: 5,
};

const USER_AGENT = "SPECTRA/0.1 (+https://github.com/HarshithNayakaL/spectra)";
const ROBOTS_TOKEN = "spectra";

export async function crawlWithNode(target: string): Promise<CrawlOutput> {
  const root = (await validatePublicUrl(target)).url;
  const startedAt = new Date().toISOString();
  const robotsUrl = new URL("/robots.txt", root);
  const robotsResponse = await safeFetch(robotsUrl, false).catch(() => null);
  const robotsText = robotsResponse ? await readBounded(robotsResponse) : "";
  const robots = parseRobots(robotsText);
  if (!isAllowed(robots, root))
    throw new Error("robots.txt disallows crawling this target");
  const sitemaps = robots.sitemaps.flatMap((value) => {
    try {
      return [new URL(value, root)];
    } catch {
      return [];
    }
  });

  const queue: Array<{ url: URL; depth: number }> = [{ url: root, depth: 0 }];
  const seen = new Set<string>([root.href]);
  const fingerprints = new Map<string, string>();
  const pages: CrawlOutput["pages"] = [];
  const crawlEdges: CrawlOutput["crawlEdges"] = [];
  const warnings: string[] = [
    "Rust crawler binary was unavailable; the secure Node compatibility crawler handled this audit.",
  ];

  while (queue.length && pages.length < limits.maxPages) {
    const item = queue.shift()!;
    try {
      const response = await safeFetch(item.url, true);
      const contentType = response.headers.get("content-type") ?? "";
      const normalizedContentType = contentType.toLowerCase();
      const isMarkdown = normalizedContentType.includes("text/markdown");
      if (
        !normalizedContentType.includes("text/html") &&
        !normalizedContentType.includes("application/xhtml+xml") &&
        !isMarkdown
      ) {
        warnings.push(
          `${item.url.href}: skipped non-HTML content (${contentType || "unknown"})`,
        );
        continue;
      }
      const body = await readBounded(response);
      const page = isMarkdown
        ? extractMarkdownPage(response.url, response.status, contentType, body)
        : extractPage(response.url, response.status, contentType, body);
      const duplicate = fingerprints.get(page.fingerprint);
      if (duplicate) page.duplicateOf = duplicate;
      else fingerprints.set(page.fingerprint, page.id);
      pages.push(page);
      if (item.depth < limits.maxDepth)
        for (const href of page.links) {
          let link: URL;
          try {
            link = new URL(href);
          } catch {
            continue;
          }
          link.hash = "";
          if (link.origin !== root.origin) continue;
          crawlEdges.push({ from: page.url, to: link.href });
          if (seen.has(link.href)) continue;
          if (!isAllowed(robots, link)) continue;
          seen.add(link.href);
          queue.push({ url: link, depth: item.depth + 1 });
        }
    } catch (error) {
      warnings.push(
        `${item.url.href}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!pages.length)
    throw new Error(
      "No crawlable public HTML or Markdown pages were retrieved.",
    );
  return crawlOutputSchema.parse({
    target: root.href,
    startedAt,
    completedAt: new Date().toISOString(),
    robots: {
      url: robotsUrl.href,
      allowed: true,
      sitemaps: sitemaps.map((url) => url.href),
      status: robotsResponse?.status ?? null,
    },
    pages,
    crawlEdges,
    warnings,
    limits,
  });
}

/**
 * Fetches a URL with the redirect chain re-validated at every hop, and with the
 * connection pinned to addresses that were checked as public. Pinning matters:
 * validating the hostname and then letting fetch resolve it again leaves a
 * DNS-rebinding window where the second lookup returns a private address.
 */
async function safeFetch(initial: URL, acceptHtml: boolean): Promise<Response> {
  let current = initial;
  for (let redirect = 0; redirect <= limits.maxRedirects; redirect++) {
    const { url, addresses } = await validatePublicUrl(current.href);
    current = url;
    const dispatcher = pinnedDispatcher(addresses);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(limits.timeoutMs),
        headers: {
          "user-agent": USER_AGENT,
          accept: acceptHtml
            ? "text/html,application/xhtml+xml,text/markdown"
            : "text/plain,*/*;q=0.1",
        },
        // @ts-expect-error -- undici extension, honoured by Node's global fetch
        dispatcher,
      });
    } catch (error) {
      await dispatcher.close().catch(() => {});
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      const location = response.headers.get("location");
      if (!location)
        throw new Error("Redirect response did not include a location.");
      try {
        current = new URL(location, current);
      } catch {
        throw new Error("Redirect response carried an unusable location.");
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    const announced = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(announced) && announced > limits.maxBytes) {
      await response.body?.cancel().catch(() => {});
      await dispatcher.close().catch(() => {});
      throw new Error("Response exceeds the 2 MiB size limit.");
    }
    // The dispatcher stays open until the body is drained; readBounded closes it.
    pending.set(response, dispatcher);
    return response;
  }
  throw new Error("Redirect limit exceeded.");
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

async function readBounded(response: Response): Promise<string> {
  const dispatcher = pending.get(response);
  pending.delete(response);
  try {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limits.maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeds the 2 MiB size limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    await dispatcher?.close().catch(() => {});
  }
}

async function validatePublicUrl(
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

type Robots = {
  rules: Array<{ allow: boolean; path: string }>;
  sitemaps: string[];
};

/**
 * RFC 9309 group matching. The previous implementation treated any
 * `Disallow: /` line as a site-wide block, so one hostile-bot rule locked
 * SPECTRA out of sites it was welcome to read, and per-path rules were ignored
 * entirely in the other direction.
 */
export function parseRobots(text: string): Robots {
  const sitemaps: string[] = [];
  const groups: Array<{ agents: string[]; rules: Robots["rules"] }> = [];
  let current: { agents: string[]; rules: Robots["rules"] } | null = null;
  let previousWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !previousWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      previousWasAgent = true;
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    previousWasAgent = false;
    if (!current) continue;
    current.rules.push({ allow: field === "allow", path: value });
  }
  const exact = groups.filter((group) => group.agents.includes(ROBOTS_TOKEN));
  const wildcard = groups.filter((group) => group.agents.includes("*"));
  const chosen = exact.length ? exact : wildcard;
  return { rules: chosen.flatMap((group) => group.rules), sitemaps };
}

export function isAllowed(robots: Robots, url: URL): boolean {
  const path = `${url.pathname}${url.search}`;
  let decision: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    // An empty Disallow value means "allow everything" and carries no path.
    if (!rule.path) continue;
    if (!matchesRobotsPath(rule.path, path)) continue;
    const length = rule.path.length;
    // Longest match wins; Allow wins ties, per RFC 9309.
    if (
      !decision ||
      length > decision.length ||
      (length === decision.length && rule.allow)
    )
      decision = { allow: rule.allow, length };
  }
  return decision ? decision.allow : true;
}

function matchesRobotsPath(pattern: string, path: string): boolean {
  const mustEnd = pattern.endsWith("$");
  const body = mustEnd ? pattern.slice(0, -1) : pattern;
  const segments = body.split("*");
  let index = 0;
  for (const [position, segment] of segments.entries()) {
    if (!segment) continue;
    if (position === 0) {
      if (!path.startsWith(segment)) return false;
      index = segment.length;
      continue;
    }
    const found = path.indexOf(segment, index);
    if (found < 0) return false;
    index = found + segment.length;
  }
  if (mustEnd) {
    const last = segments[segments.length - 1];
    return segments.length === 1 ? path === body : path.endsWith(last);
  }
  return true;
}

export function extractPage(
  urlValue: string,
  status: number,
  contentType: string,
  html: string,
): CrawlOutput["pages"][number] {
  const url = new URL(urlValue);
  const $ = cheerio.load(html);

  // Links are harvested before the chrome is stripped. Removing nav and footer
  // first left the crawler unable to see a site's primary navigation, so most
  // audits only ever reached the entry page.
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    try {
      const href = $(element).attr("href");
      if (!href || /^\s*(javascript|mailto|tel|data):/i.test(href)) return;
      const link = new URL(href, url);
      link.hash = "";
      if (["http:", "https:"].includes(link.protocol)) links.add(link.href);
    } catch {}
  });

  $(
    "script:not([type='application/ld+json']),style,noscript,svg,nav,footer,form",
  ).remove();
  const title = clean($("title").first().text());
  const description = clean(
    $("meta[name='description']").attr("content") ?? "",
  );
  const canonicalValue = $("link[rel='canonical']").attr("href");
  let canonicalUrl: string | null = null;
  try {
    if (canonicalValue) canonicalUrl = new URL(canonicalValue, url).href;
  } catch {}
  const headings: Array<{ level: number; text: string }> = [];
  $("h1,h2,h3,h4,h5,h6").each((_, element) => {
    const text = clean($(element).text());
    if (text) headings.push({ level: Number(element.tagName[1]), text });
  });
  const text = clean(
    $("main").first().text() || $("article").first().text() || $("body").text(),
  ).slice(0, 100_000);
  const jsonLd: unknown[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      jsonLd.push(JSON.parse($(element).text()));
    } catch {}
  });
  const openGraph: Record<string, string> = {};
  $("meta[property^='og:']").each((_, element) => {
    const key = $(element).attr("property"),
      value = $(element).attr("content");
    if (key && value) openGraph[key] = value;
  });
  const twitter: Record<string, string> = {};
  $("meta[name^='twitter:']").each((_, element) => {
    const key = $(element).attr("name"),
      value = $(element).attr("content");
    if (key && value) twitter[key] = value;
  });
  const semanticElements: Array<{ tag: string; text: string }> = [];
  $("main,article,section,address,time,header").each((_, element) => {
    const value = clean($(element).text()).slice(0, 2000);
    if (value) semanticElements.push({ tag: element.tagName, text: value });
  });
  return {
    id: pageId(url),
    url: url.href,
    status,
    title,
    description,
    canonicalUrl,
    headings,
    text,
    links: [...links],
    jsonLd,
    openGraph,
    twitter,
    semanticElements,
    fingerprint: createHash("sha256").update(text).digest("hex"),
    contentType,
    duplicateOf: null,
  };
}

export function extractMarkdownPage(
  urlValue: string,
  status: number,
  contentType: string,
  markdown: string,
): CrawlOutput["pages"][number] {
  const url = new URL(urlValue);
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(
    (match) => ({ level: match[1].length, text: clean(match[2]) }),
  );
  const links = new Set<string>();
  for (const match of markdown.matchAll(
    /\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g,
  )) {
    try {
      const link = new URL(match[1], url);
      link.hash = "";
      if (["http:", "https:"].includes(link.protocol)) links.add(link.href);
    } catch {}
  }
  const paragraphs = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("```"))
    .map((line) =>
      clean(
        line.replace(/[\*_`]/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"),
      ),
    );
  const text = clean(
    `${headings.map((heading) => heading.text).join(" ")} ${paragraphs.join(" ")}`,
  ).slice(0, 100_000);
  return {
    id: pageId(url),
    url: url.href,
    status,
    title: headings[0]?.text ?? "",
    description: paragraphs[0] ?? "",
    canonicalUrl: null,
    headings,
    text,
    links: [...links],
    jsonLd: [],
    openGraph: {},
    twitter: {},
    semanticElements: text
      ? [{ tag: "markdown", text: text.slice(0, 2000) }]
      : [],
    fingerprint: createHash("sha256").update(text).digest("hex"),
    contentType,
    duplicateOf: null,
  };
}

/**
 * Identity comes from the URL, not the body hash. Content hashes collide across
 * distinct pages (every empty page hashes alike), and evidence IDs are built as
 * `${page.id}:${suffix}` — colliding page IDs produced duplicate evidence IDs
 * that broke record selection and survival tracing.
 */
export function pageId(url: URL): string {
  return createHash("sha256").update(url.href).digest("hex").slice(0, 12);
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
