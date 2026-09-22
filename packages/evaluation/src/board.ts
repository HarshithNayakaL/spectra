import type { Audit, Check, LayerId } from "@spectra/schemas";
import { LAYERS } from "./readiness";
import { FANOUT_TYPE_LABEL } from "./fanout";

/**
 * The board: one screen that says how far the measurement got, what each stage
 * actually measured, and what is missing.
 *
 * An audit produces a lot of true statements. What it did not produce is just
 * as informative, and until now the report never said so: a stage that never
 * ran looked the same as a stage that ran and found nothing. The board is
 * derived from the audit alone — it is never stored, so an audit saved before
 * this existed still renders one.
 */

export type StageState =
  /** Ran, and nothing is missing. */
  | "pass"
  /** Ran, and found gaps. */
  | "partial"
  /** Ran, and the news is bad. */
  | "fail"
  /** Has not run yet on an audit that is still going. */
  | "running"
  /** Could not run, and the report says why. */
  | "skipped";

export type Gap = {
  text: string;
  severity: "high" | "medium" | "low";
  /** Anchor in the report that shows the evidence for this gap. */
  href?: string;
};

export type Stage = {
  id: string;
  label: string;
  /** The question this stage answers, in the reader's words. */
  question: string;
  state: StageState;
  /** The headline count, as measured over measurable. */
  measured: string;
  /** 0-100 when the stage has a denominator, null when it has none. */
  coverage: number | null;
  facts: Array<{ label: string; value: string; bad?: boolean }>;
  missing: Gap[];
  /** Where to read the evidence. */
  href: string;
};

export type Board = {
  stages: Stage[];
  /** Every gap on the board, worst first. */
  gaps: Gap[];
  /** Stages that produced a measurement. */
  ran: number;
  total: number;
  /** True while the audit is still running. */
  live: boolean;
};

const TERMINAL = new Set(["complete", "partial", "failed"]);

export function buildBoard(audit: Audit): Board {
  const live = !TERMINAL.has(audit.status);
  const stages = [
    crawlStage(audit, live),
    ...(["content", "entity", "agent"] as LayerId[]).map((layer) =>
      layerStage(audit, layer, live),
    ),
    retrievalStage(audit, live),
    fanoutStage(audit, live),
    answerStage(audit, live),
    fixStage(audit, live),
  ];
  // A stage that named a gap is not clear, whatever its own checks scored.
  // Without this a row could read "pass" beside "2 gaps", which is the kind of
  // flattery this product exists to avoid.
  for (const stage of stages)
    if (stage.state === "pass" && stage.missing.length) stage.state = "partial";

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return {
    stages,
    gaps: stages
      .flatMap((stage) => stage.missing)
      .sort((a, b) => rank[a.severity] - rank[b.severity]),
    ran: stages.filter(
      (stage) => stage.state !== "running" && stage.state !== "skipped",
    ).length,
    total: stages.length,
    live,
  };
}

/* ============================================================ stages */

function crawlStage(audit: Audit, live: boolean): Stage {
  const scan = audit.scan;
  const checks = layerChecks(audit, "access");
  if (!scan)
    return {
      id: "crawl",
      label: "Crawl",
      question: LAYERS.access.question,
      state: live ? "running" : "skipped",
      measured: live ? "fetching" : "not reached",
      coverage: null,
      facts: [],
      missing: live
        ? []
        : [
            {
              text: audit.error || "The site could not be fetched at all.",
              severity: "high",
            },
          ],
      href: "#pages",
    };
  const blocked = scan.bots.filter(
    (bot) => bot.blocked && bot.agent !== "Browser",
  );
  const browserBlocked = scan.bots.some(
    (bot) => bot.agent === "Browser" && bot.blocked,
  );
  return {
    id: "crawl",
    label: "Crawl",
    question: LAYERS.access.question,
    state: stateOf(checks, blocked.length > 0),
    measured: `${scan.pages.length} ${scan.pages.length === 1 ? "page" : "pages"} read`,
    coverage: coverageOf(checks),
    facts: [
      {
        label: "AI crawlers allowed",
        value: `${scan.bots.length - 1 - blocked.length}/${scan.bots.length - 1}`,
        bad: blocked.length > 0,
      },
      {
        label: "robots.txt",
        value:
          scan.robots.status === 200
            ? "served"
            : `${scan.robots.status ?? "no answer"}`,
        bad: scan.robots.status !== 200,
      },
      {
        label: "Sitemap URLs",
        value: scan.sitemap.urls
          ? scan.sitemap.urls.toLocaleString("en")
          : "none",
        bad: !scan.sitemap.urls,
      },
      {
        label: "Failed requests",
        value: String(scan.failures.length),
        bad: scan.failures.length > 0,
      },
    ],
    missing: [
      ...blocked.map((bot) => ({
        text: `${bot.agent} was refused${bot.note ? ` — it ${bot.note}` : ""}${
          browserBlocked ? "" : ", while a browser was let in"
        }.`,
        severity: "high" as const,
        href: "#layer-access",
      })),
      ...gapsFrom(checks, "#layer-access"),
    ],
    href: "#layer-access",
  };
}

function layerStage(audit: Audit, layer: LayerId, live: boolean): Stage {
  const checks = layerChecks(audit, layer);
  const scan = audit.scan;
  const label = {
    content: "Extraction",
    entity: "Entity",
    agent: "AI files",
    access: "Crawl",
  }[layer];
  if (!checks.length)
    return {
      id: layer,
      label,
      question: LAYERS[layer].question,
      state: live ? "running" : "skipped",
      measured: live ? "waiting" : "not reached",
      coverage: null,
      facts: [],
      missing: [],
      href: `#layer-${layer}`,
    };
  const facts: Stage["facts"] = [];
  if (layer === "content" && scan) {
    const shells = scan.pages.filter((page) => page.appShell).length;
    const words = scan.pages.reduce((total, page) => total + page.words, 0);
    facts.push(
      {
        label: "Words in raw HTML",
        value: words.toLocaleString("en"),
        bad: words < 1200,
      },
      {
        label: "Pages needing JavaScript",
        value: `${shells}/${scan.pages.length}`,
        bad: shells > 0,
      },
      {
        label: "Pages with a description",
        value: `${scan.pages.filter((page) => page.description).length}/${scan.pages.length}`,
        bad: scan.pages.some((page) => !page.description),
      },
    );
  }
  if (layer === "entity" && scan) {
    const types = new Set(scan.pages.flatMap((page) => page.jsonLdTypes));
    const profiles = new Set(scan.pages.flatMap((page) => page.socialLinks));
    facts.push(
      {
        label: "Structured-data types",
        value: types.size ? [...types].slice(0, 3).join(", ") : "none",
        bad: types.size === 0,
      },
      {
        label: "Official profiles linked",
        value: String(profiles.size),
        bad: profiles.size === 0,
      },
      {
        label: "Broken JSON-LD blocks",
        value: String(
          scan.pages.reduce((total, page) => total + page.jsonLdErrors, 0),
        ),
        bad: scan.pages.some((page) => page.jsonLdErrors > 0),
      },
    );
  }
  if (layer === "agent" && scan)
    facts.push(
      {
        label: "llms.txt",
        value: scan.llmsTxt.status === 200 ? "served" : "absent",
        bad: scan.llmsTxt.status !== 200,
      },
      {
        label: "llms-full.txt",
        value: scan.llmsFullTxt.status === 200 ? "served" : "absent",
        bad: scan.llmsFullTxt.status !== 200,
      },
    );
  const passed = checks.filter((check) => check.status === "pass").length;
  const counted = checks.filter((check) => check.status !== "na").length;
  return {
    id: layer,
    label,
    question: LAYERS[layer].question,
    state: stateOf(checks, false),
    measured: `${passed}/${counted} checks passed`,
    coverage: coverageOf(checks),
    facts,
    missing: gapsFrom(checks, `#layer-${layer}`),
    href: `#layer-${layer}`,
  };
}

/**
 * Retrieval is the half of the fan-out our own crawler runs, so it is its own
 * stage: "do you even have a page about this" is a different failure from
 * "the engine did not name you", and it has a different fix.
 */
function retrievalStage(audit: Audit, live: boolean): Stage {
  const fanout = audit.fanout;
  const question = "Do you have a page that answers each sub-query?";
  const rows = (fanout?.queries ?? []).filter((query) => query.retrieval);
  if (!rows.length)
    return {
      id: "retrieval",
      label: "Retrieval",
      question,
      state: live ? "running" : "skipped",
      measured: live ? "indexing" : "not measured",
      coverage: null,
      facts: [],
      missing: live
        ? []
        : [
            {
              text: "No sub-queries were retrieved over the crawl, so it is not known which of them your own pages could answer.",
              severity: "medium",
            },
          ],
      href: "#fanout",
    };
  const lost = rows.filter((row) => row.retrieval!.lost);
  const answered = rows.filter((row) => row.retrieval!.status === "answered");
  const weak = rows.filter((row) => row.retrieval!.status === "weak");
  const absent = rows.filter((row) => row.retrieval!.status === "missing");
  // The words no page of yours carries, most-wanted first. This is the brief.
  const wanted = new Map<string, number>();
  for (const row of [...weak, ...absent])
    for (const term of row.retrieval!.missingTerms)
      wanted.set(term, (wanted.get(term) ?? 0) + 1);
  const worst = [...wanted.entries()]
    // Two-letter terms still count toward coverage, but "vs" is not a word
    // anyone goes away and writes, so it stays out of the brief.
    .filter(([term]) => term.length > 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);

  return {
    id: "retrieval",
    label: "Retrieval",
    question,
    state: absent.length ? "fail" : weak.length ? "partial" : "pass",
    measured: `${answered.length}/${rows.length} sub-queries answerable`,
    coverage: Math.round((answered.length / rows.length) * 100),
    facts: [
      { label: "Pages indexed", value: String(fanout?.indexedPages ?? 0) },
      {
        label: "Sites compared",
        value: (fanout?.rivals ?? []).length
          ? `you + ${(fanout?.rivals ?? []).filter((rival) => rival.pages).length}`
          : "you only",
      },
      {
        label: "A rival's page wins",
        value: `${lost.length}/${rows.length}`,
        bad: lost.length > 0,
      },
      {
        label: "A page answers it",
        value: `${answered.length}/${rows.length}`,
        bad: answered.length === 0,
      },
      {
        label: "A page is close but thin",
        value: String(weak.length),
        bad: weak.length > 0,
      },
      {
        label: "No page on the subject",
        value: String(absent.length),
        bad: absent.length > 0,
      },
    ],
    missing: [
      ...absent.slice(0, 5).map((row) => ({
        text: `No page of yours is about "${row.query}".`,
        severity: "high" as const,
        href: "#fanout",
      })),
      ...lost.slice(0, 5).map((row) => ({
        text: `${row.retrieval!.rival!.host} would be retrieved ahead of you for "${row.query}".`,
        severity: "high" as const,
        href: "#fanout",
      })),
      ...(worst.length
        ? [
            {
              text: `Words no page of yours carries, most-wanted first: ${worst
                .map(([term, count]) => `${term} (${count})`)
                .join(", ")}.`,
              severity: "medium" as const,
              href: "#fanout",
            },
          ]
        : []),
    ],
    href: "#fanout",
  };
}

function fanoutStage(audit: Audit, live: boolean): Stage {
  const fanout = audit.fanout;
  const question =
    "What does the engine ask on your behalf, and are you in it?";
  if (!fanout || !fanout.measured)
    return {
      id: "fanout",
      label: "Fan-out",
      question,
      state: live ? "running" : "skipped",
      measured: live ? "expanding" : "not measured",
      coverage: null,
      facts: [],
      missing: live
        ? []
        : [
            {
              text:
                fanout?.engineNote ||
                "The question was never expanded, so it is not known which sub-queries reach you.",
              severity: "medium",
            },
          ],
      href: "#fanout",
    };
  const lost = fanout.byType.filter((row) => row.hits === 0);
  return {
    id: "fanout",
    label: "Fan-out",
    question,
    state:
      fanout.coverage === null
        ? "skipped"
        : fanout.coverage >= 60
          ? "pass"
          : fanout.coverage > 0
            ? "partial"
            : "fail",
    measured: `reached on ${fanout.mentions + fanout.cited > 0 ? fanout.queries.filter((q) => q.status === "ok" && (q.mentioned || q.cited)).length : 0} of ${fanout.measured} sub-queries`,
    coverage: fanout.coverage,
    facts: [
      {
        label: "Sub-queries run",
        value: String(fanout.measured),
      },
      {
        label: "Named in the sub-answer",
        value: `${fanout.mentions}/${fanout.measured}`,
        bad: fanout.mentions === 0,
      },
      {
        label: "Your site used as a source",
        value: `${fanout.cited}/${fanout.measured}`,
        bad: fanout.cited === 0,
      },
      {
        label: "Answered instead by",
        value: fanout.answeredBy.find((row) => !row.own)?.domain ?? "nobody",
      },
    ],
    missing: [
      ...lost.map((row) => ({
        text: `Absent from every "${FANOUT_TYPE_LABEL[row.type].toLowerCase()}" sub-query (${row.measured} run).`,
        severity: (row.type === "comparison" || row.type === "canonicalization"
          ? "high"
          : "medium") as Gap["severity"],
        href: "#fanout",
      })),
      ...(fanout.cited === 0 && fanout.engine === "gemini_search"
        ? [
            {
              text: "Your own domain was never used as a source for any sub-query.",
              severity: "high" as const,
              href: "#fanout",
            },
          ]
        : []),
    ],
    href: "#fanout",
  };
}

function answerStage(audit: Audit, live: boolean): Stage {
  const v = audit.visibility;
  const question = "When a buyer asks, are you in the answer?";
  if (!v || !v.measured)
    return {
      id: "answers",
      label: "Answers",
      question,
      state: live ? "running" : "skipped",
      measured: live ? "asking" : "not measured",
      coverage: null,
      facts: [],
      missing: live
        ? []
        : [
            {
              text: "No buyer questions were answered, so visibility is unknown on this run.",
              severity: "high",
            },
          ],
      href: "#questions",
    };
  const notAsked = v.prompts.filter(
    (prompt) => prompt.status === "skipped",
  ).length;
  const wrong = v.prompts.reduce(
    (total, prompt) => total + prompt.inaccuracies.length,
    0,
  );
  return {
    id: "answers",
    label: "Answers",
    question,
    state:
      v.categoryMeasured === 0
        ? "skipped"
        : v.categoryMentions === 0
          ? "fail"
          : v.categoryMentions < v.categoryMeasured
            ? "partial"
            : "pass",
    measured: `named in ${v.categoryMentions} of ${v.categoryMeasured} buyer questions`,
    coverage: v.categoryMeasured
      ? Math.round((v.categoryMentions / v.categoryMeasured) * 100)
      : null,
    facts: [
      { label: "Questions answered", value: String(v.measured) },
      {
        label: "Cited as a source",
        value: `${v.citations}/${v.groundedMeasured}`,
        bad: v.citations === 0,
      },
      {
        label: "Average rank when listed",
        value:
          v.averagePosition === null ? "never listed" : `#${v.averagePosition}`,
        bad: v.averagePosition === null,
      },
      {
        label: "Facts it got wrong",
        value: String(wrong),
        bad: wrong > 0,
      },
    ],
    missing: [
      ...(v.categoryMentions === 0
        ? [
            {
              text: "You were not named in a single unbranded buyer question.",
              severity: "high" as const,
              href: "#questions",
            },
          ]
        : []),
      ...(v.citations === 0 && v.groundedMeasured > 0
        ? [
            {
              text: "No answer used your site as a source, so the engine is describing you from elsewhere.",
              severity: "high" as const,
              href: "#competitors",
            },
          ]
        : []),
      ...(wrong > 0
        ? [
            {
              text: `${wrong} statement${wrong === 1 ? "" : "s"} about you contradicted your own pages.`,
              severity: "high" as const,
              href: "#questions",
            },
          ]
        : []),
      ...(notAsked > 0
        ? [
            {
              text: `${notAsked} question${notAsked === 1 ? " was" : "s were"} never asked: the audit ran out of time.`,
              severity: "low" as const,
              href: "#questions",
            },
          ]
        : []),
      ...(v.engine === "gemini_model"
        ? [
            {
              text: "Live search was unavailable, so citations could not be measured on this run.",
              severity: "medium" as const,
            },
          ]
        : []),
    ],
    href: "#questions",
  };
}

function fixStage(audit: Audit, live: boolean): Stage {
  const points = audit.actions.reduce(
    (total, action) => total + action.points,
    0,
  );
  const high = audit.actions.filter((action) => action.priority === "high");
  return {
    id: "fixes",
    label: "Fixes",
    question: "What would change the measurement?",
    state: !audit.actions.length
      ? live
        ? "running"
        : "pass"
      : high.length
        ? "partial"
        : "pass",
    measured: audit.actions.length
      ? `${audit.actions.length} ${audit.actions.length === 1 ? "task" : "tasks"}`
      : live
        ? "waiting"
        : "nothing to fix",
    coverage: null,
    facts: [
      {
        label: "High priority",
        value: String(high.length),
        bad: high.length > 0,
      },
      { label: "Readiness points recoverable", value: `+${points}` },
      {
        label: "Ready-to-paste artifacts",
        value: String(audit.actions.filter((action) => action.fix.code).length),
      },
    ],
    missing: [],
    href: "#fixes",
  };
}

/* ============================================================ helpers */

function layerChecks(audit: Audit, layer: LayerId): Check[] {
  return (audit.readiness?.checks ?? []).filter(
    (check) => check.layer === layer,
  );
}

function stateOf(checks: Check[], blocked: boolean): StageState {
  // A refused crawler is a measured fact on its own. It must not read as
  // "not measured" just because the checks have not been scored yet.
  if (blocked) return "fail";
  if (!checks.length) return "skipped";
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "partial";
  return "pass";
}

function coverageOf(checks: Check[]): number | null {
  const counted = checks.filter((check) => check.status !== "na");
  if (!counted.length) return null;
  const possible = counted.reduce((total, check) => total + check.weight, 0);
  const earned = counted.reduce((total, check) => total + check.earned, 0);
  return possible ? Math.round((earned / possible) * 100) : null;
}

/** A failing or warning check, said as the thing that is missing. */
function gapsFrom(checks: Check[], href: string): Gap[] {
  return checks
    .filter((check) => check.status === "fail" || check.status === "warn")
    .sort((a, b) => b.weight - a.weight)
    .map((check) => ({
      text: `${check.label}: ${check.found}`,
      severity: (check.status === "fail"
        ? check.weight >= 4
          ? "high"
          : "medium"
        : "low") as Gap["severity"],
      href,
    }));
}
