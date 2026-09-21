import { describe, expect, it } from "vitest";
import { auditSchema, type Audit, type Intent } from "@spectra/schemas";
import type { ModelProvider } from "@spectra/model-gateway";
import { measureIntent } from "./pipeline";

function audit(): Audit {
  return auditSchema.parse({
    id: "00000000-0000-0000-0000-0000000000aa",
    target: "https://example.com/",
    status: "intents",
    createdAt: new Date(0).toISOString(),
    completedAt: null,
    scoringVersion: "spectra-v0.1",
    crawl: null,
    evidence: [
      {
        id: "p1:body",
        url: "https://example.com/",
        text: "Example.",
        evidenceType: "visible_text",
      },
    ],
    analysis: null,
    graph: null,
    contract: null,
    intents: [],
    survival: [],
    retrievals: [],
    metrics: [],
    issues: [],
    recommendations: [],
    modelRuns: [],
    warnings: [],
  });
}

function intent(): Intent {
  return {
    id: "i1",
    text: "Find a way to contact this person",
    source: "declared",
    successCriteria: ["Gives an email address"],
    criteriaSource: "declared",
    variants: [],
    outcome: "not_run",
    answer: null,
    reason: "",
    metCriteria: [],
    unmetCriteria: [],
    variantsSatisfied: 0,
    variantsMeasured: 0,
    evidenceIds: [],
    retrievalIds: [],
    stages: [],
    failedAt: null,
    durationMs: 0,
  };
}

const ok = <T>(value: T) => ({ value, usage: {}, durationMs: 5 });
const overloaded = () =>
  Promise.reject(
    new Error('Gemini 503: {"status":"UNAVAILABLE","message":"high demand"}'),
  );

function provider(plan: Array<"miss" | "hit" | "503">): ModelProvider {
  let call = 0;
  return {
    generateIntentVariants: async () => ok(["b", "c", "d"]),
    deriveIntentCriteria: async () => ok(["Gives an email address"]),
    attemptIntent: async () => {
      const step = plan[call++] ?? "miss";
      if (step === "503") return overloaded();
      return ok({
        answer: step === "hit" ? "hello@example.com" : "Not stated.",
        metCriteria: step === "hit" ? ["Gives an email address"] : [],
        unmetCriteria: step === "hit" ? [] : ["Gives an email address"],
        satisfied: step === "hit",
        reason: "",
      });
    },
  } as unknown as ModelProvider;
}

describe("intent measurement under provider failures", () => {
  it("keeps a measured phrasing when a later phrasing is overloaded", async () => {
    const a = audit(),
      i = intent();
    await measureIntent(
      a,
      provider(["miss", "503", "503", "503"]),
      i,
      "m",
      a.id,
    );
    // Previously this reported "error" and discarded the real result.
    expect(i.outcome).toBe("unsatisfied");
    expect(i.variantsMeasured).toBe(1);
    expect(i.unmetCriteria).toEqual(["Gives an email address"]);
    expect(i.error).toContain("3 of 4 phrasings could not be run");
    expect(i.error).toContain("overloaded");
  });

  it("scores partial success across mixed outcomes", async () => {
    const a = audit(),
      i = intent();
    await measureIntent(
      a,
      provider(["hit", "503", "miss", "hit"]),
      i,
      "m",
      a.id,
    );
    expect(i.outcome).toBe("partial");
    expect(i.variantsSatisfied).toBe(2);
    expect(i.variantsMeasured).toBe(3);
    expect(i.metCriteria).toEqual(["Gives an email address"]);
    expect(i.unmetCriteria).toEqual([]);
  });

  it("reports an error only when no phrasing ran at all", async () => {
    const a = audit(),
      i = intent();
    await measureIntent(
      a,
      provider(["503", "503", "503", "503"]),
      i,
      "m",
      a.id,
    );
    expect(i.outcome).toBe("error");
    expect(i.variantsMeasured).toBe(0);
  });

  it("records a retrieval for every phrasing, failed ones included", async () => {
    const a = audit(),
      i = intent();
    await measureIntent(
      a,
      provider(["hit", "503", "hit", "hit"]),
      i,
      "m",
      a.id,
    );
    const runs = a.retrievals.filter((r) => r.intentId === "i1");
    expect(runs).toHaveLength(4);
    expect(runs.filter((r) => r.status === "error")).toHaveLength(1);
  });

  it("stops starting phrasings once the deadline is close", async () => {
    const a = audit(),
      i = intent();
    await measureIntent(
      a,
      provider(["hit", "hit", "hit", "hit"]),
      i,
      "m",
      a.id,
      Date.now() + 1000,
    );
    // The first phrasing always runs; later ones are not started past the deadline.
    expect(i.variantsMeasured).toBe(1);
    expect(i.outcome).toBe("satisfied");
  });
});
