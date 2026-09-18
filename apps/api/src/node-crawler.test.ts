import { describe, expect, it } from "vitest";
import {
  extractMarkdownPage,
  extractPage,
  isAllowed,
  isPublicAddress,
  pageId,
  parseRobots,
} from "./node-crawler";

describe("compatibility crawler network safety", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:172.16.0.1",
    "::ffff:100.64.0.1",
    "::ffff:10.0.0.1",
    "0:0:0:0:0:ffff:169.254.169.254",
  ])("blocks IPv4-mapped private address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["2002:7f00:1::1", "64:ff9b::7f00:1"])(
    "blocks tunnelled address %s",
    (address) => expect(isPublicAddress(address)).toBe(false),
  );

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "1.1.1.1"])(
    "allows public address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it.each(["", "not-an-address", "999.1.1.1", "10.0.0"])(
    "rejects malformed address %s",
    (address) => expect(isPublicAddress(address)).toBe(false),
  );
});

describe("robots.txt group matching", () => {
  it("ignores a site-wide block aimed at a different agent", () => {
    const robots = parseRobots(
      [
        "User-agent: BadBot",
        "Disallow: /",
        "",
        "User-agent: *",
        "Allow: /",
      ].join("\n"),
    );
    expect(isAllowed(robots, new URL("https://example.com/"))).toBe(true);
  });

  it("honours a site-wide block that applies to every agent", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /");
    expect(isAllowed(robots, new URL("https://example.com/about"))).toBe(false);
  });

  it("applies per-path rules instead of only site-wide ones", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /private");
    expect(isAllowed(robots, new URL("https://example.com/private/x"))).toBe(
      false,
    );
    expect(isAllowed(robots, new URL("https://example.com/public"))).toBe(true);
  });

  it("lets the longest match win, with Allow breaking ties", () => {
    const robots = parseRobots(
      "User-agent: *\nDisallow: /docs\nAllow: /docs/public",
    );
    expect(isAllowed(robots, new URL("https://example.com/docs/secret"))).toBe(
      false,
    );
    expect(
      isAllowed(robots, new URL("https://example.com/docs/public/a")),
    ).toBe(true);
  });

  it("prefers a group naming SPECTRA over the wildcard group", () => {
    const robots = parseRobots(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: spectra",
        "Allow: /",
      ].join("\n"),
    );
    expect(isAllowed(robots, new URL("https://example.com/"))).toBe(true);
  });

  it("treats an empty Disallow as permission and collects sitemaps", () => {
    const robots = parseRobots(
      "Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:",
    );
    expect(isAllowed(robots, new URL("https://example.com/any"))).toBe(true);
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("supports wildcard and end-anchored patterns", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /*.pdf$");
    expect(isAllowed(robots, new URL("https://example.com/a/b.pdf"))).toBe(
      false,
    );
    expect(isAllowed(robots, new URL("https://example.com/a/b.html"))).toBe(
      true,
    );
  });

  it("allows everything when robots.txt is absent or empty", () => {
    expect(isAllowed(parseRobots(""), new URL("https://example.com/"))).toBe(
      true,
    );
  });
});

describe("page identity", () => {
  it("gives distinct URLs distinct ids even when their text matches", () => {
    const a = extractMarkdownPage(
      "https://example.com/a",
      200,
      "text/markdown",
      "",
    );
    const b = extractMarkdownPage(
      "https://example.com/b",
      200,
      "text/markdown",
      "",
    );
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.id).not.toBe(b.id);
  });

  it("is stable for the same URL", () => {
    expect(pageId(new URL("https://example.com/x"))).toBe(
      pageId(new URL("https://example.com/x")),
    );
  });
});

describe("Markdown page extraction", () => {
  it("keeps headings, prose, and public links as crawl evidence", () => {
    const page = extractMarkdownPage(
      "https://example.com/",
      200,
      "text/markdown; charset=utf-8",
      "# Ada Lovelace\n\nAI engineer and creator.\n\n## Work\n[Atlas](/atlas)",
    );
    expect(page.title).toBe("Ada Lovelace");
    expect(page.text).toContain("AI engineer");
    expect(page.links).toContain("https://example.com/atlas");
  });
});

describe("HTML page extraction", () => {
  const html = `<!doctype html><html><head>
      <title>Atlas</title>
      <meta name="description" content="Atlas overview">
      <script type="application/ld+json">{"@type":"Organization"}</script>
    </head><body>
      <nav><a href="/products">Products</a><a href="/pricing">Pricing</a></nav>
      <main><h1>Atlas</h1><p>Body copy.</p><a href="/docs">Docs</a></main>
      <footer><a href="/contact">Contact</a></footer>
      <a href="javascript:void(0)">noop</a>
      <a href="mailto:hi@example.com">mail</a>
    </body></html>`;

  it("harvests links from nav and footer, not just main content", () => {
    const page = extractPage("https://example.com/", 200, "text/html", html);
    expect(page.links).toEqual(
      expect.arrayContaining([
        "https://example.com/products",
        "https://example.com/pricing",
        "https://example.com/docs",
        "https://example.com/contact",
      ]),
    );
  });

  it("skips non-navigable schemes", () => {
    const page = extractPage("https://example.com/", 200, "text/html", html);
    expect(page.links.some((href) => href.startsWith("javascript:"))).toBe(
      false,
    );
    expect(page.links.some((href) => href.startsWith("mailto:"))).toBe(false);
  });

  it("still excludes chrome from the extracted text", () => {
    const page = extractPage("https://example.com/", 200, "text/html", html);
    expect(page.text).toContain("Body copy.");
    expect(page.text).not.toContain("Pricing");
    expect(page.title).toBe("Atlas");
    expect(page.description).toBe("Atlas overview");
    expect(page.jsonLd).toHaveLength(1);
  });
});
