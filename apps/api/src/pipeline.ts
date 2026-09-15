import { randomUUID } from "node:crypto";
import {
  auditSchema,
  type Audit,
  type ModelRun,
  type RetrievalResult,
} from "@spectra/schemas";
import { evaluate, normalize, selectContract } from "@spectra/evaluation";
import {
  GeminiProvider,
  GroundingUnavailableError,
} from "@spectra/model-gateway";
import { crawl } from "./crawler";
import { saveAudit } from "./store";

export type Progress = (
  stage: string,
  message: string,
  auditId: string,
) => void;

export async function runAudit(
  rawTarget: string,
  progress: Progress,
): Promise<Audit> {
  const target = normalizeTarget(rawTarget),
    id = randomUUID(),
    model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  let audit: Audit = {
    id,
    target,
    status: "queued",
    currentStage: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    scoringVersion: "spectra-v0.1",
    crawl: null,
    evidence: [],
    analysis: null,
    graph: null,
    contract: null,
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
  try {
    await stage("validating", "Validating the public target");
    await stage(
      "crawling",
      "Checking robots.txt, crawling pages, and extracting source signals",
    );
    const crawled = await crawl(target);
    audit.crawl = crawled.output;
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
    } else {
      const provider = new GeminiProvider(key, model);
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
        for (const group of groups) {
          const claim = audit.graph.claims.find(
            (item) => item.id === group.claimId,
          );
          if (!claim) continue;
          const expected = `${claim.subject} ${claim.predicate} ${claim.object}`;
          for (const [variantIndex, query] of group.variants.entries()) {
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
              const text = message(error),
                unavailable = error instanceof GroundingUnavailableError;
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
      } catch (error) {
        const text = message(error);
        audit.warnings.push(`Semantic pipeline failed: ${text}`);
        audit.modelRuns.push(
          run(model, audit.currentStage, "error", 0, false, undefined, text),
        );
        log(id, audit.currentStage, { error: text });
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
    audit = evaluate(audit);
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
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function log(auditId: string, stage: string, data: Record<string, unknown>) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), auditId, stage, ...data }),
  );
}
