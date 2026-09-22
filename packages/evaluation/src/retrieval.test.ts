import { describe, expect, it } from "vitest";
import {
  buildIndex,
  retrieve,
  snippetFor,
  tokenise,
  type IndexedPage,
} from "./retrieval";

const page = (over: Partial<IndexedPage> & { url: string }): IndexedPage => ({
  title: "",
  description: "",
  headings: [],
  text: "",
  ...over,
});

const site = [
  page({
    url: "https://acme.test/",
    title: "Acme Data | B2B contact data",
    description: "Verified contact data for revenue teams.",
    headings: ["Trusted by 400 sales teams"],
    text: "Acme Data sells verified business contact records to sales teams.",
  }),
  page({
    url: "https://acme.test/pricing",
    title: "Pricing | Acme Data",
    description: "Plans and prices.",
    headings: ["Plans", "Team", "Enterprise"],
    text: "Team is $29 per seat per month. Enterprise pricing is bespoke.",
  }),
  page({
    url: "https://acme.test/blog/hiring",
    title: "We are hiring | Acme Data",
    description: "Open roles.",
    headings: ["Engineering", "Sales"],
    text: "We are hiring engineers and account executives in Austin.",
  }),
];

describe("tokenise", () => {
  it("drops the words that cannot tell two pages apart", () => {
    expect(tokenise("What is the best tool for our team")).toEqual([
      "tool",
      "team",
    ]);
  });

  it("keeps the shapes a category actually uses", () => {
    expect(tokenise("B2B SaaS, C++ and .NET — $29/seat")).toEqual([
      "b2b",
      "saas",
      "c++",
      "net",
      "29",
      "seat",
    ]);
  });

  it("survives an empty or symbol-only query", () => {
    expect(tokenise("")).toEqual([]);
    expect(tokenise("!!! ??? ---")).toEqual([]);
  });
});

describe("retrieve", () => {
  const index = buildIndex(site);

  it("indexes every crawled page", () => {
    expect(index.pages).toBe(3);
    expect(index.averageLength).toBeGreaterThan(0);
  });

  it("returns the page that would actually be retrieved", () => {
    const hit = retrieve(index, "acme data pricing per seat");
    expect(hit.url).toBe("https://acme.test/pricing");
    expect(hit.status).toBe("answered");
    expect(hit.coverage).toBe(1);
    expect(hit.missingTerms).toEqual([]);
    expect(hit.snippet.toLowerCase()).toContain("seat");
  });

  it("names the words the best page is missing", () => {
    const hit = retrieve(index, "b2b contact data gdpr compliance");
    expect(hit.url).toBe("https://acme.test/");
    expect(hit.matched).toEqual(expect.arrayContaining(["b2b", "contact"]));
    expect(hit.missingTerms).toEqual(
      expect.arrayContaining(["gdpr", "compliance"]),
    );
    // Half the terms present is a page about something adjacent, not an answer.
    expect(hit.status).toBe("weak");
  });

  it("says missing when the site has no page on the subject at all", () => {
    const hit = retrieve(index, "soc2 penetration testing audit report");
    expect(hit.status).toBe("missing");
    expect(hit.url).toBe("");
    expect(hit.missingTerms.length).toBeGreaterThan(0);
  });

  it("prefers the page whose title owns the subject", () => {
    // "data" appears on every page; the title weighting decides.
    expect(retrieve(index, "hiring engineers austin").url).toBe(
      "https://acme.test/blog/hiring",
    );
  });

  it("is deterministic: the same crawl and query give the same answer", () => {
    const a = retrieve(index, "verified contact data");
    const b = retrieve(buildIndex(site), "verified contact data");
    expect(a).toEqual(b);
  });

  it("handles an empty crawl and an empty query without throwing", () => {
    expect(retrieve(buildIndex([]), "anything").status).toBe("missing");
    expect(retrieve(index, "   ").status).toBe("missing");
    expect(retrieve(index, "the and of").matched).toEqual([]);
  });

  it("does not reward a page for lacking a common term", () => {
    // "data" is on all three pages, so its IDF floors rather than going
    // negative; a page that has it must not score below one that does not.
    const withTerm = retrieve(index, "data");
    expect(withTerm.score).toBeGreaterThan(0);
  });
});

describe("snippetFor", () => {
  it("lifts the passage that carries the terms, not the first line", () => {
    const body = `${"filler words here. ".repeat(40)}Team is $29 per seat per month.`;
    const snippet = snippetFor(body, ["29", "seat"], 120);
    expect(snippet).toContain("$29");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("marks only the ends it actually trimmed", () => {
    expect(snippetFor("Short body.", ["short"], 200)).toBe("Short body.");
  });
});
