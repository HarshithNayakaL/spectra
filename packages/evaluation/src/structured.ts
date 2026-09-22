/**
 * Structured-data validation: is the JSON-LD on a page complete enough to be
 * used?
 *
 * A block that parses is not a block that works. An Organization without a url,
 * a Product without offers, an FAQPage whose answers are empty: each is valid
 * JSON and useless to an engine. This checks every node against the properties
 * schema.org and Google's structured-data documentation list for its type, and
 * says which are missing. The lists are fixed and written down here, so the
 * same markup always gets the same verdict.
 */

export type NodeCheck = {
  type: string;
  /** The node's own name or headline, to tell two nodes of one type apart. */
  label: string;
  missingRequired: string[];
  missingRecommended: string[];
  /** Problems a property list cannot express: an empty answer, a bad date. */
  problems: string[];
  ok: boolean;
};

type Rule = {
  required: string[];
  recommended: string[];
  /** One of these must be present, e.g. SoftwareApplication offers|rating. */
  oneOf?: string[];
};

const RULES: Record<string, Rule> = {
  Organization: {
    required: ["name", "url"],
    recommended: ["logo", "sameAs", "description", "contactPoint"],
  },
  Corporation: {
    required: ["name", "url"],
    recommended: ["logo", "sameAs", "description"],
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["telephone", "openingHoursSpecification", "geo", "url"],
  },
  WebSite: { required: ["name", "url"], recommended: ["potentialAction"] },
  Product: {
    required: ["name"],
    recommended: ["description", "image", "brand"],
    oneOf: ["offers", "aggregateRating", "review"],
  },
  SoftwareApplication: {
    required: ["name"],
    recommended: ["applicationCategory", "operatingSystem", "description"],
    oneOf: ["offers", "aggregateRating", "review"],
  },
  WebApplication: {
    required: ["name"],
    recommended: ["applicationCategory", "operatingSystem", "description"],
    oneOf: ["offers", "aggregateRating", "review"],
  },
  Service: {
    required: ["name"],
    recommended: ["description", "provider", "areaServed", "offers"],
  },
  Offer: {
    required: ["price", "priceCurrency"],
    recommended: ["availability", "url"],
  },
  FAQPage: { required: ["mainEntity"], recommended: [] },
  Question: { required: ["name", "acceptedAnswer"], recommended: [] },
  Article: {
    required: ["headline"],
    recommended: ["author", "datePublished", "dateModified", "image"],
  },
  BlogPosting: {
    required: ["headline"],
    recommended: ["author", "datePublished", "dateModified", "image"],
  },
  NewsArticle: {
    required: ["headline"],
    recommended: ["author", "datePublished", "dateModified", "image"],
  },
  HowTo: { required: ["name", "step"], recommended: ["totalTime", "image"] },
  BreadcrumbList: { required: ["itemListElement"], recommended: [] },
  Person: { required: ["name"], recommended: ["url", "sameAs", "jobTitle"] },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["endDate", "offers", "description"],
  },
  Review: {
    required: ["author", "reviewRating"],
    recommended: ["itemReviewed"],
  },
  AggregateRating: {
    required: ["ratingValue"],
    oneOf: ["ratingCount", "reviewCount"],
    recommended: ["bestRating"],
  },
};

/** Every typed node in the page's JSON-LD, nested ones included. */
export function nodesOf(blocks: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record["@type"]) out.push(record);
    for (const [key, child] of Object.entries(record))
      if (key !== "@context") walk(child, depth + 1);
  };
  walk(blocks, 0);
  return out;
}

function typesOf(node: Record<string, unknown>) {
  return ([] as unknown[])
    .concat(node["@type"])
    .filter((type): type is string => typeof type === "string");
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(present);
  return true;
}

export function validateStructuredData(blocks: unknown[]): NodeCheck[] {
  const checks: NodeCheck[] = [];
  for (const node of nodesOf(blocks)) {
    const type = typesOf(node).find((name) => RULES[name]);
    if (!type) continue;
    const rule = RULES[type];
    const missingRequired = rule.required.filter((key) => !present(node[key]));
    if (rule.oneOf && !rule.oneOf.some((key) => present(node[key])))
      missingRequired.push(rule.oneOf.join(" or "));
    const missingRecommended = rule.recommended.filter(
      (key) => !present(node[key]),
    );
    const problems: string[] = [];
    if (type === "Question") {
      const answer = node.acceptedAnswer as Record<string, unknown> | undefined;
      const text = ([] as unknown[]).concat(answer ?? [])[0] as
        Record<string, unknown> | undefined;
      if (answer && !present(text?.text))
        problems.push("The accepted answer has no text.");
    }
    for (const key of ["datePublished", "dateModified", "startDate"])
      if (
        typeof node[key] === "string" &&
        Number.isNaN(Date.parse(node[key] as string))
      )
        problems.push(`${key} is not a date: "${node[key]}".`);
    if (typeof node.url === "string" && !/^https?:\/\//i.test(node.url))
      problems.push(`url is not absolute: "${node.url}".`);
    const label = [node.name, node.headline].find(
      (value): value is string => typeof value === "string" && !!value.trim(),
    );
    checks.push({
      type,
      label: label ? label.slice(0, 80) : "",
      missingRequired,
      missingRecommended,
      problems,
      ok: !missingRequired.length && !problems.length,
    });
  }
  // Nested Questions under an FAQPage repeat themselves; keep them, but cap the
  // list so a 60-question FAQ does not bury the rest.
  return checks.slice(0, 24);
}
