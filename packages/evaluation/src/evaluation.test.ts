import { describe, expect, it } from "vitest";
import { scanSchema, type PromptResult, type Scan } from "@spectra/schemas";
import {
  brandFromTitle,
  buildActions,
  buildFixPrompt,
  buildLlmsTxt,
  deriveIdentity,
  evaluateReadiness,
  listPosition,
  mentions,
  recognises,
  summariseVisibility,
} from "./index";

function page(url: string, extra: Record<string, unknown> = {}) {
  return {
    url,
    status: 200,
    ms: 300,
    bytes: 40_000,
    title: `Page ${url} | Acme Data`,
    description: "Acme Data sells verified B2B contact data.",
    h1: ["Acme Data"],
    headings: [
      { level: 1, text: "Acme Data" },
      { level: 2, text: "What is Acme Data?" },
      { level: 2, text: "Pricing" },
    ],
    words: 900,
    lang: "en",
    canonical: url,
    internalLinks: ["https://acme.test/about", "https://acme.test/contact"],
    ...extra,
  };
}

function scan(overrides: Partial<Record<string, unknown>> = {}): Scan {
  return scanSchema.parse({
    target: "https://acme.test/",
    finalUrl: "https://acme.test/",
    https: true,
    robots: {
      url: "https://acme.test/robots.txt",
      status: 200,
      body: "User-agent: *\nAllow: /\nSitemap: https://acme.test/sitemap.xml",
    },
    sitemap: {
      url: "https://acme.test/sitemap.xml",
      status: 200,
      urls: 20,
      referenced: true,
    },
    llmsTxt: { url: "https://acme.test/llms.txt", status: 404 },
    llmsFullTxt: { url: "https://acme.test/llms-full.txt", status: 404 },
    bots: [
      { agent: "Browser", status: 200, blocked: false },
      { agent: "GPTBot", status: 200, blocked: false },
    ],
    pages: [
      page("https://acme.test/"),
      page("https://acme.test/about", { title: "About | Acme Data" }),
    ],
    ...overrides,
  });
}

const byId = (s: Scan, id: string) =>
  evaluateReadiness(s, deriveIdentity(s)).checks.find((c) => c.id === id)!;

describe("readiness checks", () => {
  it("fails search crawlers blocked in robots.txt and writes the exact allow rules", () => {
    const s = scan({
      robots: {
        url: "https://acme.test/robots.txt",
        status: 200,
        body: "User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /",
      },
    });
    const check = byId(s, "search-crawlers");
    expect(check.status).toBe("fail");
    expect(check.found).toContain("OAI-SearchBot");
    expect(check.fix?.code).toBe("User-agent: OAI-SearchBot\nAllow: /");
  });

  it("flags a firewall that refuses AI crawlers but serves browsers", () => {
    const s = scan({
      bots: [
        { agent: "Browser", status: 200, blocked: false },
        { agent: "GPTBot", status: 403, blocked: true, note: "answered 403" },
      ],
    });
    expect(byId(s, "firewall").status).toBe("fail");
  });

  it("treats a timeout as inconclusive, not a block", () => {
    const s = scan({
      bots: [
        { agent: "Browser", status: 200, blocked: false },
        {
          agent: "GPTBot",
          status: null,
          blocked: false,
          note: "timed out (inconclusive)",
        },
      ],
    });
    expect(byId(s, "firewall").status).toBe("warn");
  });

  it("fails a JavaScript app shell", () => {
    const s = scan({
      pages: [page("https://acme.test/", { words: 12, appShell: true })],
    });
    expect(byId(s, "server-rendered").status).toBe("fail");
  });

  it("generates an llms.txt from the crawled pages when it is missing", () => {
    const check = byId(scan(), "llms-txt");
    expect(check.status).toBe("fail");
    expect(check.fix?.code).toMatch(/^# Acme Data/);
    expect(check.fix?.code).toContain("(https://acme.test/about)");
  });

  it("scores a clean site higher than a broken one", () => {
    const good = evaluateReadiness(scan(), deriveIdentity(scan()));
    const bad = scan({
      robots: {
        url: "https://acme.test/robots.txt",
        status: 200,
        body: "User-agent: *\nDisallow: /",
      },
      sitemap: { url: "https://acme.test/sitemap.xml", status: 404 },
    });
    expect(evaluateReadiness(bad, deriveIdentity(bad)).score).toBeLessThan(
      good.score,
    );
    expect(good.score).toBeLessThan(100); // no llms.txt, no org schema
  });
});

describe("brand detection", () => {
  const matcher = {
    brand: "Thomson Data",
    aliases: [],
    host: "thomsondata.com",
  };

  it("matches the brand regardless of spacing and case", () => {
    expect(mentions("Try ThomsonData for lists", matcher)).toBe(true);
    expect(mentions("Try ZoomInfo", matcher)).toBe(false);
  });

  it("does not count 'no information about the company' as recognition", () => {
    expect(
      recognises(
        "I couldn't find any information about Thomson Data.",
        matcher,
      ),
    ).toBe(false);
  });

  it("still counts a known brand with no public pricing as recognised", () => {
    expect(
      recognises(
        "Thomson Data is a B2B list vendor. I don't have specific pricing information for Thomson Data.",
        matcher,
      ),
    ).toBe(true);
  });

  it("reads the rank from the answer's own list", () => {
    const answer =
      "Top providers:\n1. **ZoomInfo**: big\n2. **Apollo.io**: cheap\n3. **Thomson Data**: lists";
    expect(listPosition(answer, matcher)).toBe(3);
    expect(
      listPosition("1. ZoomInfo: works with Thomson Data exports", matcher),
    ).toBeNull();
  });

  it("reads the brand out of a page title", () => {
    expect(
      brandFromTitle("Pricing | Acme Analytics", "acmeanalytics.com"),
    ).toBe("Acme Analytics");
  });
});

function result(partial: Partial<PromptResult>): PromptResult {
  return {
    id: "p1",
    text: "best b2b data",
    kind: "category",
    engine: "gemini_search",
    status: "ok",
    answer: "",
    mentioned: false,
    position: null,
    cited: false,
    competitors: [],
    sentiment: null,
    inaccuracies: [],
    sources: [],
    durationMs: 0,
    ...partial,
  };
}

describe("visibility summary and actions", () => {
  const matcher = { brand: "Acme Data", aliases: [], host: "acme.test" };
  const prompts = [
    result({
      id: "p1",
      competitors: ["ZoomInfo", "Apollo"],
      sources: [{ uri: "https://x", title: "g2.com", domain: "g2.com" }],
    }),
    result({
      id: "p2",
      mentioned: true,
      position: 2,
      cited: true,
      competitors: ["ZoomInfo"],
      sources: [{ uri: "https://y", title: "acme.test", domain: "acme.test" }],
    }),
    result({ id: "p3", kind: "branded", mentioned: true }),
    result({ id: "p4", status: "error", error: "Gemini is overloaded (503)" }),
  ];
  const v = summariseVisibility(prompts, matcher, "gemini_search", "");

  it("counts only measured prompts and weights unbranded questions most", () => {
    expect(v.measured).toBe(3);
    expect(v.categoryMentions).toBe(1);
    expect(v.categoryMeasured).toBe(2);
    expect(v.citations).toBe(1);
    // 0.6 * 1/2 + 0.2 * 1/1 + 0.2 * 1/3 grounded (branded is grounded too)
    expect(v.score).toBe(
      Math.round((0.6 * 0.5 + 0.2 * 1 + 0.2 * (1 / 3)) * 100),
    );
  });

  it("ranks competitors by how many answers named them", () => {
    expect(v.shareOfVoice[0]).toEqual({
      name: "ZoomInfo",
      mentions: 2,
      brand: false,
    });
    expect(v.shareOfVoice.find((s) => s.brand)?.mentions).toBe(1);
  });

  it("turns gaps into tasks, highest priority first, with a fix prompt", () => {
    const s = scan();
    const identity = deriveIdentity(s);
    const actions = buildActions(
      evaluateReadiness(s, identity),
      v,
      identity,
      null,
    );
    expect(actions[0].priority).toBe("high");
    expect(actions.map((a) => a.id)).toContain("visibility-absent");
    expect(actions.map((a) => a.id)).toContain("visibility-sources");
    const absent = actions.find((a) => a.id === "visibility-absent")!;
    expect(absent.detail).toContain("ZoomInfo");
    expect(buildLlmsTxt(identity, s.pages)).toContain("## Key pages");
  });

  it("builds a fix prompt that carries tasks and code", () => {
    const s = scan();
    const identity = deriveIdentity(s);
    const readiness = evaluateReadiness(s, identity);
    const prompt = buildFixPrompt({
      id: "x",
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
      scan: s,
      readiness,
      profile: null,
      visibility: v,
      actions: buildActions(readiness, v, identity, null),
      llmsTxt: null,
      warnings: [],
      error: null,
    });
    expect(prompt).toContain("# Make acme.test visible in AI answers");
    expect(prompt).toContain("```markdown");
    expect(prompt).toContain("Named in 1 of 2 unbranded buyer questions");
  });
});
