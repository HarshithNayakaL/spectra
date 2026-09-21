import type { Check, Metric } from "@spectra/schemas";

export const SCORING_VERSION = "spectra-v0.1" as const;
export const dimensionRegistry = {
  intent_completion: {
    label: "Intent Completion",
    requiredInputs: ["intents", "retrievals"],
    limitations: ["Measured only against the intents supplied for this audit"],
  },
  machine_accessibility: {
    label: "Machine Accessibility",
    requiredInputs: ["crawl"],
    limitations: ["Does not render client JavaScript"],
  },
  semantic_extraction: {
    label: "Semantic Extraction",
    requiredInputs: ["evidence"],
    limitations: ["Important text is approximated deterministically"],
  },
  entity_clarity: {
    label: "Entity Clarity",
    requiredInputs: ["analysis", "graph"],
    limitations: ["Semantic observations depend on provider availability"],
  },
  relationship_preservation: {
    label: "Relationship Preservation",
    requiredInputs: ["graph"],
    limitations: ["Only evidence-linked edges qualify"],
  },
  claim_retrievability: {
    label: "Claim Retrievability",
    requiredInputs: ["retrievals"],
    limitations: ["Query sample is finite"],
  },
  structured_evidence: {
    label: "Structured Evidence",
    requiredInputs: ["crawl"],
    limitations: ["Schema correctness is shallowly validated in V0"],
  },
  ai_search_discoverability: {
    label: "AI Search Discoverability",
    requiredInputs: ["grounded retrievals"],
    limitations: ["Depends on search grounding availability"],
  },
} as const;

export function scoreChecks(checks: Check[]): Metric[] {
  const dimensions = Object.keys(dimensionRegistry) as Array<
    keyof typeof dimensionRegistry
  >;
  const metrics = dimensions
    .map((d) =>
      metric(
        d,
        checks.filter((c) => c.dimension === d),
      ),
    )
    .filter((m) => m.applied.length || m.notApplicable.length);
  return [...metrics, metric("overall", checks)];
}
function metric(dimension: Metric["dimension"], checks: Check[]): Metric {
  const applied = checks.filter((c) => c.status !== "na"),
    notApplicable = checks.filter((c) => c.status === "na");
  const denominator = applied.reduce((n, c) => n + c.weight, 0),
    earned = applied.reduce((n, c) => n + c.weight * c.value, 0);
  return {
    dimension,
    score: denominator ? Math.round((earned / denominator) * 100) : null,
    earned,
    denominator,
    applied,
    notApplicable,
    calculation: "sum(weight × value) / sum(applicable weight) × 100",
    scoringVersion: SCORING_VERSION,
    limitations: [
      ...new Set(applied.map((c) => c.limitation).filter(Boolean) as string[]),
    ],
  };
}
