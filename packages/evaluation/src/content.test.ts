import { describe, expect, it } from "vitest";
import {
  fanoutQuerySchema,
  fanoutSchema,
  pageSignalsSchema,
  type Audit,
} from "@spectra/schemas";
import { buildCitability, isLiftable, scorePage } from "./citability";
import { buildBriefs, slugOf } from "./briefs";
import { buildFixPrompt } from "./fix-prompt";

const LIFT =
  "Acme Ledger is an invoicing tool for freelancers that sends invoices, chases late payments and reconciles bank feeds, and it costs $12 a month for up to 50 clients across 30 countries.";

function page(over: Record<string, unknown> = {}) {
  return pageSignalsSchema.parse({
    url: "https://acme.test/",
    status: 200,
    ms: 100,
    bytes: 1000,
    structureRead: true,
    ...over,
  });
}

function audit(over: Partial<Audit> = {}): Audit {
  return {
    id: "a1",
    version: "spectra-v2",
    target: "acme.test",
    host: "acme.test",
    status: "complete",
    stage: "",
    createdAt: "",
    completedAt: null,
    durationMs: 0,
    model: "m",
    customPrompts: [],
    scan: null,
    readiness: null,
    profile: null,
    visibility: null,
    fanout: null,
    actions: [],
    llmsTxt: null,
    warnings: [],
    error: null,
    ...over,
  };
}

function scanOf(pages: ReturnType<typeof page>[]) {
  return { pages } as unknown as Audit["scan"];
}

describe("citability", () => {
  it("treats a passage that leans on context as not liftable", () => {
    expect(isLiftable(LIFT)).toBe(true);
    expect(isLiftable(`This ${LIFT.slice(5)}`)).toBe(false);
    expect(isLiftable("Too short to quote.")).toBe(false);
  });

  it("scores a page from what its HTML carries, and names the passage", () => {
    const strong = scorePage(
      page({
        lead: LIFT,
        passages: [LIFT, LIFT.replace("Acme Ledger", "Acme Sync"), LIFT, LIFT],
        excerpt: `${LIFT} Founded 2019. 99.9% uptime. 4 hours support.`,
        lists: 2,
        tables: 1,
        questionHeadings: 3,
        hasDate: true,
        hasAuthor: true,
        jsonLdTypes: ["SoftwareApplication"],
      }),
    );
    expect(strong.score).toBe(100);
    expect(strong.best).toContain("Acme");
    expect(strong.liftable).toBe(4);

    const weak = scorePage(
      page({ passages: ["It is great. We love it a lot."] }),
    );
    expect(weak.score).toBe(0);
    expect(weak.next).toMatch(/Open with one sentence/);
  });

  it("scores a page that ships no text as zero, whatever its markup", () => {
    const shell = scorePage(
      page({ appShell: true, jsonLdTypes: ["Organization"], hasDate: true }),
    );
    expect(shell.score).toBe(0);
    expect(shell.next).toMatch(/JavaScript/);
  });

  it("says an old scan was not measured instead of scoring it empty", () => {
    const citability = buildCitability(
      audit({ scan: scanOf([page({ structureRead: false })]) }),
    );
    expect(citability?.score).toBeNull();
    expect(citability?.unmeasured).toHaveLength(1);
    expect(buildCitability(audit())).toBeNull();
  });
});

describe("content briefs", () => {
  const retrieval = (over: Record<string, unknown>) => ({
    status: "missing",
    url: "",
    coverage: 0,
    matched: [],
    missingTerms: ["alternatives", "hubspot"],
    ...over,
  });
  const fanout = (queries: Array<Record<string, unknown>>) =>
    fanoutSchema.parse({
      seed: "best invoicing tool",
      engine: "gemini_model",
      queries: queries.map((query, index) =>
        fanoutQuerySchema.parse({
          id: `q${index}`,
          type: "comparison",
          status: "skipped",
          ...query,
        }),
      ),
    });

  it("turns lost, missing and thin sub-queries into briefs, worst first", () => {
    const briefs = buildBriefs(
      audit({
        profile: {
          brand: "Acme",
          aliases: [],
          category: "invoicing",
          description: "",
          audience: "",
          market: "",
          facts: [],
        },
        fanout: fanout([
          {
            query: "invoicing for freelancers",
            type: "specification",
            retrieval: retrieval({
              status: "weak",
              url: "https://acme.test/pricing",
              coverage: 0.5,
              matched: ["invoicing"],
              missingTerms: ["freelancers"],
            }),
          },
          { query: "Acme alternatives to HubSpot?", retrieval: retrieval({}) },
          {
            query: "acme vs zoho invoice",
            retrieval: retrieval({
              status: "answered",
              url: "https://acme.test/vs",
              coverage: 0.8,
              lost: true,
              rival: {
                host: "zoho.test",
                url: "https://zoho.test/vs-acme",
                title: "Zoho vs Acme",
                coverage: 1,
                score: 4,
              },
            }),
          },
          {
            query: "what is invoicing",
            retrieval: retrieval({ status: "answered", coverage: 1 }),
          },
          // Same words as the second: one page, one brief.
          { query: "HubSpot alternatives Acme", retrieval: retrieval({}) },
        ]),
      }),
    );
    expect(briefs.map((brief) => brief.reason)).toEqual([
      "lost",
      "missing",
      "weak",
    ]);
    const [lost, missing, weak] = briefs;
    expect(lost.action).toBe("extend");
    expect(lost.target).toBe("https://acme.test/vs");
    expect(lost.rival?.host).toBe("zoho.test");
    expect(missing.action).toBe("write");
    expect(missing.target).toBe(
      "https://acme.test/acme-alternatives-to-hubspot",
    );
    expect(missing.title).toBe("Acme alternatives to HubSpot");
    expect(missing.mustCover).toEqual(["alternatives", "hubspot"]);
    expect(JSON.parse(missing.schema).mainEntity[0].name).toBe(
      "Acme alternatives to HubSpot?",
    );
    expect(weak.action).toBe("extend");
    expect(weak.markdown).toContain("**Must cover:** freelancers");
    expect(weak.markdown).toContain("retrievable, but thin");

    // The full fix prompt carries the briefs; a single-task prompt does not.
    const withBriefs = audit({
      fanout: fanout([{ query: "acme pricing", retrieval: retrieval({}) }]),
    });
    expect(buildFixPrompt(withBriefs)).toContain("## Content to write");
    expect(buildFixPrompt(withBriefs)).toContain("### Write: Acme pricing");
    expect(buildFixPrompt(withBriefs, [])).not.toContain("Content to write");
  });

  it("makes paths a person would type", () => {
    expect(slugOf("C++ vs C# for games")).toBe(
      "c-plus-plus-vs-c-sharp-for-games",
    );
    expect(slugOf("???")).toBe("page");
    const long = slugOf(
      "the most complete comparison of invoicing tools for freelancers in europe",
    );
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("-")).toBe(false);
    expect(
      "the-most-complete-comparison-of-invoicing-tools-for-freelancers-in-europe".startsWith(
        long,
      ),
    ).toBe(true);
  });
});
