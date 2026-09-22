import type { Audit, FanoutQuery, FanoutType } from "@spectra/schemas";
import { FANOUT_TYPE_LABEL, FANOUT_TYPE_WHY } from "./fanout";
import { tokenise } from "./retrieval";

/**
 * Content briefs: what to write, made from what the retrieval step could not
 * find.
 *
 * The fan-out measurement ends in a list of sub-queries your own pages cannot
 * answer, or answer worse than a rival's. That list is the editorial calendar.
 * Each brief here is one of those sub-queries turned into a page a writer can
 * start on: the page to write or extend, the words it has to carry, the rival
 * page it has to beat, the outline, and the FAQ markup.
 *
 * Nothing is invented. The words to cover are the ones the retrieval step
 * found missing; the rival is the page it retrieved; the outline is a fixed
 * shape per kind of sub-query. The writer supplies the facts.
 */

export type Brief = {
  id: string;
  query: string;
  type: FanoutType;
  kind: string;
  /** "write" a new page, or "extend" the page that nearly answers it. */
  action: "write" | "extend";
  /** Why this one: lost to a rival, no page, or a thin page. */
  reason: "lost" | "missing" | "weak";
  /** The page to extend, or the suggested path of the new one. */
  target: string;
  title: string;
  /** The words retrieval looked for and did not find. */
  mustCover: string[];
  /** Words the page already carries for this query. */
  alreadyHas: string[];
  outline: string[];
  rival: { host: string; url: string; title: string; coverage: number } | null;
  why: string;
  /** FAQPage JSON-LD with the answer left for the writer. */
  schema: string;
  /** The whole brief as Markdown, for the clipboard. */
  markdown: string;
};

const ORDER = { lost: 0, missing: 1, weak: 2 } as const;
const LIMIT = 8;

export function buildBriefs(audit: Audit): Brief[] {
  const queries = audit.fanout?.queries ?? [];
  const brand = audit.profile?.brand ?? audit.host;
  const briefs: Brief[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const retrieval = query.retrieval;
    if (!retrieval) continue;
    const reason = retrieval.lost
      ? "lost"
      : retrieval.status === "missing"
        ? "missing"
        : retrieval.status === "weak"
          ? "weak"
          : null;
    if (!reason) continue;
    // Two sub-queries that want the same page are one brief, not two.
    const key = [...new Set(tokenise(query.query))].sort().join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    briefs.push(briefFor(query, reason, brand, audit.host));
  }
  return briefs
    .sort(
      (a, b) =>
        ORDER[a.reason] - ORDER[b.reason] ||
        b.mustCover.length - a.mustCover.length ||
        a.query.localeCompare(b.query),
    )
    .slice(0, LIMIT);
}

function briefFor(
  query: FanoutQuery,
  reason: Brief["reason"],
  brand: string,
  host: string,
): Brief {
  const retrieval = query.retrieval!;
  // A page that carries under half the words is about something else: extending
  // it would bend it out of shape, so the brief is a new page.
  const action: Brief["action"] =
    retrieval.url && retrieval.coverage >= 0.4 ? "extend" : "write";
  const title = titleOf(query.query);
  const target =
    action === "extend"
      ? retrieval.url
      : `https://${host}/${slugOf(query.query)}`;
  const outline = OUTLINE[query.type](title, brand);
  const rival = retrieval.rival
    ? {
        host: retrieval.rival.host,
        url: retrieval.rival.url,
        title: retrieval.rival.title,
        coverage: retrieval.rival.coverage,
      }
    : null;
  const schema = JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: questionOf(query.query),
          acceptedAnswer: {
            "@type": "Answer",
            text: `TODO: answer in 40-60 words, naming ${brand} and covering ${retrieval.missingTerms.join(", ") || "the question"}.`,
          },
        },
      ],
    },
    null,
    2,
  );
  const brief: Omit<Brief, "markdown"> = {
    id: query.id,
    query: query.query,
    type: query.type,
    kind: FANOUT_TYPE_LABEL[query.type],
    action,
    reason,
    target,
    title,
    mustCover: retrieval.missingTerms,
    alreadyHas: retrieval.matched,
    outline,
    rival,
    why: FANOUT_TYPE_WHY[query.type],
    schema,
  };
  return { ...brief, markdown: markdownOf(brief, retrieval.coverage) };
}

function markdownOf(brief: Omit<Brief, "markdown">, coverage: number) {
  const found =
    brief.reason === "lost" && brief.rival
      ? `A rival page is retrieved ahead of yours: ${brief.rival.url} carries ${pct(brief.rival.coverage)} of the query's words, yours ${pct(coverage)}.`
      : brief.reason === "missing"
        ? "None of your crawled pages carries enough of this query to be retrieved for it."
        : `Your best page carries ${pct(coverage)} of the query's words: retrievable, but thin.`;
  return [
    `## ${brief.action === "extend" ? "Extend" : "Write"}: ${brief.title}`,
    "",
    `**Sub-query:** ${brief.query} (${brief.kind.toLowerCase()})`,
    `**Page:** ${brief.target}`,
    `**Found:** ${found}`,
    "",
    brief.mustCover.length
      ? `**Must cover:** ${brief.mustCover.join(", ")}`
      : "**Must cover:** the query as asked, in the first paragraph.",
    ...(brief.alreadyHas.length
      ? [`**Already has:** ${brief.alreadyHas.join(", ")}`]
      : []),
    "",
    "### Outline",
    ...brief.outline.map((line) => `- ${line}`),
    "",
    "### Rules",
    "- Answer the sub-query in the first 40-60 words, naming the product.",
    "- One claim per paragraph, 40-80 words, each naming its subject.",
    "- Numbers over adjectives. Where a fact is unknown, leave a TODO: do not invent it.",
    "",
    "### FAQ markup",
    "```json",
    brief.schema,
    "```",
  ].join("\n");
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

/** Sentence case, no trailing question mark, kept inside a search title. */
function titleOf(query: string) {
  const text = query
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!]+$/, "");
  const cased = text.charAt(0).toUpperCase() + text.slice(1);
  return cased.length > 60
    ? `${cased.slice(0, 57).replace(/\s+\S*$/, "")}…`
    : cased;
}

function questionOf(query: string) {
  const text = query
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");
  const cased = text.charAt(0).toUpperCase() + text.slice(1);
  return cased.endsWith("?") ? cased : `${cased}?`;
}

export function slugOf(query: string) {
  // Every word stays: a path that drops "for" and "vs" reads as a typo, and
  // the stop-word list is for scoring, not for writing.
  const slug = query
    .toLowerCase()
    .replace(/\+/g, "-plus")
    .replace(/#/g, "-sharp")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Cut at a word boundary: a path ending in half a word reads as a typo.
  const short =
    slug.length > 60 ? slug.slice(0, 61).replace(/-[^-]*$/, "") : slug;
  return short || "page";
}

const OUTLINE: Record<FanoutType, (title: string, brand: string) => string[]> =
  {
    equivalent: (title, brand) => [
      `H1: ${title}`,
      `The answer in one paragraph: what ${brand} does for this, in the searcher's words`,
      "H2: How it works, as numbered steps",
      "H2: What it costs and what the limits are",
      "H2: Questions buyers ask (one H3 per question, answered first)",
    ],
    canonicalization: (title, brand) => [
      `H1: ${title}`,
      `The category's own name in the first sentence, and where ${brand} sits in it`,
      "H2: What the category is, defined in 40-60 words",
      `H2: How ${brand} fits the definition, and where it differs`,
      "H2: The terms buyers use for it, as a short glossary list",
    ],
    specification: (title, brand) => [
      `H1: ${title}`,
      `Who this is for, stated first: the segment, size, place or use case`,
      `H2: What ${brand} does for that case specifically`,
      "H2: A worked example with real numbers",
      "H2: Requirements and limits for this case",
    ],
    generalization: (title, brand) => [
      `H1: ${title}`,
      "The broad answer first, without a sales pitch",
      "H2: The options, as a table: approach, best for, trade-off",
      `H2: Where ${brand} fits among them`,
      "H2: How to choose, as a checklist",
    ],
    comparison: (title, brand) => [
      `H1: ${title}`,
      `The verdict in one paragraph: when to choose ${brand} and when not to`,
      "H2: Side by side, as a table: price, limits, integrations, support",
      `H2: Where ${brand} is stronger, with evidence`,
      "H2: Where the alternative is stronger, stated honestly",
      "H2: How to switch",
    ],
    follow_up: (title, brand) => [
      `H1: ${title}`,
      "The direct answer to the follow-up, in the first paragraph",
      `H2: What happens after you start with ${brand}`,
      "H2: The objection this answers, and the evidence",
      "H2: Related questions (one H3 each)",
    ],
    entailment: (title, brand) => [
      `H1: ${title}`,
      `The fact the question assumes, stated plainly about ${brand}, with a source`,
      "H2: The evidence: numbers, dates, certifications, customers you can name",
      "H2: Where this is documented (link the primary source)",
    ],
  };
