import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "@spectra/evaluation";
import { isPublicAddress } from "./net";

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
