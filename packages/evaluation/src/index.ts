import type {
  Audit,
  Check,
  CrawlOutput,
  EvaluationContract,
  SemanticGraph,
  SiteAnalysis,
  SourceEvidence,
} from "@spectra/schemas";
import { scoreChecks } from "@spectra/scoring";

const allDimensions: EvaluationContract["dimensions"][number]["id"][] = [
  "machine_accessibility",
  "semantic_extraction",
  "entity_clarity",
  "relationship_preservation",
  "claim_retrievability",
  "structured_evidence",
  "ai_search_discoverability",
];
const archetypeRegistry: Record<string, string[]> = {
  professional_portfolio: [
    "identity",
    "expertise",
    "projects",
    "employment",
    "contact",
    "authorship",
  ],
  restaurant: [
    "business_identity",
    "cuisine",
    "location",
    "hours",
    "menu",
    "reservations",
    "contact",
  ],
  manufacturer: [
    "organization_identity",
    "products",
    "models",
    "specifications",
    "product_relationships",
    "dealers",
    "locations",
  ],
  b2b_company: [
    "organization_identity",
    "services",
    "industries",
    "positioning",
    "contact",
    "expertise",
  ],
  product_site: [
    "product_identity",
    "features",
    "specifications",
    "manufacturer",
    "availability",
  ],
  university: [
    "organization_identity",
    "programs",
    "departments",
    "locations",
    "admissions",
  ],
  hospital: [
    "organization_identity",
    "services",
    "specialists",
    "locations",
    "contact",
  ],
  publisher: [
    "publisher_identity",
    "articles",
    "authors",
    "topics",
    "publication_dates",
  ],
};
const required: Record<(typeof allDimensions)[number], string[]> = {
  machine_accessibility: ["crawl.pages"],
  semantic_extraction: ["normalized_evidence"],
  entity_clarity: ["gemini.analysis", "semantic_graph"],
  relationship_preservation: ["semantic_graph.relationships"],
  claim_retrievability: ["direct_retrieval_results"],
  structured_evidence: ["crawl.metadata", "crawl.json_ld"],
  ai_search_discoverability: ["search_grounded_results"],
};

export function normalize(crawl: CrawlOutput): SourceEvidence[] {
  const evidence: SourceEvidence[] = [];
  for (const page of crawl.pages) {
    const add = (
      suffix: string,
      text: string,
      evidenceType: SourceEvidence["evidenceType"],
      selector?: string,
      value?: unknown,
      structuredSource?: string,
    ) => {
      if (text)
        evidence.push({
          id: `${page.id}:${suffix}`,
          url: page.url,
          text,
          value,
          evidenceType,
          selector,
          pageId: page.id,
          structuredSource,
          confidence: 1,
        });
    };
    add("title", page.title, "title", "title");
    add(
      "description",
      page.description,
      "description",
      'meta[name="description"]',
    );
    page.headings.forEach((h, i) =>
      add(
        `heading-${i}`,
        h.text,
        "heading",
        `h${h.level}:nth-of-type(${i + 1})`,
      ),
    );
    add(
      "body",
      page.text.slice(0, 16_000),
      "visible_text",
      "main, article, body",
    );
    if (page.canonicalUrl)
      add("canonical", page.canonicalUrl, "canonical", 'link[rel="canonical"]');
    page.jsonLd.forEach((value, i) =>
      add(
        `jsonld-${i}`,
        JSON.stringify(value),
        "json_ld",
        `script[type="application/ld+json"]:nth-of-type(${i + 1})`,
        value,
        "schema.org",
      ),
    );
    Object.entries(page.openGraph).forEach(([key, value]) =>
      add(
        `og-${key}`,
        value,
        "open_graph",
        `meta[property="${key}"]`,
        value,
        "OpenGraph",
      ),
    );
    Object.entries(page.twitter).forEach(([key, value]) =>
      add(
        `twitter-${key}`,
        value,
        "twitter",
        `meta[name="${key}"]`,
        value,
        "Twitter Cards",
      ),
    );
    page.semanticElements.forEach((item, i) =>
      add(`semantic-${i}`, item.text, "semantic_html", item.tag),
    );
  }
  return evidence;
}

export function selectContract(analysis: SiteAnalysis): EvaluationContract {
  const classes = archetypeRegistry[analysis.siteArchetype] ?? [
    "identity",
    "purpose",
    "offerings",
    "location",
    "contact",
    "authority",
  ];
  return {
    version: "spectra-v0.1",
    archetype: analysis.siteArchetype,
    dimensions: allDimensions.map((id) => ({
      id,
      reason: `${id.replaceAll("_", " ")} measures ${analysis.siteArchetype} evidence for ${classes.join(", ")}`,
      requiredInputs: required[id],
      evaluationMethod:
        id.includes("retrievability") || id.includes("discoverability")
          ? "observed_query_outcomes"
          : "deterministic_evidence_check",
      normalization: "weighted_ratio",
      weight:
        id.includes("retrievability") || id.includes("discoverability") ? 2 : 1,
      naBehavior: "exclude when required inputs are unavailable",
    })),
    unsupportedObservations: analysis.importantInformationClasses.filter(
      (value) => !classes.includes(value),
    ),
  };
}

export function evaluate(audit: Audit): Audit {
  if (!audit.crawl) return audit;
  const pages = audit.crawl.pages,
    graph = audit.graph,
    claims = graph?.claims ?? [],
    direct = audit.retrievals.filter((r) => r.mode === "direct"),
    grounded = audit.retrievals.filter((r) => r.mode === "search_grounded"),
    hasDescription = pages.some((p) => p.description),
    hasLd = pages.some((p) => p.jsonLd.length),
    bodyEvidence = audit.evidence
      .filter((e) => e.evidenceType === "visible_text")
      .map((e) => e.id),
    directMeasured = direct.filter(
      (r) => r.status === "passed" || r.status === "failed",
    ),
    groundedMeasured = grounded.filter(
      (r) => r.status === "passed" || r.status === "failed",
    );
  const checks: Check[] = [
    check(
      "public-pages",
      "machine_accessibility",
      "Successful public HTML pages",
      pages.length > 0 ? 1 : 0,
      2,
      audit.evidence.slice(0, 3).map((e) => e.id),
    ),
    check(
      "extractable-text",
      "semantic_extraction",
      "Meaningful visible text extracted",
      pages.some((p) => p.text.length > 120) ? 1 : 0,
      2,
      bodyEvidence,
    ),
    graph
      ? check(
          "entity-evidence",
          "entity_clarity",
          "Primary entity references source evidence",
          graph.entities[0]?.evidenceIds.length ? 1 : 0,
          2,
          graph.entities[0]?.evidenceIds ?? [],
        )
      : na(
          "entity-evidence",
          "entity_clarity",
          "Primary entity references source evidence",
          "Gemini classification/graph unavailable",
        ),
    graph && graph.relationships.length
      ? check(
          "edge-evidence",
          "relationship_preservation",
          "All relationships reference source evidence",
          graph.relationships.every((r) => r.evidenceIds.length) ? 1 : 0,
          1,
          graph.relationships.flatMap((r) => r.evidenceIds),
        )
      : na(
          "edge-evidence",
          "relationship_preservation",
          "Relationships preserve evidence",
          "No relationships available to measure",
        ),
    check(
      "metadata",
      "structured_evidence",
      "Descriptive metadata is present",
      hasDescription ? 1 : 0,
      1,
      audit.evidence
        .filter((e) => e.evidenceType === "description")
        .map((e) => e.id),
    ),
    check(
      "jsonld",
      "structured_evidence",
      "JSON-LD is present",
      hasLd ? 1 : 0,
      1,
      audit.evidence
        .filter((e) => e.evidenceType === "json_ld")
        .map((e) => e.id),
    ),
    directMeasured.length
      ? check(
          "direct-retrieval",
          "claim_retrievability",
          "Claims survive direct Gemini understanding",
          ratio(directMeasured),
          2,
          directMeasured.flatMap((r) => r.evidenceIds),
        )
      : na(
          "direct-retrieval",
          "claim_retrievability",
          "Claims survive direct Gemini understanding",
          claims.length
            ? "Direct evaluation failed or was unavailable"
            : "No evidence-backed claims",
        ),
    groundedMeasured.length
      ? check(
          "grounded-retrieval",
          "ai_search_discoverability",
          "Claims survive Google-grounded retrieval",
          ratio(groundedMeasured),
          2,
          groundedMeasured.flatMap((r) => r.evidenceIds),
        )
      : na(
          "grounded-retrieval",
          "ai_search_discoverability",
          "Claims survive Google-grounded retrieval",
          "Search grounding unavailable or no claims",
        ),
  ];
  audit.metrics = scoreChecks(checks);
  audit.stability = buildStability(audit);
  audit.survival = claims.map((claim) =>
    buildSurvival(audit, claim.id, claim.evidenceIds),
  );
  audit.issues = diagnose(audit, hasDescription, hasLd, bodyEvidence);
  audit.recommendations = audit.issues.map((issue, index) => ({
    id: `fix-${index + 1}`,
    issueId: issue.id,
    whatFailed: issue.title,
    where: failureWhere(issue.type),
    evidenceIds: issue.evidenceIds,
    change: issue.recommendedFix,
    rationale: `This addresses the measured ${failureWhere(issue.type)} failure without adding unsupported business facts.`,
  }));
  return audit;
}

function check(
  id: string,
  dimension: Check["dimension"],
  label: string,
  value: number,
  weight: number,
  evidenceIds: string[],
): Check {
  return {
    id,
    dimension,
    label,
    status: value >= 0.999 ? "pass" : "fail",
    value,
    weight,
    evidenceIds,
  };
}
function na(
  id: string,
  dimension: Check["dimension"],
  label: string,
  limitation: string,
): Check {
  return {
    id,
    dimension,
    label,
    status: "na",
    value: 0,
    weight: 1,
    evidenceIds: [],
    limitation,
  };
}
function ratio(results: Audit["retrievals"]) {
  return results.length
    ? results.filter((r) => r.correct === true).length / results.length
    : 0;
}
function buildStability(audit: Audit): Audit["stability"] {
  const keys = new Set(
    audit.retrievals
      .filter((r) => r.claimId)
      .map((r) => `${r.claimId}:${r.mode}`),
  );
  return [...keys].map((key) => {
    const [claimId, mode] = key.split(":") as [
        string,
        "direct" | "search_grounded",
      ],
      items = audit.retrievals.filter(
        (r) => r.claimId === claimId && r.mode === mode,
      ),
      measured = items.filter((r) => r.correct !== null),
      successfulVariants = measured.filter((r) => r.correct).length,
      failedVariants = measured.length - successfulVariants,
      answers = [
        ...new Set(measured.map((r) => r.answer).filter(Boolean) as string[]),
      ];
    return {
      claimId,
      mode,
      successfulVariants,
      failedVariants,
      unavailableVariants: items.length - measured.length,
      stabilityRatio: measured.length
        ? successfulVariants / measured.length
        : null,
      contradictoryAnswers: successfulVariants && failedVariants ? answers : [],
      uncertainty: !measured.length
        ? "unavailable"
        : failedVariants
          ? "Equivalent formulations produced inconsistent or incorrect results"
          : "consistent across measured variants",
    };
  });
}
function buildSurvival(
  audit: Audit,
  claimId: string,
  evidenceIds: string[],
): Audit["survival"][number] {
  const evidencePresent =
      evidenceIds.length > 0 &&
      evidenceIds.every((id) => audit.evidence.some((e) => e.id === id)),
    graphPresent = Boolean(audit.graph?.claims.some((c) => c.id === claimId)),
    direct = audit.retrievals.filter(
      (r) => r.claimId === claimId && r.mode === "direct",
    ),
    search = audit.retrievals.filter(
      (r) => r.claimId === claimId && r.mode === "search_grounded",
    ),
    directPass = direct.some((r) => r.correct === true),
    searchMeasured = search.some((r) => r.correct !== null),
    searchPass = search.some((r) => r.correct === true);
  const values: Array<
    [
      Audit["survival"][number]["stages"][number]["stage"],
      Audit["survival"][number]["stages"][number]["status"],
      string,
    ]
  > = [
    [
      "source",
      evidencePresent ? "survived" : "failed",
      "Claim cites source evidence",
    ],
    [
      "crawler",
      evidencePresent ? "survived" : "failed",
      "Crawl retained cited source",
    ],
    [
      "extraction",
      evidencePresent ? "survived" : "failed",
      "Normalizer retained cited evidence",
    ],
    [
      "semantic_graph",
      graphPresent ? "survived" : "failed",
      "Claim exists in validated graph",
    ],
    [
      "model_understanding",
      direct.length ? (directPass ? "survived" : "failed") : "not_tested",
      "Derived from direct Gemini query outcomes",
    ],
    [
      "retrieval",
      searchMeasured ? (searchPass ? "survived" : "failed") : "not_tested",
      "Derived from Google-grounded query outcomes",
    ],
  ];
  const failed = values.find((v) => v[1] === "failed")?.[0] ?? null,
    measured = values.filter((v) => v[1] !== "not_tested");
  return {
    claimId,
    stages: values.map(([stage, status, note]) => ({
      stage,
      status,
      evidenceIds,
      note,
    })),
    failedAt: failed,
    survivalRate: measured.length
      ? measured.filter((v) => v[1] === "survived").length / measured.length
      : 0,
  };
}
function diagnose(
  audit: Audit,
  hasDescription: boolean,
  hasLd: boolean,
  context: string[],
): Audit["issues"] {
  const issues: Audit["issues"] = [],
    graph = audit.graph,
    claims = graph?.claims ?? [];
  if (!hasDescription)
    issues.push(
      issue(
        "missing-description",
        "weak_machine_description",
        "medium",
        "Primary page lacks a machine-readable description",
        "No meta description survived extraction.",
        [],
        [],
        context,
        "The page does not publish a description meta element.",
        "Add a concise description naming the primary entity and purpose.",
        0.98,
      ),
    );
  if (!hasLd)
    issues.push(
      issue(
        "missing-jsonld",
        "missing_structured_data",
        "medium",
        "No JSON-LD evidence was found",
        "No schema.org JSON-LD survived the crawl.",
        graph?.entities.slice(0, 1).map((e) => e.id) ?? [],
        claims.map((c) => c.id),
        context,
        "Structured entity markup is absent from crawlable HTML.",
        `Publish valid schema.org JSON-LD for the ${audit.analysis?.siteArchetype ?? "site"}, using only verified facts.`,
        0.92,
      ),
    );
  for (const stability of audit.stability.filter(
    (s) => s.stabilityRatio !== null && s.stabilityRatio < 0.75,
  )) {
    const claim = claims.find((c) => c.id === stability.claimId);
    issues.push(
      issue(
        `unstable-${stability.mode}-${stability.claimId}`,
        "retrieval_instability",
        "high",
        "An important claim is interpreted inconsistently",
        `${stability.successfulVariants} variants succeeded and ${stability.failedVariants} failed in ${stability.mode}.`,
        [],
        [stability.claimId],
        claim?.evidenceIds ?? context,
        "Equivalent wording does not consistently surface the same fact.",
        "Clarify the claim near the primary entity and reinforce it with consistent structured data and internal links.",
        0.9,
      ),
    );
  }
  return issues;
}
function issue(
  id: string,
  type: string,
  severity: "low" | "medium" | "high" | "critical",
  title: string,
  description: string,
  affectedEntities: string[],
  affectedClaims: string[],
  evidenceIds: string[],
  likelyCause: string,
  recommendedFix: string,
  confidence: number,
) {
  return {
    id,
    type,
    severity,
    title,
    description,
    affectedEntities,
    affectedClaims,
    evidenceIds,
    likelyCause,
    recommendedFix,
    confidence,
  };
}
function failureWhere(type: string) {
  return type.includes("retrieval")
    ? "retrieval"
    : type.includes("structured") || type.includes("description")
      ? "structured evidence"
      : "semantic interpretation";
}
