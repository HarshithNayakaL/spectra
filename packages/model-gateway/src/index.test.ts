import { describe, expect, it } from "vitest";
import {
  GeminiProvider,
  readableError,
  retryAfterMs,
  stripJsonFence,
} from "./index";

const header = (value: string | null) => ({ headers: { get: () => value } });

describe("Retry-After parsing", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterMs(header("3"))).toBe(3000);
    expect(retryAfterMs(header(" 12 "))).toBe(12_000);
  });

  it("reads an HTTP date in the future", () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    expect(retryAfterMs(header(future))).toBeGreaterThan(10_000);
  });

  it("treats a past date as no delay rather than a negative one", () => {
    expect(retryAfterMs(header("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(0);
  });

  it("returns zero for an absent or unparseable value", () => {
    expect(retryAfterMs(header(null))).toBe(0);
    // A NaN here used to defeat Math.max and collapse the backoff.
    expect(retryAfterMs(header("soon"))).toBe(0);
    expect(Number.isNaN(retryAfterMs(header("soon")))).toBe(false);
  });
});

describe("fenced JSON", () => {
  it("unwraps a Markdown fence", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves bare JSON untouched", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("readable errors", () => {
  it("keeps only Google's sentence, not the JSON envelope", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan. For more information on this error, head to: https://ai.google.dev",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(readableError(body)).toBe(
      "You exceeded your current quota, please check your plan.",
    );
  });

  it("falls back to trimmed text for non-JSON bodies", () => {
    expect(readableError("  upstream\n timeout ")).toBe("upstream timeout");
  });
});

/**
 * The fan-out expansion is the one audit call whose response shape is new, and
 * it cannot be exercised against the live model in CI. These drive the real
 * request, parse and validation path with the payloads Gemini actually returns.
 */
describe("expandFanout", () => {
  const profile = {
    brand: "Acme Data",
    aliases: [],
    category: "B2B contact data provider",
    description: "Acme Data sells verified B2B contact data.",
    audience: "Sales teams",
    market: "United States",
    facts: [],
  };

  function reply(text: string, status = 200) {
    return {
      ok: status === 200,
      status,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
      }),
      text: async () => text,
      headers: { get: () => null },
    } as unknown as Response;
  }

  async function run(text: string) {
    const calls: Array<{ url: string; body: any }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return reply(text);
    }) as typeof fetch;
    try {
      const provider = new GeminiProvider("k", "gemini-3.1-flash-lite");
      const result = await provider.expandFanout({
        profile,
        seed: "best b2b data provider",
        count: 4,
      });
      return { result, calls };
    } finally {
      globalThis.fetch = original;
    }
  }

  const good = JSON.stringify({
    queries: [
      {
        type: "canonicalization",
        query: "b2b contact data provider",
        covers: "The category's own name",
      },
      {
        type: "comparison",
        query: "zoominfo alternatives for small sales teams",
        covers: "A buyer weighing the incumbent",
      },
      {
        type: "specification",
        query: "verified contact data for us saas startups",
        covers: "A narrower cut by market and segment",
      },
      {
        type: "follow_up",
        query: "how accurate is purchased b2b contact data",
        covers: "The objection that follows the shortlist",
      },
    ],
  });

  it("returns typed sub-queries and asks for them without grounding", async () => {
    const { result, calls } = await run(good);
    expect(result.value).toHaveLength(4);
    expect(result.value[0]).toEqual({
      type: "canonicalization",
      query: "b2b contact data provider",
      covers: "The category's own name",
    });
    // An expansion is a planning call: it must not spend search quota.
    expect(calls[0].body.tools).toBeUndefined();
    expect(calls[0].body.generationConfig.responseMimeType).toBe(
      "application/json",
    );
    expect(calls[0].body.generationConfig.responseJsonSchema.required).toEqual([
      "queries",
    ]);
    // The seed and the category both reach the model.
    expect(calls[0].body.contents[0].parts[0].text).toContain(
      "best b2b data provider",
    );
    expect(calls[0].body.contents[0].parts[0].text).toContain(
      "B2B contact data provider",
    );
  });

  it("accepts a fenced response, as some models still send one", async () => {
    const { result } = await run("```json\n" + good + "\n```");
    expect(result.value).toHaveLength(4);
  });

  it("rejects a kind that is not one of the seven", async () => {
    await expect(
      run(
        JSON.stringify({
          queries: [{ type: "vibes", query: "anything", covers: "" }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects an empty expansion rather than reporting zero coverage", async () => {
    await expect(run(JSON.stringify({ queries: [] }))).rejects.toThrow();
  });

  it("defaults a missing 'covers' instead of failing the whole stage", async () => {
    const { result } = await run(
      JSON.stringify({
        queries: [{ type: "equivalent", query: "b2b data vendors" }],
      }),
    );
    expect(result.value[0].covers).toBe("");
  });
});
