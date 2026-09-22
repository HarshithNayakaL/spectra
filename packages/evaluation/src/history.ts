import type { Audit } from "@spectra/schemas";
import { buildCitability } from "./citability";

/**
 * Tracking: one row per finished audit of a site, so a change can be seen as a
 * change. The row keeps the headline numbers only — the full audit stays
 * reachable by its id — and a number that was not measured on a run is null,
 * so a missing measurement never reads as a drop.
 */

export type HistoryEntry = {
  id: string;
  host: string;
  completedAt: string;
  status: Audit["status"];
  model: string;
  pages: number;
  readiness: number | null;
  grade: string;
  layers: Record<string, number | null>;
  visibility: number | null;
  named: number | null;
  asked: number | null;
  citability: number | null;
  answerable: number | null;
  lost: number | null;
  /** Checks failing on this run, with their labels for the change list. */
  failing: Array<{ id: string; label: string }>;
};

export function historyEntryOf(audit: Audit): HistoryEntry {
  const readiness = audit.readiness;
  const visibility = audit.visibility;
  const fanout = audit.fanout;
  return {
    id: audit.id,
    host: audit.host,
    completedAt: audit.completedAt ?? audit.createdAt,
    status: audit.status,
    model: audit.model,
    pages: audit.scan?.pages.length ?? 0,
    readiness: readiness?.score ?? null,
    grade: readiness?.grade ?? "",
    layers: Object.fromEntries(
      (readiness?.layers ?? []).map((layer) => [layer.id, layer.score]),
    ),
    visibility: visibility?.score ?? null,
    named: visibility?.categoryMeasured ? visibility.categoryMentions : null,
    asked: visibility?.categoryMeasured || null,
    citability: buildCitability(audit)?.score ?? null,
    answerable: fanout?.answerableCoverage ?? null,
    lost: fanout?.queries.some((query) => query.retrieval) ? fanout.lost : null,
    failing: (readiness?.checks ?? [])
      .filter((check) => check.status === "fail")
      .map((check) => ({ id: check.id, label: check.label })),
  };
}

export type Change = {
  metric: string;
  from: number | null;
  to: number | null;
  /** Positive is better, whatever the metric's direction. */
  delta: number | null;
};

/** What moved between two runs, and which checks started or stopped failing. */
export function diffEntries(before: HistoryEntry, after: HistoryEntry) {
  const metric = (
    name: string,
    from: number | null,
    to: number | null,
    lowerIsBetter = false,
  ): Change => ({
    metric: name,
    from,
    to,
    delta:
      from === null || to === null
        ? null
        : lowerIsBetter
          ? from - to
          : to - from,
  });
  return {
    changes: [
      metric("AI readiness", before.readiness, after.readiness),
      metric("AI visibility", before.visibility, after.visibility),
      metric("Citability", before.citability, after.citability),
      metric("Answerable sub-queries", before.answerable, after.answerable),
      metric("Sub-queries lost to rivals", before.lost, after.lost, true),
    ],
    fixed: before.failing.filter(
      (check) => !after.failing.some((row) => row.id === check.id),
    ),
    broke: after.failing.filter(
      (check) => !before.failing.some((row) => row.id === check.id),
    ),
  };
}
