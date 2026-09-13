# Scoring V0.1

`spectra-v0.1` is intentionally simple and reproducible. Each registered dimension contains weighted binary or ratio checks. A check is included only when its prerequisites and archetype applicability are satisfied. N/A checks contribute neither earned points nor denominator.

The dimension score is `sum(weight × value) / sum(applicable weight) × 100`. The overall score uses the same calculation across all applicable checks, so the denominator is always visible. Values are clamped to 0..1. Each check must include evidence IDs or a limitation explaining why evidence is unavailable.

Initial equal-ish weights are engineering assumptions, not scientific claims. They exist to exercise the evaluation contract and will be calibrated against labeled fixture and production audit sets. A metric reports its version, calculation, applied checks, N/A checks, earned points, denominator, and limitations.

