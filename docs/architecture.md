# Architecture

SPECTRA separates hostile network work, semantic interpretation, deterministic evaluation, and presentation. The Rust crawler emits `CrawlOutput`; TypeScript validates it before normalization. Model output is validated again before graph construction. The scorer accepts only typed checks, never prose or model-authored numbers.

## Failure boundaries

An audit advances through `validating`, `crawling`, `analyzing`, `evaluating`, and `complete`. A crawler failure is fatal. Model and search-grounding failures are partial and retain pages, metadata, structured data, and deterministic metrics. Every model run records provider, model, purpose, timing, status, and validation errors without secrets.

## Persistence model

The production relational model uses append-only audits. `targets` own many `audits`; audits own pages, evidence, entities, claims, relationships, evaluations, retrieval queries/results, metrics, issues, recommendations, and model runs. Relationships reference entity IDs. Claims and graph edges join to evidence IDs. JSONB is reserved for provider payload metadata and schema.org documents; core queryable fields remain relational. Audit mutation is limited to lifecycle state while running, then sealed with `completed_at` and `scoring_version`.

## Trust boundaries

1. Browser input is schema-validated by the API.
2. API delegates network access only to the crawler process.
3. Crawler resolves and validates every destination and redirect hop.
4. Crawler output is validated at the process boundary.
5. Normalized evidence is size-budgeted before model calls.
6. Model JSON is untrusted until schema validation succeeds.
7. Scoring consumes measured checks only.

## Journeys

A journey is a second, independent measurement over the same trust boundaries.
`runJourney` owns the loop; `packages/evaluation/journey.ts` owns every
judgement in it, and is pure. The split is the point: the model may choose
where to go, and nothing else.

1. The requested job resolves to an intent specification: the task sentence, the
   route patterns that lead toward it, and the pattern that proves it was done.
2. `robots.txt` is fetched as the chosen agent and parsed against that agent's
   own token, so a disallowed path is recorded as refused rather than fetched.
3. Each turn, the navigator returns a `NavigatorMove`, validated against
   `navigatorMoveSchema`. `clamp` is the only gate to the network: a fetch must
   be an absolute URL on the site, unvisited, and inside the remaining budget. A
   refused move is recorded as a warning and the deterministic walker takes the
   turn, so a hallucinated field can never become a request.
4. `classifyFetch` turns one response into issue codes. `proveIntent` looks for
   the intent's proof in the page text and keeps the sentence that carried it.
5. `judgeJourney` decides the outcome from the steps alone. An answer the agent
   claims but no page confirms is `partial`, never `completed`.

The whole journey is streamed after every move and checkpointed to the same
store as audits under a `journeys/` key, so a trail opened mid-walk reads
correctly and a disconnected client does not stop the walk.

## Re-scan design

Audits are immutable snapshots sharing a target identity. A later comparison aligns claims by normalized subject/predicate/object and evidence fingerprints, then shows stage changes and metric deltas without rewriting either audit.
