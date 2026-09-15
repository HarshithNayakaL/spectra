import { describe, expect, it } from "vitest";
import { auditSchema } from "@spectra/schemas";
import { evaluate, selectContract } from "./index";
it("selects restaurant information dimensions", () =>
  expect(
    selectContract({
      primaryEntity: {
        name: "A",
        type: "Organization",
        description: "",
        evidenceIds: ["e1"],
      },
      siteArchetype: "restaurant",
      secondaryArchetypes: [],
      purpose: [],
      intendedAudience: [],
      importantInformationClasses: [],
      expectedUserQuestions: [],
      expectedUserIntents: [],
      confidence: { overall: 1, reasons: [] },
      ambiguities: [],
    }).dimensions.some((d) => d.id === "structured_evidence"),
  ).toBe(true));

describe("measured survival and stability", () => {
  it("uses real retrieval outcomes and preserves N/A", () => {
    const audit = auditSchema.parse({
      id: "00000000-0000-0000-0000-000000000001",
      target: "https://example.com/",
      status: "evaluating",
      createdAt: new Date(0).toISOString(),
      completedAt: null,
      scoringVersion: "spectra-v0.1",
      crawl: {
        target: "https://example.com/",
        startedAt: "fixture",
        completedAt: "fixture",
        robots: {
          url: "https://example.com/robots.txt",
          allowed: true,
          sitemaps: [],
          status: 200,
        },
        pages: [
          {
            id: "p1",
            url: "https://example.com/",
            status: 200,
            title: "Ada",
            description: "Ada created Atlas",
            canonicalUrl: null,
            headings: [],
            text: "Ada created Atlas for Example Labs. This text is deliberately long enough to count as meaningful extracted evidence for this deterministic evaluation.",
            links: [],
            jsonLd: [],
            fingerprint: "abc",
            contentType: "text/html",
            duplicateOf: null,
          },
        ],
        crawlEdges: [],
        warnings: [],
        limits: {
          maxPages: 20,
          maxDepth: 2,
          maxBytes: 2097152,
          timeoutMs: 10000,
          maxRedirects: 5,
        },
      },
      evidence: [
        {
          id: "e1",
          url: "https://example.com/",
          text: "Ada created Atlas",
          selector: "main",
          pageId: "p1",
        },
      ],
      analysis: {
        primaryEntity: {
          name: "Ada",
          type: "Person",
          description: "Engineer",
          evidenceIds: ["e1"],
        },
        siteArchetype: "professional_portfolio",
        secondaryArchetypes: [],
        purpose: ["Portfolio"],
        intendedAudience: ["Employers"],
        importantInformationClasses: ["projects"],
        expectedUserQuestions: [],
        expectedUserIntents: [],
        confidence: { overall: 1, reasons: [] },
        ambiguities: [],
      },
      graph: {
        entities: [
          { id: "ada", name: "Ada", type: "Person", evidenceIds: ["e1"] },
        ],
        relationships: [],
        claims: [
          {
            id: "c1",
            subject: "Ada",
            predicate: "created",
            object: "Atlas",
            importance: 1,
            extractionConfidence: 1,
            informationClass: "projects",
            evidenceIds: ["e1"],
          },
        ],
      },
      contract: null,
      survival: [],
      stability: [],
      metrics: [],
      issues: [],
      recommendations: [],
      modelRuns: [],
      warnings: [],
      retrievals: [
        {
          id: "r1",
          claimId: "c1",
          query: "Who created Atlas?",
          mode: "direct",
          answer: "Ada",
          correct: true,
          evidenceIds: ["e1"],
          status: "passed",
        },
        {
          id: "r2",
          claimId: "c1",
          query: "Who built Atlas?",
          mode: "direct",
          answer: "Unknown",
          correct: false,
          evidenceIds: ["e1"],
          status: "failed",
        },
        {
          id: "r3",
          claimId: "c1",
          query: "Who made Atlas?",
          mode: "search_grounded",
          answer: null,
          correct: null,
          evidenceIds: ["e1"],
          status: "unavailable",
        },
      ],
    });
    const result = evaluate(audit);
    expect(
      result.stability.find((item) => item.mode === "direct")?.stabilityRatio,
    ).toBe(0.5);
    expect(
      result.survival[0].stages.find((item) => item.stage === "retrieval")
        ?.status,
    ).toBe("not_tested");
    expect(
      result.metrics.find(
        (item) => item.dimension === "ai_search_discoverability",
      )?.score,
    ).toBeNull();
  });
});
