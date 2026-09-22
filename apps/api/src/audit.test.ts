import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { scanSchema } from "@spectra/schemas";
import {
  GroundingUnavailableError,
  PermanentModelError,
  type ModelProvider,
} from "@spectra/model-gateway";

process.env.SPECTRA_DATA_DIR = mkdtempSync(join(tmpdir(), "spectra-audit-"));

vi.mock("./scan", () => ({
  ScanError: class extends Error {},
  scanSite: async () =>
    scanSchema.parse({
      target: "https://acme.test/",
      finalUrl: "https://acme.test/",
      https: true,
      robots: {
        url: "https://acme.test/robots.txt",
        status: 200,
        body: "User-agent: *\nAllow: /",
      },
      sitemap: { url: "https://acme.test/sitemap.xml", status: 404 },
      llmsTxt: { url: "https://acme.test/llms.txt", status: 404 },
      llmsFullTxt: { url: "https://acme.test/llms-full.txt", status: 404 },
      bots: [{ agent: "Browser", status: 200, blocked: false }],
      pages: [
        {
          url: "https://acme.test/",
          status: 200,
          ms: 200,
          bytes: 1000,
          title: "Acme Data | B2B data",
          words: 600,
        },
      ],
    }),
}));

let runAudit: typeof import("./audit").runAudit;
beforeAll(async () => {
  ({ runAudit } = await import("./audit"));
});

function fakeProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    model: "fake",
    profileSite: async () => ({
      value: {
        brand: "Acme Data",
        aliases: [],
        category: "B2B data provider",
        description: "Acme Data sells B2B contact data.",
        audience: "",
        market: "",
        facts: ["323M profiles"],
        categoryPrompts: ["best b2b data providers", "zoominfo alternatives"],
        brandedPrompts: ["what is acme data"],
      },
      usage: {},
      durationMs: 1,
    }),
    ask: async (query) => ({
      value: {
        answer: query.includes("best")
          ? "1. ZoomInfo\n2. Acme Data\n3. Apollo"
          : query.includes("acme")
            ? "Acme Data is a B2B data vendor."
            : "1. Apollo\n2. Lusha",
        sources: [{ uri: "https://r.test/1", title: "g2.com" }],
        queries: [],
      },
      usage: {},
      durationMs: 1,
    }),
    expandFanout: async ({ count }) => ({
      value: [
        {
          type: "comparison" as const,
          query: "zoominfo alternatives for startups",
          covers: "A buyer comparing against the incumbent",
        },
        {
          type: "canonicalization" as const,
          query: "b2b contact data provider",
          covers: "The category's own name",
        },
        {
          type: "specification" as const,
          query: "contact data for seed stage sales teams",
          covers: "A narrower cut of the category",
        },
      ].slice(0, count),
      usage: {},
      durationMs: 1,
    }),
    analyseAnswers: async (_profile, items) => ({
      value: items.map((item) => ({
        id: item.id,
        competitors: item.answer.includes("Apollo")
          ? ["Apollo", "ZoomInfo"]
          : [],
        sentiment: null,
        inaccuracies: [],
      })),
      usage: {},
      durationMs: 1,
    }),
    ...overrides,
  };
}

describe("runAudit", () => {
  it("measures mentions, rank, competitors and custom prompts", async () => {
    const audit = await runAudit(
      "acme.test",
      () => {},
      ["who sells verified phone numbers"],
      undefined,
      {
        provider: fakeProvider(),
      },
    );
    expect(audit.status).toBe("complete");
    const v = audit.visibility!;
    expect(v.prompts.map((p) => p.kind)).toEqual([
      "custom",
      "category",
      "category",
      "branded",
    ]);
    expect(v.prompts[1]).toMatchObject({ mentioned: true, position: 2 });
    expect(v.prompts[2].mentioned).toBe(false);
    expect(v.categoryMeasured).toBe(3);
    expect(v.categoryMentions).toBe(1);
    expect(v.shareOfVoice[0].name).toBe("Apollo");
    expect(audit.readiness!.score).toBeLessThan(100);
    expect(audit.actions.some((a) => a.id === "visibility-absent")).toBe(true);
    expect(audit.llmsTxt).toContain("# Acme Data");
  });

  it("falls back to model-only answers when grounding quota is gone", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider({
        ask: async (query, grounded) => {
          if (grounded)
            throw new GroundingUnavailableError(
              "Google Search grounding quota is exhausted for this API key",
            );
          return {
            value: { answer: `About ${query}`, sources: [], queries: [] },
            usage: {},
            durationMs: 1,
          };
        },
      }),
    });
    expect(audit.visibility!.engine).toBe("gemini_model");
    expect(
      audit.visibility!.prompts.every(
        (p) => p.status === "ok" && p.engine === "gemini_model",
      ),
    ).toBe(true);
    expect(audit.visibility!.engineNote).toMatch(/quota/);
  });

  it("keeps answered questions when a later one errors", async () => {
    let calls = 0;
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider({
        ask: async () => {
          calls += 1;
          if (calls === 2) throw new Error("Gemini is overloaded (503)");
          return {
            value: { answer: "Acme Data", sources: [], queries: [] },
            usage: {},
            durationMs: 1,
          };
        },
      }),
    });
    const statuses = audit.visibility!.prompts.map((p) => p.status);
    expect(statuses).toEqual(["ok", "error", "ok"]);
    expect(audit.status).toBe("partial");
  });

  it("stops asking and says why when the API key's quota is spent", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider({
        ask: async () => {
          throw new PermanentModelError("Gemini API quota exhausted for fake");
        },
      }),
    });
    expect(audit.visibility!.prompts[0].status).toBe("error");
    expect(
      audit.visibility!.prompts.slice(1).every((p) => p.status === "skipped"),
    ).toBe(true);
    expect(audit.warnings.join(" ")).toMatch(/quota exhausted/);
  });

  it("still returns readiness when no API key is configured", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      apiKey: "",
    });
    expect(audit.status).toBe("partial");
    expect(audit.readiness).not.toBeNull();
    expect(audit.visibility).toBeNull();
  });
});

describe("the fan-out stage", () => {
  it("runs the expansion and measures each sub-query", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider(),
    });
    const fanout = audit.fanout!;
    expect(fanout).not.toBeNull();
    expect(fanout.seed).not.toBe("");
    expect(fanout.measured).toBe(3);
    expect(fanout.queries.map((query) => query.type)).toEqual([
      "comparison",
      "canonicalization",
      "specification",
    ]);
    // The fake answers "best…" with Acme in second place and everything else
    // without it, so exactly one sub-query reaches the brand.
    expect(fanout.mentions).toBe(0);
    expect(fanout.coverage).toBe(0);
    expect(fanout.byType.map((row) => row.type)).toEqual([
      "canonicalization",
      "specification",
      "comparison",
    ]);
    expect(fanout.answeredBy[0]).toEqual({
      domain: "g2.com",
      count: 3,
      own: false,
    });
    // Competitors come from the same reader the prompts use.
    expect(fanout.queries.some((query) => query.competitors.length)).toBe(true);
  });

  it("records which queries the search tool actually typed", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider({
        ask: async () => ({
          value: {
            answer: "1. Apollo",
            sources: [],
            queries: ["b2b data vendors 2026", "B2B Data Vendors 2026"],
          },
          usage: {},
          durationMs: 1,
        }),
      }),
    });
    expect(audit.visibility!.prompts[0].issuedQueries).toEqual([
      "b2b data vendors 2026",
      "B2B Data Vendors 2026",
    ]);
    // De-duplicated case-insensitively on the way into the summary.
    expect(audit.fanout!.issued).toEqual(["b2b data vendors 2026"]);
  });

  it("says why it skipped rather than reporting a silent zero", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider({
        ask: async () => {
          throw new GroundingUnavailableError("no grounding here");
        },
      }),
    });
    expect(audit.fanout!.measured).toBe(0);
    expect(audit.fanout!.coverage).toBeNull();
    expect(audit.fanout!.engineNote).toContain("live search was unavailable");
  });

  it("keeps the audit alive when the expansion itself fails", async () => {
    const audit = await runAudit("acme.test", () => {}, [], undefined, {
      provider: fakeProvider({
        expandFanout: async () => {
          throw new Error("model said no");
        },
      }),
    });
    expect(audit.status).toBe("complete");
    expect(audit.fanout!.engineNote).toContain("model said no");
    expect(audit.visibility!.measured).toBeGreaterThan(0);
  });
});
