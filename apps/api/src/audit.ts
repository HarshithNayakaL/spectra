import { randomUUID } from "node:crypto";
import {
  buildActions,
  buildLlmsTxt,
  deriveIdentity,
  evaluateReadiness,
  findOrganization,
  isOwnDomain,
  isPlatform,
  listPosition,
  mentions,
  normaliseSources,
  recognises,
  summariseVisibility,
  type BrandMatcher,
} from "@spectra/evaluation";
import {
  DeadlineError,
  GeminiProvider,
  GroundingUnavailableError,
  PermanentModelError,
  type ModelProvider,
  type SiteProfile,
} from "@spectra/model-gateway";
import {
  SCHEMA_VERSION,
  type Audit,
  type Engine,
  type PromptKind,
  type PromptResult,
} from "@spectra/schemas";
import { DEFAULT_MODEL } from "./models";
import { scanSite, ScanError } from "./scan";
import { saveAudit } from "./store";

export type Progress = (
  stage: string,
  message: string,
  auditId: string,
) => void;

/**
 * How long an audit may run. On serverless the function is killed at its
 * maxDuration, so the budget stops early enough to score and save whatever
 * was measured. Locally the ceiling is generous.
 */
export function timeBudgetMs(): number {
  if (process.env.SPECTRA_TIME_BUDGET_MS)
    return Number(process.env.SPECTRA_TIME_BUDGET_MS);
  if (!process.env.VERCEL) return 600_000;
  const maxDuration = Number(process.env.SPECTRA_FUNCTION_MAX_DURATION || 300);
  return Math.max(30, maxDuration - 30) * 1000;
}

export async function runAudit(
  rawTarget: string,
  progress: Progress,
  customPrompts: string[] = [],
  requestedModel?: string,
  options: { provider?: ModelProvider; apiKey?: string } = {},
): Promise<Audit> {
  const started = Date.now();
  const deadline = started + timeBudgetMs();
  const timeLeft = () => deadline - Date.now();
  const model = requestedModel || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const audit: Audit = {
    id: randomUUID(),
    version: SCHEMA_VERSION,
    target: rawTarget,
    host: hostOf(rawTarget),
    status: "scanning",
    stage: "Fetching the site as AI crawlers see it",
    createdAt: new Date().toISOString(),
    completedAt: null,
    durationMs: 0,
    model,
    customPrompts,
    scan: null,
    readiness: null,
    profile: null,
    visibility: null,
    actions: [],
    llmsTxt: null,
    warnings: [],
    error: null,
  };
  const step = async (status: Audit["status"], stage: string) => {
    audit.status = status;
    audit.stage = stage;
    progress(status, stage, audit.id);
    await saveAudit(audit).catch(() => {});
  };
  await step("scanning", audit.stage);

  // 1. Scan. Deterministic and fast; everything else builds on it.
  try {
    audit.scan = await scanSite(rawTarget);
  } catch (error) {
    audit.status = "failed";
    audit.error =
      error instanceof ScanError
        ? error.message
        : `Scan failed: ${messageOf(error)}`;
    audit.completedAt = new Date().toISOString();
    audit.durationMs = Date.now() - started;
    await saveAudit(audit).catch(() => {});
    throw Object.assign(new Error(audit.error), { auditId: audit.id });
  }
  const scan = audit.scan;
  audit.host = new URL(scan.finalUrl).hostname.replace(/^www\./, "");
  audit.readiness = evaluateReadiness(scan, deriveIdentity(scan));
  audit.llmsTxt = buildLlmsTxt(deriveIdentity(scan), scan.pages);
  audit.actions = buildActions(
    audit.readiness,
    null,
    deriveIdentity(scan),
    null,
  );
  for (const failure of scan.failures.slice(0, 5))
    audit.warnings.push(`Could not read ${failure.url}: ${failure.error}`);

  // 2. Visibility. Needs Gemini.
  const key = options.apiKey ?? process.env.GEMINI_API_KEY;
  const provider =
    options.provider ??
    (key ? new GeminiProvider(key, model, { deadline }) : null);
  if (!provider) {
    audit.warnings.push(
      "GEMINI_API_KEY is not configured, so AI visibility was not measured. Readiness checks are complete.",
    );
    return finish(audit, started, "partial");
  }

  await step(
    "profiling",
    `Scanned ${scan.pages.length} pages. Asking Gemini what ${audit.host} sells`,
  );
  let profile: SiteProfile;
  try {
    profile = (await provider.profileSite(profileInput(audit, customPrompts)))
      .value;
  } catch (error) {
    if (error instanceof PermanentModelError) {
      audit.warnings.push(
        `AI visibility was not measured: ${messageOf(error)}.`,
      );
      return finish(audit, started, "partial");
    }
    const identity = deriveIdentity(scan);
    audit.warnings.push(
      `Gemini could not profile the site (${messageOf(error)}); buyer questions were limited to branded ones.`,
    );
    profile = {
      brand: identity.brand,
      aliases: [],
      category: "",
      description: identity.description,
      audience: "",
      market: "",
      facts: [],
      categoryPrompts: [],
      brandedPrompts: [
        `What is ${identity.brand}?`,
        `${identity.brand} reviews`,
      ],
    };
  }
  const { categoryPrompts, brandedPrompts, ...plain } = profile;
  audit.profile = plain;
  const identity = deriveIdentity(scan, plain);
  const matcher: BrandMatcher = {
    brand: plain.brand,
    aliases: plain.aliases,
    host: audit.host,
  };

  const queue: Array<{ text: string; kind: PromptKind }> = dedupe([
    ...customPrompts.map((text) => ({ text, kind: "custom" as const })),
    ...categoryPrompts.map((text) => ({ text, kind: "category" as const })),
    ...brandedPrompts.map((text) => ({ text, kind: "branded" as const })),
  ]).slice(0, 12);

  let engine: Engine = "gemini_search";
  let engineNote =
    "Answers came from Gemini with Google Search grounding, the same retrieval behind Google AI Mode and AI Overviews.";
  const results: PromptResult[] = [];
  const publish = () => {
    audit.visibility = summariseVisibility(
      results,
      matcher,
      engine,
      engineNote,
    );
  };

  for (const [index, item] of queue.entries()) {
    const id = `p${index + 1}`;
    if (timeLeft() < 25_000) {
      results.push(skipped(id, item, engine));
      continue;
    }
    await step(
      "asking",
      `Asking Gemini ${index + 1} of ${queue.length}: "${item.text}"`,
    );
    const began = Date.now();
    try {
      let grounded = engine === "gemini_search";
      let answer;
      try {
        answer = (await provider.ask(item.text, grounded)).value;
      } catch (error) {
        if (!(error instanceof GroundingUnavailableError)) throw error;
        engine = "gemini_model";
        engineNote = `${messageOf(error)}, so answers came from Gemini's own knowledge without live search. Citations could not be measured.`;
        grounded = false;
        answer = (await provider.ask(item.text, false)).value;
      }
      const sources = normaliseSources(answer.sources);
      results.push({
        id,
        text: item.text,
        kind: item.kind,
        engine: grounded ? "gemini_search" : "gemini_model",
        status: "ok",
        answer: answer.answer,
        mentioned:
          item.kind === "branded"
            ? recognises(answer.answer, matcher)
            : mentions(answer.answer, matcher),
        position:
          item.kind === "branded" ? null : listPosition(answer.answer, matcher),
        cited: sources.some((s) => isOwnDomain(s.domain, audit.host)),
        competitors: [],
        sentiment: null,
        inaccuracies: [],
        sources,
        durationMs: Date.now() - began,
      });
    } catch (error) {
      results.push({
        ...skipped(id, item, engine),
        status: "error",
        error: messageOf(error),
        durationMs: Date.now() - began,
      });
      if (error instanceof PermanentModelError) {
        audit.warnings.push(`Stopped asking questions: ${messageOf(error)}.`);
        for (const [rest, next] of queue.slice(index + 1).entries())
          results.push(skipped(`p${index + 2 + rest}`, next, engine));
        break;
      }
    }
    publish();
  }
  if (results.some((r) => r.status === "skipped" && !r.error))
    audit.warnings.push(
      "Some questions were not asked because the audit reached its time limit.",
    );

  // 3. Read the answers: who else was named, tone, factual errors.
  const answered = results.filter((r) => r.status === "ok");
  if (answered.length && timeLeft() > 15_000) {
    await step(
      "analysing",
      `Reading ${answered.length} answers for competitors and errors`,
    );
    try {
      const analysis = (
        await provider.analyseAnswers(
          plain,
          answered.map((r) => ({ id: r.id, prompt: r.text, answer: r.answer })),
        )
      ).value;
      for (const row of analysis) {
        const result = results.find((r) => r.id === row.id);
        if (!result) continue;
        result.competitors = row.competitors
          .filter((name) => !mentions(name, matcher) && !isPlatform(name))
          .slice(0, 12);
        result.sentiment = result.mentioned ? row.sentiment : null;
        result.inaccuracies = result.mentioned
          ? row.inaccuracies.slice(0, 4)
          : [];
      }
    } catch (error) {
      audit.warnings.push(
        `Competitor analysis did not finish (${messageOf(error)}); mentions and citations are still measured.`,
      );
    }
  }
  publish();

  audit.readiness = evaluateReadiness(scan, identity);
  audit.llmsTxt = buildLlmsTxt(identity, scan.pages);
  audit.actions = buildActions(
    audit.readiness,
    audit.visibility,
    identity,
    plain,
  );
  const complete = answered.length === results.length && answered.length > 0;
  return finish(audit, started, complete ? "complete" : "partial");
}

async function finish(audit: Audit, started: number, status: Audit["status"]) {
  audit.status = status;
  audit.stage = status === "complete" ? "Complete" : "Finished with gaps";
  audit.completedAt = new Date().toISOString();
  audit.durationMs = Date.now() - started;
  await saveAudit(audit);
  return audit;
}

function profileInput(audit: Audit, customPrompts: string[]) {
  const scan = audit.scan!;
  return {
    host: audit.host,
    organization: findOrganization(scan.pages),
    customPrompts,
    pages: scan.pages.slice(0, 8).map((page) => ({
      url: page.url,
      title: page.title,
      description: page.description,
      headings: page.headings.slice(0, 15).map((h) => h.text),
      excerpt: page.excerpt.slice(0, page === scan.pages[0] ? 2500 : 1200),
    })),
  };
}

function skipped(
  id: string,
  item: { text: string; kind: PromptKind },
  engine: Engine,
): PromptResult {
  return {
    id,
    text: item.text,
    kind: item.kind,
    engine,
    status: "skipped",
    answer: "",
    mentioned: false,
    position: null,
    cited: false,
    competitors: [],
    sentiment: null,
    inaccuracies: [],
    sources: [],
    durationMs: 0,
  };
}

function dedupe<T extends { text: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.text.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hostOf(value: string) {
  try {
    return new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function messageOf(error: unknown) {
  if (error instanceof DeadlineError) return "the time limit was reached";
  return error instanceof Error ? error.message : String(error);
}
