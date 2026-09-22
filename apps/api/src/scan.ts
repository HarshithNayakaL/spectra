import * as cheerio from "cheerio";
import {
  scanSchema,
  type BotProbe,
  type FileProbe,
  type PageSignals,
  type Scan,
} from "@spectra/schemas";
import { isAllowed, parseRobots } from "@spectra/evaluation";
import { fetchPublic, type Fetched } from "./net";

const MAX_PAGES = 12;
const CONCURRENCY = 4;

const BROWSER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** Real user-agent strings the answer engines send. */
export const AI_AGENTS: Array<{ name: string; ua: string }> = [
  {
    name: "GPTBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  },
  {
    name: "OAI-SearchBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  },
  {
    name: "ChatGPT-User",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  },
  {
    name: "PerplexityBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  },
  {
    name: "ClaudeBot",
    ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  },
];

/** Pages an answer engine leans on when it describes a business. */
const PRIORITY: Array<[RegExp, number]> = [
  [/\/(about|company|who-we-are|our-story)/, 10],
  [/\/(pricing|plans|price)/, 9],
  [/\/(products?|services?|solutions?|features?|platform)/, 8],
  [/\/(faq|faqs|help|support)/, 7],
  [/\/(contact|locations?)/, 6],
  [/\/(compare|vs|alternatives?|reviews?|customers?|case-stud)/, 6],
  [/\/(docs|documentation|api)/, 4],
  [/\/(blog|news|resources|articles?|insights)/, 3],
];
const SKIP =
  /\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mp3|xml|json|css|js|ico)$|\/(wp-|cart|checkout|login|signin|signup|register|account|tag\/|author\/|feed)/i;

export class ScanError extends Error {}

export async function scanSite(target: string): Promise<Scan> {
  const started = Date.now();
  let root: URL;
  try {
    root = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`);
  } catch {
    throw new ScanError("Enter a valid public URL.");
  }

  let home: Fetched;
  try {
    home = await fetchPublic(root);
  } catch (error) {
    if (root.protocol === "https:" && !/^https?:\/\//i.test(target)) {
      root.protocol = "http:";
      home = await fetchPublic(root).catch(() => {
        throw new ScanError(unreachable(target, error));
      });
    } else throw new ScanError(unreachable(target, error));
  }
  const origin = new URL(home.url);

  // Bot probes run alongside the page crawl; they are independent requests.
  const botsPending = probeBots(origin);
  const [robots, llmsTxt, llmsFullTxt] = await Promise.all([
    probe(new URL("/robots.txt", origin), "text/plain,*/*;q=0.1"),
    probe(new URL("/llms.txt", origin), "text/plain,text/markdown,*/*;q=0.1"),
    probe(
      new URL("/llms-full.txt", origin),
      "text/plain,text/markdown,*/*;q=0.1",
      64_000,
    ),
  ]);
  const robotsRules = parseRobots(robots.status === 200 ? robots.body : "");
  const sitemap = await probeSitemap(origin, robotsRules.sitemaps);

  const pages: PageSignals[] = [];
  const failures: Scan["failures"] = [];
  if (isHtml(home)) pages.push(readPage(home));
  else
    failures.push({
      url: home.url,
      error:
        `Homepage returned ${home.status} ${home.headers.get("content-type") ?? ""}`.trim(),
    });

  const crawlStarted = Date.now();
  const candidates = pickPages(
    origin,
    [...(pages[0]?.internalLinks ?? []), ...sitemap.locs],
    new Set([normalise(home.url)]),
  ).filter((url) => isAllowed(robotsRules, url));
  let cursor = 0;
  let inFlight = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      // Stop starting new fetches after 15s: a slow site still gets a report.
      while (
        cursor < candidates.length &&
        pages.length + inFlight < MAX_PAGES &&
        Date.now() - crawlStarted < 12_000
      ) {
        const url = candidates[cursor++];
        inFlight += 1;
        try {
          const response = await fetchPublic(url);
          if (!isHtml(response)) {
            if (response.status >= 400)
              failures.push({
                url: url.href,
                error: `HTTP ${response.status}`,
              });
            continue;
          }
          if (
            pages.some(
              (page) => normalise(page.url) === normalise(response.url),
            )
          )
            continue;
          pages.push(readPage(response));
        } catch (error) {
          failures.push({ url: url.href, error: messageOf(error) });
        } finally {
          inFlight -= 1;
        }
      }
    }),
  );

  const bots = await botsPending;
  if (!pages.length)
    throw new ScanError(
      home.status >= 400
        ? `${origin.host} answered ${home.status} to every request. The site is blocking automated visitors, so AI crawlers are blocked too.`
        : `${origin.host} did not return any readable HTML pages.`,
    );

  return scanSchema.parse({
    target: root.href,
    finalUrl: home.url,
    https: origin.protocol === "https:",
    robots,
    sitemap: {
      url: sitemap.probe.url,
      status: sitemap.probe.status,
      bytes: sitemap.probe.bytes,
      contentType: sitemap.probe.contentType,
      body: "",
      urls: sitemap.locs.length,
      referenced: robotsRules.sitemaps.length > 0,
    },
    llmsTxt,
    llmsFullTxt: { ...llmsFullTxt, body: llmsFullTxt.body.slice(0, 2000) },
    bots,
    pages,
    failures,
    durationMs: Date.now() - started,
  });
}

function unreachable(target: string, error: unknown) {
  const text = messageOf(error);
  if (/non-public|Local targets|did not resolve/i.test(text))
    return `${target} is not a public site (${text.toLowerCase().replace(/\.$/, "")}).`;
  return `Could not reach ${target}: ${text}`;
}

async function probe(
  url: URL,
  accept: string,
  maxBytes = 200_000,
): Promise<FileProbe> {
  try {
    const response = await fetchPublic(url, { accept, maxBytes });
    const contentType = response.headers.get("content-type") ?? "";
    // A soft 404 (the homepage served for every path) is not a file.
    const html =
      /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(response.body);
    return {
      url: url.href,
      status: html && response.status === 200 ? 404 : response.status,
      bytes: response.bytes,
      contentType,
      body: response.status === 200 && !html ? response.body : "",
    };
  } catch (error) {
    return { url: url.href, status: null, bytes: 0, contentType: "", body: "" };
  }
}

/**
 * Requests the homepage as each AI crawler and as a browser. A firewall that
 * answers 403 to GPTBot but 200 to Chrome blocks that engine no matter what
 * robots.txt says.
 */
async function probeBots(origin: URL): Promise<BotProbe[]> {
  const agents = [{ name: "Browser", ua: BROWSER_AGENT }, ...AI_AGENTS];
  return Promise.all(
    agents.map(async ({ name, ua }) => {
      try {
        const response = await fetchPublic(origin, {
          userAgent: ua,
          maxBytes: 60_000,
        });
        const challenge =
          /cf-chl|challenge-platform|just a moment\.\.\.|attention required|captcha|access denied/i.test(
            response.body.slice(0, 20_000),
          );
        const blocked = response.status >= 400 || challenge;
        return {
          agent: name,
          status: response.status,
          blocked,
          note: challenge
            ? "served a bot challenge page"
            : blocked
              ? `answered ${response.status}`
              : "",
        };
      } catch (error) {
        const text = messageOf(error);
        // A slow server is not a firewall. Only a refusal counts as a block.
        const timedOut = /timed out|timeout|aborted/i.test(text);
        return {
          agent: name,
          status: null,
          blocked: !timedOut,
          note: timedOut ? "timed out (inconclusive)" : text,
        };
      }
    }),
  );
}

async function probeSitemap(origin: URL, declared: string[]) {
  const urls = [
    ...declared.flatMap((value) => {
      try {
        return [new URL(value, origin)];
      } catch {
        return [];
      }
    }),
    new URL("/sitemap.xml", origin),
    new URL("/sitemap_index.xml", origin),
  ];
  let first: FileProbe | null = null;
  for (const url of urls.slice(0, 4)) {
    const result = await probe(
      url,
      "application/xml,text/xml,*/*;q=0.1",
      1_500_000,
    );
    first ??= result;
    if (result.status !== 200 || !/<(urlset|sitemapindex)/i.test(result.body))
      continue;
    let locs = locsOf(result.body);
    // An index lists sitemaps, not pages: open the first child for page URLs.
    if (/<sitemapindex/i.test(result.body) && locs.length) {
      const child = await probe(
        new URL(locs[0]),
        "application/xml,*/*;q=0.1",
        1_500_000,
      );
      const pages = child.status === 200 ? locsOf(child.body) : [];
      if (pages.length) locs = pages;
    }
    return { probe: { ...result, body: "" }, locs };
  }
  return {
    probe: {
      ...(first ?? {
        url: urls[0].href,
        status: null,
        bytes: 0,
        contentType: "",
        body: "",
      }),
      status: first?.status === 200 ? 422 : (first?.status ?? null),
    },
    locs: [] as string[],
  };
}

function locsOf(xml: string) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map(
    (match) => match[1].replace(/&amp;/g, "&"),
  );
}

export function pickPages(origin: URL, links: string[], seen: Set<string>) {
  const host = origin.hostname.replace(/^www\./, "");
  const scored: Array<{ url: URL; score: number }> = [];
  for (const href of links) {
    let url: URL;
    try {
      url = new URL(href, origin);
    } catch {
      continue;
    }
    url.hash = "";
    if (url.hostname.replace(/^www\./, "") !== host) continue;
    if (SKIP.test(url.pathname) || url.search.length > 40) continue;
    const key = normalise(url.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const path = url.pathname.toLowerCase();
    const depth = path.split("/").filter(Boolean).length;
    const bonus = PRIORITY.find(([pattern]) => pattern.test(path))?.[1] ?? 0;
    scored.push({ url, score: bonus * 3 - depth * 2 - (url.search ? 3 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  // One page per priority family first, so twelve blog posts cannot crowd out
  // the about and pricing pages.
  const picked: URL[] = [];
  const families = new Set<number>();
  for (const item of scored) {
    const family = PRIORITY.findIndex(([pattern]) =>
      pattern.test(item.url.pathname.toLowerCase()),
    );
    if (family >= 0 && families.has(family)) continue;
    families.add(family);
    picked.push(item.url);
  }
  for (const item of scored)
    if (!picked.includes(item.url)) picked.push(item.url);
  return picked.slice(0, MAX_PAGES * 2);
}

function normalise(href: string) {
  try {
    const url = new URL(href);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
  } catch {
    return href;
  }
}

function isHtml(response: Fetched) {
  const type = response.headers.get("content-type") ?? "";
  return (
    response.status < 400 &&
    (/html/i.test(type) || (!type && /<html/i.test(response.body)))
  );
}

const SOCIAL =
  /^https?:\/\/(www\.)?(linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|github\.com|crunchbase\.com|[a-z]{2}\.wikipedia\.org|wikidata\.org|tiktok\.com|g2\.com|trustpilot\.com)\//i;

/** Reads the signals an answer engine can take from raw, unrendered HTML. */
export function readPage(response: {
  url: string;
  status: number;
  ms: number;
  bytes: number;
  body: string;
  headers: Headers;
}): PageSignals {
  const $ = cheerio.load(response.body);
  const url = new URL(response.url);
  const host = url.hostname.replace(/^www\./, "");

  const jsonLd: unknown[] = [];
  const types = new Set<string>();
  let jsonLdErrors = 0;
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      const value = JSON.parse($(element).text());
      jsonLd.push(value);
      collectTypes(value, types);
    } catch {
      jsonLdErrors += 1;
    }
  });

  const socialLinks = new Set<string>();
  const internalLinks = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || /^\s*(javascript|mailto|tel|data):/i.test(href)) return;
    try {
      const link = new URL(href, url);
      link.hash = "";
      if (SOCIAL.test(link.href)) socialLinks.add(link.href.replace(/\/$/, ""));
      else if (link.hostname.replace(/^www\./, "") === host)
        internalLinks.add(link.href);
    } catch {}
  });
  $("link[rel='me'][href]").each((_, element) => {
    const href = $(element).attr("href");
    if (href && SOCIAL.test(href)) socialLinks.add(href.replace(/\/$/, ""));
  });

  const openGraph: Record<string, string> = {};
  $("meta[property^='og:']").each((_, element) => {
    const key = $(element).attr("property"),
      value = $(element).attr("content");
    if (key && value) openGraph[key] = value.trim();
  });

  const images = $("img");
  let imagesWithAlt = 0;
  images.each((_, element) => {
    if (($(element).attr("alt") ?? "").trim()) imagesWithAlt += 1;
  });
  const scripts = $("script[src]").length;
  const hasDate = Boolean(
    $("time[datetime]").length ||
    $("meta[property='article:published_time']").length ||
    $("meta[property='article:modified_time']").length ||
    /"date(Published|Modified)"/.test(JSON.stringify(jsonLd)),
  );
  const hasAuthor = Boolean(
    $("meta[name='author']").attr("content") ||
    $("[rel='author']").length ||
    /"author"/.test(JSON.stringify(jsonLd)),
  );

  const title = clean($("title").first().text());
  const description = clean(
    $("meta[name='description']").attr("content") ??
      $("meta[name='Description']").attr("content") ??
      "",
  );
  const lang = ($("html").attr("lang") ?? "").trim();
  const canonical = $("link[rel='canonical']").attr("href")?.trim() ?? "";
  const metaRobots = [
    $("meta[name='robots']").attr("content"),
    $("meta[name='googlebot']").attr("content"),
  ]
    .filter(Boolean)
    .join(", ");
  const headings: PageSignals["headings"] = [];
  $("h1,h2,h3").each((_, element) => {
    const text = clean($(element).text());
    if (text && headings.length < 60)
      headings.push({ level: Number(element.tagName[1]), text });
  });
  const h1 = headings.filter((h) => h.level === 1).map((h) => h.text);
  const questionHeadings = headings.filter(
    (h) =>
      h.text.endsWith("?") ||
      /^(how|what|why|when|where|who|which|can|does|do|is|are|should)\b/i.test(
        h.text,
      ),
  ).length;

  $("script,style,noscript,svg,template,iframe").remove();
  const bodyText = clean($("body").text());
  const mainText = clean(
    $("main").first().text() || $("article").first().text() || bodyText,
  );
  const words = bodyText ? bodyText.split(" ").length : 0;
  const mountPoint = $(
    "#root, #app, #__next, #__nuxt, [data-reactroot], app-root",
  );
  const appShell = words < 120 && (mountPoint.length > 0 || scripts >= 3);

  return {
    url: response.url,
    status: response.status,
    ms: response.ms,
    bytes: response.bytes,
    title,
    description,
    h1,
    headings,
    words,
    lang,
    canonical,
    metaRobots,
    xRobotsTag: response.headers.get("x-robots-tag") ?? "",
    jsonLdTypes: [...types],
    jsonLd: jsonLd.slice(0, 8),
    jsonLdErrors,
    openGraph,
    images: images.length,
    imagesWithAlt,
    scripts,
    appShell,
    questionHeadings,
    hasDate,
    hasAuthor,
    socialLinks: [...socialLinks].slice(0, 12),
    internalLinks: [...internalLinks].slice(0, 250),
    // The retrieval index is built from this, so it keeps more than a preview
    // would need. Everything handed to the model is sliced again at that call.
    excerpt: mainText.slice(0, 6000),
  };
}

function collectTypes(value: unknown, into: Set<string>, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value) collectTypes(item, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") into.add(type);
  if (Array.isArray(type))
    for (const item of type) if (typeof item === "string") into.add(item);
  for (const [key, child] of Object.entries(record))
    if (key !== "@context") collectTypes(child, into, depth + 1);
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text === "fetch failed" && error instanceof Error && error.cause
    ? messageOf(error.cause)
    : text;
}

/**
 * A rival's site, fetched the way we fetch the customer's, and cheaply.
 *
 * This is the crawler standing in for grounding. A live search would find the
 * pages that answer a sub-query anywhere on the web; we cannot find, but we
 * can fetch, so the competitive set is named first and then crawled. It is a
 * named set rather than the whole web, and the report says so.
 *
 * Deliberately small: the homepage plus the few pages an answer engine leans
 * on, inside a hard time budget, because this runs inside an audit that is
 * already against the clock.
 */
export async function crawlRival(
  host: string,
  options: { maxPages?: number; budgetMs?: number } = {},
): Promise<{ host: string; pages: PageSignals[]; error: string }> {
  const maxPages = options.maxPages ?? 4;
  const started = Date.now();
  const budget = options.budgetMs ?? 14_000;
  let origin: URL;
  try {
    origin = new URL(
      `https://${host.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`,
    );
  } catch {
    return { host, pages: [], error: "not a usable hostname" };
  }

  let home: Fetched;
  try {
    home = await fetchPublic(origin, { maxBytes: 400_000, timeoutMs: 8_000 });
  } catch (error) {
    return { host, pages: [], error: messageOf(error) };
  }
  if (!isHtml(home))
    return {
      host,
      pages: [],
      error: `answered ${home.status} and no readable HTML`,
    };

  const pages = [readPage(home)];
  const candidates = pickPages(
    new URL(home.url),
    pages[0].internalLinks,
    new Set([normalise(home.url)]),
  ).slice(0, maxPages - 1);
  // One round, in parallel: a rival's site is context, not the measurement,
  // and it must never be the reason an audit runs out of time.
  await Promise.all(
    candidates.map(async (url) => {
      if (Date.now() - started > budget) return;
      try {
        const response = await fetchPublic(url, {
          maxBytes: 400_000,
          timeoutMs: 7_000,
        });
        if (isHtml(response)) pages.push(readPage(response));
      } catch {
        // A rival page we cannot read is simply not in the index.
      }
    }),
  );
  return {
    host: new URL(home.url).hostname.replace(/^www\./, ""),
    pages: pages.slice(0, maxPages),
    error: "",
  };
}
