import type { Layer, Scan } from "@spectra/schemas";
import { evaluateReadiness, SEARCH_BOTS } from "./readiness";
import { deriveIdentity } from "./site";
import { isAllowed, parseRobots } from "./robots";
import { scorePage } from "./citability";
import { buildIndex, retrieve, type IndexedPage } from "./retrieval";

/**
 * Head to head: your site against the rivals a buyer weighs you with, measured
 * the same way on the same day.
 *
 * Every number comes from one crawl of each site, scored by the same pure
 * functions the audit uses, and every question is retrieved over one shared
 * index holding all the sites' pages. Nothing here asks a model who is better:
 * the leader of each row is whoever the measurement says, and a site that
 * could not be crawled is shown as not measured, never as last.
 */

export type SiteColumn = {
  host: string;
  /** Empty when the crawl worked. */
  error: string;
  measured: boolean;
  pages: number;
  readiness: number | null;
  grade: string;
  layers: Array<Pick<Layer, "id" | "label" | "score">>;
  citability: number | null;
  quotable: number;
  paragraphs: number;
  /** Search crawlers that can reach the homepage, out of all listed. */
  searchReach: number;
  searchTotal: number;
  firewallBlocks: string[];
  llmsTxt: boolean;
  schemaTypes: string[];
  appShellPages: number;
  /** Questions this site's pages would answer. */
  answers: number;
  wins: number;
};

export type QuestionRow = {
  question: string;
  /** The host whose page carries most of the question, null on a tie at zero. */
  winner: string | null;
  results: Array<{
    host: string;
    status: "answered" | "weak" | "missing";
    coverage: number;
    url: string;
    title: string;
  }>;
};

export type Comparison = {
  you: string;
  sites: SiteColumn[];
  questions: QuestionRow[];
  /** One line per dimension: who leads it, measured. */
  leaders: Array<{ dimension: string; host: string | null; detail: string }>;
  /** What the first site should take from the comparison. */
  takeaways: string[];
};

export function indexable(
  page: Scan["pages"][number],
  host: string,
): IndexedPage {
  return {
    url: page.url,
    host,
    title: page.title,
    description: page.description,
    headings: page.headings.map((heading) => heading.text),
    text: page.excerpt,
  };
}

export function compareSites(input: {
  sites: Array<{ host: string; scan: Scan | null; error: string }>;
  questions: string[];
}): Comparison {
  const columns: SiteColumn[] = input.sites.map(({ host, scan, error }) => {
    if (!scan)
      return {
        host,
        error: error || "The site could not be crawled.",
        measured: false,
        pages: 0,
        readiness: null,
        grade: "",
        layers: [],
        citability: null,
        quotable: 0,
        paragraphs: 0,
        searchReach: 0,
        searchTotal: SEARCH_BOTS.length,
        firewallBlocks: [],
        llmsTxt: false,
        schemaTypes: [],
        appShellPages: 0,
        answers: 0,
        wins: 0,
      };
    const readiness = evaluateReadiness(scan, deriveIdentity(scan));
    const scored = scan.pages
      .map(scorePage)
      .filter((row) => row.score !== null);
    const robotsText = scan.robots.status === 200 ? scan.robots.body : "";
    const home = new URL(scan.finalUrl);
    const firewallBlocks = scan.bots
      .filter((bot) => bot.blocked && bot.agent !== "Browser")
      .map((bot) => bot.agent);
    const searchReach = SEARCH_BOTS.filter(
      (bot) =>
        isAllowed(parseRobots(robotsText, bot.token), home) &&
        !firewallBlocks.includes(bot.token),
    ).length;
    return {
      host,
      error: "",
      measured: true,
      pages: scan.pages.length,
      readiness: readiness.score,
      grade: readiness.grade,
      layers: readiness.layers.map(({ id, label, score }) => ({
        id,
        label,
        score,
      })),
      citability: scored.length
        ? Math.round(
            scored.reduce((total, row) => total + row.score!, 0) /
              scored.length,
          )
        : null,
      quotable: scored.reduce((total, row) => total + row.liftable, 0),
      paragraphs: scored.reduce((total, row) => total + row.paragraphs, 0),
      searchReach,
      searchTotal: SEARCH_BOTS.length,
      firewallBlocks,
      llmsTxt: scan.llmsTxt.status === 200,
      schemaTypes: [...new Set(scan.pages.flatMap((page) => page.jsonLdTypes))],
      appShellPages: scan.pages.filter((page) => page.appShell).length,
      answers: 0,
      wins: 0,
    };
  });

  // One index over every site, so a question is answered by whichever page in
  // the whole market carries it best, exactly as a retriever would.
  const index = buildIndex(
    input.sites.flatMap(({ host, scan }) =>
      (scan?.pages ?? []).map((page) => indexable(page, host)),
    ),
  );
  const measured = columns.filter((column) => column.measured);
  const questions: QuestionRow[] = input.questions.map((question) => {
    const results = measured.map((column) => {
      const hit = retrieve(index, question, { host: column.host });
      return {
        host: column.host,
        status: hit.status,
        coverage: hit.coverage,
        url: hit.url,
        title: hit.title,
        score: hit.score,
      };
    });
    const best = [...results].sort(
      (a, b) => b.coverage - a.coverage || b.score - a.score,
    )[0];
    const winner = best && best.coverage > 0 ? best.host : null;
    for (const result of results) {
      const column = columns.find((item) => item.host === result.host)!;
      if (result.status === "answered") column.answers += 1;
      if (result.host === winner) column.wins += 1;
    }
    return {
      question,
      winner,
      results: results.map(({ score: _score, ...rest }) => rest),
    };
  });

  const you = input.sites[0]?.host ?? "";
  const leaders = [
    leader("AI readiness", measured, (c) => c.readiness, "/100"),
    leader("Citability", measured, (c) => c.citability, "/100"),
    leader(
      "Search crawlers let in",
      measured,
      (c) => c.searchReach,
      `/${SEARCH_BOTS.length}`,
    ),
    leader("Quotable paragraphs", measured, (c) => c.quotable, " paragraphs"),
    ...(questions.length
      ? [
          leader(
            "Questions won",
            measured,
            (c) => c.wins,
            `/${questions.length}`,
          ),
        ]
      : []),
  ];

  return {
    you,
    sites: columns,
    questions,
    leaders,
    takeaways: takeawaysFor(columns, questions, you),
  };
}

function leader(
  dimension: string,
  columns: SiteColumn[],
  value: (column: SiteColumn) => number | null,
  unit: string,
) {
  const rows = columns
    .map((column) => ({ host: column.host, value: value(column) }))
    .filter((row): row is { host: string; value: number } => row.value !== null)
    .sort((a, b) => b.value - a.value);
  if (!rows.length)
    return { dimension, host: null, detail: "Not measured on any site." };
  // A tie is reported as one; naming either site would be a coin toss.
  if (rows.length > 1 && rows[0].value === rows[1].value)
    return {
      dimension,
      host: null,
      detail: `Tied at ${rows[0].value}${unit}.`,
    };
  return {
    dimension,
    host: rows[0].host,
    detail: `${rows[0].value}${unit}${rows[1] ? `, next ${rows[1].host} at ${rows[1].value}${unit}` : ""}.`,
  };
}

function takeawaysFor(
  columns: SiteColumn[],
  questions: QuestionRow[],
  you: string,
): string[] {
  const mine = columns.find((column) => column.host === you);
  if (!mine?.measured) return [];
  const rivals = columns.filter(
    (column) => column.host !== you && column.measured,
  );
  if (!rivals.length) return [];
  const lines: string[] = [];
  const ahead = (value: (column: SiteColumn) => number | null) =>
    rivals.filter((rival) => (value(rival) ?? -1) > (value(mine) ?? -1));
  const readier = ahead((column) => column.readiness);
  if (readier.length)
    lines.push(
      `${readier.map((rival) => `${rival.host} (${rival.readiness}/100)`).join(", ")} ${readier.length === 1 ? "is" : "are"} more AI-ready than you (${mine.readiness}/100). ${readier[0].host}'s lead is widest in ${layerGap(mine, readier[0])}.`,
    );
  const reach = ahead((column) => column.searchReach);
  if (reach.length)
    lines.push(
      `${reach[0].host} lets ${reach[0].searchReach} of ${mine.searchTotal} search crawlers in; you let ${mine.searchReach}. An engine that cannot fetch you answers from them.`,
    );
  const quoted = ahead((column) => column.citability);
  if (quoted.length)
    lines.push(
      `${quoted[0].host}'s pages are easier to quote (${quoted[0].citability}/100 against your ${mine.citability ?? "not measured"}).`,
    );
  const lost = questions.filter(
    (row) => row.winner !== null && row.winner !== you,
  );
  if (lost.length)
    lines.push(
      `A rival's page would be retrieved ahead of yours for ${lost.length} of ${questions.length} questions: ${lost
        .slice(0, 3)
        .map((row) => `“${row.question}” (${row.winner})`)
        .join(", ")}.`,
    );
  if (!mine.llmsTxt && rivals.some((rival) => rival.llmsTxt))
    lines.push(
      `${rivals
        .filter((rival) => rival.llmsTxt)
        .map((rival) => rival.host)
        .join(", ")} publish an llms.txt; you do not.`,
    );
  if (!lines.length)
    lines.push(
      "You lead or tie every measured dimension. Re-run after rivals ship changes: this is a snapshot, not a standing.",
    );
  return lines;
}

function layerGap(mine: SiteColumn, rival: SiteColumn) {
  const gaps = rival.layers
    .map((layer) => {
      const own = mine.layers.find((item) => item.id === layer.id)?.score;
      return {
        label: layer.label.toLowerCase(),
        gap: (layer.score ?? 0) - (own ?? 0),
      };
    })
    .sort((a, b) => b.gap - a.gap);
  return gaps[0] && gaps[0].gap > 0
    ? `${gaps[0].label} (+${gaps[0].gap})`
    : "no single layer";
}
