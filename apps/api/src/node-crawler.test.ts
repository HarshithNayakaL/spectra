import { describe, expect, it } from "vitest";
import { extractMarkdownPage, isPublicAddress } from "./node-crawler";

describe("compatibility crawler network safety", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
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
