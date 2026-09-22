import { describe, expect, it } from "vitest";
import { pageSignalsSchema, scanSchema, type Audit } from "@spectra/schemas";
import { validateStructuredData } from "./structured";
import { buildPageReport } from "./page";
import { compareSites } from "./compare";
import { diffEntries, historyEntryOf } from "./history";

function page(over: Record<string, unknown> = {}) {
  return pageSignalsSchema.parse({
    url: "https://acme.test/pricing",
    status: 200,
    ms: 100,
    bytes: 1000,
    structureRead: true,
    title: "Pricing",
    description: "Acme pricing",
    words: 400,
    ...over,
  });
}

function scan(
  host: string,
  pages: ReturnType<typeof page>[],
  over: Record<string, unknown> = {},
) {
  const probe = {
    url: `https://${host}/x`,
    status: 404,
    bytes: 0,
    contentType: "",
    body: "",
  };
  return scanSchema.parse({
    target: `https://${host}/`,
    finalUrl: `https://${host}/`,
    https: true,
    robots: { ...probe, status: 200, body: "User-agent: *\nAllow: /" },
    sitemap: probe,
    llmsTxt: probe,
    llmsFullTxt: probe,
    bots: [],
    pages,
    ...over,
  });
}

describe("structured data", () => {
  it("names what each node is missing, including nested ones", () => {
    const rows = validateStructuredData([
      {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme", url: "/" },
          {
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "Price?",
                acceptedAnswer: { "@type": "Answer", text: "" },
              },
            ],
          },
          { "@type": "SoftwareApplication", name: "Acme" },
          { "@type": "Article", headline: "Launch", datePublished: "soon" },
        ],
      },
    ]);
    const byType = Object.fromEntries(rows.map((row) => [row.type, row]));
    expect(byType.Organization.ok).toBe(false);
    expect(byType.Organization.problems[0]).toMatch(/not absolute/);
    expect(byType.FAQPage.ok).toBe(true);
    expect(byType.Question.problems).toContain(
      "The accepted answer has no text.",
    );
    expect(byType.SoftwareApplication.missingRequired).toEqual([
      "offers or aggregateRating or review",
    ]);
    expect(byType.Article.problems[0]).toMatch(/not a date/);
  });
});

describe("page report", () => {
  it("combines robots, firewall and snippet controls into findings", () => {
    const report = buildPageReport({
      page: page({
        metaRobots: "max-snippet:20",
        canonical: "https://acme.test/other",
        excerpt: "Acme pricing starts at $10 per seat.",
      }),
      robotsText:
        "User-agent: PerplexityBot\nDisallow: /pricing\n\nUser-agent: *\nAllow: /",
      probes: [
        { agent: "Browser", status: 200, blocked: false, note: "" },
        {
          agent: "OAI-SearchBot",
          status: 403,
          blocked: true,
          note: "answered 403",
        },
      ],
      question: "acme price per seat for startups",
    });
    const row = (token: string) =>
      report.crawlers.find((item) => item.token === token)!;
    expect(row("PerplexityBot").robots).toBe("blocked");
    expect(row("PerplexityBot").reaches).toBe(false);
    expect(row("OAI-SearchBot").reaches).toBe(false);
    expect(row("Googlebot").reaches).toBe(true);
    expect(report.controls.maxSnippet).toBe(20);
    expect(report.controls.canonicalElsewhere).toBe(true);
    const text = report.findings.map((finding) => finding.text).join("\n");
    expect(text).toMatch(
      /OAI-SearchBot, PerplexityBot cannot fetch this page \(robots\.txt\), while a browser gets through/,
    );
    expect(text).toMatch(/max-snippet:20/);
    expect(report.findings[0].severity).toBe("high");
    expect(report.match?.missingTerms).toEqual(["startups"]);
  });

  it("treats a missing robots.txt as allowing everyone", () => {
    const report = buildPageReport({
      page: page(),
      robotsText: null,
      probes: [],
    });
    expect(
      report.crawlers.every((row) => row.robots === "no-file" && row.reaches),
    ).toBe(true);
    expect(report.match).toBeNull();
  });
});

describe("compare", () => {
  it("scores sites the same way and decides questions by retrieval", () => {
    const result = compareSites({
      sites: [
        {
          host: "acme.test",
          scan: scan("acme.test", [
            page({
              url: "https://acme.test/",
              title: "Acme invoicing",
              excerpt: "Invoicing for freelancers.",
            }),
          ]),
          error: "",
        },
        {
          host: "rival.test",
          scan: scan("rival.test", [
            page({
              url: "https://rival.test/",
              title: "Rival",
              excerpt: "Invoicing and payroll for freelancers and agencies.",
            }),
          ]),
          error: "",
        },
        { host: "down.test", scan: null, error: "answered 503" },
      ],
      questions: [
        "payroll for agencies",
        "invoicing freelancers",
        "space travel",
      ],
    });
    expect(result.you).toBe("acme.test");
    expect(result.sites[2]).toMatchObject({
      measured: false,
      readiness: null,
      error: "answered 503",
    });
    expect(result.questions.map((row) => row.winner)).toEqual([
      "rival.test",
      "acme.test",
      null,
    ]);
    // The site that could not be crawled is left out of the question columns.
    expect(result.questions[0].results.map((row) => row.host)).toEqual([
      "acme.test",
      "rival.test",
    ]);
    expect(result.takeaways.join(" ")).toMatch(/payroll for agencies/);
  });
});

describe("history", () => {
  it("never reads a missing measurement as a drop", () => {
    const base = {
      id: "a",
      host: "acme.test",
      status: "complete",
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:00Z",
      model: "m",
      scan: null,
      visibility: null,
      fanout: null,
      readiness: {
        score: 60,
        grade: "C",
        layers: [],
        checks: [
          {
            id: "llms-txt",
            layer: "agent",
            label: "llms.txt",
            status: "fail",
            weight: 1,
            earned: 0,
            found: "",
            why: "",
            urls: [],
            fix: null,
          },
        ],
      },
    } as unknown as Audit;
    const before = historyEntryOf(base);
    const after = historyEntryOf({
      ...base,
      id: "b",
      readiness: { ...base.readiness!, score: 72, checks: [] },
    } as Audit);
    const diff = diffEntries(before, after);
    expect(diff.changes[0]).toMatchObject({
      metric: "AI readiness",
      from: 60,
      to: 72,
      delta: 12,
    });
    expect(diff.changes[1].delta).toBeNull();
    expect(diff.fixed.map((check) => check.label)).toEqual(["llms.txt"]);
    expect(diff.broke).toEqual([]);
  });
});
