import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "@spectra/model-gateway";
import type { NavigatorMove } from "@spectra/schemas";

process.env.SPECTRA_DATA_DIR = mkdtempSync(join(tmpdir(), "spectra-journey-"));
process.env.SPECTRA_TIME_BUDGET_MS = "60000";

/** Every path the fake site serves, keyed by pathname. */
const SITE: Record<
  string,
  { status?: number; type?: string; body: string } | undefined
> = {
  "/robots.txt": {
    type: "text/plain",
    body: "User-agent: *\nDisallow: /vault\n",
  },
  "/": {
    body: html(
      "Acme Data",
      `<h1>Acme Data</h1>
       <p>${filler("We sell business data to revenue teams.")}</p>
       <a href="/pricing">Pricing</a>
       <a href="/about">About</a>
       <a href="/vault">Customer vault</a>
       <a href="https://elsewhere.test/pricing">Our reseller's pricing</a>`,
    ),
  },
  "/pricing": {
    body: html(
      "Pricing | Acme Data",
      `<h1>Plans</h1>
       <p>${filler("Team is $29 per seat per month, billed annually.")}</p>`,
    ),
  },
  "/about": { body: html("About", "<h1>About</h1><p>A company.</p>") },
  "/vault": { body: html("Vault", `<p>${filler("Secrets.")}</p>`) },
  "/gone": { status: 404, body: html("Not found", "<h1>404</h1>") },
};

function html(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;
}
/** Enough words that the page is not classified as thin content. */
function filler(lead: string) {
  return `${lead} ${"Every record is verified before it ships. ".repeat(40)}`;
}

const fetched: string[] = [];

vi.mock("./net", () => ({
  SPECTRA_AGENT: "test",
  fetchPublic: async (target: string | URL) => {
    const url = new URL(String(target));
    // Only the fake site answers. Any other host is an unresolvable one.
    if (url.hostname !== "acme.test")
      throw new Error("getaddrinfo ENOTFOUND missing.test");
    fetched.push(url.pathname);
    const page = SITE[url.pathname];
    if (!page) throw new Error("getaddrinfo ENOTFOUND");
    const body = page.body;
    return {
      status: page.status ?? 200,
      url: url.href,
      headers: new Headers({
        "content-type": page.type ?? "text/html; charset=utf-8",
      }),
      body,
      bytes: body.length,
      ms: 120,
    };
  },
}));

let journey: typeof import("./journey");
beforeAll(async () => {
  journey = await import("./journey");
});
beforeEach(() => {
  fetched.length = 0;
});

/** A provider that plays a fixed script of moves, one per call. */
function scripted(moves: Array<Partial<NavigatorMove>>): AgentProvider {
  let turn = 0;
  return {
    model: "scripted",
    async navigate() {
      const move = moves[Math.min(turn++, moves.length - 1)] ?? {};
      return {
        value: {
          action: "giveup",
          url: "",
          query: "",
          reason: "scripted",
          found: "",
          answer: "",
          ...move,
        },
        usage: {},
        durationMs: 1,
      };
    },
    async ask() {
      return {
        value: {
          answer:
            "Acme charges about $29 per seat, according to a review site.",
          sources: [{ uri: "https://g2.test/acme", title: "g2.test" }],
          queries: ["acme pricing"],
        },
        usage: {},
        durationMs: 1,
      };
    },
  };
}

const intent = (id: string, text = "") => {
  const spec = journey.resolveIntent(id, text);
  if (!spec) throw new Error(`no intent ${id}`);
  return spec;
};

const silent = () => {};

describe("the agent catalogue", () => {
  it("offers every agent with a robots token and a real user-agent string", () => {
    expect(journey.JOURNEY_AGENTS.length).toBeGreaterThanOrEqual(5);
    for (const agent of journey.JOURNEY_AGENTS) {
      expect(agent.token, agent.name).toBe(agent.name.toLowerCase());
      expect(agent.ua).toContain(agent.name);
      expect(agent.label).not.toBe("");
    }
    expect(journey.findAgent(journey.DEFAULT_AGENT)).toBeDefined();
  });

  it("refuses an unknown job and an empty custom one", () => {
    expect(journey.resolveIntent("nonsense", "")).toBeNull();
    expect(journey.resolveIntent("custom", "  ")).toBeNull();
    expect(journey.resolveIntent("custom", "find the SLA")?.custom).toBe(true);
  });

  it("rejects a target that is not an http URL", () => {
    expect(() => journey.startUrlOf("ftp://acme.test")).toThrow(
      journey.JourneyError,
    );
    expect(() => journey.startUrlOf("javascript:alert(1)")).toThrow(
      journey.JourneyError,
    );
    expect(() => journey.startUrlOf("https://user:pw@acme.test")).toThrow(
      journey.JourneyError,
    );
    expect(() => journey.startUrlOf("   ")).toThrow(journey.JourneyError);
    expect(journey.startUrlOf("acme.test").href).toBe("https://acme.test/");
    expect(journey.startUrlOf("HTTP://Acme.test/x").href).toBe(
      "http://acme.test/x",
    );
  });
});

describe("the gate between a move and the network", () => {
  const limits = {
    host: "acme.test",
    visited: new Set(["acme.test/pricing"]),
    fetchesLeft: 3,
    searchesLeft: 1,
  };
  const move = (over: Partial<NavigatorMove>): NavigatorMove => ({
    action: "fetch",
    url: "",
    query: "",
    reason: "",
    found: "",
    answer: "",
    ...over,
  });

  it("allows a relative path on the site and a subdomain", () => {
    expect(journey.clamp(move({ url: "/about" }), limits)?.url).toBe(
      "https://acme.test/about",
    );
    expect(
      journey.clamp(move({ url: "https://docs.acme.test/api" }), limits)?.url,
    ).toBe("https://docs.acme.test/api");
  });

  it("refuses another site, another scheme and a page already read", () => {
    expect(
      journey.clamp(move({ url: "https://elsewhere.test/" }), limits),
    ).toBeNull();
    expect(
      journey.clamp(move({ url: "file:///etc/passwd" }), limits),
    ).toBeNull();
    expect(
      journey.clamp(move({ url: "https://www.acme.test/pricing/" }), limits),
    ).toBeNull();
  });

  it("refuses a fetch or a search once its budget is spent", () => {
    expect(
      journey.clamp(move({ url: "/new" }), { ...limits, fetchesLeft: 0 }),
    ).toBeNull();
    expect(
      journey.clamp(move({ action: "search", query: "acme pricing" }), {
        ...limits,
        searchesLeft: 0,
      }),
    ).toBeNull();
  });

  it("always lets the agent answer or give up", () => {
    expect(journey.clamp(move({ action: "answer" }), limits)).not.toBeNull();
    expect(journey.clamp(move({ action: "giveup" }), limits)).not.toBeNull();
  });
});

describe("runJourney", () => {
  it("walks to the price with the rule-based walker and verifies it", async () => {
    const result = await journey.runJourney(
      "acme.test",
      intent("pricing"),
      silent,
      undefined,
      "ChatGPT-User",
      { provider: null },
    );
    expect(result.navigator).toBe("heuristic");
    expect(result.status).toBe("complete");
    expect(result.outcome).toBe("completed");
    expect(result.verified).toBe(true);
    expect(result.answer).toContain("$29");
    expect(result.answerUrl).toBe("https://acme.test/pricing");
    expect(result.steps.map((step) => step.url)).toEqual([
      "https://acme.test/",
      "https://acme.test/pricing",
      "https://acme.test/pricing",
    ]);
    expect(result.metrics.fetches).toBe(2);
    expect(result.issues).toEqual([]);
  });

  it("records a robots refusal without fetching the page", async () => {
    const result = await journey.runJourney(
      "acme.test",
      intent("pricing"),
      silent,
      undefined,
      "ChatGPT-User",
      {
        provider: scripted([
          { action: "fetch", url: "https://acme.test/vault" },
        ]),
      },
    );
    const blocked = result.steps.find((step) =>
      step.issues.includes("robots_blocked"),
    );
    expect(blocked?.url).toBe("https://acme.test/vault");
    expect(blocked?.status).toBeNull();
    expect(fetched).not.toContain("/vault");
    expect(result.issues.some((issue) => issue.code === "robots_blocked")).toBe(
      true,
    );
  });

  it("refuses a move off the site and lets its own walker take the step", async () => {
    const result = await journey.runJourney(
      "acme.test",
      intent("pricing"),
      silent,
      undefined,
      "ChatGPT-User",
      {
        provider: scripted([
          { action: "fetch", url: "https://elsewhere.test/pricing" },
        ]),
      },
    );
    expect(fetched.some((path) => path.includes("elsewhere"))).toBe(false);
    expect(result.warnings.join(" ")).toContain("not a move it can make");
    expect(result.outcome).toBe("completed");
  });

  it("reports an answer no page confirmed as partial", async () => {
    const result = await journey.runJourney(
      "acme.test",
      intent("pricing"),
      silent,
      undefined,
      "ChatGPT-User",
      {
        provider: scripted([
          { action: "answer", answer: "It is about thirty dollars a seat." },
        ]),
      },
    );
    expect(result.outcome).toBe("partial");
    expect(result.verified).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      "unverified_answer",
    );
  });

  it("counts a search as leaving the site and says who answered instead", async () => {
    const result = await journey.runJourney(
      "acme.test",
      intent("policy"),
      silent,
      undefined,
      "ChatGPT-User",
      {
        provider: scripted([
          { action: "search", query: "acme refund policy" },
          { action: "giveup", reason: "The site does not publish one." },
        ]),
      },
    );
    expect(result.metrics.searches).toBe(1);
    expect(result.steps[1].title).toContain("g2.test");
    expect(result.warnings.join(" ")).toContain("not from acme.test");
    expect(result.issues.map((issue) => issue.code)).toContain("left_the_site");
  });

  it("calls a host that does not resolve a failed journey, not a silent one", async () => {
    const result = await journey.runJourney(
      "missing.test",
      intent("pricing"),
      silent,
      undefined,
      "ChatGPT-User",
      { provider: null },
    );
    expect(result.outcome).toBe("blocked");
    expect(result.steps[0].issues).toEqual(["unreachable"]);
    expect(result.issues[0].code).toBe("unreachable");
  });

  it("streams the whole journey after every move", async () => {
    const snapshots: Array<{ stage: string; steps: number }> = [];
    const result = await journey.runJourney(
      "acme.test",
      intent("pricing"),
      (snapshot) =>
        snapshots.push({ stage: snapshot.stage, steps: snapshot.steps.length }),
      undefined,
      "ChatGPT-User",
      { provider: null },
    );
    expect(snapshots[0].stage).toContain("Arriving at acme.test");
    expect(
      snapshots.some((snapshot) => snapshot.stage.startsWith("Step 1")),
    ).toBe(true);
    expect(
      snapshots.some((snapshot) => snapshot.stage.startsWith("Step 2")),
    ).toBe(true);
    // The step count only ever grows, so a watcher never sees the trail shrink.
    expect(snapshots.map((snapshot) => snapshot.steps)).toEqual(
      [...snapshots.map((snapshot) => snapshot.steps)].sort((a, b) => a - b),
    );
    expect(snapshots.at(-1)?.steps).toBe(result.steps.length);
  });

  it("reads robots.txt as the agent it is impersonating", async () => {
    await journey.runJourney(
      "acme.test",
      intent("pricing"),
      silent,
      undefined,
      "PerplexityBot",
      { provider: null },
    );
    expect(fetched[0]).toBe("/robots.txt");
  });
});

describe("readForAgent", () => {
  it("keeps only the links and text that were in the HTML", () => {
    const seen = journey.readForAgent(
      "https://acme.test/",
      html(
        "Acme",
        `<a href="/pricing">Pricing</a><a href="mailto:x@acme.test">Mail</a>
         <script>document.write('<a href="/hidden">Hidden</a>')</script>
         <p>Real text.</p>`,
      ),
      "text/html",
    );
    expect(seen.page.links.map((link) => link.href)).toEqual([
      "https://acme.test/pricing",
    ]);
    expect(seen.page.text).toContain("Real text.");
    expect(seen.page.text).not.toContain("document.write");
    expect(seen.readable).toBe(true);
  });

  it("keeps words apart across block elements", () => {
    const seen = journey.readForAgent(
      "https://acme.test/pricing",
      html(
        "Pricing",
        `<p>Payments globally, online and in person</p><h2>Enable any billing model</h2>
         <ul><li>Pro plan</li><li>Billed monthly</li></ul><table><tr><td>$29</td><td>per seat</td></tr></table>`,
      ),
      "text/html",
    );
    expect(seen.page.text).toContain("in person Enable any billing model");
    expect(seen.page.text).toContain("Pro plan Billed monthly");
    expect(seen.page.text).toContain("$29 per seat");
    expect(seen.page.text).not.toMatch(/personEnable|planBilled/);
  });

  it("treats a line break as a space", () => {
    const seen = journey.readForAgent(
      "https://acme.test/contact",
      html("Contact", "<p>Call us<br />on 555 010 1234</p>"),
      "text/html",
    );
    expect(seen.page.text).toContain("Call us on 555 010 1234");
  });

  it("recognises an app shell that has nothing in it", () => {
    const seen = journey.readForAgent(
      "https://acme.test/",
      `<html><body><div id="root"></div><script src="/a.js"></script></body></html>`,
      "text/html",
    );
    expect(seen.appShell).toBe(true);
    expect(seen.words).toBeLessThan(5);
  });

  it("recognises a bot challenge and a sign-in wall", () => {
    expect(
      journey.readForAgent(
        "https://acme.test/",
        html("Just a moment...", "<p>Checking your browser</p>"),
        "text/html",
      ).challenge,
    ).toBe(true);
    expect(
      journey.readForAgent(
        "https://acme.test/app",
        html("Sign in", `<form><input type="password" /></form>`),
        "text/html",
      ).loginWall,
    ).toBe(true);
  });

  it("marks a binary body unreadable rather than pretending to read it", () => {
    const seen = journey.readForAgent(
      "https://acme.test/brochure.pdf",
      "%PDF-1.7 binary",
      "application/pdf",
    );
    expect(seen.readable).toBe(false);
    expect(seen.page.links).toEqual([]);
  });
});
