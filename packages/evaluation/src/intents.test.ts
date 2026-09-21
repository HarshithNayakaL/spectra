import { describe, expect, it } from "vitest";
import { auditSchema, type Audit } from "@spectra/schemas";
import { evaluate } from "./index";

function fixture(intents: unknown[]): Audit {
  return auditSchema.parse({
    id: "00000000-0000-0000-0000-0000000000ff",
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
          title: "Example",
          description: "Example sells seats",
          canonicalUrl: null,
          headings: [],
          text: "Example sells seats to teams. This body text is deliberately long enough to register as meaningful extracted content for the deterministic checks.",
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
        text: "Example sells seats to teams.",
        evidenceType: "visible_text",
        pageId: "p1",
      },
    ],
    analysis: null,
    graph: null,
    contract: null,
    intents,
    survival: [],
    retrievals: [],
    metrics: [],
    issues: [],
    recommendations: [],
    modelRuns: [],
    warnings: [],
  });
}

const base = {
  id: "i1",
  text: "Find the enterprise plan price per seat",
  source: "declared",
  successCriteria: ["States a per-seat price", "Names the enterprise plan"],
  criteriaSource: "declared",
  variants: ["a", "b", "c"],
};

function metric(audit: Audit) {
  return audit.metrics.find((m) => m.dimension === "intent_completion");
}

describe("intent completion scoring", () => {
  it("is not applicable when no intents were declared or inferred", () => {
    const audit = evaluate(fixture([]));
    const dimension = metric(audit);
    expect(dimension?.score).toBeNull();
    expect(dimension?.notApplicable[0]?.limitation).toBe(
      "No intents were declared for this audit",
    );
  });

  it("stays not applicable when intents were declared but never tested", () => {
    const audit = evaluate(
      fixture([{ ...base, outcome: "not_run", variantsMeasured: 0 }]),
    );
    expect(metric(audit)?.score).toBeNull();
    expect(metric(audit)?.notApplicable[0]?.limitation).toBe(
      "Intents were declared but could not be tested",
    );
  });

  it("scores a fully satisfied intent at 100", () => {
    const audit = evaluate(
      fixture([
        {
          ...base,
          outcome: "satisfied",
          variantsSatisfied: 3,
          variantsMeasured: 3,
          metCriteria: base.successCriteria,
        },
      ]),
    );
    expect(metric(audit)?.score).toBe(100);
    expect(audit.issues.some((i) => i.type === "intent_not_completable")).toBe(
      false,
    );
  });

  it("scores an unsatisfied intent at 0 and raises a critical issue", () => {
    const audit = evaluate(
      fixture([
        {
          ...base,
          outcome: "unsatisfied",
          variantsSatisfied: 0,
          variantsMeasured: 3,
          unmetCriteria: ["States a per-seat price"],
          failedAt: "model_understanding",
        },
      ]),
    );
    expect(metric(audit)?.score).toBe(0);
    const issue = audit.issues.find((i) => i.type === "intent_not_completable");
    expect(issue?.severity).toBe("critical");
    expect(issue?.title).toContain("cannot complete");
    expect(issue?.recommendedFix).toContain("1 missing fact");
  });

  it("gives partial credit by phrasing and flags the instability", () => {
    const audit = evaluate(
      fixture([
        {
          ...base,
          outcome: "partial",
          variantsSatisfied: 1,
          variantsMeasured: 4,
          unmetCriteria: ["Names the enterprise plan"],
        },
      ]),
    );
    expect(metric(audit)?.score).toBe(25);
    const issue = audit.issues.find((i) => i.type === "intent_not_completable");
    expect(issue?.severity).toBe("high");
    expect(issue?.description).toContain("1 of 4 phrasings");
  });

  it("averages across intents rather than across phrasings", () => {
    const audit = evaluate(
      fixture([
        {
          ...base,
          id: "i1",
          outcome: "satisfied",
          variantsSatisfied: 4,
          variantsMeasured: 4,
        },
        {
          ...base,
          id: "i2",
          text: "Book a demo",
          outcome: "unsatisfied",
          variantsSatisfied: 0,
          variantsMeasured: 1,
        },
      ]),
    );
    expect(metric(audit)?.score).toBe(50);
  });

  it("turns every unmet intent into a recommendation", () => {
    const audit = evaluate(
      fixture([
        {
          ...base,
          outcome: "unsatisfied",
          variantsSatisfied: 0,
          variantsMeasured: 2,
          unmetCriteria: ["States a per-seat price"],
        },
      ]),
    );
    const fix = audit.recommendations.find((r) =>
      r.issueId.startsWith("intent-"),
    );
    expect(fix?.where).toBe("intent completion");
    // The criterion is a judging condition, so it belongs in missingFacts, not
    // inlined into a sentence that reads as the copy to publish.
    expect(fix?.missingFacts).toEqual(["States a per-seat price"]);
    expect(fix?.steps.join(" ")).toContain("crawlable text");
    expect(fix?.verify).toContain("Re-run the audit");
  });

  it("weights intent completion above the other dimensions", () => {
    const audit = evaluate(
      fixture([
        {
          ...base,
          outcome: "satisfied",
          variantsSatisfied: 1,
          variantsMeasured: 1,
        },
      ]),
    );
    const applied = metric(audit)?.applied[0];
    expect(applied?.weight).toBe(3);
  });
});
