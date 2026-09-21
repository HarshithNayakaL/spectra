import type { PageSignals, Profile, Scan } from "@spectra/schemas";

/** Who the site is, as far as the markup and (when available) Gemini can tell. */
export type Identity = {
  brand: string;
  origin: string;
  host: string;
  description: string;
  category: string;
  market: string;
  logo: string;
  facts: string[];
};

export function deriveIdentity(scan: Scan, profile?: Profile | null): Identity {
  const home = scan.pages[0];
  const origin = new URL(scan.finalUrl).origin;
  const host = new URL(scan.finalUrl).hostname.replace(/^www\./, "");
  const org = orgName(scan.pages);
  const brand =
    profile?.brand ||
    org ||
    home?.openGraph["og:site_name"] ||
    brandFromTitle(home?.title ?? "", host) ||
    host;
  return {
    brand,
    origin,
    host,
    description:
      profile?.description ||
      home?.description ||
      home?.openGraph["og:description"] ||
      "",
    category: profile?.category ?? "",
    market: profile?.market ?? "",
    logo: absolute(home?.openGraph["og:image"] ?? "", origin),
    facts: profile?.facts ?? [],
  };
}

function orgName(pages: PageSignals[]) {
  for (const page of pages)
    for (const block of page.jsonLd) {
      const nodes = ([] as unknown[]).concat(
        (block as { "@graph"?: unknown[] })?.["@graph"] ?? block,
      );
      for (const node of nodes) {
        const record = node as Record<string, unknown>;
        const type = ([] as unknown[]).concat(record?.["@type"] ?? []);
        if (
          type.some(
            (t) =>
              typeof t === "string" &&
              /Organization|Business|Corporation/.test(t),
          ) &&
          typeof record.name === "string"
        )
          return record.name;
      }
    }
  return "";
}

/** "Pricing | Acme Analytics" → "Acme Analytics"; picks the part matching the host. */
export function brandFromTitle(title: string, host: string) {
  const parts = title
    .split(/\s+[|\-–—:·•]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  const stem = host
    .split(".")[0]
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  // The shortest part naming the host is the brand; longer ones are taglines.
  const match = parts
    .filter((part) =>
      part
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase()
        .includes(stem),
    )
    .sort((a, b) => a.length - b.length)[0];
  if (match && match.length <= 40) return match;
  const shortest = [...parts].sort((a, b) => a.length - b.length)[0];
  return shortest.length <= 30 ? shortest : "";
}

function absolute(value: string, origin: string) {
  if (!value) return "";
  try {
    return new URL(value, origin).href;
  } catch {
    return "";
  }
}

/**
 * Drafts llms.txt from what was actually crawled, following the llmstxt.org
 * layout: H1 name, blockquote summary, then sections of annotated links.
 */
export function buildLlmsTxt(identity: Identity, pages: PageSignals[]) {
  const seen = new Set<string>();
  const entries = pages
    .filter((page) => page.status < 400 && page.title)
    .filter(
      (page) =>
        !/(privacy|terms|cookie|legal|careers?|jobs|login|sitemap|disclaimer)/i.test(
          new URL(page.url).pathname,
        ),
    )
    .filter((page) => {
      const key = page.url.replace(/\/+$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((page) => {
      // The title names the page; an H1 is often a slogan or a question.
      const fromTitle = page.title
        .split(/\s+[|\-–—:]\s+/)
        .filter(
          (part) => part.toLowerCase() !== identity.brand.toLowerCase(),
        )[0];
      const label = fromTitle || page.h1[0] || page.title;
      return `- [${label.replace(/[\[\]]/g, "")}](${page.url})${page.description ? `: ${page.description}` : ""}`;
    });
  const docs = entries.filter((line) =>
    /\/(docs|blog|guides?|resources|faq|help)/i.test(line),
  );
  const main = entries.filter((line) => !docs.includes(line));
  return [
    `# ${identity.brand}`,
    "",
    `> ${identity.description || `${identity.brand} — describe what you offer and who it is for in one sentence.`}`,
    "",
    ...(identity.facts.length
      ? [...identity.facts.map((fact) => `- ${fact}`), ""]
      : []),
    "## Key pages",
    "",
    ...main,
    ...(docs.length ? ["", "## Resources", "", ...docs] : []),
    "",
  ].join("\n");
}
