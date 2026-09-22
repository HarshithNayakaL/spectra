import { z } from "zod";

export const SCHEMA_VERSION = "spectra-v2" as const;

/**
 * Everything the scanner observed about one page, taken from the raw HTML the
 * server sent. AI crawlers do not run JavaScript, so this is what they get.
 */
export const pageSignalsSchema = z.object({
  url: z.string().url(),
  status: z.number().int(),
  ms: z.number(),
  bytes: z.number(),
  title: z.string().default(""),
  description: z.string().default(""),
  h1: z.array(z.string()).default([]),
  headings: z
    .array(z.object({ level: z.number().int(), text: z.string() }))
    .default([]),
  words: z.number().int().default(0),
  lang: z.string().default(""),
  canonical: z.string().default(""),
  metaRobots: z.string().default(""),
  xRobotsTag: z.string().default(""),
  jsonLdTypes: z.array(z.string()).default([]),
  jsonLd: z.array(z.unknown()).default([]),
  jsonLdErrors: z.number().int().default(0),
  openGraph: z.record(z.string(), z.string()).default({}),
  images: z.number().int().default(0),
  imagesWithAlt: z.number().int().default(0),
  scripts: z.number().int().default(0),
  appShell: z.boolean().default(false),
  questionHeadings: z.number().int().default(0),
  hasDate: z.boolean().default(false),
  hasAuthor: z.boolean().default(false),
  socialLinks: z.array(z.string()).default([]),
  internalLinks: z.array(z.string()).default([]),
  excerpt: z.string().default(""),
  /**
   * False on pages scanned before the structure below was read, so the report
   * can say "not measured" instead of scoring an old scan as empty.
   */
  structureRead: z.boolean().default(false),
  /** The first real paragraph of the main content: what an engine quotes. */
  lead: z.string().default(""),
  /** Paragraphs of the main content, in order, for passage-level scoring. */
  passages: z.array(z.string()).default([]),
  /** Lists with two or more items, and tables with two or more rows. */
  lists: z.number().int().default(0),
  tables: z.number().int().default(0),
  /** Elements marked data-nosnippet, whose text engines must not quote. */
  nosnippetBlocks: z.number().int().default(0),
});

export const fileProbeSchema = z.object({
  url: z.string(),
  status: z.number().int().nullable(),
  bytes: z.number().int().default(0),
  contentType: z.string().default(""),
  body: z.string().default(""),
});

export const botProbeSchema = z.object({
  agent: z.string(),
  status: z.number().int().nullable(),
  blocked: z.boolean(),
  note: z.string().default(""),
});

export const scanSchema = z.object({
  target: z.string().url(),
  finalUrl: z.string().url(),
  https: z.boolean(),
  robots: fileProbeSchema,
  sitemap: fileProbeSchema.extend({
    urls: z.number().int().default(0),
    referenced: z.boolean().default(false),
  }),
  llmsTxt: fileProbeSchema,
  llmsFullTxt: fileProbeSchema,
  bots: z.array(botProbeSchema).default([]),
  pages: z.array(pageSignalsSchema),
  failures: z
    .array(z.object({ url: z.string(), error: z.string() }))
    .default([]),
  durationMs: z.number().default(0),
});

export const layerIdSchema = z.enum(["access", "content", "entity", "agent"]);
export const checkStatusSchema = z.enum(["pass", "warn", "fail", "na"]);

export const fixSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
  /** A ready-to-paste artifact: robots rules, JSON-LD, an llms.txt, markup. */
  code: z.string().optional(),
  language: z.string().optional(),
  file: z.string().optional(),
});

export const checkSchema = z.object({
  id: z.string(),
  layer: layerIdSchema,
  label: z.string(),
  status: checkStatusSchema,
  weight: z.number().positive(),
  earned: z.number().min(0),
  /** What was actually observed, in plain words. */
  found: z.string(),
  /** Why an answer engine cares. */
  why: z.string(),
  urls: z.array(z.string()).default([]),
  fix: fixSchema.nullable().default(null),
});

export const layerSchema = z.object({
  id: layerIdSchema,
  label: z.string(),
  question: z.string(),
  earned: z.number(),
  possible: z.number(),
  score: z.number().nullable(),
});

export const readinessSchema = z.object({
  score: z.number().min(0).max(100),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  layers: z.array(layerSchema),
  checks: z.array(checkSchema),
});

export const profileSchema = z.object({
  brand: z.string(),
  aliases: z.array(z.string()).default([]),
  category: z.string(),
  description: z.string(),
  audience: z.string().default(""),
  market: z.string().default(""),
  facts: z.array(z.string()).default([]),
});

export const sourceSchema = z.object({
  uri: z.string(),
  title: z.string().default(""),
  domain: z.string().default(""),
});

export const promptKindSchema = z.enum(["custom", "category", "branded"]);
export const engineSchema = z.enum(["gemini_search", "gemini_model"]);

export const promptResultSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: promptKindSchema,
  engine: engineSchema,
  status: z.enum(["ok", "error", "skipped"]),
  answer: z.string().default(""),
  mentioned: z.boolean().default(false),
  /** 1-based rank among the brands the answer recommends, when it lists any. */
  position: z.number().int().positive().nullable().default(null),
  cited: z.boolean().default(false),
  competitors: z.array(z.string()).default([]),
  sentiment: z
    .enum(["positive", "neutral", "negative"])
    .nullable()
    .default(null),
  inaccuracies: z.array(z.string()).default([]),
  sources: z.array(sourceSchema).default([]),
  /**
   * The queries the model's search tool actually typed, which are not the
   * question we asked: an answer engine fans one question out into several.
   */
  issuedQueries: z.array(z.string()).default([]),
  error: z.string().optional(),
  durationMs: z.number().default(0),
});

export const visibilitySchema = z.object({
  score: z.number().min(0).max(100).nullable(),
  engine: engineSchema,
  engineNote: z.string().default(""),
  prompts: z.array(promptResultSchema),
  measured: z.number().int(),
  mentions: z.number().int(),
  categoryMeasured: z.number().int(),
  categoryMentions: z.number().int(),
  citations: z.number().int(),
  groundedMeasured: z.number().int(),
  averagePosition: z.number().nullable(),
  shareOfVoice: z.array(
    z.object({
      name: z.string(),
      mentions: z.number().int(),
      brand: z.boolean(),
    }),
  ),
  citedDomains: z.array(
    z.object({
      domain: z.string(),
      count: z.number().int(),
      own: z.boolean(),
    }),
  ),
});

/* ============================================================ fan-out

   An answer engine does not run your question. It decomposes it into several
   synthetic sub-queries, fires them at its search tool in parallel, reads what
   comes back and synthesises one answer. Google calls the expansions "themes";
   the industry calls the mechanism query fan-out.

   Ranking for the question is therefore not the measurement. Being retrievable
   for the sub-queries is. This records the fan-out: what was asked on your
   behalf, what the search tool returned for each one, and which of those you
   were in.
   ============================================================ */

/**
 * The kinds of sub-query an expansion produces, named after the classes in
 * Google's thematic-search work rather than invented here.
 */
export const fanoutTypeSchema = z.enum([
  /** The same question in different words. */
  "equivalent",
  /** The question a reader asks next. */
  "follow_up",
  /** A broader version of the question. */
  "generalization",
  /** A narrower, more specific version. */
  "specification",
  /** The standard way the category is named. */
  "canonicalization",
  /** Something the question implies without saying. */
  "entailment",
  /** A head-to-head or alternatives question. */
  "comparison",
]);

/**
 * What our own crawler retrieves for a sub-query, over the pages it fetched.
 * This is the retrieval step run ourselves, so it holds whether or not a live
 * search was available.
 */
/** A rival site the crawler fetched, so retrieval has something to compare to. */
export const rivalSiteSchema = z.object({
  name: z.string(),
  host: z.string(),
  /** Pages we could read. Zero means the site refused or did not resolve. */
  pages: z.number().int().default(0),
  note: z.string().default(""),
});

/** The best page on one host for one sub-query. */
export const retrievalHitSchema = z.object({
  host: z.string().default(""),
  url: z.string().default(""),
  title: z.string().default(""),
  coverage: z.number().min(0).max(1).default(0),
  score: z.number().default(0),
});

export const retrievalSchema = z.object({
  status: z.enum(["answered", "weak", "missing"]),
  /** The page of yours that would be retrieved, when one would be. */
  url: z.string().default(""),
  title: z.string().default(""),
  /** BM25. Kept for the record and for ordering, never shown as a verdict. */
  score: z.number().default(0),
  /** Share of the sub-query's meaningful terms that page carries, 0-1. */
  coverage: z.number().min(0).max(1).default(0),
  matched: z.array(z.string()).default([]),
  /** The words your best page does not have. The thing to go and write. */
  missingTerms: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  /**
   * The rival page that would be retrieved for the same sub-query, when rival
   * sites were crawled. Null when there were none to compare against.
   */
  rival: retrievalHitSchema.nullable().default(null),
  /** True when a rival's page scores above yours for this sub-query. */
  lost: z.boolean().default(false),
});

export const fanoutQuerySchema = z.object({
  id: z.string(),
  type: fanoutTypeSchema,
  /** The sub-query, exactly as it was sent. */
  query: z.string(),
  /** Which buyer intent this sub-query stands for. */
  covers: z.string().default(""),
  status: z.enum(["ok", "error", "skipped"]),
  answer: z.string().default(""),
  mentioned: z.boolean().default(false),
  /** 1-based rank among the brands the sub-answer recommends. */
  position: z.number().int().positive().nullable().default(null),
  cited: z.boolean().default(false),
  competitors: z.array(z.string()).default([]),
  sources: z.array(sourceSchema).default([]),
  /** What the search tool typed for this sub-query. */
  issuedQueries: z.array(z.string()).default([]),
  /** Our own retrieval over the crawl. Null only on an audit that predates it. */
  retrieval: retrievalSchema.nullable().default(null),
  error: z.string().default(""),
  durationMs: z.number().default(0),
});

export const fanoutSchema = z.object({
  /** The question that was expanded. */
  seed: z.string(),
  engine: engineSchema,
  engineNote: z.string().default(""),
  queries: z.array(fanoutQuerySchema).default([]),
  measured: z.number().int().default(0),
  /** Sub-queries whose answer named the brand. */
  mentions: z.number().int().default(0),
  /** Sub-queries whose answer used the brand's own site as a source. */
  cited: z.number().int().default(0),
  /** Share of measured sub-queries that reached the brand at all, 0-100. */
  coverage: z.number().min(0).max(100).nullable().default(null),
  /** Where the losses are concentrated, by kind of sub-query. */
  byType: z
    .array(
      z.object({
        type: fanoutTypeSchema,
        measured: z.number().int(),
        hits: z.number().int(),
      }),
    )
    .default([]),
  /** The same breakdown for our own retrieval, which always runs. */
  byTypeAnswerable: z
    .array(
      z.object({
        type: fanoutTypeSchema,
        measured: z.number().int(),
        hits: z.number().int(),
      }),
    )
    .default([]),
  /** Who answered instead, by domain. */
  answeredBy: z
    .array(
      z.object({
        domain: z.string(),
        count: z.number().int(),
        own: z.boolean(),
      }),
    )
    .default([]),
  /** Every query the search tool typed across the whole audit, de-duplicated. */
  issued: z.array(z.string()).default([]),
  /** Pages our crawler indexed to answer the retrieval step itself. */
  indexedPages: z.number().int().default(0),
  /** The rival sites the crawler fetched to compare against. */
  rivals: z.array(rivalSiteSchema).default([]),
  /** Sub-queries a rival's page would be retrieved ahead of yours. */
  lost: z.number().int().default(0),
  /** Sub-queries a page of yours could actually be retrieved for. */
  answerable: z.number().int().default(0),
  /** Sub-queries where a page exists but is too thin to win, 0 when none. */
  weak: z.number().int().default(0),
  /** Share of sub-queries your own site can answer at all, 0-100. */
  answerableCoverage: z.number().min(0).max(100).nullable().default(null),
});

export type RivalSite = z.infer<typeof rivalSiteSchema>;
export type RetrievalHit = z.infer<typeof retrievalHitSchema>;
export type Retrieval = z.infer<typeof retrievalSchema>;
export type FanoutType = z.infer<typeof fanoutTypeSchema>;
export type FanoutQuery = z.infer<typeof fanoutQuerySchema>;
export type Fanout = z.infer<typeof fanoutSchema>;

export const actionSchema = z.object({
  id: z.string(),
  source: z.enum(["readiness", "visibility"]),
  checkId: z.string().nullable().default(null),
  title: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  /** Exact readiness points recovered when this passes; 0 for visibility work. */
  points: z.number().default(0),
  detail: z.string(),
  fix: fixSchema,
});

export const intentRequestSchema = z.object({
  text: z.string().trim().min(3).max(280),
});

export const auditStatusSchema = z.enum([
  "queued",
  "scanning",
  "profiling",
  "asking",
  "expanding",
  "analysing",
  "complete",
  "partial",
  "failed",
]);

export const auditSchema = z.object({
  id: z.string(),
  version: z.literal(SCHEMA_VERSION),
  target: z.string(),
  host: z.string(),
  status: auditStatusSchema,
  stage: z.string().default(""),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().default(0),
  model: z.string(),
  customPrompts: z.array(z.string()).default([]),
  scan: scanSchema.nullable(),
  readiness: readinessSchema.nullable(),
  profile: profileSchema.nullable(),
  visibility: visibilitySchema.nullable(),
  /** Null on an audit that ran before the fan-out stage existed. */
  fanout: fanoutSchema.nullable().default(null),
  actions: z.array(actionSchema).default([]),
  llmsTxt: z.string().nullable().default(null),
  warnings: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});

export type PageSignals = z.infer<typeof pageSignalsSchema>;
export type FileProbe = z.infer<typeof fileProbeSchema>;
export type BotProbe = z.infer<typeof botProbeSchema>;
export type Scan = z.infer<typeof scanSchema>;
export type LayerId = z.infer<typeof layerIdSchema>;
export type CheckStatus = z.infer<typeof checkStatusSchema>;
export type Fix = z.infer<typeof fixSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type Readiness = z.infer<typeof readinessSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type PromptKind = z.infer<typeof promptKindSchema>;
export type Engine = z.infer<typeof engineSchema>;
export type PromptResult = z.infer<typeof promptResultSchema>;
export type Visibility = z.infer<typeof visibilitySchema>;
export type Action = z.infer<typeof actionSchema>;
export type IntentRequest = z.infer<typeof intentRequestSchema>;
export type AuditStatus = z.infer<typeof auditStatusSchema>;
export type Audit = z.infer<typeof auditSchema>;

/* ============================================================ journey

   A journey is one AI agent trying to do one job on a site, recorded move by
   move. It answers a different question from an audit: not "does the model
   know you exist" but "can an agent that arrives with a task actually finish
   it here". Every step keeps the response it was built from, so a failure can
   be located at the hop that caused it.
   ============================================================ */

/** The job handed to the agent. Presets carry a verifier; custom text does not. */
export const journeyIntentSchema = z.object({
  id: z.string(),
  label: z.string(),
  task: z.string(),
  custom: z.boolean().default(false),
});

/** What the agent did on one step. */
export const journeyActionSchema = z.enum([
  "fetch",
  "search",
  "answer",
  "giveup",
]);

export const journeyIssueCodeSchema = z.enum([
  "robots_blocked",
  "firewall_blocked",
  "auth_wall",
  "not_found",
  "server_error",
  "unreachable",
  "javascript_only",
  "thin_content",
  "slow_response",
  "wrong_content_type",
  "redirected",
  "left_the_site",
  "no_route",
  "unverified_answer",
  "budget_exhausted",
]);

export const journeyIssueSchema = z.object({
  code: journeyIssueCodeSchema,
  severity: z.enum(["blocker", "friction", "note"]),
  /** 1-based step this was observed on; null when it is about the run itself. */
  step: z.number().int().nullable().default(null),
  url: z.string().default(""),
  /** What was actually observed. */
  detail: z.string(),
  /** Why it matters to an agent. */
  why: z.string(),
  /** What to change on the site. */
  fix: z.string(),
});

export const journeyStepSchema = z.object({
  n: z.number().int(),
  action: journeyActionSchema,
  url: z.string().default(""),
  query: z.string().default(""),
  /** The agent's own stated reason for the move, before it was carried out. */
  reason: z.string().default(""),
  status: z.number().int().nullable().default(null),
  finalUrl: z.string().default(""),
  contentType: z.string().default(""),
  ms: z.number().default(0),
  bytes: z.number().int().default(0),
  words: z.number().int().default(0),
  title: z.string().default(""),
  /** What the agent took from the response, in its own words. */
  found: z.string().default(""),
  /** Literal text from the page that satisfies the intent, when any does. */
  evidence: z.string().default(""),
  issues: z.array(journeyIssueCodeSchema).default([]),
  error: z.string().default(""),
  /** Milliseconds since the journey started. */
  at: z.number().default(0),
});

export const journeyOutcomeSchema = z.enum([
  "completed",
  "partial",
  "stalled",
  "blocked",
  "failed",
]);

export const journeyStatusSchema = z.enum([
  "queued",
  "starting",
  "walking",
  "reading",
  "complete",
  "failed",
]);

export const journeyMetricsSchema = z.object({
  steps: z.number().int().default(0),
  fetches: z.number().int().default(0),
  searches: z.number().int().default(0),
  blocked: z.number().int().default(0),
  broken: z.number().int().default(0),
  bytes: z.number().int().default(0),
  /** Total time spent waiting on the site, not on the model. */
  siteMs: z.number().default(0),
  slowestMs: z.number().default(0),
  blockers: z.number().int().default(0),
  friction: z.number().int().default(0),
});

export const journeySchema = z.object({
  id: z.string(),
  version: z.literal(SCHEMA_VERSION),
  target: z.string(),
  host: z.string(),
  status: journeyStatusSchema,
  stage: z.string().default(""),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().default(0),
  model: z.string(),
  intent: journeyIntentSchema,
  /** The crawler the agent identified itself as, and the exact string sent. */
  agent: z.object({ name: z.string(), userAgent: z.string() }),
  /** Who chose each move: Gemini, or the built-in deterministic walker. */
  navigator: z.enum(["gemini", "heuristic"]),
  outcome: journeyOutcomeSchema.nullable().default(null),
  /** The agent's answer to the task, when it produced one. */
  answer: z.string().default(""),
  answerUrl: z.string().default(""),
  /** Page text that independently confirms the answer, when it was found. */
  verified: z.boolean().default(false),
  steps: z.array(journeyStepSchema).default([]),
  issues: z.array(journeyIssueSchema).default([]),
  metrics: journeyMetricsSchema,
  warnings: z.array(z.string()).default([]),
  error: z.string().nullable().default(null),
});

export type JourneyIntent = z.infer<typeof journeyIntentSchema>;
export type JourneyAction = z.infer<typeof journeyActionSchema>;
export type JourneyIssueCode = z.infer<typeof journeyIssueCodeSchema>;
export type JourneyIssue = z.infer<typeof journeyIssueSchema>;
export type JourneyStep = z.infer<typeof journeyStepSchema>;
export type JourneyOutcome = z.infer<typeof journeyOutcomeSchema>;
export type JourneyStatus = z.infer<typeof journeyStatusSchema>;
export type JourneyMetrics = z.infer<typeof journeyMetricsSchema>;
export type Journey = z.infer<typeof journeySchema>;

/**
 * One move, as the navigator returns it. Model output is validated against
 * this before anything is fetched, so a hallucinated field cannot reach the
 * network layer.
 */
export const navigatorMoveSchema = z.object({
  action: journeyActionSchema,
  /** Absolute URL for a fetch. Ignored for every other action. */
  url: z.string().default(""),
  /** Search terms for a search. Ignored for every other action. */
  query: z.string().default(""),
  /** Why this move, in one sentence, before it is carried out. */
  reason: z.string().default(""),
  /** What the previous response gave the agent, in one sentence. */
  found: z.string().default(""),
  /** The answer to the task, on an answer move. */
  answer: z.string().default(""),
});

export type NavigatorMove = z.infer<typeof navigatorMoveSchema>;

/** Everything the navigator is allowed to see when it chooses a move. */
export type NavigatorContext = {
  task: string;
  host: string;
  startUrl: string;
  /** Steps so far, oldest first. */
  trail: Array<{
    n: number;
    action: JourneyAction;
    url: string;
    query: string;
    status: number | null;
    title: string;
    words: number;
    found: string;
    issues: JourneyIssueCode[];
    error: string;
  }>;
  /** The page the agent is standing on, already stripped of scripts. */
  current: {
    url: string;
    title: string;
    description: string;
    headings: string[];
    text: string;
    links: Array<{ href: string; text: string }>;
  } | null;
  fetchesLeft: number;
  searchesLeft: number;
};
