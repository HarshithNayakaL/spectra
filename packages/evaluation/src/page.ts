import type { BotProbe, PageSignals } from "@spectra/schemas";
import { isAllowed, parseRobots } from "./robots";
import { SEARCH_BOTS, TRAINING_BOTS } from "./readiness";
import { scorePage, type PageCitability } from "./citability";
import { buildIndex, retrieve, type Retrieved } from "./retrieval";
import { validateStructuredData, type NodeCheck } from "./structured";

/**
 * The page inspector: everything an answer engine can and cannot take from one
 * URL, from the one fetch it would make.
 *
 * The audit spreads itself over a site. This goes deep on a single page: who
 * is allowed to fetch it, what they are served, what they may quote, whether
 * its markup is complete, and whether it answers the question you care about.
 * Every line is read from the response; nothing is inferred by a model.
 */

export type CrawlerRow = {
  token: string;
  engine: string;
  kind: "search" | "training";
  /** What robots.txt says for this exact path. */
  robots: "allowed" | "blocked" | "no-file";
  /** The live request as this crawler, when one was made. */
  live: { status: number | null; blocked: boolean; note: string } | null;
  /** The verdict: can this crawler actually get the page? */
  reaches: boolean;
};

export type SnippetControls = {
  noindex: boolean;
  nosnippet: boolean;
  /** -1 means unlimited, 0 means none, null means not set. */
  maxSnippet: number | null;
  noai: boolean;
  /** Where the directives came from: the meta tag, the header, or both. */
  source: string;
  canonical: string;
  /** True when the canonical points somewhere else. */
  canonicalElsewhere: boolean;
  /** Elements marked data-nosnippet; their text is withheld from snippets. */
  nosnippetBlocks: number;
};

export type Finding = {
  severity: "high" | "medium" | "low";
  text: string;
};

export type PageReport = {
  url: string;
  host: string;
  status: number;
  ms: number;
  bytes: number;
  title: string;
  description: string;
  words: number;
  appShell: boolean;
  lang: string;
  headings: PageSignals["headings"];
  /** The main text as a crawler receives it, before any JavaScript. */
  text: string;
  crawlers: CrawlerRow[];
  controls: SnippetControls;
  schema: NodeCheck[];
  schemaTypes: string[];
  schemaErrors: number;
  citability: PageCitability;
  /** How well the page answers the question asked, when one was asked. */
  match: (Retrieved & { question: string }) | null;
  /** Everything that stops an engine using this page, worst first. */
  findings: Finding[];
};

/** Live probes are named by product; robots tokens are what they obey. */
const LIVE_TOKEN: Record<string, string> = {
  GPTBot: "GPTBot",
  "OAI-SearchBot": "OAI-SearchBot",
  "ChatGPT-User": "ChatGPT-User",
  PerplexityBot: "PerplexityBot",
  ClaudeBot: "ClaudeBot",
};

export function readControls(page: PageSignals): SnippetControls {
  const meta = page.metaRobots.toLowerCase();
  const header = page.xRobotsTag.toLowerCase();
  const all = `${meta}, ${header}`;
  const max = all.match(/max-snippet\s*:\s*(-?\d+)/);
  let canonicalElsewhere = false;
  if (page.canonical)
    try {
      const target = new URL(page.canonical, page.url);
      const here = new URL(page.url);
      const clean = (url: URL) =>
        `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "") || "/"}`;
      canonicalElsewhere = clean(target) !== clean(here);
    } catch {
      canonicalElsewhere = false;
    }
  return {
    noindex: /\b(noindex|none)\b/.test(all),
    nosnippet: /\b(nosnippet|none)\b/.test(all),
    maxSnippet: max ? Number(max[1]) : null,
    noai: /\bnoai\b/.test(all),
    source: [meta && "meta robots", header && "X-Robots-Tag header"]
      .filter(Boolean)
      .join(" and "),
    canonical: page.canonical,
    canonicalElsewhere,
    nosnippetBlocks: page.nosnippetBlocks,
  };
}

export function crawlerRows(
  url: string,
  robotsText: string | null,
  probes: BotProbe[],
): CrawlerRow[] {
  const target = new URL(url);
  const bots = [
    ...SEARCH_BOTS.map((bot) => ({ ...bot, kind: "search" as const })),
    ...TRAINING_BOTS.map((bot) => ({ ...bot, kind: "training" as const })),
  ];
  return bots.map((bot) => {
    const robots: CrawlerRow["robots"] =
      robotsText === null
        ? "no-file"
        : isAllowed(parseRobots(robotsText, bot.token), target)
          ? "allowed"
          : "blocked";
    const probe = probes.find(
      (candidate) => LIVE_TOKEN[candidate.agent] === bot.token,
    );
    const live = probe
      ? { status: probe.status, blocked: probe.blocked, note: probe.note }
      : null;
    return {
      token: bot.token,
      engine: bot.engine,
      kind: bot.kind,
      robots,
      live,
      reaches: robots !== "blocked" && !(live?.blocked ?? false),
    };
  });
}

export function buildPageReport(input: {
  page: PageSignals;
  robotsText: string | null;
  probes: BotProbe[];
  question?: string;
}): PageReport {
  const { page } = input;
  const host = new URL(page.url).hostname.replace(/^www\./, "");
  const crawlers = crawlerRows(page.url, input.robotsText, input.probes);
  const controls = readControls(page);
  const schema = validateStructuredData(page.jsonLd);
  const citability = scorePage(page);
  const question = input.question?.trim() ?? "";
  const match = question
    ? {
        question,
        ...retrieve(
          buildIndex([
            {
              url: page.url,
              host,
              title: page.title,
              description: page.description,
              headings: page.headings.map((heading) => heading.text),
              text: page.excerpt,
            },
          ]),
          question,
        ),
      }
    : null;

  const findings: Finding[] = [];
  const blockedSearch = crawlers.filter(
    (row) => row.kind === "search" && !row.reaches,
  );
  const browser = input.probes.find((probe) => probe.agent === "Browser");
  if (page.status >= 400)
    findings.push({
      severity: "high",
      text: `The page answered ${page.status}. Nothing on it can be used.`,
    });
  if (controls.noindex)
    findings.push({
      severity: "high",
      text: `Marked noindex in the ${controls.source}: search-backed engines will drop it.`,
    });
  if (blockedSearch.length)
    findings.push({
      severity: "high",
      text: `${blockedSearch.map((row) => row.token).join(", ")} cannot fetch this page${
        blockedSearch.some((row) => row.robots === "blocked")
          ? " (robots.txt)"
          : ""
      }${
        blockedSearch.some((row) => row.live?.blocked) &&
        browser &&
        !browser.blocked
          ? ", while a browser gets through"
          : ""
      }.`,
    });
  if (page.appShell)
    findings.push({
      severity: "high",
      text: `Only ${page.words} words arrive in the HTML; the rest is built by JavaScript, which AI crawlers do not run.`,
    });
  if (controls.nosnippet)
    findings.push({
      severity: "high",
      text: "nosnippet forbids quoting the page, which keeps it out of AI Overviews and AI Mode answers.",
    });
  else if (controls.maxSnippet !== null && controls.maxSnippet >= 0)
    findings.push({
      severity: controls.maxSnippet < 50 ? "high" : "medium",
      text: `max-snippet:${controls.maxSnippet} caps any quote at ${controls.maxSnippet} characters.`,
    });
  if (controls.nosnippetBlocks && !controls.nosnippet)
    findings.push({
      severity: "low",
      text: `${controls.nosnippetBlocks} ${controls.nosnippetBlocks === 1 ? "element is" : "elements are"} marked data-nosnippet: engines may read ${controls.nosnippetBlocks === 1 ? "it" : "them"} but must not quote ${controls.nosnippetBlocks === 1 ? "it" : "them"}. Check nothing you want cited is inside.`,
    });
  if (controls.canonicalElsewhere)
    findings.push({
      severity: "medium",
      text: `The canonical points to ${controls.canonical}, so engines credit that URL, not this one.`,
    });
  if (!page.title)
    findings.push({ severity: "medium", text: "The page has no <title>." });
  if (!page.description)
    findings.push({
      severity: "low",
      text: "There is no meta description to summarise the page.",
    });
  for (const node of schema.filter((row) => !row.ok).slice(0, 4))
    findings.push({
      severity: "medium",
      text: `${node.type}${node.label ? ` “${node.label}”` : ""}: ${[
        node.missingRequired.length &&
          `missing ${node.missingRequired.join(", ")}`,
        ...node.problems,
      ]
        .filter(Boolean)
        .join("; ")}.`,
    });
  if (page.jsonLdErrors)
    findings.push({
      severity: "medium",
      text: `${page.jsonLdErrors} JSON-LD ${page.jsonLdErrors === 1 ? "block does" : "blocks do"} not parse, so ${page.jsonLdErrors === 1 ? "it is" : "they are"} ignored.`,
    });
  if (!page.jsonLdTypes.length)
    findings.push({
      severity: "low",
      text: "No structured data labels what this page is.",
    });
  if (match && match.status !== "answered")
    findings.push({
      severity: match.status === "missing" ? "high" : "medium",
      text: `For “${question}” the page carries ${Math.round(match.coverage * 100)}% of the words${
        match.missingTerms.length
          ? `; it never mentions ${match.missingTerms.join(", ")}`
          : ""
      }.`,
    });
  if (citability.score !== null && citability.score < 50 && !page.appShell)
    findings.push({
      severity: "medium",
      text: `Citability ${citability.score}/100: ${citability.next.charAt(0).toLowerCase()}${citability.next.slice(1)}`,
    });

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return {
    url: page.url,
    host,
    status: page.status,
    ms: page.ms,
    bytes: page.bytes,
    title: page.title,
    description: page.description,
    words: page.words,
    appShell: page.appShell,
    lang: page.lang,
    headings: page.headings,
    text: page.excerpt,
    crawlers,
    controls,
    schema,
    schemaTypes: page.jsonLdTypes,
    schemaErrors: page.jsonLdErrors,
    citability,
    match,
    findings: findings.sort((a, b) => rank[a.severity] - rank[b.severity]),
  };
}
