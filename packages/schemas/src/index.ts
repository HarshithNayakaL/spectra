import { z } from "zod";

export const evidenceSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  text: z.string(),
  value: z.unknown().optional(),
  evidenceType: z
    .enum([
      "title",
      "description",
      "heading",
      "visible_text",
      "json_ld",
      "open_graph",
      "twitter",
      "canonical",
      "link",
      "semantic_html",
    ])
    .default("visible_text"),
  selector: z.string().optional(),
  pageId: z.string().optional(),
  structuredSource: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1),
});
export const entitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum([
    "Person",
    "Organization",
    "Product",
    "Project",
    "Service",
    "Location",
    "Technology",
    "Article",
    "Event",
    "Concept",
    "Other",
  ]),
  description: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
});
export const relationshipSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  predicate: z.enum([
    "created",
    "built",
    "works_at",
    "offers",
    "located_in",
    "owns",
    "developed",
    "specializes_in",
    "authored",
    "manufactures",
    "provides",
    "part_of",
    "related_to",
  ]),
  objectId: z.string(),
  evidenceIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});
export const claimSchema = z.object({
  id: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  importance: z.number().min(0).max(1),
  extractionConfidence: z.number().min(0).max(1).default(0.5),
  informationClass: z.string().default("general"),
  evidenceIds: z.array(z.string()).min(1),
});
export const pageSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  status: z.number().int(),
  title: z.string().default(""),
  description: z.string().default(""),
  canonicalUrl: z.string().url().nullable().default(null),
  headings: z
    .array(
      z.object({ level: z.number().int().min(1).max(6), text: z.string() }),
    )
    .default([]),
  text: z.string().default(""),
  links: z.array(z.string().url()).default([]),
  jsonLd: z.array(z.unknown()).default([]),
  openGraph: z.record(z.string(), z.string()).default({}),
  twitter: z.record(z.string(), z.string()).default({}),
  semanticElements: z
    .array(z.object({ tag: z.string(), text: z.string() }))
    .default([]),
  fingerprint: z.string(),
  contentType: z.string(),
  duplicateOf: z.string().nullable().default(null),
});
export const crawlOutputSchema = z.object({
  target: z.string().url(),
  startedAt: z.string(),
  completedAt: z.string(),
  robots: z.object({
    url: z.string().url(),
    allowed: z.boolean(),
    sitemaps: z.array(z.string().url()),
    status: z.number().nullable(),
  }),
  pages: z.array(pageSchema),
  crawlEdges: z.array(
    z.object({ from: z.string().url(), to: z.string().url() }),
  ),
  warnings: z.array(z.string()),
  failures: z
    .array(z.object({ url: z.string(), stage: z.string(), error: z.string() }))
    .default([]),
  limits: z.object({
    maxPages: z.number(),
    maxDepth: z.number(),
    maxBytes: z.number(),
    timeoutMs: z.number(),
    maxRedirects: z.number(),
  }),
});

export const siteAnalysisSchema = z.object({
  primaryEntity: z.object({
    name: z.string(),
    type: z.string(),
    description: z.string(),
    evidenceIds: z.array(z.string()).default([]),
  }),
  siteArchetype: z.string(),
  secondaryArchetypes: z.array(z.string()),
  purpose: z.array(z.string()),
  intendedAudience: z.array(z.string()).default([]),
  importantInformationClasses: z.array(z.string()),
  expectedUserQuestions: z.array(z.string()),
  expectedUserIntents: z.array(z.string()).default([]),
  confidence: z.object({
    overall: z.number().min(0).max(1),
    reasons: z.array(z.string()),
  }),
  ambiguities: z.array(z.string()),
});
export const semanticGraphSchema = z.object({
  entities: z.array(entitySchema),
  relationships: z.array(relationshipSchema),
  claims: z.array(claimSchema),
  ambiguities: z.array(z.string()).default([]),
});
export const dimensionIdSchema = z.enum([
  "machine_accessibility",
  "semantic_extraction",
  "entity_clarity",
  "relationship_preservation",
  "claim_retrievability",
  "structured_evidence",
  "ai_search_discoverability",
]);
export const contractSchema = z.object({
  version: z.literal("spectra-v0.1").default("spectra-v0.1"),
  archetype: z.string(),
  dimensions: z.array(
    z.object({
      id: dimensionIdSchema,
      reason: z.string(),
      requiredInputs: z.array(z.string()).default([]),
      evaluationMethod: z.string().default("deterministic"),
      normalization: z.string().default("weighted_ratio"),
      weight: z.number().positive().default(1),
      naBehavior: z.string().default("excluded_from_denominator"),
    }),
  ),
  unsupportedObservations: z.array(z.string()).default([]),
});
export const survivalSchema = z.object({
  claimId: z.string(),
  stages: z.array(
    z.object({
      stage: z.enum([
        "source",
        "crawler",
        "extraction",
        "semantic_graph",
        "model_understanding",
        "retrieval",
      ]),
      status: z.enum(["survived", "failed", "not_tested"]),
      evidenceIds: z.array(z.string()),
      note: z.string(),
    }),
  ),
  failedAt: z.string().nullable(),
  survivalRate: z.number().min(0).max(1).default(0),
});
export const checkSchema = z.object({
  id: z.string(),
  dimension: dimensionIdSchema,
  label: z.string(),
  status: z.enum(["pass", "fail", "na"]),
  value: z.number().min(0).max(1),
  weight: z.number().positive(),
  evidenceIds: z.array(z.string()),
  limitation: z.string().optional(),
});
export const metricSchema = z.object({
  dimension: dimensionIdSchema.or(z.literal("overall")),
  score: z.number().min(0).max(100).nullable(),
  earned: z.number(),
  denominator: z.number(),
  applied: z.array(checkSchema),
  notApplicable: z.array(checkSchema),
  calculation: z.string(),
  scoringVersion: z.literal("spectra-v0.1"),
  limitations: z.array(z.string()),
});
export const groundingSourceSchema = z.object({
  uri: z.string().url(),
  title: z.string().default(""),
});
export const retrievalSchema = z.object({
  id: z.string(),
  claimId: z.string().optional(),
  query: z.string(),
  variantIndex: z.number().int().default(0),
  mode: z.enum(["direct", "search_grounded"]),
  answer: z.string().nullable(),
  correct: z.boolean().nullable(),
  reason: z.string().optional(),
  evidenceIds: z.array(z.string()),
  groundingSources: z.array(groundingSourceSchema).default([]),
  groundingMetadata: z.unknown().optional(),
  status: z.enum(["passed", "failed", "not_run", "error", "unavailable"]),
  error: z.string().optional(),
  durationMs: z.number().default(0),
});
export const stabilitySchema = z.object({
  claimId: z.string(),
  mode: z.enum(["direct", "search_grounded"]),
  successfulVariants: z.number(),
  failedVariants: z.number(),
  unavailableVariants: z.number(),
  stabilityRatio: z.number().min(0).max(1).nullable(),
  contradictoryAnswers: z.array(z.string()),
  uncertainty: z.string(),
});
export const issueSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string(),
  description: z.string(),
  affectedEntities: z.array(z.string()),
  affectedClaims: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  likelyCause: z.string(),
  recommendedFix: z.string(),
  confidence: z.number().min(0).max(1),
});
export const modelRunSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string(),
  purpose: z.string(),
  status: z.enum(["success", "error", "skipped"]),
  durationMs: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  groundingEnabled: z.boolean().default(false),
  error: z.string().optional(),
});
export const auditSchema = z.object({
  id: z.string(),
  target: z.string().url(),
  status: z.enum([
    "idle",
    "queued",
    "validating",
    "crawling",
    "extracting",
    "analyzing",
    "classifying",
    "mapping",
    "evaluating",
    "retrieving",
    "scoring",
    "diagnosing",
    "complete",
    "partial_failure",
    "fatal_failure",
  ]),
  currentStage: z.string().default("idle"),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  scoringVersion: z.literal("spectra-v0.1"),
  crawl: crawlOutputSchema.nullable(),
  evidence: z.array(evidenceSchema),
  analysis: siteAnalysisSchema.nullable(),
  graph: semanticGraphSchema.nullable(),
  contract: contractSchema.nullable(),
  survival: z.array(survivalSchema),
  stability: z.array(stabilitySchema).default([]),
  retrievals: z.array(retrievalSchema),
  metrics: z.array(metricSchema),
  issues: z.array(issueSchema),
  recommendations: z.array(
    z.object({
      id: z.string(),
      issueId: z.string(),
      whatFailed: z.string(),
      where: z.string(),
      evidenceIds: z.array(z.string()),
      change: z.string(),
      rationale: z.string(),
    }),
  ),
  modelRuns: z.array(modelRunSchema),
  warnings: z.array(z.string()),
});

export type Audit = z.infer<typeof auditSchema>;
export type CrawlOutput = z.infer<typeof crawlOutputSchema>;
export type SourceEvidence = z.infer<typeof evidenceSchema>;
export type SiteAnalysis = z.infer<typeof siteAnalysisSchema>;
export type SemanticGraph = z.infer<typeof semanticGraphSchema>;
export type EvaluationContract = z.infer<typeof contractSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type RetrievalResult = z.infer<typeof retrievalSchema>;
export type ModelRun = z.infer<typeof modelRunSchema>;
