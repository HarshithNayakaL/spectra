import { randomUUID } from "node:crypto";
import {
  auditSchema,
  type Audit,
  type Intent,
  type IntentRequest,
  type ModelRun,
  type RetrievalResult,
} from "@spectra/schemas";
import { evaluate, normalize, selectContract } from "@spectra/evaluation";
import {
  DeadlineError,
  GeminiProvider,
  GroundingUnavailableError,
  type ModelProvider,
} from "@spectra/model-gateway";
import { crawl } from "./crawler";
import { saveAudit } from "./store";

export type Progress = (
  stage: string,
  message: string,
  auditId: string,
) => void;

const MAX_INTENTS = 5;

/** Raised when the remaining wall clock cannot fit the next stage. */
class BudgetExhausted extends Error {}

/**
 * How long an audit may run. On serverless the function is killed at its
 * maxDuration, so the budget stops early enough to score and save whatever
 * was measured. Locally there is no ceiling.
 */
function timeBudgetMs(): number {
  if (process.env.SPECTRA_TIME_BUDGET_MS)
    return Number(process.env.SPECTRA_TIME_BUDGET_MS);
  if (!process.env.VERCEL) return Number.POSITIVE_INFINITY;
  const maxDuration = Number(process.env.SPECTRA_FUNCTION_MAX_DURATION || 300);
  return Math.max(30, maxDuration - 40) * 1000;
}
const MAX_INTENT_VARIANTS = 4;

const STAGE_PURPOSES: Record<string, string> = {
  classifying: "site_classification",
  mapping: "semantic_graph",
  evaluating: "retrieval_question_generation",
  retrieving: "retrieval",
  intents: "intent_completion",
};

export async function runAudit(
  rawTarget: string,
  progress: Progress,
  intentRequests: IntentRequest[] = [],
  requestedModel?: string,
): Promise<Audit> {
  const id = randomUUID(),
    model =
      requestedModel || process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
    budgetMs = timeBudgetMs(),
    deadline = Date.now() + budgetMs,
    timeLeft = () => deadline - Date.now(),
    ensureTime = (needMs: number, skipped: string) => {
      if (timeLeft() < needMs) throw new BudgetExhausted(skipped);
    };
  let target: string;
  try {
    target = normalizeTarget(rawTarget);
  } catch (error) {
    // Thrown before an audit record exists, so give the caller the reason
    // rather than a bare "Invalid URL" from the URL constructor.
    throw Object.assign(new Error(message(error)), { auditId: id });
  }
  let audit: Audit = {
    id,
    target,
    status: "queued",
    currentStage: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    scoringVersion: "spectra-v0.1",
    model,
    crawl: null,
    evidence: [],
    analysis: null,
    graph: null,
    contract: null,
    intents: [],
    survival: [],
    stability: [],
    retrievals: [],
    metrics: [],
    issues: [],
    recommendations: [],
    modelRuns: [],
    warnings: [],
  };
  const stage = async (status: Audit["status"], message: string) => {
    audit.status = status;
    audit.currentStage = status;
    progress(status, message, id);
    await saveAudit(audit);
    log(id, status, { message });
  };
  audit.intents = intentRequests.slice(0, MAX_INTENTS).map((request) => ({
    id: randomUUID(),
    text: request.text,
    source: "declared" as const,
    successCriteria: request.successCriteria,
    criteriaSource: request.successCriteria.length
      ? ("declared" as const)
      : ("model" as const),
    variants: [],
    outcome: "not_run" as const,
    answer: null,
    reason: "",
    metCriteria: [],
    unmetCriteria: [],
    variantsSatisfied: 0,
    variantsMeasured: 0,
    evidenceIds: [],
    retrievalIds: [],
    stages: [],
    failedAt: null,
    durationMs: 0,
  }));
  try {
    await stage("validating", "Validating the public target");
    await stage(
      "crawling",
      "Checking robots.txt, crawling pages, and extracting source signals",
    );
    const crawled = await crawl(target);
    audit.crawl = crawled.output;
    if (crawled.fallback)
      audit.warnings.push(
        "The Rust crawler binary was unavailable; this audit ran on the Node compatibility crawler.",
      );
    await stage(
      "extracting",
      `Normalizing evidence from ${audit.crawl.pages.length} crawled pages`,
    );
    audit.evidence = normalize(audit.crawl);
    await saveAudit(audit);
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      audit.warnings.push(
        "Gemini is not configured. Semantic and retrieval evaluations are unavailable; deterministic crawl measurements remain inspectable.",
      );
      audit.modelRuns.push(
        run(
          model,
          "site_classification",
          "skipped",
          0,
          false,
          undefined,
          "GEMINI_API_KEY is not configured",
        ),
      );
      if (audit.intents.length)
        audit.warnings.push(
          `${audit.intents.length} declared intent${audit.intents.length === 1 ? " was" : "s were"} recorded but not tested: intent completion needs a configured model.`,
        );
    } else {
      const provider = new GeminiProvider(key, model, { deadline });
      try {
        await stage(
          "classifying",
          "Gemini is classifying the site and primary entity",
        );
        const classified = await provider.analyzeSite(audit.evidence);
        audit.analysis = classified.value;
        audit.modelRuns.push(
          run(
            model,
            "site_classification",
            "success",
            classified.durationMs,
            false,
            classified.usage,
          ),
        );
        await saveAudit(audit);

        // Declared intents run before the claim work. They are the question
        // the operator actually asked, and the grounded-retrieval loop can
        // spend minutes on backoff that must not starve them.
        const targets = intentTargets(audit);
        if (targets.length) {
          await stage(
            "intents",
            `Testing whether ${targets.length} intent${targets.length === 1 ? "" : "s"} can be completed from site evidence`,
          );
          for (const [index, intent] of targets.entries()) {
            // Intents are the headline measurement, so they get the time first,
            // but an intent that cannot finish is marked rather than started.
            if (timeLeft() < 20_000) {
              for (const rest of targets.slice(index)) {
                rest.reason = "Skipped: the audit reached its time budget.";
                rest.stages = intentStages(audit, rest);
              }
              audit.warnings.push(
                `${targets.length - index} intent${targets.length - index === 1 ? " was" : "s were"} not tested because the audit reached its time budget.`,
              );
              break;
            }
            await measureIntent(audit, provider, intent, model, id, deadline);
            await saveAudit(audit);
          }
        }

        ensureTime(45_000, "the semantic graph and retrieval checks");
        await stage(
          "mapping",
          "Gemini is extracting evidence-linked entities, relationships, and claims",
        );
        const mapped = await provider.extractSemanticGraph(
          audit.evidence,
          audit.analysis,
        );
        audit.graph = mapped.value;
        audit.modelRuns.push(
          run(
            model,
            "semantic_graph",
            "success",
            mapped.durationMs,
            false,
            mapped.usage,
          ),
        );
        audit.contract = selectContract(audit.analysis);
        await saveAudit(audit);
        ensureTime(30_000, "the retrieval checks");
        await stage(
          "evaluating",
          "Gemini is generating retrieval questions from important claims",
        );
        const questions = await provider.generateRetrievalQueries(audit.graph);
        audit.modelRuns.push(
          run(
            model,
            "retrieval_question_generation",
            "success",
            questions.durationMs,
            false,
            questions.usage,
          ),
        );
        const important = [...audit.graph.claims]
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 2);
        const allowed = new Set(important.map((c) => c.id));
        const groups = questions.value
          .filter((group) => allowed.has(group.claimId))
          .map((group) => ({ ...group, variants: group.variants.slice(0, 3) }));
        await stage(
          "retrieving",
          `Running direct and Google-grounded evaluations for ${groups.reduce((n, g) => n + g.variants.length, 0)} query variants`,
        );
        // One grounding failure is almost always a quota or availability wall,
        // and retrying it per variant cost minutes of backoff each time.
        let groundingOff = false;
        let budgetHit = false;
        retrieval: for (const group of groups) {
          const claim = audit.graph.claims.find(
            (item) => item.id === group.claimId,
          );
          if (!claim) continue;
          const expected = `${claim.subject} ${claim.predicate} ${claim.object}`;
          for (const [variantIndex, query] of group.variants.entries()) {
            if (timeLeft() < 15_000) {
              budgetHit = true;
              break retrieval;
            }
            try {
              const result = await provider.answerDirect(
                query,
                expected,
                audit.evidence,
              );
              audit.retrievals.push({
                id: randomUUID(),
                claimId: claim.id,
                query,
                variantIndex,
                mode: "direct",
                answer: result.value.answer,
                correct: result.value.supported,
                reason: result.value.reason,
                evidenceIds: claim.evidenceIds,
                groundingSources: [],
                status: result.value.supported ? "passed" : "failed",
                durationMs: result.durationMs,
              });
              audit.modelRuns.push(
                run(
                  model,
                  "direct_understanding",
                  "success",
                  result.durationMs,
                  false,
                  result.usage,
                ),
              );
              log(id, "direct_understanding", {
                claimId: claim.id,
                variantIndex,
                success: result.value.supported,
                durationMs: result.durationMs,
              });
            } catch (error) {
              const text = message(error);
              audit.retrievals.push(
                failedRetrieval(
                  claim.id,
                  query,
                  variantIndex,
                  "direct",
                  claim.evidenceIds,
                  text,
                ),
              );
              audit.modelRuns.push(
                run(
                  model,
                  "direct_understanding",
                  "error",
                  0,
                  false,
                  undefined,
                  text,
                ),
              );
            }
            if (groundingOff) {
              audit.retrievals.push({
                ...failedRetrieval(
                  claim.id,
                  query,
                  variantIndex,
                  "search_grounded",
                  claim.evidenceIds,
                  "Skipped after an earlier grounded request failed in this audit.",
                ),
                status: "unavailable",
              });
              await saveAudit(audit);
              continue;
            }
            try {
              const grounded = await provider.answerGrounded(query);
              const judged = await provider.evaluateRetrievedAnswer(
                query,
                grounded.value.answer,
                expected,
              );
              audit.retrievals.push({
                id: randomUUID(),
                claimId: claim.id,
                query,
                variantIndex,
                mode: "search_grounded",
                answer: grounded.value.answer,
                correct: judged.value.correct,
                reason: judged.value.reason,
                evidenceIds: claim.evidenceIds,
                groundingSources: grounded.value.sources,
                groundingMetadata: grounded.value.metadata,
                status: judged.value.correct ? "passed" : "failed",
                durationMs: grounded.durationMs + judged.durationMs,
              });
              audit.modelRuns.push(
                run(
                  model,
                  "search_grounded_retrieval",
                  "success",
                  grounded.durationMs,
                  true,
                  grounded.usage,
                ),
                run(
                  model,
                  "retrieval_judgment",
                  "success",
                  judged.durationMs,
                  false,
                  judged.usage,
                ),
              );
              log(id, "search_grounded_retrieval", {
                claimId: claim.id,
                variantIndex,
                success: judged.value.correct,
                sources: grounded.value.sources.length,
                durationMs: grounded.durationMs,
              });
            } catch (error) {
              groundingOff = true;
              const text = message(error),
                unavailable =
                  error instanceof GroundingUnavailableError ||
                  error instanceof DeadlineError;
              audit.retrievals.push({
                ...failedRetrieval(
                  claim.id,
                  query,
                  variantIndex,
                  "search_grounded",
                  claim.evidenceIds,
                  text,
                ),
                status: unavailable ? "unavailable" : "error",
              });
              audit.modelRuns.push(
                run(
                  model,
                  "search_grounded_retrieval",
                  unavailable ? "skipped" : "error",
                  0,
                  true,
                  undefined,
                  text,
                ),
              );
            }
            await saveAudit(audit);
          }
        }
        if (budgetHit)
          audit.warnings.push(
            "Some retrieval variants were skipped because the audit reached its time budget. Completed measurements are kept.",
          );
      } catch (error) {
        const text = message(error);
        if (
          error instanceof BudgetExhausted ||
          error instanceof DeadlineError
        ) {
          // Running out of wall clock is not a model failure: say what was
          // skipped and keep everything that was measured.
          audit.warnings.push(
            error instanceof BudgetExhausted
              ? `Time budget reached: skipped ${text}. Completed measurements are kept.`
              : `Time budget reached during ${audit.currentStage}. Completed measurements are kept.`,
          );
          log(id, audit.currentStage, { budget: text });
        } else {
          audit.warnings.push(`Semantic pipeline failed: ${text}`);
          audit.modelRuns.push(
            run(
              model,
              STAGE_PURPOSES[audit.currentStage] ?? "semantic_pipeline",
              "error",
              0,
              false,
              undefined,
              text,
            ),
          );
          log(id, audit.currentStage, { error: text });
        }
      }
    }
    await stage(
      "scoring",
      "Calculating deterministic measurements and information survival",
    );
    audit = evaluate(audit);
    await stage(
      "diagnosing",
      "Building evidence-backed positioning issues and repairs",
    );
    const semanticFailed =
      !audit.analysis ||
      !audit.graph ||
      audit.modelRuns.some((item) => item.status === "error");
    audit.status = semanticFailed ? "partial_failure" : "complete";
    audit.currentStage = audit.status;
    audit.completedAt = new Date().toISOString();
    await saveAudit(audit);
    progress("complete", "Report persisted and ready", id);
    log(id, audit.status, {
      pages: audit.crawl?.pages.length ?? 0,
      evidence: audit.evidence.length,
      claims: audit.graph?.claims.length ?? 0,
      retrievals: audit.retrievals.length,
    });
    return auditSchema.parse(audit);
  } catch (error) {
    audit.status = "fatal_failure";
    audit.currentStage = "fatal_failure";
    audit.completedAt = new Date().toISOString();
    audit.warnings.push(message(error));
    await saveAudit(audit).catch(() => {});
    log(id, "fatal_failure", { error: message(error) });
    throw Object.assign(new Error(message(error)), { auditId: id });
  }
}

/**
 * Declared intents are the thing being measured. When none were declared the
 * model's own inferred intents stand in, so the dimension still reports
 * something, but they are marked as model-authored and never outrank a
 * declared one.
 */
function intentTargets(audit: Audit): Intent[] {
  if (audit.intents.length) return audit.intents;
  const inferred = audit.analysis?.expectedUserIntents ?? [];
  audit.intents = inferred.slice(0, 3).map((text) => ({
    id: randomUUID(),
    text,
    source: "model" as const,
    successCriteria: [],
    criteriaSource: "model" as const,
    variants: [],
    outcome: "not_run" as const,
    answer: null,
    reason: "",
    metCriteria: [],
    unmetCriteria: [],
    variantsSatisfied: 0,
    variantsMeasured: 0,
    evidenceIds: [],
    retrievalIds: [],
    stages: [],
    failedAt: null,
    durationMs: 0,
  }));
  return audit.intents;
}

export async function measureIntent(
  audit: Audit,
  provider: ModelProvider,
  intent: Intent,
  model: string,
  auditId: string,
  deadline = Number.POSITIVE_INFINITY,
) {
  const started = Date.now();
  try {
    if (!intent.successCriteria.length) {
      const derived = await provider.deriveIntentCriteria(
        intent.text,
        audit.analysis,
      );
      intent.successCriteria = derived.value;
      intent.criteriaSource = "model";
      audit.modelRuns.push(
        run(
          model,
          "intent_criteria",
          "success",
          derived.durationMs,
          false,
          derived.usage,
        ),
      );
    }

    const variants = await provider.generateIntentVariants(intent.text);
    audit.modelRuns.push(
      run(
        model,
        "intent_variants",
        "success",
        variants.durationMs,
        false,
        variants.usage,
      ),
    );
    intent.variants = [...new Set([intent.text, ...variants.value])].slice(
      0,
      MAX_INTENT_VARIANTS,
    );

    const unmet = new Set<string>();
    const met = new Set<string>();
    const failedPhrasings: string[] = [];
    for (const [variantIndex, query] of intent.variants.entries()) {
      // Score whatever phrasings fit rather than losing the whole intent.
      if (variantIndex > 0 && Date.now() > deadline - 12_000) break;
      let attempt: Awaited<ReturnType<ModelProvider["attemptIntent"]>>;
      try {
        attempt = await provider.attemptIntent(
          query,
          intent.successCriteria,
          audit.evidence,
        );
      } catch (error) {
        const text = message(error);
        failedPhrasings.push(text);
        audit.retrievals.push({
          ...failedRetrieval("", query, variantIndex, "direct", [], text),
          claimId: undefined,
          intentId: intent.id,
        });
        audit.modelRuns.push(
          run(model, "intent_attempt", "error", 0, false, undefined, text),
        );
        if (error instanceof DeadlineError) break;
        continue;
      }
      const verdict = attempt.value;
      intent.variantsMeasured += 1;
      if (verdict.satisfied) intent.variantsSatisfied += 1;
      for (const criterion of verdict.metCriteria) met.add(criterion);
      for (const criterion of verdict.unmetCriteria) unmet.add(criterion);
      if (variantIndex === 0 || (verdict.satisfied && !intent.answer)) {
        intent.answer = verdict.answer;
        intent.reason = verdict.reason;
      }
      const retrievalId = randomUUID();
      intent.retrievalIds.push(retrievalId);
      audit.retrievals.push({
        id: retrievalId,
        intentId: intent.id,
        query,
        variantIndex,
        mode: "direct",
        answer: verdict.answer,
        correct: verdict.satisfied,
        reason: verdict.reason,
        evidenceIds: [],
        groundingSources: [],
        status: verdict.satisfied ? "passed" : "failed",
        durationMs: attempt.durationMs,
      });
      audit.modelRuns.push(
        run(
          model,
          "intent_attempt",
          "success",
          attempt.durationMs,
          false,
          attempt.usage,
        ),
      );
    }

    // A criterion met by any phrasing is met; the rest are genuinely missing.
    for (const criterion of met) unmet.delete(criterion);
    intent.metCriteria = [...met];
    intent.unmetCriteria = [...unmet];
    // Scored on the phrasings that actually ran. Only when none ran is the
    // intent an error, because then there is no measurement to report.
    intent.outcome =
      intent.variantsMeasured === 0
        ? "error"
        : intent.variantsSatisfied === 0
          ? "unsatisfied"
          : intent.variantsSatisfied === intent.variantsMeasured
            ? "satisfied"
            : "partial";
    if (failedPhrasings.length) {
      intent.error =
        intent.variantsMeasured === 0
          ? failedPhrasings[0]
          : `${failedPhrasings.length} of ${intent.variants.length} phrasings could not be run (${summariseFailure(failedPhrasings[0])}); the result is scored on the ${intent.variantsMeasured} that were.`;
    }
    log(auditId, "intent_completion", {
      intentId: intent.id,
      outcome: intent.outcome,
      satisfied: intent.variantsSatisfied,
      measured: intent.variantsMeasured,
    });
  } catch (error) {
    const text = message(error);
    intent.outcome = "error";
    intent.error = text;
    audit.modelRuns.push(
      run(model, "intent_attempt", "error", 0, false, undefined, text),
    );
    log(auditId, "intent_completion", { intentId: intent.id, error: text });
  }
  intent.durationMs = Date.now() - started;
  intent.stages = intentStages(audit, intent);
  intent.failedAt =
    intent.stages.find((entry) => entry.status === "failed")?.stage ?? null;
  // Deliberately not populated for an unmet intent: no record supports it, and
  // citing arbitrary ids would fake the provenance the report is built on.
  intent.evidenceIds =
    intent.outcome === "satisfied" || intent.outcome === "partial"
      ? audit.evidence
          .filter((item) => item.evidenceType === "visible_text")
          .slice(0, 3)
          .map((item) => item.id)
      : [];
}

/**
 * The same six-stage trace the claims use, so an unmet intent points at the
 * handover that lost it rather than just reporting a failure.
 */
function intentStages(audit: Audit, intent: Intent): Intent["stages"] {
  const pages = audit.crawl?.pages.length ?? 0;
  const evidence = audit.evidence.length;
  const reached = intent.variantsMeasured > 0;
  const satisfied = intent.outcome === "satisfied";
  const partial = intent.outcome === "partial";
  return [
    {
      stage: "source",
      status: pages ? "survived" : "failed",
      note: "Public pages were reachable",
    },
    {
      stage: "crawler",
      status: pages ? "survived" : "failed",
      note: `${pages} pages retrieved`,
    },
    {
      stage: "extraction",
      status: evidence ? "survived" : "failed",
      note: `${evidence} evidence records normalised`,
    },
    {
      stage: "semantic_graph",
      status: audit.graph ? "survived" : "not_tested",
      note: audit.graph
        ? "Semantic graph available"
        : "Intent tested directly against evidence",
    },
    {
      stage: "model_understanding",
      status: !reached
        ? "not_tested"
        : satisfied || partial
          ? "survived"
          : "failed",
      note: reached
        ? `${intent.variantsSatisfied} of ${intent.variantsMeasured} phrasings completed the job`
        : "Intent was not tested",
    },
    {
      stage: "retrieval",
      status: "not_tested",
      note: "Grounded retrieval is not run per intent",
    },
  ];
}

function run(
  model: string,
  purpose: string,
  status: ModelRun["status"],
  durationMs: number,
  groundingEnabled: boolean,
  usage?: { inputTokens?: number; outputTokens?: number },
  error?: string,
): ModelRun {
  return {
    id: randomUUID(),
    provider: "gemini",
    model,
    purpose,
    status,
    durationMs,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    groundingEnabled,
    error,
  };
}
function failedRetrieval(
  claimId: string,
  query: string,
  variantIndex: number,
  mode: RetrievalResult["mode"],
  evidenceIds: string[],
  error: string,
): RetrievalResult {
  return {
    id: randomUUID(),
    claimId,
    query,
    variantIndex,
    mode,
    answer: null,
    correct: null,
    evidenceIds,
    groundingSources: [],
    status: "error",
    error,
    durationMs: 0,
  };
}
function normalizeTarget(value: string) {
  const raw = value.trim(),
    candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
    url = new URL(candidate);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Enter a public HTTP or HTTPS URL without embedded credentials.",
    );
  url.hash = "";
  return url.href;
}
/** Turns a raw provider error into a short, readable cause. */
function summariseFailure(text: string) {
  if (/\b503\b|UNAVAILABLE|high demand/i.test(text))
    return "the model was overloaded";
  if (/\b429\b|quota/i.test(text)) return "the API quota was exhausted";
  if (/time budget/i.test(text)) return "the time budget ran out";
  return text.slice(0, 80);
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function log(auditId: string, stage: string, data: Record<string, unknown>) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), auditId, stage, ...data }),
  );
}
