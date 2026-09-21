import type { Audit, Recommendation } from "@spectra/schemas";

export type FixPromptOptions = {
  /** Recommendation ids to include. Omit to include every one. */
  selected?: string[];
  /** Base URL of the API, used to write a runnable re-audit command. */
  apiUrl?: string;
};

/**
 * Builds the brief an operator hands to a coding agent.
 *
 * The shape is deliberate: a finding states what was observed, the record ids
 * let the agent verify the finding rather than trust it, the steps say what to
 * change, and the verify line closes the loop. Points are exact, because
 * scoring is deterministic and published.
 */
export function buildFixPrompt(
  audit: Audit,
  options: FixPromptOptions = {},
): string {
  const chosen = options.selected
    ? audit.recommendations.filter((r) => options.selected!.includes(r.id))
    : audit.recommendations;
  const ranked = rankFixes(chosen);
  const host = hostOf(audit.target);
  const overall = audit.metrics.find((m) => m.dimension === "overall");
  const recoverable =
    Math.round(ranked.reduce((sum, r) => sum + r.scoreImpact, 0) * 10) / 10;
  const declared = audit.intents.filter((i) => i.source === "declared");
  const out: string[] = [];

  out.push(`# Fix plan for ${host}`, "");
  out.push(
    "SPECTRA measures what an AI system understands about a website, and traces",
    "where information is lost between the page and the answer. Each finding below",
    "cites the evidence records the measurement was computed from, so you can check",
    "it rather than take it on trust.",
    "",
  );

  out.push("## Current state", "");
  out.push(`- Target: ${audit.target}`);
  out.push(`- Audit: ${audit.id}`);
  out.push(
    `- Perception score: ${overall?.score ?? "not measured"} / 100${
      overall
        ? ` (${overall.earned.toFixed(1)} of ${overall.denominator.toFixed(1)} weighted points)`
        : ""
    }`,
  );
  out.push(`- Pages crawled: ${audit.crawl?.pages.length ?? 0}`);
  out.push(`- Evidence records: ${audit.evidence.length}`);
  if (ranked.length)
    out.push(
      `- Recoverable from the fixes below: +${recoverable.toFixed(1)} points`,
    );
  if (audit.status !== "complete")
    out.push(
      `- Audit status: ${audit.status.replaceAll("_", " ")}. Some measurements did not finish, so this plan may be incomplete.`,
    );
  out.push("");

  const measured = audit.metrics.filter(
    (m) => m.dimension !== "overall" && m.score !== null,
  );
  if (measured.length) {
    out.push("Dimension scores:", "");
    for (const m of measured)
      out.push(
        `- ${m.dimension.replaceAll("_", " ")}: ${m.score}/100 (${m.earned.toFixed(1)} of ${m.denominator.toFixed(1)})`,
      );
    out.push("");
  }

  out.push("## How to read this", "");
  out.push(
    "- **Finding** is what the measurement observed, not an opinion.",
    "- **Records checked** are evidence ids from this audit. Each is quoted verbatim in the report under Evidence, so you can confirm the absence yourself.",
    "- **Fix** is the change to make. **Verify** is how to confirm it landed.",
    "- Points are exact, not estimates: the overall score is sum(weight x value) / sum(weight), so a check moving to a full pass is worth a computable number of points.",
    "- Do not invent facts about this organisation. If a fact is missing from the site, the fix is for a human to supply it, not for you to write a plausible one.",
    "",
  );

  if (!ranked.length) {
    out.push("## Fixes", "");
    out.push(
      "No evidence-backed fixes were produced for this audit. Nothing here needs changing.",
      "",
    );
    return out.join("\n");
  }

  out.push("## Fixes", "");
  out.push(
    "Ordered by severity, then by recoverable points. Work top to bottom and re-audit between batches.",
    "",
  );

  ranked.forEach((fix, index) => {
    out.push(`### ${index + 1}. ${fix.whatFailed}`, "");
    const meta = [
      `recoverable +${fix.scoreImpact.toFixed(1)} pts`,
      `severity ${fix.severity}`,
      fix.dimension ? `dimension ${fix.dimension.replaceAll("_", " ")}` : null,
      fix.checkIds.length ? `unblocks ${fix.checkIds.join(", ")}` : null,
    ].filter(Boolean);
    out.push(meta.join(" · "), "");

    const issue = audit.issues.find((i) => i.id === fix.issueId);
    if (issue) out.push(`**Finding:** ${issue.description}`, "");
    if (fix.rationale) out.push(`**Likely cause:** ${fix.rationale}`, "");

    if (fix.missingFacts.length) {
      out.push(
        "**Missing facts.** None of these appear in any crawled evidence record:",
        "",
      );
      for (const fact of fix.missingFacts) out.push(`- ${fact}`);
      out.push("");
    }

    // Every issue SPECTRA raises is an absence or an inconsistency, so these
    // ids are the records that were searched, not records that support a
    // claim. Labelling them "evidence" would overstate what they show.
    if (fix.evidenceIds.length) {
      out.push(
        `**Records checked:** ${fix.evidenceIds.slice(0, 8).join(", ")}${fix.evidenceIds.length > 8 ? `, and ${fix.evidenceIds.length - 8} more` : ""}`,
        "",
      );
    } else if (fix.missingFacts.length) {
      out.push(
        `**Records checked:** all ${audit.evidence.length} evidence records in this audit. None contains the facts above.`,
        "",
      );
    }

    if (fix.steps.length) {
      out.push("**Fix:**", "");
      fix.steps.forEach((step, n) => out.push(`${n + 1}. ${step}`));
      out.push("");
    }

    if (fix.verify) out.push(`**Verify:** ${fix.verify}`, "");
  });

  out.push("## Pages the crawler reached", "");
  out.push(
    "A fact only counts once it is on a page in this set, or on a page linked from one within two hops.",
    "",
  );
  const pages = (audit.crawl?.pages ?? []).slice(0, 12);
  for (const page of pages) out.push(`- ${page.url}`);
  if ((audit.crawl?.pages.length ?? 0) > pages.length)
    out.push(`- and ${(audit.crawl?.pages.length ?? 0) - pages.length} more`);
  out.push("");

  out.push("## Re-audit", "");
  const api = options.apiUrl?.replace(/\/$/, "") || "http://localhost:8787";
  const body = JSON.stringify(
    declared.length
      ? {
          url: audit.target,
          intents: declared.map((i) => ({
            text: i.text,
            ...(i.criteriaSource === "declared"
              ? { successCriteria: i.successCriteria }
              : {}),
          })),
        }
      : { url: audit.target },
  );
  out.push("```bash");
  out.push(`curl -N -X POST ${api}/api/audits \\`);
  out.push(`  -H 'content-type: application/json' \\`);
  out.push(`  -d '${body}'`);
  out.push("```");
  out.push("");
  if (declared.length)
    out.push(
      "The same intents are included above so the re-audit is comparable to this one. Changing them changes what is being measured.",
      "",
    );
  return out.join("\n");
}

/** Critical before high before medium, then by points recoverable. */
export function rankFixes(fixes: Recommendation[]): Recommendation[] {
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return [...fixes].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] || b.scoreImpact - a.scoreImpact,
  );
}

/** Rough token count for a budget readout. Four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hostOf(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}
