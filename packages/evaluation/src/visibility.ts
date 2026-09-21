import type {
  Engine,
  PromptResult,
  Source,
  Visibility,
} from "@spectra/schemas";

export type BrandMatcher = { brand: string; aliases: string[]; host: string };

const compact = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

function needles({ brand, aliases, host }: BrandMatcher) {
  const stem = host.replace(/^www\./, "").split(".")[0];
  return [...new Set([brand, ...aliases, stem, host].map(compact))].filter(
    (value) => value.length >= 4,
  );
}

/** Platforms answers cite or mention that are not competing vendors. */
const PLATFORMS = new Set(
  [
    "G2",
    "Capterra",
    "Gartner",
    "Forrester",
    "TrustRadius",
    "Trustpilot",
    "GetApp",
    "Software Advice",
    "Clutch",
    "Reddit",
    "Quora",
    "LinkedIn",
    "Wikipedia",
    "Forbes",
    "Google",
    "YouTube",
    "Crunchbase",
    "Glassdoor",
    "Yelp",
  ].map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")),
);
export function isPlatform(name: string) {
  return PLATFORMS.has(compact(name));
}

/** True when the answer names the brand, however it is spaced or cased. */
export function mentions(text: string, matcher: BrandMatcher) {
  const haystack = compact(text);
  return needles(matcher).some((needle) => haystack.includes(needle));
}

// Phrases that disown the company as a whole. "No pricing information" is a
// gap in what it knows, not a failure to recognise the brand.
const UNKNOWN =
  /(don't|do not|couldn't|could not|can't|cannot|was unable to|am unable to)\s+(have|find|locate|identify)\s+(any\s+)?(specific\s+|reliable\s+|credible\s+)?(information|details|records?)\s+(about|on)\s+(a\s+|the\s+)?(company|business|brand|organi[sz]ation|firm|entity)|not (familiar|aware) with (a |the )?(company|business|brand|organi[sz]ation)|no (reliable |credible )?(information|record) (exists )?(about|on) (a |the )?(company|business)/i;

/** A branded answer that names you only to say it knows nothing does not count. */
export function recognises(text: string, matcher: BrandMatcher) {
  if (!mentions(text, matcher) || UNKNOWN.test(text)) return false;
  const name = matcher.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const disowned = new RegExp(
    `(don't|do not|couldn't|could not|can't|cannot|unable to|no)[^.]{0,40}(information|details|record)s?\\s+(about|on)\\s+["“]?${name}\\b(?!['’]s)`,
    "i",
  );
  return !disowned.test(text);
}

/**
 * The brand's rank among the items of the first list that contains it. Read
 * from the answer's own structure, so it is reproducible from the saved text.
 */
export function listPosition(
  text: string,
  matcher: BrandMatcher,
): number | null {
  let rank = 0;
  for (const line of text.split(/\r?\n/)) {
    // Top-level numbered or bulleted items, or "### 2. Name" style headings.
    if (/^\s{2,}/.test(line)) continue;
    const entry =
      line.match(/^(?:\d+[.)]|[-*•])\s+(.*)$/)?.[1] ??
      line.match(/^#{2,4}\s+(?:\d+[.)]\s*)?(.*)$/)?.[1];
    if (entry === undefined) continue;
    rank += 1;
    // Judge the item by its name, not by a description that mentions you.
    const head = entry.split(/:|–|—|\s-\s/)[0];
    if (mentions(head, matcher)) return rank;
  }
  return null;
}

export function domainOf(source: { uri: string; title?: string }) {
  const title = (source.title ?? "").trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(title))
    return title.replace(/^www\./, "");
  try {
    return new URL(source.uri).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isOwnDomain(domain: string, host: string) {
  const own = host.replace(/^www\./, "");
  return domain === own || domain.endsWith(`.${own}`);
}

export function normaliseSources(
  sources: Array<{ uri: string; title?: string }>,
): Source[] {
  return sources.map((source) => ({
    uri: source.uri,
    title: source.title ?? "",
    domain: domainOf(source),
  }));
}

/** Rolls prompt results up into the numbers the report leads with. */
export function summariseVisibility(
  prompts: PromptResult[],
  matcher: BrandMatcher,
  engine: Engine,
  engineNote: string,
): Visibility {
  const ok = prompts.filter((p) => p.status === "ok");
  const unbranded = ok.filter((p) => p.kind !== "branded");
  const branded = ok.filter((p) => p.kind === "branded");
  const grounded = ok.filter((p) => p.engine === "gemini_search");
  const unbrandedMentions = unbranded.filter((p) => p.mentioned).length;
  const brandedKnown = branded.filter((p) => p.mentioned).length;
  const citations = grounded.filter((p) => p.cited).length;
  const positions = ok
    .map((p) => p.position)
    .filter((p): p is number => p !== null);

  const parts = [
    { weight: 0.6, measured: unbranded.length, hits: unbrandedMentions },
    { weight: 0.2, measured: branded.length, hits: brandedKnown },
    { weight: 0.2, measured: grounded.length, hits: citations },
  ].filter((part) => part.measured > 0);
  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = totalWeight
    ? Math.round(
        (parts.reduce((a, p) => a + p.weight * (p.hits / p.measured), 0) /
          totalWeight) *
          100,
      )
    : null;

  const counts = new Map<string, { name: string; mentions: number }>();
  for (const prompt of unbranded)
    for (const name of new Set(
      prompt.competitors.map((c) => c.trim()).filter(Boolean),
    )) {
      if (mentions(name, matcher) || isPlatform(name)) continue;
      const key = compact(name);
      const entry = counts.get(key) ?? { name, mentions: 0 };
      entry.mentions += 1;
      counts.set(key, entry);
    }
  // The brand is always in the chart: being absent from it is the finding.
  const shareOfVoice = [
    { name: matcher.brand, mentions: unbrandedMentions, brand: true },
    ...[...counts.values()]
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 8)
      .map((entry) => ({ ...entry, brand: false })),
  ].sort(
    (a, b) => b.mentions - a.mentions || Number(b.brand) - Number(a.brand),
  );

  const domains = new Map<string, number>();
  for (const prompt of grounded)
    for (const domain of new Set(
      prompt.sources.map((s) => s.domain).filter(Boolean),
    ))
      domains.set(domain, (domains.get(domain) ?? 0) + 1);
  const citedDomains = [...domains.entries()]
    .map(([domain, count]) => ({
      domain,
      count,
      own: isOwnDomain(domain, matcher.host),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    score,
    engine,
    engineNote,
    prompts,
    measured: ok.length,
    mentions: ok.filter((p) => p.mentioned).length,
    categoryMeasured: unbranded.length,
    categoryMentions: unbrandedMentions,
    citations,
    groundedMeasured: grounded.length,
    averagePosition: positions.length
      ? Math.round(
          (positions.reduce((a, b) => a + b, 0) / positions.length) * 10,
        ) / 10
      : null,
    shareOfVoice,
    citedDomains,
  };
}
