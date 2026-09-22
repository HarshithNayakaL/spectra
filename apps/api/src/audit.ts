import { randomUUID } from "node:crypto";
import {
  buildActions,
  buildIndex,
  buildLlmsTxt,
  citedOwnDomain,
  deriveIdentity,
  evaluateReadiness,
  fanoutCompetitors,
  findOrganization,
  isOwnDomain,
  isPlatform,
  listPosition,
  mentions,
  normaliseSources,
  recognises,
  retrieve,
  retrieveRanked,
  summariseFanout,
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
  type FanoutQuery,
  type RivalSite,
  type PromptKind,
  type PromptResult,
} from "@spectra/schemas";
import { DEFAULT_MODEL } from "./models";
import { crawlRival, scanSite, ScanError } from "./scan";
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
    fanout: null,
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
    // Expanding a question needs a model, but retrieving does not. When the
    // operator typed their own questions there is still something true to
    // measure: whether any page we crawled could be retrieved for them.
    if (customPrompts.length)
      audit.fanout = retrievalOnlyFanout(
        scan,
        customPrompts,
        audit.host,
        "No model is configured, so these questions were not expanded or put to an answer engine. They were run through SPECTRA's own retrieval over the pages we crawled, which needs no model at all.",
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
        issuedQueries: answer.queries.slice(0, 12),
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

  // 4. Fan-out. An answer engine never searches the question it was asked: it
  //    expands it into synthetic sub-queries, runs those, and writes one answer
  //    from what came back. Ranking for the question is therefore not the
  //    measurement; being reachable for the sub-queries is.
  const issued = results.flatMap((result) => result.issuedQueries);
  const seed =
    customPrompts.find((text) => text.trim().length > 2) ??
    categoryPrompts[0] ??
    queue[0]?.text ??
    "";
  // The crawler is the search engine for half of this. The index is built from
  // the pages it already fetched, so the retrieval step runs on every
  // sub-query whether or not a live search is available, and a dead grounding
  // quota costs the live answers rather than the whole stage. The index is
  // never stored; only what it retrieved is.
  // Rivals first: a live search would find the pages that answer a sub-query
  // anywhere on the web. We cannot find, but we can fetch, so the competitive
  // set is named by the model — a plain call that spends no search quota — and
  // then crawled. It is a named set rather than the whole web, and the report
  // says exactly that.
  const rivals: RivalSite[] = [];
  const rivalPages: Array<ReturnType<typeof indexable>> = [];
  if (timeLeft() > 60_000)
    try {
      await step("expanding", `Finding who ${audit.host} is measured against`);
      const named = (
        await provider.nameRivals({
          profile: plain,
          host: audit.host,
          count: 3,
        })
      ).value.slice(0, 3);
      if (named.length) {
        await step(
          "expanding",
          `Crawling ${named.map((rival) => rival.host).join(", ")}`,
        );
        const crawled = await Promise.all(
          named.map(async (rival) => ({
            rival,
            result: await crawlRival(rival.host, {
              maxPages: 4,
              budgetMs: Math.min(14_000, Math.max(6_000, timeLeft() - 50_000)),
            }).catch((error) => ({
              host: rival.host,
              pages: [],
              error: messageOf(error),
            })),
          })),
        );
        for (const { rival, result } of crawled) {
          rivals.push({
            name: rival.name,
            host: result.host || rival.host,
            pages: result.pages.length,
            note: result.error,
          });
          for (const page of result.pages)
            rivalPages.push(indexable(page, result.host || rival.host));
        }
      }
    } catch (error) {
      audit.warnings.push(
        `The competitive set could not be named (${messageOf(error)}), so retrieval was measured against your site alone.`,
      );
    }

  const corpus = buildIndex([
    ...scan.pages.map((page) => indexable(page, audit.host)),
    ...rivalPages,
  ]);

  if (!seed) {
    // Nothing to expand: no question survived.
  } else {
    // A grounded sub-query costs a request and its pacing interval, so the
    // live half is whatever the remaining budget affords. Retrieval costs
    // nothing, so the width does not shrink with the clock.
    const room = Math.floor((timeLeft() - 45_000) / 9_000);
    const live = engine === "gemini_search" && room >= 3;
    const width = 7;
    {
      await step(
        "expanding",
        `Expanding "${seed}" the way an answer engine does`,
      );
      const rows: FanoutQuery[] = [];
      let note = live
        ? "Each sub-query below was sent to Gemini with Google Search on, exactly as written, and run through SPECTRA's own retrieval over the pages we crawled. They are synthetic: no reader typed them, the engine invents them."
        : engine === "gemini_search"
          ? "There was not enough of the time budget left to put these sub-queries to a live search, so they were measured by SPECTRA's own retrieval over the pages we crawled."
          : "Live search was unavailable, so these sub-queries were not put to an answer engine. They were still run through SPECTRA's own retrieval over the pages we crawled, which is what answerability measures.";
      const publishFanout = () => {
        audit.fanout = summariseFanout({
          seed,
          queries: rows,
          matcher,
          engine,
          engineNote: note,
          issued: [...issued, ...rows.flatMap((row) => row.issuedQueries)],
          indexedPages: corpus.pages,
          rivals,
        });
      };
      try {
        const plan = (
          await provider.expandFanout({ profile: plain, seed, count: width })
        ).value.slice(0, width);
        for (const [position, item] of plan.entries()) {
          const id = `f${position + 1}`;
          // Retrieval first: it always runs, and never costs a request.
          const retrieval = compare(corpus, item.query, audit.host);
          if (!live || timeLeft() < 22_000) {
            rows.push({ ...blankFanout(id, item), retrieval });
            publishFanout();
            continue;
          }
          await step(
            "expanding",
            `Sub-query ${position + 1} of ${plan.length}: "${item.query}"`,
          );
          const began = Date.now();
          try {
            const answer = (await provider.ask(item.query, true)).value;
            const sources = normaliseSources(answer.sources);
            rows.push({
              id,
              type: item.type,
              query: item.query,
              covers: item.covers,
              status: "ok",
              answer: answer.answer.slice(0, 4000),
              mentioned: mentions(answer.answer, matcher),
              position: listPosition(answer.answer, matcher),
              cited: citedOwnDomain(sources, audit.host),
              competitors: [],
              sources,
              issuedQueries: answer.queries.slice(0, 8),
              retrieval,
              error: "",
              durationMs: Date.now() - began,
            });
          } catch (error) {
            const permanent =
              error instanceof PermanentModelError ||
              error instanceof GroundingUnavailableError;
            rows.push({
              ...blankFanout(id, item),
              status: "error",
              retrieval,
              error: messageOf(error),
              durationMs: Date.now() - began,
            });
            if (permanent) {
              note = `Live answers stopped early (${messageOf(error)}); the rest of the fan-out was measured by SPECTRA's own retrieval alone.`;
              for (const [rest, next] of plan.slice(position + 1).entries())
                rows.push({
                  ...blankFanout(`f${position + 2 + rest}`, next),
                  retrieval: compare(corpus, next.query, audit.host),
                });
              break;
            }
          }
          publishFanout();
          await saveAudit(audit).catch(() => {});
        }
        // Who answered instead. One call over every sub-answer, and only when
        // the budget still allows it.
        const answeredRows = rows.filter((row) => row.status === "ok");
        if (answeredRows.length && timeLeft() > 18_000)
          try {
            const analysis = (
              await provider.analyseAnswers(
                plain,
                answeredRows.map((row) => ({
                  id: row.id,
                  prompt: row.query,
                  answer: row.answer,
                })),
              )
            ).value;
            for (const item of analysis) {
              const row = rows.find((candidate) => candidate.id === item.id);
              if (row)
                row.competitors = fanoutCompetitors(item.competitors, matcher);
            }
          } catch (error) {
            audit.warnings.push(
              `The fan-out's competitor read did not finish (${messageOf(error)}); its coverage numbers are still measured.`,
            );
          }
      } catch (error) {
        note = `The question could not be expanded (${messageOf(error)}), so the fan-out was not measured.`;
      }
      publishFanout();
    }
  }

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
    issuedQueries: [],
    durationMs: 0,
  };
}

/**
 * The fan-out with the model taken out of it: the operator's own questions,
 * retrieved over the crawl. Nothing here is expanded or answered, so the rows
 * carry only what our own index can prove.
 */
function retrievalOnlyFanout(
  scan: NonNullable<Audit["scan"]>,
  prompts: string[],
  host: string,
  note: string,
) {
  const corpus = buildIndex(scan.pages.map((page) => indexable(page, host)));
  const queries = prompts.slice(0, 7).map((text, position) => ({
    ...blankFanout(`f${position + 1}`, {
      type: "equivalent" as const,
      query: text,
      covers: "Your own question, as you typed it",
    }),
    retrieval: compare(corpus, text, host),
  }));
  return summariseFanout({
    seed: prompts[0],
    queries,
    matcher: { brand: host, aliases: [], host },
    engine: "gemini_search",
    engineNote: note,
    issued: [],
    indexedPages: corpus.pages,
    rivals: [],
  });
}

/** One crawled page, in the shape the index wants. */
function indexable(
  page: NonNullable<Audit["scan"]>["pages"][number],
  host: string,
) {
  return {
    url: page.url,
    host,
    title: page.title,
    description: page.description,
    headings: page.headings.map((heading) => heading.text),
    text: page.excerpt,
  };
}

/**
 * Your best page for a sub-query, and the rival page that would be retrieved
 * ahead of it.
 *
 * "Lost" is decided on term coverage, not the raw BM25 score. BM25 rewards
 * density, and a rival's four crawled pages include short ones where a couple
 * of matched terms score highly — which reported a page carrying a quarter of
 * the sub-query as beating one carrying three quarters. Coverage is the
 * verdict everywhere else in this product for the same reason: it is the thing
 * an operator can act on. The score only breaks a tie.
 */
function compare(
  corpus: Parameters<typeof retrieveRanked>[0],
  query: string,
  host: string,
) {
  const mine = retrieve(corpus, query, { host });
  const theirs = retrieveRanked(corpus, query, { limit: 8 }).find(
    (hit) => hit.host !== host,
  );
  return {
    ...mine,
    rival: theirs
      ? {
          host: theirs.host,
          url: theirs.url,
          title: theirs.title,
          coverage: theirs.coverage,
          score: theirs.score,
        }
      : null,
    lost: Boolean(
      theirs &&
      (theirs.coverage > mine.coverage ||
        (theirs.coverage === mine.coverage && theirs.score > mine.score)),
    ),
  };
}

function blankFanout(
  id: string,
  item: { type: FanoutQuery["type"]; query: string; covers: string },
): FanoutQuery {
  return {
    id,
    type: item.type,
    query: item.query,
    covers: item.covers,
    status: "skipped",
    answer: "",
    mentioned: false,
    position: null,
    cited: false,
    competitors: [],
    sources: [],
    issuedQueries: [],
    retrieval: null,
    error: "",
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
