import { z } from "zod";
import { profileSchema, type Profile } from "@spectra/schemas";

type Usage = { inputTokens?: number; outputTokens?: number };
export type Result<T> = { value: T; usage: Usage; durationMs: number };

export type ProfileInput = {
  host: string;
  pages: Array<{
    url: string;
    title: string;
    description: string;
    headings: string[];
    excerpt: string;
  }>;
  organization: unknown;
  customPrompts: string[];
};
export type SiteProfile = Profile & {
  categoryPrompts: string[];
  brandedPrompts: string[];
};
export type Answer = {
  answer: string;
  sources: Array<{ uri: string; title: string }>;
  queries: string[];
};
export type AnswerAnalysis = {
  id: string;
  competitors: string[];
  sentiment: "positive" | "neutral" | "negative" | null;
  inaccuracies: string[];
};

export interface ModelProvider {
  readonly model: string;
  profileSite(input: ProfileInput): Promise<Result<SiteProfile>>;
  /** Asks the question exactly as a user would, optionally grounded in Google Search. */
  ask(query: string, grounded: boolean): Promise<Result<Answer>>;
  analyseAnswers(
    profile: Profile,
    items: Array<{ id: string; prompt: string; answer: string }>,
  ): Promise<Result<AnswerAnalysis[]>>;
}
export class GroundingUnavailableError extends Error {}
/** The request could not finish before the caller's deadline. */
export class DeadlineError extends Error {}
/** A failure that will repeat identically on retry (bad key, bad request). */
export class PermanentModelError extends Error {}

const siteProfileSchema = profileSchema.extend({
  categoryPrompts: z.array(z.string()).min(1).max(8),
  brandedPrompts: z.array(z.string()).min(1).max(3),
});
const siteProfileResponseSchema = {
  type: "object",
  properties: {
    brand: { type: "string" },
    aliases: { type: "array", items: { type: "string" } },
    category: { type: "string" },
    description: { type: "string" },
    audience: { type: "string" },
    market: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    categoryPrompts: { type: "array", items: { type: "string" } },
    brandedPrompts: { type: "array", items: { type: "string" } },
  },
  required: [
    "brand",
    "aliases",
    "category",
    "description",
    "audience",
    "market",
    "facts",
    "categoryPrompts",
    "brandedPrompts",
  ],
};
const analysisSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      competitors: z.array(z.string()).default([]),
      sentiment: z
        .enum(["positive", "neutral", "negative", "none"])
        .default("none"),
      inaccuracies: z.array(z.string()).default([]),
    }),
  ),
});
const analysisResponseSchema = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          competitors: { type: "array", items: { type: "string" } },
          sentiment: {
            type: "string",
            enum: ["positive", "neutral", "negative", "none"],
          },
          inaccuracies: { type: "array", items: { type: "string" } },
        },
        required: ["id", "competitors", "sentiment", "inaccuracies"],
      },
    },
  },
  required: ["answers"],
};

export class GeminiProvider implements ModelProvider {
  readonly model: string;
  private nextRequestAt = 0;
  // Serverless has a hard wall clock, so pacing and retries are tighter there.
  private readonly minimumInterval = Number(
    process.env.GEMINI_MIN_REQUEST_INTERVAL_MS ||
      (process.env.VERCEL ? 1000 : 4000),
  );
  private readonly maxAttempts = Math.max(
    1,
    Number(process.env.GEMINI_MAX_ATTEMPTS || 3),
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

  async profileSite(input: ProfileInput) {
    const pages = input.pages
      .map(
        (page) =>
          `URL: ${page.url}\nTITLE: ${page.title}\nDESCRIPTION: ${page.description}\nHEADINGS: ${page.headings.join(" | ")}\nTEXT: ${page.excerpt}`,
      )
      .join("\n---\n")
      .slice(0, 40_000);
    return this.structured(
      `You are profiling a business from its own website so its visibility in AI answers can be measured.

Return:
- brand: the business's name as customers say it (not the domain, not a slogan).
- aliases: other names or spellings in use (may be empty).
- category: a short noun phrase for what it sells, as a buyer would search for it (e.g. "B2B contact data provider", "project management software", "dental clinic in Austin").
- description: one factual sentence: what it offers and to whom.
- audience: who buys it.
- market: the geography it serves if stated, else "".
- facts: 3 to 5 specific, checkable facts stated on the site (numbers, founding year, locations, named products, prices). Never invent.
- categoryPrompts: ${input.customPrompts.length ? 3 : 5} questions a real buyer would type into ChatGPT or Google AI Mode while looking for this kind of business, WITHOUT naming the brand. Mix "best X for Y", "top X providers", "how do I choose X", "alternatives to <a well-known competitor>", and one specific need the site serves. Include the market if the business is local.
- brandedPrompts: 2 questions a buyer asks about this brand by name, such as "What is <brand> and is it legit?" or "<brand> pricing and reviews".

WEBSITE ${input.host}
${input.organization ? `ORGANIZATION MARKUP: ${JSON.stringify(input.organization).slice(0, 2000)}\n` : ""}${pages}`,
      siteProfileSchema,
      siteProfileResponseSchema,
    );
  }

  async ask(query: string, grounded: boolean): Promise<Result<Answer>> {
    const started = Date.now();
    const data = await this.request(
      {
        contents: [{ role: "user", parts: [{ text: query }] }],
        ...(grounded ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { temperature: 0.4, maxOutputTokens: 1600 },
      },
      grounded,
    );
    const candidate = data.candidates?.[0];
    const answer = (candidate?.content?.parts ?? [])
      .map((p: any) => p.text ?? "")
      .join("")
      .trim();
    if (!answer)
      throw new Error(
        `Gemini returned no answer${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}`,
      );
    const metadata = candidate?.groundingMetadata;
    const sources = (metadata?.groundingChunks ?? []).flatMap((chunk: any) =>
      chunk.web?.uri
        ? [{ uri: chunk.web.uri, title: chunk.web.title ?? "" }]
        : [],
    );
    return {
      value: { answer, sources, queries: metadata?.webSearchQueries ?? [] },
      usage: usage(data),
      durationMs: Date.now() - started,
    };
  }

  async analyseAnswers(
    profile: Profile,
    items: Array<{ id: string; prompt: string; answer: string }>,
  ) {
    const result = await this.structured(
      `Analyse AI assistant answers for how they treat one brand.

BRAND: ${profile.brand}${profile.aliases.length ? ` (also: ${profile.aliases.join(", ")})` : ""}
WHAT IT IS: ${profile.description}
FACTS FROM ITS WEBSITE: ${JSON.stringify(profile.facts)}

For every answer return:
- id: unchanged.
- competitors: every other company, product or brand the answer names or recommends, in the order they appear. Brand names only, no descriptions. Exclude ${profile.brand} itself, generic categories, and review sites, directories, publishers and social platforms (G2, Capterra, Gartner, Clutch, Reddit, LinkedIn, Wikipedia, Forbes).
- sentiment: how the answer portrays ${profile.brand}: positive, neutral, negative, or none if it is not mentioned.
- inaccuracies: statements about ${profile.brand} that contradict the facts above, each as one sentence saying what the answer claimed and what the site says. Empty when nothing contradicts. Never flag something merely because it is absent from the facts.

ANSWERS:
${JSON.stringify(items.map((i) => ({ ...i, answer: i.answer.slice(0, 5000) })))}`,
      analysisSchema,
      analysisResponseSchema,
    );
    return {
      ...result,
      value: result.value.answers.map((a) => ({
        id: a.id,
        competitors: a.competitors,
        sentiment: a.sentiment === "none" ? null : a.sentiment,
        inaccuracies: a.inaccuracies,
      })),
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
          const detail = readableError(await response.text());
          const quota = response.status === 429 && /quota/i.test(detail);
          // Search grounding has its own, much smaller quota. Once it is spent
          // the audit falls back to model-only answers instead of waiting.
          if (grounding && quota)
            throw new GroundingUnavailableError(
              `Google Search grounding quota is exhausted for this API key`,
            );
          last = new Error(
            quota
              ? `Gemini API quota exhausted for ${this.model}`
              : response.status >= 500
                ? `Gemini is overloaded (${response.status})`
                : `Gemini rate limit hit (${detail})`,
          );
          if (quota) throw new PermanentModelError((last as Error).message);
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
          const detail = readableError(await response.text());
          throw new PermanentModelError(
            response.status === 403 || response.status === 401
              ? `Gemini rejected the API key (${response.status}): ${detail}`
              : `Gemini request failed (${response.status}): ${detail}`,
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
/** Google wraps errors in JSON; keep only the human sentence. */
export function readableError(body: string): string {
  try {
    const message = JSON.parse(body)?.error?.message;
    if (typeof message === "string")
      return message
        .split(/\s+For more information/)[0]
        .trim()
        .slice(0, 200);
  } catch {}
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
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
