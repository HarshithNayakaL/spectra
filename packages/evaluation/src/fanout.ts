import type {
  Engine,
  Fanout,
  FanoutQuery,
  FanoutType,
  Source,
} from "@spectra/schemas";
import {
  isOwnDomain,
  isPlatform,
  mentions,
  type BrandMatcher,
} from "./visibility";

/**
 * The fan-out measurement.
 *
 * An answer engine does not search the question it was asked. It expands the
 * question into synthetic sub-queries, runs those against its search tool,
 * reads what comes back and writes one answer from it. So "do we rank for this
 * question" is the wrong question: what matters is how many of the sub-queries
 * an expansion produces can reach you at all, and which kinds lose.
 *
 * Nothing here is an opinion. Every number counts sub-answers that were
 * actually returned.
 */

/** The order the report shows the kinds in: nearest the question first. */
export const FANOUT_TYPES: FanoutType[] = [
  "equivalent",
  "canonicalization",
  "specification",
  "generalization",
  "comparison",
  "follow_up",
  "entailment",
];

export const FANOUT_TYPE_LABEL: Record<FanoutType, string> = {
  equivalent: "Same question, other words",
  canonicalization: "The category's real name",
  specification: "A narrower cut",
  generalization: "The broader question",
  comparison: "Versus and alternatives",
  follow_up: "What they ask next",
  entailment: "What the question assumes",
};

export const FANOUT_TYPE_WHY: Record<FanoutType, string> = {
  equivalent:
    "The engine rephrases before it searches. Losing this means your page only matches one wording of the thing you sell.",
  canonicalization:
    "The engine normalises to the industry's own term. Losing this means you describe yourself in words the market does not use.",
  specification:
    "Most buying questions arrive narrowed, by segment, size, place or use case. Losing these is losing the buyers who know what they want.",
  generalization:
    "The broad question is where the engine builds its shortlist. Absent here, you are not a candidate at all.",
  comparison:
    "Comparison and alternatives sub-queries are where a shortlist becomes a choice, and where review sites answer for you if you do not.",
  follow_up:
    "The engine keeps reading after the first answer. Losing the follow-ups means your answer stops before the objection does.",
  entailment:
    "The engine verifies what the question took for granted. Losing this means a fact about you cannot be confirmed, so it is left out.",
};

/**
 * Rolls sub-answers up into the fan-out picture. `issued` is every query the
 * search tool actually typed across the whole audit, which is the engine's own
 * expansion rather than ours.
 */
export function summariseFanout(input: {
  seed: string;
  queries: FanoutQuery[];
  matcher: BrandMatcher;
  engine: Engine;
  engineNote: string;
  issued: string[];
  /** Pages our crawler indexed to run the retrieval step itself. */
  indexedPages: number;
}): Fanout {
  const { queries, matcher } = input;
  const ok = queries.filter((query) => query.status === "ok");
  const reached = ok.filter((query) => query.mentioned || query.cited);
  const retrieved = queries.flatMap((query) =>
    query.retrieval ? [query.retrieval] : [],
  );
  const counts = new Map<string, { count: number; own: boolean }>();
  for (const query of ok)
    for (const domain of new Set(
      query.sources.map((source) => source.domain).filter(Boolean),
    )) {
      const row = counts.get(domain) ?? {
        count: 0,
        own: isOwnDomain(domain, matcher.host),
      };
      row.count += 1;
      counts.set(domain, row);
    }

  return {
    seed: input.seed,
    engine: input.engine,
    engineNote: input.engineNote,
    queries,
    measured: ok.length,
    mentions: ok.filter((query) => query.mentioned).length,
    cited: ok.filter((query) => query.cited).length,
    coverage: ok.length ? Math.round((reached.length / ok.length) * 100) : null,
    byType: FANOUT_TYPES.flatMap((type) => {
      const rows = ok.filter((query) => query.type === type);
      if (!rows.length) return [];
      return [
        {
          type,
          measured: rows.length,
          hits: rows.filter((query) => query.mentioned || query.cited).length,
        },
      ];
    }),
    byTypeAnswerable: FANOUT_TYPES.flatMap((type) => {
      const rows = queries.filter(
        (query) => query.type === type && query.retrieval,
      );
      if (!rows.length) return [];
      return [
        {
          type,
          measured: rows.length,
          hits: rows.filter((query) => query.retrieval!.status === "answered")
            .length,
        },
      ];
    }),
    answeredBy: [...counts.entries()]
      .map(([domain, row]) => ({ domain, ...row }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
      .slice(0, 12),
    // De-duplicated, case-insensitively: the same expansion recurs across
    // sub-queries and the list is meant to be read, not counted twice.
    issued: dedupe(tidy(input.issued)),
    // Answerability is measured over every sub-query, answered or not: our own
    // retrieval runs whether or not a live search was available, so this half
    // of the fan-out survives a dead grounding quota.
    indexedPages: input.indexedPages,
    answerable: retrieved.filter((row) => row.status === "answered").length,
    weak: retrieved.filter((row) => row.status === "weak").length,
    answerableCoverage: retrieved.length
      ? Math.round(
          (retrieved.filter((row) => row.status === "answered").length /
            retrieved.length) *
            100,
        )
      : null,
  };
}

function tidy(values: string[]) {
  return values
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Competitor names, cleaned the same way the prompt results are. */
export function fanoutCompetitors(names: string[], matcher: BrandMatcher) {
  return names
    .filter((name) => !mentions(name, matcher) && !isPlatform(name))
    .slice(0, 8);
}

/** True when any returned source is on the brand's own domain. */
export function citedOwnDomain(sources: Source[], host: string) {
  return sources.some((source) => isOwnDomain(source.domain, host));
}
