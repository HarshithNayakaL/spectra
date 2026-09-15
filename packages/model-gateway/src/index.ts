import { z } from "zod";
import {
  semanticGraphSchema,
  siteAnalysisSchema,
  type SemanticGraph,
  type SiteAnalysis,
  type SourceEvidence,
} from "@spectra/schemas";

type Usage = { inputTokens?: number; outputTokens?: number };
type Result<T> = { value: T; usage: Usage; durationMs: number };
export type QueryGroup = { claimId: string; variants: string[] };
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
}
export class GroundingUnavailableError extends Error {}

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
          type: { type: "string" },
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
          predicate: { type: "string" },
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
  private readonly minimumInterval = Number(
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS || 7000,
  );
  constructor(
    private key: string,
    model = process.env.GEMINI_MODEL || "gemini-3.8-flash",
  ) {
    this.model = model;
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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned malformed JSON");
    }
    return {
      value: schema.parse(parsed),
      usage: usage(data),
      durationMs: Date.now() - started,
    };
  }

  private async request(body: unknown, grounding: boolean): Promise<any> {
    let last: unknown;
    const attempts = 5;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const wait = this.nextRequestAt - Date.now();
      if (wait > 0) await delay(wait);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 45_000);
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.key)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        if (grounding && [400, 404].includes(response.status))
          throw new GroundingUnavailableError(
            `Google Search grounding is unavailable for ${this.model} (${response.status})`,
          );
        if (response.status === 429 || response.status >= 500) {
          const retry = Number(response.headers.get("retry-after") ?? 0);
          const detail = (await response.text())
            .slice(0, 500)
            .replace(/\s+/g, " ");
          last = new Error(
            `Gemini ${response.status}${detail ? `: ${detail}` : ""}`,
          );
          const backoff =
            response.status === 429
              ? Math.min(60_000, 15_000 * 2 ** attempt)
              : 1000 * 2 ** attempt;
          await delay(Math.max(retry * 1000, backoff));
          continue;
        }
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 300);
          throw new Error(
            `Gemini request failed (${response.status}): ${detail}`,
          );
        }
        return await response.json();
      } catch (error) {
        if (error instanceof GroundingUnavailableError) throw error;
        last = error;
        if (attempt < attempts - 1) await delay(1000 * 2 ** attempt);
      } finally {
        this.nextRequestAt = Date.now() + this.minimumInterval;
        clearTimeout(timer);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
function budget(evidence: SourceEvidence[]) {
  return JSON.stringify(evidence).slice(0, 80_000);
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
