import type { Action, Audit } from "@spectra/schemas";

/**
 * One Markdown brief a coding agent (Claude Code, Cursor, Copilot) can act on:
 * the goal, the measured state, every task with its evidence and ready code,
 * and how to verify. Built only from the saved audit, so it never drifts from
 * what the report shows.
 */
export function buildFixPrompt(audit: Audit, only?: Action[]): string {
  const actions = only ?? audit.actions;
  const r = audit.readiness;
  const v = audit.visibility;
  const brand = audit.profile?.brand ?? audit.host;
  const lines: string[] = [
    `# Make ${audit.host} visible in AI answers`,
    "",
    "## Goal",
    `Answer engines (Google AI Mode and AI Overviews, ChatGPT search, Perplexity, Claude, Copilot) should be able to reach, read and correctly describe ${brand}, and should name it when buyers ask about its category. Apply the changes below to this codebase.`,
    "",
    "## Current results",
  ];
  if (r) {
    lines.push(`- AI readiness: ${r.score}/100 (grade ${r.grade})`);
    for (const layer of r.layers)
      if (layer.score !== null)
        lines.push(`  - ${layer.label}: ${layer.earned}/${layer.possible}`);
  }
  if (v && v.measured) {
    lines.push(
      `- AI visibility: ${v.score ?? "n/a"}/100. Named in ${v.categoryMentions} of ${v.categoryMeasured} unbranded buyer questions; cited as a source in ${v.citations} of ${v.groundedMeasured} search-grounded answers.`,
    );
    const rivals = v.shareOfVoice.filter((s) => !s.brand && s.mentions);
    if (rivals.length)
      lines.push(
        `- Competitors named instead: ${rivals.map((s) => `${s.name} (${s.mentions})`).join(", ")}`,
      );
  }
  if (audit.profile)
    lines.push(`- What ${brand} is: ${audit.profile.description}`);
  lines.push("", "## Tasks, highest impact first", "");

  actions.forEach((action, index) => {
    lines.push(
      `### ${index + 1}. ${action.title}${action.points ? ` (+${action.points} readiness points)` : ""}`,
      "",
      `**Found:** ${action.detail}`,
      "",
    );
    if (action.fix.steps.length) {
      for (const step of action.fix.steps) lines.push(`- ${step}`);
      lines.push("");
    }
    if (action.fix.code) {
      if (action.fix.file) lines.push(`File: \`${action.fix.file}\``);
      lines.push(
        "```" + (action.fix.language ?? ""),
        action.fix.code,
        "```",
        "",
      );
    }
  });

  lines.push(
    "## Rules",
    "- Do not invent facts, prices, customers or numbers. Where a value is unknown, leave a clearly marked TODO.",
    "- Keep existing robots.txt rules for private areas; only open what is listed.",
    "- Keep visual design unchanged unless a task requires new content.",
    "",
    "## Verify",
    `- Fetch https://${audit.host}/robots.txt, /llms.txt and /sitemap.xml and confirm they return 200.`,
    `- Run \`curl -s -A "GPTBot/1.2" https://${audit.host}/\` and confirm the page text is in the HTML.`,
    `- Re-run the SPECTRA audit for ${audit.target} and compare the scores.`,
  );
  return lines.join("\n");
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}
