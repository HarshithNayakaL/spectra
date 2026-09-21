import { z } from "zod";
import {
  entitySchema,
  relationshipSchema,
  semanticGraphSchema,
  siteAnalysisSchema,
  type SemanticGraph,
  type SiteAnalysis,
  type SourceEvidence,
} from "@spectra/schemas";

type Usage = { inputTokens?: number; outputTokens?: number };
type Result<T> = { value: T; usage: Usage; durationMs: number };
export type QueryGroup = { claimId: string; variants: string[] };
export type IntentVerdict = {
  answer: string;
  metCriteria: string[];
  unmetCriteria: string[];
  satisfied: boolean;
  reason: string;
};
export type GroundedAnswer = {
  answer: string;
  sources: Array<{ uri: string; title: string }>;
  metadata: unknown;
};
export interface ModelProvider {
  analyzeSite(evidence: SourceEvidence[]): Promise<Result<SiteAnalysis>>;
  extractSemanticGraph(
    evidence: SourceEvidence[],
    analysis: SiteAnalysis,
  ): Promise<Result<SemanticGraph>>;
  generateRetrievalQueries(graph: SemanticGraph): Promise<Result<QueryGroup[]>>;
  answerDirect(
    query: string,
    claim: string,
    evidence: SourceEvidence[],
  ): Promise<Result<{ answer: string; supported: boolean; reason: string }>>;
  answerGrounded(query: string): Promise<Result<GroundedAnswer>>;
  evaluateRetrievedAnswer(
    query: string,
    answer: string,
    claim: string,
  ): Promise<Result<{ correct: boolean; reason: string }>>;
  deriveIntentCriteria(
    intent: string,
    analysis: SiteAnalysis | null,
  ): Promise<Result<string[]>>;
  generateIntentVariants(intent: string): Promise<Result<string[]>>;
  attemptIntent(
    query: string,
    criteria: string[],
    evidence: SourceEvidence[],
  ): Promise<Result<IntentVerdict>>;
}
export class GroundingUnavailableError extends Error {}
/** The request could not finish before the caller's deadline. */
export class DeadlineError extends Error {}
/** A failure that will repeat identically on retry (bad key, bad request). */
export class PermanentModelError extends Error {}

const queryGroupsSchema = z.array(
  z.object({
    claimId: z.string(),
    variants: z.array(z.string()).min(3).max(4),
  }),
);
const directSchema = z.object({
  answer: z.string(),
  supported: z.boolean(),
  reason: z.string(),
});
const judgmentSchema = z.object({ correct: z.boolean(), reason: z.string() });
const criteriaSchema = z.object({
  criteria: z.array(z.string()).min(1).max(5),
});
const variantsSchema = z.object({
  variants: z.array(z.string()).min(1).max(4),
});
const intentVerdictSchema = z.object({
  answer: z.string(),
  metCriteria: z.array(z.string()).default([]),
  unmetCriteria: z.array(z.string()).default([]),
  satisfied: z.boolean(),
  reason: z.string(),
});
const criteriaResponseSchema = {
  type: "object",
  properties: {
    criteria: { type: "array", items: { type: "string" } },
  },
  required: ["criteria"],
};
const variantsResponseSchema = {
  type: "object",
  properties: {
    variants: { type: "array", items: { type: "string" } },
  },
  required: ["variants"],
};
const intentVerdictResponseSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    metCriteria: { type: "array", items: { type: "string" } },
    unmetCriteria: { type: "array", items: { type: "string" } },
    satisfied: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["answer", "metCriteria", "unmetCriteria", "satisfied", "reason"],
};
// The graph schema validates these as enums. Declaring them as bare strings
// in the response schema let Gemini answer with values the parser then
// rejected, failing the whole semantic stage after the tokens were spent.
const ENTITY_TYPES = entitySchema.shape.type.options;
const RELATIONSHIP_PREDICATES = relationshipSchema.shape.predicate.options;

const siteResponseSchema = {
  type: "object",
  properties: {
    primaryEntity: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string" },
        description: { type: "string" },
        evidenceIds: { type: "array", items: { type: "string" } },
      },
      required: ["name", "type", "description", "evidenceIds"],
    },
    siteArchetype: { type: "string" },
    secondaryArchetypes: { type: "array", items: { type: "string" } },
    purpose: { type: "array", items: { type: "string" } },
    intendedAudience: { type: "array", items: { type: "string" } },
    importantInformationClasses: { type: "array", items: { type: "string" } },
    expectedUserQuestions: { type: "array", items: { type: "string" } },
    expectedUserIntents: { type: "array", items: { type: "string" } },
    confidence: {
      type: "object",
      properties: {
        overall: { type: "number" },
        reasons: { type: "array", items: { type: "string" } },
      },
      required: ["overall", "reasons"],
    },
    ambiguities: { type: "array", items: { type: "string" } },
  },
  required: [
    "primaryEntity",
    "siteArchetype",
    "secondaryArchetypes",
    "purpose",
    "intendedAudience",
    "importantInformationClasses",
    "expectedUserQuestions",
    "expectedUserIntents",
    "confidence",
    "ambiguities",
  ],
};
const graphResponseSchema = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ENTITY_TYPES },
          description: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: ["id", "name", "type", "evidenceIds"],
      },
    },
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          subjectId: { type: "string" },
          predicate: { type: "string", enum: RELATIONSHIP_PREDICATES },
          objectId: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: [
          "id",
          "subjectId",
          "predicate",
          "objectId",
          "evidenceIds",
          "confidence",
        ],
      },
    },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          subject: { type: "string" },
          predicate: { type: "string" },
          object: { type: "string" },
          importance: { type: "number" },
          extractionConfidence: { type: "number" },
          informationClass: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "subject",
          "predicate",
          "object",
          "importance",
          "extractionConfidence",
          "informationClass",
          "evidenceIds",
        ],
      },
    },
    ambiguities: { type: "array", items: { type: "string" } },
  },
  required: ["entities", "relationships", "claims", "ambiguities"],
};

export class GeminiProvider implements ModelProvider {
  readonly model: string;
  private nextRequestAt = 0;
  // Serverless has a hard wall clock, so pacing and retries are tighter there.
  private readonly minimumInterval = Number(
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS ||
      (process.env.VERCEL ? 1200 : 7000),
  );
  private readonly maxAttempts = Math.max(
    1,
    Number(process.env.GEMINI_MAX_ATTEMPTS || (process.env.VERCEL ? 3 : 6)),
  );
  /** Epoch ms after which no request may start or keep waiting. */
  private readonly deadline: number;
  constructor(
    private key: string,
    model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    options: { deadline?: number } = {},
  ) {
    this.model = model;
    this.deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  }

  /** Waits, but refuses to wait past the deadline. */
  private async waitWithin(ms: number) {
    if (ms <= 0) return;
    if (Date.now() + ms > this.deadline - 1500)
      throw new DeadlineError("Time budget reached before the model responded");
    await delay(ms);
  }

  async analyzeSite(evidence: SourceEvidence[]) {
    return this.structured(
      `Classify the website using only the supplied evidence IDs. Do not score it. Identify its primary entity, archetype, purpose, intended audiences, important information classes, user questions/intents, confidence and ambiguities. The primary entity must cite evidence IDs.\nEVIDENCE:\n${budget(evidence)}`,
      siteAnalysisSchema,
      siteResponseSchema,
    );
  }
  async extractSemanticGraph(
    evidence: SourceEvidence[],
    analysis: SiteAnalysis,
  ) {
    return this.structured(
      `Extract a canonical semantic graph using only directly supported facts. Every entity, relationship and claim must cite exact supplied evidence IDs. Never create plausible but unsupported edges. Claims need importance, extraction confidence, and information class.\nCLASSIFICATION:${JSON.stringify(analysis)}\nEVIDENCE:${budget(evidence)}`,
      semanticGraphSchema,
      graphResponseSchema,
    );
  }
  async generateRetrievalQueries(graph: SemanticGraph) {
    return this.structured(
      `For each supplied claim, generate 3-4 natural, semantically equivalent questions a user might ask an AI search system. Keep the exact claimId. Do not answer the questions.\nCLAIMS:${JSON.stringify(graph.claims)}`,
      queryGroupsSchema,
    );
  }
  async answerDirect(query: string, claim: string, evidence: SourceEvidence[]) {
    return this.structured(
      `Answer the question using only the supplied website evidence, then state whether that evidence-backed answer correctly supports the expected claim. If evidence is insufficient or contradicts it, set supported=false.\nQUESTION:${query}\nEXPECTED CLAIM:${claim}\nEVIDENCE:${budget(evidence)}`,
      directSchema,
    );
  }
  async evaluateRetrievedAnswer(query: string, answer: string, claim: string) {
    return this.structured(
      `Judge whether the answer correctly supports the expected claim. Be strict about subject, relationship and object.\nQUESTION:${query}\nEXPECTED CLAIM:${claim}\nANSWER:${answer}`,
      judgmentSchema,
    );
  }

  /**
   * Only used when the operator declared an intent but no success criteria.
   * Criteria must be checkable against page evidence, not opinions.
   */
  async deriveIntentCriteria(intent: string, analysis: SiteAnalysis | null) {
    const result = await this.structured(
      `A website operator wants to know whether an AI assistant can complete this job using only their website. Write 2 to 4 success criteria that decide whether the job was done. Each criterion must be a single, concrete, checkable fact the answer has to contain, such as a named price, a named page, a specific figure or a specific action. Do not write vague criteria like "is helpful" or "is accurate". Do not invent facts about the site.\nJOB: ${intent}${analysis ? `\nSITE CLASSIFICATION: ${JSON.stringify(analysis.primaryEntity)} archetype=${analysis.siteArchetype}` : ""}`,
      criteriaSchema,
      criteriaResponseSchema,
    );
    return { ...result, value: result.value.criteria };
  }

  async generateIntentVariants(intent: string) {
    const result = await this.structured(
      `Rewrite this request as 3 natural, semantically equivalent questions a real person would type into an AI assistant. Keep the same job. Vary the wording, not the meaning. Do not answer them.\nREQUEST: ${intent}`,
      variantsSchema,
      variantsResponseSchema,
    );
    return { ...result, value: result.value.variants };
  }

  /**
   * Answers strictly from crawled evidence, then judges the answer against the
   * criteria. Both halves run in one call so the verdict cannot drift from the
   * answer it is judging.
   */
  async attemptIntent(
    query: string,
    criteria: string[],
    evidence: SourceEvidence[],
  ) {
    return this.structured(
      `Act as an AI assistant that may only use the supplied website evidence. First answer the question from that evidence alone. Then check the answer against each success criterion and sort every criterion verbatim into metCriteria or unmetCriteria. Set satisfied=true only when every criterion is met. If the evidence does not support an answer, say so plainly and mark the criteria unmet. Never use outside knowledge about this organisation.\nQUESTION: ${query}\nSUCCESS CRITERIA: ${JSON.stringify(criteria)}\nEVIDENCE: ${budget(evidence)}`,
      intentVerdictSchema,
      intentVerdictResponseSchema,
    );
  }

  async answerGrounded(query: string): Promise<Result<GroundedAnswer>> {
    const started = Date.now();
    const data = await this.request(
      {
        contents: [
          {
            parts: [
              {
                text: `Use Google Search to answer this question accurately and concisely. If reliable results do not support an answer, say that it is unavailable.\nQUESTION: ${query}`,
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1200 },
      },
      true,
    );
    const candidate = data.candidates?.[0];
    const answer = (candidate?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join(" ")
      .trim();
    const metadata = candidate?.groundingMetadata;
    const chunks = metadata?.groundingChunks ?? [];
    const sources = chunks.flatMap((chunk: any) =>
      chunk.web?.uri
        ? [{ uri: chunk.web.uri, title: chunk.web.title ?? "" }]
        : [],
    );
    return {
      value: { answer, sources, metadata },
      usage: usage(data),
      durationMs: Date.now() - started,
    };
  }

  private async structured<T>(
    prompt: string,
    schema: z.ZodType<T>,
    responseSchema?: object,
  ): Promise<Result<T>> {
    const started = Date.now();
    const data = await this.request(
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema ?? (schema as any).toJSONSchema(),
          maxOutputTokens: 6000,
          temperature: 0.1,
        },
      },
      false,
    );
    const candidate = data.candidates?.[0];
    // Long structured answers arrive split across parts; reading only parts[0]
    // truncated them into unparseable JSON.
    const text = (candidate?.content?.parts ?? [])
      .map((part: any) => part?.text ?? "")
      .join("")
      .trim();
    if (!text) {
      const reason =
        candidate?.finishReason ?? data.promptFeedback?.blockReason;
      throw new Error(
        reason
          ? `Gemini returned no content (${reason})`
          : "Gemini returned no content",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(text));
    } catch {
      throw new Error(
        candidate?.finishReason === "MAX_TOKENS"
          ? "Gemini hit the output token limit before completing its JSON response"
          : "Gemini returned malformed JSON",
      );
    }
    return {
      value: schema.parse(parsed),
      usage: usage(data),
      durationMs: Date.now() - started,
    };
  }

  private async request(body: unknown, grounding: boolean): Promise<any> {
    let last: unknown;
    const attempts = this.maxAttempts;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.waitWithin(this.nextRequestAt - Date.now());
      const remaining = this.deadline - Date.now() - 1000;
      if (remaining < 3000)
        throw new DeadlineError(
          "Time budget reached before the model responded",
        );
      const controller = new AbortController(),
        timer = setTimeout(
          () => controller.abort(),
          Math.min(45_000, remaining),
        );
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Header rather than ?key=: a key in the query string leaks into
              // access logs, proxy caches and error reports.
              "x-goog-api-key": this.key,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        if (grounding && [400, 404].includes(response.status))
          throw new GroundingUnavailableError(
            `Google Search grounding is unavailable for ${this.model} (${response.status})`,
          );
        if (response.status === 429 || response.status >= 500) {
          const detail = (await response.text())
            .slice(0, 500)
            .replace(/\s+/g, " ");
          last = new Error(
            `Gemini ${response.status}${detail ? `: ${detail}` : ""}`,
          );
          if (attempt === attempts - 1) break;
          const backoff =
            response.status === 429
              ? Math.min(60_000, 15_000 * 2 ** attempt)
              : Math.min(30_000, 2_000 * 2 ** attempt);
          await this.waitWithin(Math.max(retryAfterMs(response), backoff));
          continue;
        }
        if (!response.ok) {
          // 400/401/403 is a request or credential defect. Retrying it burns
          // five backoff windows to arrive at the same answer.
          const detail = (await response.text()).slice(0, 300);
          throw new PermanentModelError(
            `Gemini request failed (${response.status}): ${detail}`,
          );
        }
        return await response.json();
      } catch (error) {
        if (
          error instanceof GroundingUnavailableError ||
          error instanceof PermanentModelError ||
          error instanceof DeadlineError
        )
          throw error;
        last = error;
        if (attempt < attempts - 1)
          await this.waitWithin(Math.min(30_000, 2_000 * 2 ** attempt));
      } finally {
        this.nextRequestAt = Date.now() + this.minimumInterval;
        clearTimeout(timer);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

/** Retry-After may be delta-seconds or an HTTP date; both must yield a number. */
export function retryAfterMs(response: {
  headers: { get(name: string): string | null };
}): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  // Date.parse on a malformed value yields NaN, which used to flow through
  // Math.max and collapse the backoff into an immediate retry.
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

/** Some models wrap structured output in a Markdown fence despite the MIME type. */
export function stripJsonFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text;
}
function budget(evidence: SourceEvidence[]) {
  const selected: SourceEvidence[] = [];
  const semanticPages = new Set<string>();
  let characters = 0;
  const prioritized = [...evidence].sort((a, b) => {
    const rank = (item: SourceEvidence) =>
      ["title", "description", "json_ld", "heading", "visible_text"].indexOf(
        item.evidenceType,
      );
    const aRank = rank(a),
      bRank = rank(b);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
  });
  for (const item of prioritized) {
    if (item.evidenceType === "semantic_html") {
      const pageKey = item.pageId ?? item.url;
      if (semanticPages.has(pageKey)) continue;
      semanticPages.add(pageKey);
    }
    const textLimit = ["visible_text", "semantic_html"].includes(
      item.evidenceType,
    )
      ? 4_000
      : 1_500;
    const compact = { ...item, text: item.text.slice(0, textLimit) };
    const size = JSON.stringify(compact).length;
    if (characters + size > 48_000) continue;
    selected.push(compact);
    characters += size;
  }
  return JSON.stringify(selected);
}
function usage(data: any): Usage {
  return {
    inputTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount,
  };
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
