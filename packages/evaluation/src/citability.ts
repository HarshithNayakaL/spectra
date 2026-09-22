import type { Audit, PageSignals } from "@spectra/schemas";

/**
 * Citability: can an answer engine lift a passage from this page and quote it?
 *
 * Retrieval decides whether a page is fetched. What happens next is passage
 * selection: the engine takes a few sentences that stand on their own, carry a
 * specific claim, and answer something. A page can be retrieved every time and
 * still never be quoted, because every paragraph starts with "This" and none of
 * them says anything checkable.
 *
 * Every point here is counted from the raw HTML the crawler read. There is no
 * model in it, so the same page always scores the same, and each point names
 * the thing on the page that earned or lost it.
 */

export type CitabilityCheck = {
  id:
    | "lead"
    | "passages"
    | "facts"
    | "structure"
    | "questions"
    | "provenance"
    | "schema";
  label: string;
  earned: number;
  possible: number;
  /** What was found, in the reader's words. */
  detail: string;
};

export type PageCitability = {
  url: string;
  /** Null when the page was scanned before its structure was read. */
  score: number | null;
  checks: CitabilityCheck[];
  /** The passage an engine is most likely to quote, as it stands today. */
  best: string;
  /** Liftable passages out of all paragraphs read. */
  liftable: number;
  paragraphs: number;
  /** The single change that would earn this page the most points. */
  next: string;
};

export type Citability = {
  /** Mean over the pages that could be scored, null when none could. */
  score: number | null;
  pages: PageCitability[];
  /** Pages that could not be scored, with the reason. */
  unmeasured: Array<{ url: string; reason: string }>;
};

/** Words a passage can open with and still stand on its own. */
const DANGLING =
  /^(this|that|these|those|it|its|they|them|their|he|she|here|there|also|and|but|so|which|such|as a result|in addition|moreover|however)\b/i;

/** "X is a ...", "X helps ...": the shape an engine quotes as a definition. */
const DEFINES =
  /\b(is|are|was|helps|lets|gives|provides|offers|makes|enables|allows|turns|builds|runs|measures)\b/i;

/** Numbers, money, percentages, years and units: things a reader can check. */
const FACT =
  /(\b\d{4}\b|\b\d+(?:[.,]\d+)?\s?(%|percent|x\b|ms\b|k\b|m\b|bn\b|million|billion|hours?|days?|minutes?|seconds?|users|customers|clients|seats|employees|teams|countries|languages|integrations)|[$€£₹]\s?\d)/gi;

const MIN_LIFT = 25;
const MAX_LIFT = 120;

function wordCount(text: string) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** A passage is liftable when it is quote-sized and does not lean on context. */
export function isLiftable(passage: string) {
  const words = wordCount(passage);
  return words >= MIN_LIFT && words <= MAX_LIFT && !DANGLING.test(passage);
}

function factsIn(text: string) {
  return (text.match(FACT) ?? []).length;
}

export function scorePage(page: PageSignals): PageCitability {
  const base = { url: page.url, best: "", liftable: 0, paragraphs: 0 };
  if (!page.structureRead)
    return {
      ...base,
      score: null,
      checks: [],
      next: "Re-run the audit: this page was scanned before passages were read.",
    };

  const passages = page.passages;
  const liftable = passages.filter(isLiftable);
  const leadWords = wordCount(page.lead);
  const leadDefines =
    leadWords >= 12 &&
    leadWords <= 90 &&
    !DANGLING.test(page.lead) &&
    DEFINES.test(page.lead.split(/[.!?]/)[0] ?? "");
  const facts = factsIn(page.excerpt);
  const structure = page.lists + page.tables;

  const checks: CitabilityCheck[] = [
    {
      id: "lead",
      label: "Answer first",
      possible: 20,
      earned: leadDefines ? 20 : leadWords >= 12 ? 8 : 0,
      detail: leadDefines
        ? "The first paragraph says what this is in one quotable sentence."
        : leadWords
          ? leadWords > 90
            ? `The first paragraph runs ${leadWords} words before it lands. Engines quote the first 40-60.`
            : "The first paragraph does not open with a definition an engine could quote."
          : "There is no opening paragraph in the HTML, only headings, links or script.",
    },
    {
      id: "passages",
      label: "Liftable passages",
      possible: 20,
      earned: Math.min(20, liftable.length * 5),
      detail: passages.length
        ? `${liftable.length} of ${passages.length} paragraphs are quote-sized (${MIN_LIFT}-${MAX_LIFT} words) and stand on their own.`
        : "No paragraphs were found in the main content.",
    },
    {
      id: "facts",
      label: "Specific facts",
      possible: 15,
      earned: facts >= 6 ? 15 : facts >= 3 ? 10 : facts ? 5 : 0,
      detail: facts
        ? `${facts} numbers, prices, dates or measures an engine can repeat and a reader can check.`
        : "No numbers, prices, dates or measures. Vague claims are paraphrased or dropped, not quoted.",
    },
    {
      id: "structure",
      label: "Lists and tables",
      possible: 15,
      earned: page.tables ? 15 : page.lists >= 2 ? 12 : page.lists ? 8 : 0,
      detail: structure
        ? `${page.lists} list${page.lists === 1 ? "" : "s"} and ${page.tables} table${page.tables === 1 ? "" : "s"} in the main content: steps and comparisons engines extract whole.`
        : "No lists or tables. Steps, options and comparisons written as prose are harder to extract.",
    },
    {
      id: "questions",
      label: "Question headings",
      possible: 10,
      earned: page.questionHeadings >= 2 ? 10 : page.questionHeadings ? 6 : 0,
      detail: page.questionHeadings
        ? `${page.questionHeadings} heading${page.questionHeadings === 1 ? " is" : "s are"} phrased as the question a buyer types.`
        : "No heading is phrased as a question, so no passage is marked as the answer to one.",
    },
    {
      id: "provenance",
      label: "Date and author",
      possible: 10,
      earned: (page.hasDate ? 5 : 0) + (page.hasAuthor ? 5 : 0),
      detail:
        page.hasDate && page.hasAuthor
          ? "Dated and attributed, so the claim can be weighed as current."
          : page.hasDate
            ? "Dated, but no author is marked."
            : page.hasAuthor
              ? "Attributed, but no date is marked, so freshness cannot be judged."
              : "Neither a date nor an author is marked in the HTML.",
    },
    {
      id: "schema",
      label: "Structured data",
      possible: 10,
      earned: page.jsonLdTypes.length ? 10 : 0,
      detail: page.jsonLdTypes.length
        ? `Declares ${page.jsonLdTypes.slice(0, 3).join(", ")}.`
        : "No JSON-LD, so nothing on the page is machine-labelled.",
    },
  ];

  // A page that ships no text has nothing to lift, whatever its markup says.
  const score = page.appShell
    ? 0
    : checks.reduce((total, check) => total + check.earned, 0);
  const worst = [...checks].sort(
    (a, b) => b.possible - b.earned - (a.possible - a.earned),
  )[0];
  const best =
    [...liftable].sort((a, b) => factsIn(b) - factsIn(a))[0] ??
    passages[0] ??
    "";

  return {
    url: page.url,
    score,
    checks,
    best,
    liftable: liftable.length,
    paragraphs: passages.length,
    next: page.appShell
      ? "Render the page's text into the HTML. AI crawlers do not run JavaScript, so today there is nothing to quote."
      : worst && worst.earned < worst.possible
        ? NEXT[worst.id]
        : "Nothing to add: keep new pages to this shape.",
  };
}

const NEXT: Record<CitabilityCheck["id"], string> = {
  lead: "Open with one sentence that says what this is and who it is for, in under 60 words.",
  passages:
    "Break long paragraphs into 40-80 word ones that name their subject instead of starting with “this” or “it”.",
  facts:
    "Replace adjectives with numbers: prices, limits, timings, counts, dates.",
  structure:
    "Put steps, plans and comparisons in a list or a table rather than prose.",
  questions:
    "Rename the main sections as the questions buyers ask, and answer each in the first sentence below it.",
  provenance:
    "Mark the author and the last-updated date, in the page and in the JSON-LD.",
  schema: "Add JSON-LD that labels what the page is.",
};

/** Citability for every page the crawler read, worst first. */
export function buildCitability(audit: Audit): Citability | null {
  const pages = audit.scan?.pages ?? [];
  if (!pages.length) return null;
  const scored: PageCitability[] = [];
  const unmeasured: Citability["unmeasured"] = [];
  for (const page of pages) {
    const row = scorePage(page);
    if (row.score === null)
      unmeasured.push({ url: page.url, reason: row.next });
    else scored.push(row);
  }
  scored.sort((a, b) => a.score! - b.score! || a.url.localeCompare(b.url));
  return {
    score: scored.length
      ? Math.round(
          scored.reduce((total, row) => total + row.score!, 0) / scored.length,
        )
      : null,
    pages: scored,
    unmeasured,
  };
}
