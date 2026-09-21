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
