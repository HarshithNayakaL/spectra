import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import { crawlOutputSchema, type CrawlOutput } from "@spectra/schemas";

const limits = {
  maxPages: 20,
  maxDepth: 2,
  maxBytes: 2_097_152,
  timeoutMs: 10_000,
  maxRedirects: 5,
};

export async function crawlWithNode(target: string): Promise<CrawlOutput> {
  const root = await validatePublicUrl(target);
  const startedAt = new Date().toISOString();
  const robotsUrl = new URL("/robots.txt", root);
  const robotsResponse = await safeFetch(robotsUrl, false).catch(() => null);
  const robotsText = robotsResponse ? await readBounded(robotsResponse) : "";
  const disallowed = robotsText
    .split(/\r?\n/)
    .some((line) => /^\s*disallow\s*:\s*\/\s*$/i.test(line));
  if (disallowed) throw new Error("robots.txt disallows crawling this target");
  const sitemaps = robotsText
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1])
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value!)];
      } catch {
        return [];
      }
    });

  const queue: Array<{ url: URL; depth: number }> = [{ url: root, depth: 0 }];
  const seen = new Set<string>();
  const fingerprints = new Map<string, string>();
  const pages: CrawlOutput["pages"] = [];
  const crawlEdges: CrawlOutput["crawlEdges"] = [];
  const warnings: string[] = [
    "Rust crawler binary was unavailable; the secure Node compatibility crawler handled this audit.",
  ];

  while (queue.length && pages.length < limits.maxPages) {
    const item = queue.shift()!;
    item.url.hash = "";
    if (seen.has(item.url.href)) continue;
    seen.add(item.url.href);
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
          const link = new URL(href);
          if (link.origin !== root.origin) continue;
          crawlEdges.push({ from: page.url, to: link.href });
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

async function safeFetch(initial: URL, acceptHtml: boolean): Promise<Response> {
  let current = initial;
  for (let redirect = 0; redirect <= limits.maxRedirects; redirect++) {
    current = await validatePublicUrl(current.href);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(limits.timeoutMs),
      headers: {
        "user-agent":
          "SPECTRA/0.1 (+https://github.com/HarshithNayakaL/spectra)",
        accept: acceptHtml
          ? "text/html,application/xhtml+xml,text/markdown"
          : "text/plain,*/*;q=0.1",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location)
        throw new Error("Redirect response did not include a location.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const announced = Number(response.headers.get("content-length") ?? 0);
    if (announced > limits.maxBytes)
      throw new Error("Response exceeds the 2 MiB size limit.");
    return response;
  }
  throw new Error("Redirect limit exceeded.");
}

async function readBounded(response: Response): Promise<string> {
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
}

async function validatePublicUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  if (url.username || url.password)
    throw new Error("Embedded URL credentials are not allowed.");
  if (
    !url.hostname ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost")
  )
    throw new Error("Local targets are blocked.");
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("Target resolves to a non-public address.");
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const value = address.toLowerCase();
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe8") ||
      value.startsWith("fe9") ||
      value.startsWith("fea") ||
      value.startsWith("feb") ||
      value.startsWith("ff") ||
      value.startsWith("::ffff:127.") ||
      value.startsWith("::ffff:10.") ||
      value.startsWith("::ffff:192.168.")
    );
  }
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function extractPage(
  urlValue: string,
  status: number,
  contentType: string,
  html: string,
): CrawlOutput["pages"][number] {
  const url = new URL(urlValue);
  const $ = cheerio.load(html);
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
  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    try {
      const link = new URL($(element).attr("href")!, url);
      link.hash = "";
      if (["http:", "https:"].includes(link.protocol)) links.add(link.href);
    } catch {}
  });
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
  const fingerprint = createHash("sha256").update(text).digest("hex");
  return {
    id: fingerprint.slice(0, 12),
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
    fingerprint,
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
  const fingerprint = createHash("sha256").update(text).digest("hex");
  return {
    id: fingerprint.slice(0, 12),
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
    fingerprint,
    contentType,
    duplicateOf: null,
  };
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
