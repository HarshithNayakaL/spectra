import { describe, expect, it } from "vitest";
import type { JourneyStep, NavigatorContext } from "@spectra/schemas";
import {
  classifyFetch,
  customIntent,
  findIntent,
  heuristicMove,
  judgeJourney,
  proveIntent,
  rankRoutes,
  type FetchOutcome,
  type JourneyIntentSpec,
} from "./journey";

const pricing = findIntent("pricing") as JourneyIntentSpec;
const contact = findIntent("contact") as JourneyIntentSpec;

function fetched(overrides: Partial<FetchOutcome> = {}): FetchOutcome {
  return {
    url: "https://acme.test/pricing",
    finalUrl: "https://acme.test/pricing",
    status: 200,
    contentType: "text/html; charset=utf-8",
    ms: 300,
    bytes: 20_000,
    words: 900,
    appShell: false,
    robotsBlocked: false,
    challenge: false,
    loginWall: false,
    error: "",
    ...overrides,
  };
}

function step(overrides: Partial<JourneyStep> = {}): JourneyStep {
  return {
    n: 1,
    action: "fetch",
    url: "https://acme.test/",
    query: "",
    reason: "",
    status: 200,
    finalUrl: "https://acme.test/",
    contentType: "text/html",
    ms: 200,
    bytes: 10_000,
    words: 800,
    title: "Acme",
    found: "",
    evidence: "",
    issues: [],
    error: "",
    at: 0,
    ...overrides,
  };
}

describe("intents", () => {
  it("every preset carries a task, routes and a proof", () => {
    for (const id of [
      "pricing",
      "contact",
      "what",
      "docs",
      "signup",
      "policy",
    ]) {
      const intent = findIntent(id) as JourneyIntentSpec;
      expect(intent, id).toBeDefined();
      expect(intent.task.length).toBeGreaterThan(30);
      expect(intent.routes.length).toBeGreaterThan(0);
      expect(intent.proof).not.toBeNull();
      expect(intent.proofLabel).not.toBe("");
    }
  });

  it("proves pricing from a real price and not from prose about value", () => {
    expect(
      proveIntent(pricing, "Plans start at $29 per seat per month."),
    ).toContain("$29");
    expect(proveIntent(pricing, "Our pricing is famously competitive.")).toBe(
      "",
    );
  });

  it("proves contact from an address or a booking route", () => {
    expect(
      proveIntent(contact, "Write to sales@acme.test any time."),
    ).toContain("sales@acme.test");
    expect(proveIntent(contact, "We would love to hear from you.")).toBe("");
  });

  it("keeps the words that matter in a custom job and cannot prove it", () => {
    const intent = customIntent("  Find their enterprise SLA commitments  ");
    expect(intent.custom).toBe(true);
    expect(intent.task).toBe("Find their enterprise SLA commitments");
    expect(intent.proof).toBeNull();
    expect(intent.routes[0].test("/enterprise/security")).toBe(true);
    expect(intent.routes[0].test("/blog/hiring")).toBe(false);
  });

  it("survives a custom job made only of stopwords", () => {
    const intent = customIntent("what about this site");
    expect(intent.routes).toEqual([]);
    expect(intent.label).toBe("what about this site");
  });
});

describe("classifyFetch", () => {
  it("reports nothing on a fast, readable page", () => {
    expect(classifyFetch(fetched())).toEqual([]);
  });

  it("separates a robots refusal from a firewall refusal", () => {
    expect(classifyFetch(fetched({ robotsBlocked: true }))).toContain(
      "robots_blocked",
    );
    expect(classifyFetch(fetched({ status: 403 }))).toContain(
      "firewall_blocked",
    );
    expect(classifyFetch(fetched({ status: 200, challenge: true }))).toContain(
      "firewall_blocked",
    );
  });

  it("calls an empty app shell a JavaScript-only page, not thin content", () => {
    const codes = classifyFetch(fetched({ words: 14, appShell: true }));
    expect(codes).toContain("javascript_only");
    expect(codes).not.toContain("thin_content");
  });

  it("flags thin content, slow responses and redirects", () => {
    expect(classifyFetch(fetched({ words: 40 }))).toContain("thin_content");
    expect(classifyFetch(fetched({ ms: 4200 }))).toContain("slow_response");
    expect(
      classifyFetch(fetched({ finalUrl: "https://acme.test/plans" })),
    ).toContain("redirected");
  });

  it("ignores a www-only or trailing-slash redirect", () => {
    expect(
      classifyFetch(
        fetched({
          url: "https://acme.test/pricing",
          finalUrl: "https://www.acme.test/pricing/",
        }),
      ),
    ).not.toContain("redirected");
  });

  it("reports an unreachable host once and stops looking", () => {
    expect(classifyFetch(fetched({ error: "Timed out after 10s" }))).toEqual([
      "unreachable",
    ]);
  });

  it("treats a sign-in wall and a 401 the same way", () => {
    expect(classifyFetch(fetched({ status: 401 }))).toContain("auth_wall");
    expect(classifyFetch(fetched({ loginWall: true }))).toContain("auth_wall");
  });

  it("flags a body an agent cannot read", () => {
    expect(
      classifyFetch(fetched({ contentType: "application/pdf", words: 500 })),
    ).toContain("wrong_content_type");
  });
});

describe("judgeJourney", () => {
  it("completes only when a page carried the proof", () => {
    const steps = [
      step(),
      step({ n: 2, url: "https://acme.test/pricing", evidence: "$29/mo" }),
      step({ n: 3, action: "answer", status: null }),
    ];
    const verdict = judgeJourney({
      steps,
      spec: pricing,
      answered: true,
      verified: true,
      exhausted: false,
    });
    expect(verdict.outcome).toBe("completed");
    expect(verdict.issues).toEqual([]);
    expect(verdict.metrics.fetches).toBe(2);
    expect(verdict.metrics.steps).toBe(3);
  });

  it("downgrades an answer no page confirmed to partial", () => {
    const verdict = judgeJourney({
      steps: [step(), step({ n: 2, action: "answer", status: null })],
      spec: pricing,
      answered: true,
      verified: false,
      exhausted: false,
    });
    expect(verdict.outcome).toBe("partial");
    expect(verdict.issues.map((issue) => issue.code)).toContain(
      "unverified_answer",
    );
  });

  it("trusts a custom job's own answer, since nothing can prove it", () => {
    const verdict = judgeJourney({
      steps: [step(), step({ n: 2, action: "answer", status: null })],
      spec: customIntent("Find their office in Berlin"),
      answered: true,
      verified: false,
      exhausted: false,
    });
    expect(verdict.outcome).toBe("completed");
    expect(verdict.issues.map((issue) => issue.code)).not.toContain(
      "unverified_answer",
    );
  });

  it("calls a site that never returned a readable page blocked", () => {
    const verdict = judgeJourney({
      steps: [step({ status: 403, words: 0, issues: ["firewall_blocked"] })],
      spec: pricing,
      answered: false,
      verified: false,
      exhausted: false,
    });
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.metrics.blocked).toBe(1);
    expect(verdict.issues[0].severity).toBe("blocker");
  });

  it("does not blame the route when nothing was readable to route through", () => {
    const verdict = judgeJourney({
      steps: [
        step({ status: 403, words: 0, issues: ["firewall_blocked"] }),
        step({ n: 2, action: "giveup", status: null }),
      ],
      spec: pricing,
      answered: false,
      verified: false,
      exhausted: false,
    });
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.issues.map((issue) => issue.code)).not.toContain("no_route");
  });

  it("records no route when the agent gave up with pages left unread", () => {
    const verdict = judgeJourney({
      steps: [step(), step({ n: 2, action: "giveup", status: null })],
      spec: pricing,
      answered: false,
      verified: false,
      exhausted: false,
    });
    expect(verdict.outcome).toBe("stalled");
    expect(verdict.issues.map((issue) => issue.code)).toContain("no_route");
  });

  it("collapses the same problem on the same URL into one finding", () => {
    const verdict = judgeJourney({
      steps: [
        step({ ms: 5000, issues: ["slow_response"] }),
        step({ n: 2, ms: 6000, issues: ["slow_response"] }),
      ],
      spec: pricing,
      answered: false,
      verified: false,
      exhausted: true,
    });
    expect(
      verdict.issues.filter((issue) => issue.code === "slow_response"),
    ).toHaveLength(1);
  });

  it("puts blockers before friction and notes", () => {
    const verdict = judgeJourney({
      steps: [
        step({ ms: 9000, issues: ["slow_response"] }),
        step({
          n: 2,
          url: "https://acme.test/pricing",
          status: 200,
          words: 3,
          issues: ["javascript_only"],
        }),
      ],
      spec: pricing,
      answered: false,
      verified: false,
      exhausted: true,
    });
    expect(verdict.issues[0].severity).toBe("blocker");
    expect(verdict.metrics.blockers).toBe(1);
    expect(verdict.metrics.slowestMs).toBe(9000);
  });

  it("counts a web search as leaving the site", () => {
    const verdict = judgeJourney({
      steps: [
        step(),
        step({
          n: 2,
          action: "search",
          url: "",
          query: "acme pricing",
          status: null,
          issues: ["left_the_site"],
        }),
      ],
      spec: pricing,
      answered: false,
      verified: false,
      exhausted: true,
    });
    expect(verdict.metrics.searches).toBe(1);
    const issue = verdict.issues.find((row) => row.code === "left_the_site");
    expect(issue?.detail).toContain("acme pricing");
  });
});

describe("the rule-based walker", () => {
  const context = (
    overrides: Partial<NavigatorContext> = {},
  ): NavigatorContext => ({
    task: pricing.task,
    host: "acme.test",
    startUrl: "https://acme.test/",
    trail: [],
    current: null,
    fetchesLeft: 6,
    searchesLeft: 0,
    ...overrides,
  });

  it("starts at the homepage when it has read nothing", () => {
    const move = heuristicMove(pricing, context());
    expect(move).toMatchObject({ action: "fetch", url: "https://acme.test/" });
  });

  it("ranks the page that owns the job above the page it is filed under", () => {
    const ranked = rankRoutes(
      pricing,
      [
        { href: "https://acme.test/blog/why-we-charge", text: "Why we charge" },
        { href: "https://acme.test/products", text: "Products" },
        { href: "https://acme.test/pricing", text: "Pricing" },
      ],
      new Set(),
    );
    expect(ranked.map((link) => new URL(link.href).pathname)).toEqual([
      "/pricing",
      "/products",
    ]);
  });

  it("never proposes a page it already read", () => {
    const ranked = rankRoutes(
      pricing,
      [{ href: "https://acme.test/pricing", text: "Pricing" }],
      new Set(["acme.test/pricing"]),
    );
    expect(ranked).toEqual([]);
  });

  it("answers the moment a page carries the proof", () => {
    const move = heuristicMove(
      pricing,
      context({
        current: {
          url: "https://acme.test/pricing",
          title: "Pricing",
          description: "",
          headings: [],
          text: "Team is $29 per seat per month, billed annually.",
          links: [],
        },
      }),
    );
    expect(move.action).toBe("answer");
    expect(move.answer).toContain("$29");
  });

  it("never leaves the site, even for a link that matches perfectly", () => {
    expect(
      rankRoutes(
        pricing,
        [{ href: "https://elsewhere.test/pricing", text: "Pricing" }],
        new Set(),
        "acme.test",
      ),
    ).toEqual([]);
  });

  it("gives up rather than wandering when no link leads anywhere", () => {
    const move = heuristicMove(
      pricing,
      context({
        current: {
          url: "https://acme.test/",
          title: "Acme",
          description: "",
          headings: [],
          text: "We are a company that does things for people.",
          links: [
            { href: "https://acme.test/careers", text: "Careers" },
            { href: "https://elsewhere.test/pricing", text: "Pricing" },
          ],
        },
      }),
    );
    expect(move.action).toBe("giveup");
  });
});
