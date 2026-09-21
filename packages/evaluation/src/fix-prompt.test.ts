import { describe, expect, it } from "vitest";
import { auditSchema, type Audit } from "@spectra/schemas";
import {
  buildFixPrompt,
  estimateTokens,
  evaluate,
  rankFixes,
  scoreImpact,
} from "./index";

function fixture(over: Record<string, unknown> = {}): Audit {
  return auditSchema.parse({
    id: "00000000-0000-0000-0000-00000000fix0",
    target: "https://example.com/",
    status: "complete",
    createdAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    scoringVersion: "spectra-v0.1",
    crawl: {
      target: "https://example.com/",
      startedAt: "f",
      completedAt: "f",
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
          title: "Example",
          description: "",
          canonicalUrl: null,
          headings: [],
          text: "Example sells seats to teams and this body is long enough to register as meaningful extracted content for the checks.",
          links: [],
          jsonLd: [],
          fingerprint: "a",
          contentType: "text/html",
          duplicateOf: null,
        },
      ],
      crawlEdges: [],
      warnings: [],
      limits: {
        maxPages: 20,
        maxDepth: 2,
        maxBytes: 1,
        timeoutMs: 1,
        maxRedirects: 5,
      },
    },
    evidence: [
      {
        id: "p1:title",
        url: "https://example.com/",
        text: "Example",
        evidenceType: "title",
        pageId: "p1",
      },
      {
        id: "p1:body",
        url: "https://example.com/",
        text: "Example sells seats.",
        evidenceType: "visible_text",
        pageId: "p1",
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
    ...over,
  });
}

const failedIntent = {
  id: "i1",
  text: "Find a way to contact this person",
  source: "declared",
  successCriteria: ["Provides an email address"],
  criteriaSource: "declared",
  variants: ["a", "b"],
  outcome: "unsatisfied",
  variantsSatisfied: 0,
  variantsMeasured: 2,
  unmetCriteria: ["Provides an email address"],
  failedAt: "model_understanding",
};

describe("score impact", () => {
  it("is exact, computed from weight over the applied denominator", () => {
    const checks = [
      {
        id: "a",
        dimension: "structured_evidence",
        label: "",
        status: "fail",
        value: 0,
        weight: 1,
        evidenceIds: [],
      },
      {
        id: "b",
        dimension: "machine_accessibility",
        label: "",
        status: "pass",
        value: 1,
        weight: 3,
        evidenceIds: [],
      },
    ] as never;
    // 1 x (1 - 0) out of a denominator of 4 is 25 points.
    expect(scoreImpact(checks, ["a"])).toBe(25);
    expect(scoreImpact(checks, ["b"])).toBe(0);
  });

  it("ignores N/A checks, whose denominator movement cannot be quoted honestly", () => {
    const checks = [
      {
        id: "a",
        dimension: "structured_evidence",
        label: "",
        status: "na",
        value: 0,
        weight: 5,
        evidenceIds: [],
      },
      {
        id: "b",
        dimension: "machine_accessibility",
        label: "",
        status: "fail",
        value: 0,
        weight: 1,
        evidenceIds: [],
      },
    ] as never;
    expect(scoreImpact(checks, ["a"])).toBe(0);
    expect(scoreImpact(checks, ["b"])).toBe(100);
  });

  it("returns zero rather than dividing by zero when nothing applies", () =>
    expect(scoreImpact([], ["a"])).toBe(0));
});

describe("fix ranking", () => {
  it("puts critical first, then orders by points recoverable", () => {
    const ranked = rankFixes([
      { severity: "medium", scoreImpact: 9 },
      { severity: "critical", scoreImpact: 1 },
      { severity: "medium", scoreImpact: 20 },
      { severity: "high", scoreImpact: 2 },
    ] as never);
    expect(ranked.map((r) => `${r.severity}:${r.scoreImpact}`)).toEqual([
      "critical:1",
      "high:2",
      "medium:20",
      "medium:9",
    ]);
  });
});

describe("fix prompt", () => {
  const audit = evaluate(fixture({ intents: [failedIntent] }));

  it("names the target, the score and the exact recoverable total", () => {
    const p = buildFixPrompt(audit);
    expect(p).toContain("# Fix plan for example.com");
    expect(p).toMatch(
      /Recoverable from the fixes below: \+\d+\.\d pts?|Recoverable from the fixes below: \+\d+\.\d points/,
    );
  });

  it("separates the finding from the fix and closes with a verify step", () => {
    const p = buildFixPrompt(audit);
    expect(p).toContain("**Finding:**");
    expect(p).toContain("**Fix:**");
    expect(p).toContain("**Verify:**");
  });

  it("lists the unmet facts and states that no record contains them", () => {
    const p = buildFixPrompt(audit);
    expect(p).toContain("Provides an email address");
    expect(p).toContain("None contains the facts above");
  });

  it("does not cite evidence ids for a finding that is an absence", () => {
    const fix = audit.recommendations.find((r) => r.issueId === "intent-i1");
    expect(fix?.evidenceIds).toEqual([]);
  });

  it("tells the agent not to invent facts", () =>
    expect(buildFixPrompt(audit)).toContain("Do not invent facts"));

  it("carries the declared intents into the re-audit command", () => {
    const p = buildFixPrompt(audit, { apiUrl: "https://api.test" });
    expect(p).toContain("https://api.test/api/audits");
    expect(p).toContain("Find a way to contact this person");
    expect(p).toContain('"successCriteria"');
  });

  it("includes only the selected fixes", () => {
    const one = audit.recommendations[0];
    const p = buildFixPrompt(audit, { selected: [one.id] });
    expect(p).toContain(one.whatFailed);
    expect(p.match(/^### \d+\./gm)?.length).toBe(1);
  });

  it("says so plainly when there is nothing to fix", () => {
    const clean = fixture();
    clean.crawl!.pages[0].description = "Example sells seats to teams";
    clean.crawl!.pages[0].jsonLd = [{ "@type": "Organization" }];
    const p = buildFixPrompt(evaluate(clean));
    expect(p).toContain("No evidence-backed fixes");
  });

  it("estimates a token budget", () =>
    expect(estimateTokens("abcd".repeat(100))).toBe(100));
});
