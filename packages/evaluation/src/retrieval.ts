/**
 * Retrieval: the crawler used as a search engine.
 *
 * An answer engine fans a question out into sub-queries and then *retrieves*
 * for each one. Measuring only whether you were named in the finished answer
 * skips the step that decided it. This runs the retrieval step ourselves, over
 * the pages our own crawler fetched, and answers the question that actually
 * tells an operator what to do:
 *
 *   for this sub-query, which of your pages would be retrieved, and is it
 *   good enough — or do you simply not have a page about this?
 *
 * It is BM25 over the crawl, with no model in the loop, so the same crawl and
 * the same sub-query always give the same answer. The verdict is term
 * coverage rather than the raw score, because "your best page misses the words
 * 'alternatives' and 'migration'" is a thing you can go and fix, and "score
 * 7.3" is not.
 */

export type IndexedPage = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
};

type Doc = {
  url: string;
  title: string;
  /** Term frequencies over the weighted field text. */
  freq: Map<string, number>;
  length: number;
  /** Raw text, kept for the snippet. */
  body: string;
};

export type RetrievalIndex = {
  docs: Doc[];
  averageLength: number;
  /** Inverse document frequency per term. */
  idf: Map<string, number>;
  pages: number;
};

export type Retrieved = {
  /** Whether a page of yours is good enough to be the one retrieved. */
  status: "answered" | "weak" | "missing";
  url: string;
  title: string;
  /** BM25, kept for ordering and for the record. Never shown as a verdict. */
  score: number;
  /** Share of the sub-query's meaningful terms the best page carries, 0-1. */
  coverage: number;
  matched: string[];
  /** The words the best page does not have. This is the thing to go and fix. */
  missingTerms: string[];
  /** The passage that matched, for the evidence trail. */
  snippet: string;
};

/** Words too common to tell two pages apart. */
const STOP = new Set(
  (
    "a an and are as at be but by for from has have how i in is it its of on or " +
    "that the their there these they this to was what when where which who why " +
    "will with you your our we us can do does not into over under about more " +
    "most best top good great new other any all some each per via use using " +
    "used need needs want like get got make made take should would could"
  ).split(" "),
);

export function tokenise(value: string): string[] {
  return (
    (value.toLowerCase().match(/[a-z0-9][a-z0-9'+.#-]*/g) ?? [])
      // Only sentence punctuation comes off the ends. A trailing + or # is part
      // of the word in this market: c++, c#, and node.js are category names, and
      // stripping them collapses three categories into one.
      .map((token) => token.replace(/^['.-]+|['.-]+$/g, ""))
      .filter((token) => token.length >= 2 && !STOP.has(token))
  );
}

/**
 * Field weighting by repetition: a term in the title counts three times, in a
 * heading or the description twice. Crude next to a real scorer, and exactly
 * as explainable, which matters more here.
 */
function fieldText(page: IndexedPage) {
  return [
    page.title,
    page.title,
    page.title,
    page.description,
    page.description,
    page.headings.join(" "),
    page.headings.join(" "),
    page.text,
  ].join(" ");
}

export function buildIndex(pages: IndexedPage[]): RetrievalIndex {
  const docs: Doc[] = pages.map((page) => {
    const tokens = tokenise(fieldText(page));
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    return {
      url: page.url,
      title: page.title,
      freq,
      length: tokens.length,
      body: `${page.title}. ${page.description} ${page.headings.join(". ")}. ${page.text}`,
    };
  });
  const averageLength = docs.length
    ? docs.reduce((total, doc) => total + doc.length, 0) / docs.length
    : 0;
  const idf = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const doc of docs)
    for (const term of doc.freq.keys())
      seen.set(term, (seen.get(term) ?? 0) + 1);
  for (const [term, count] of seen)
    // Okapi IDF, floored so a term in every document still contributes a little
    // rather than going negative and rewarding pages for not matching.
    idf.set(
      term,
      Math.max(0.05, Math.log((docs.length - count + 0.5) / (count + 0.5) + 1)),
    );
  return { docs, averageLength, idf, pages: docs.length };
}

const K1 = 1.5;
const B = 0.75;
/** Above this share of the sub-query's terms, a page can carry the answer. */
const ANSWERED = 0.75;
/** Below this, the page is about something else. */
const WEAK = 0.4;

export function retrieve(index: RetrievalIndex, query: string): Retrieved {
  const terms = [...new Set(tokenise(query))];
  const empty: Retrieved = {
    status: "missing",
    url: "",
    title: "",
    score: 0,
    coverage: 0,
    matched: [],
    missingTerms: terms,
    snippet: "",
  };
  if (!terms.length || !index.docs.length) return empty;

  let best: { doc: Doc; score: number } | null = null;
  for (const doc of index.docs) {
    let score = 0;
    for (const term of terms) {
      const frequency = doc.freq.get(term);
      if (!frequency) continue;
      const idf = index.idf.get(term) ?? 0.05;
      const norm =
        (frequency * (K1 + 1)) /
        (frequency +
          K1 * (1 - B + (B * doc.length) / (index.averageLength || 1)));
      score += idf * norm;
    }
    if (score > 0 && (!best || score > best.score)) best = { doc, score };
  }
  if (!best) return empty;

  const matched = terms.filter((term) => best!.doc.freq.has(term));
  const coverage = matched.length / terms.length;
  return {
    status:
      coverage >= ANSWERED ? "answered" : coverage >= WEAK ? "weak" : "missing",
    url: best.doc.url,
    title: best.doc.title,
    score: Math.round(best.score * 100) / 100,
    coverage: Math.round(coverage * 100) / 100,
    matched,
    missingTerms: terms.filter((term) => !best!.doc.freq.has(term)),
    snippet: snippetFor(best.doc.body, matched),
  };
}

/**
 * The window of the page that carries the most of the query's terms. This is
 * the passage an engine would lift, so it is the passage to show.
 */
export function snippetFor(body: string, terms: string[], width = 240): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text || !terms.length) return text.slice(0, width);
  const lower = text.toLowerCase();
  let bestStart = 0;
  let bestHits = -1;
  // Step through in half-windows: fine enough to find the dense passage, cheap
  // enough to run for every sub-query on every page.
  for (let start = 0; start < lower.length; start += Math.floor(width / 2)) {
    const window = lower.slice(start, start + width);
    const hits = terms.filter((term) => window.includes(term)).length;
    if (hits > bestHits) {
      bestHits = hits;
      bestStart = start;
    }
    if (hits === terms.length) break;
  }
  const head = bestStart > 0 ? "…" : "";
  const slice = text.slice(bestStart, bestStart + width);
  const tail = bestStart + width < text.length ? "…" : "";
  return `${head}${slice.trim()}${tail}`;
}
