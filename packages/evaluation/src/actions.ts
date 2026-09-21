import type { Action, Profile, Readiness, Visibility } from "@spectra/schemas";
import { faqJsonLd } from "./readiness";
import type { Identity } from "./site";

const REVIEW_SITES =
  /(g2|capterra|clutch|trustpilot|trustradius|getapp|softwareadvice|gartner|yelp|tripadvisor|glassdoor|producthunt)\./;
const COMMUNITY =
  /(reddit|quora|stackoverflow|stackexchange|medium|linkedin|youtube)\./;
const REFERENCE = /(wikipedia|wikidata|crunchbase|bloomberg|forbes)\./;

/**
 * Turns every failed measurement into a concrete task, ordered by what it is
 * worth. Readiness tasks carry exact points (the score is deterministic);
 * visibility tasks are ranked by how much of the market they cover.
 */
export function buildActions(
  readiness: Readiness | null,
  visibility: Visibility | null,
  identity: Identity,
  profile: Profile | null,
): Action[] {
  const actions: Action[] = [];

  if (visibility && visibility.measured) {
    const unbranded = visibility.prompts.filter(
      (p) => p.status === "ok" && p.kind !== "branded",
    );
    const absent = unbranded.filter((p) => !p.mentioned);
    if (absent.length) {
      const rivals = visibility.shareOfVoice.filter(
        (s) => !s.brand && s.mentions > 0,
      );
      actions.push({
        id: "visibility-absent",
        source: "visibility",
        checkId: null,
        title: `Get named in the ${absent.length} buyer question${absent.length === 1 ? "" : "s"} where you are missing`,
        priority: absent.length / unbranded.length >= 0.5 ? "high" : "medium",
        points: 0,
        detail: `Gemini answered ${absent.length} of ${unbranded.length} unbranded questions without mentioning ${identity.brand}${
          rivals.length
            ? `. It named ${rivals
                .slice(0, 5)
                .map((r) => `${r.name} (${r.mentions}×)`)
                .join(", ")} instead`
            : ""
        }.`,
        fix: {
          summary:
            "Publish pages that answer these exact questions better than the sources Gemini used.",
          steps: [
            ...absent.map(
              (p) =>
                `"${p.text}": answer it on your site under a heading with that wording. Open with a 40 to 60 word direct answer that names ${identity.brand}, then give specifics: pricing, numbers, who it is for, how you differ.`,
            ),
            ...(rivals.length
              ? [
                  `Publish honest comparison pages: ${identity.brand} vs ${rivals
                    .slice(0, 3)
                    .map((r) => r.name)
                    .join(
                      `, ${identity.brand} vs `,
                    )}. Answer engines lean heavily on comparison content for "best" and "alternative" questions.`,
                ]
              : []),
            "Add FAQPage structured data for these questions (code below), then re-run the audit.",
          ],
          language: "html",
          code: faqJsonLd(
            absent
              .slice(0, 6)
              .map((p) => [p.text, `… (answer that names ${identity.brand})`]),
          ),
        },
      });
    }

    const thirdParty = visibility.citedDomains.filter((d) => !d.own);
    if (thirdParty.length) {
      const review = thirdParty.filter((d) => REVIEW_SITES.test(d.domain));
      const community = thirdParty.filter((d) => COMMUNITY.test(d.domain));
      const reference = thirdParty.filter((d) => REFERENCE.test(d.domain));
      actions.push({
        id: "visibility-sources",
        source: "visibility",
        checkId: null,
        title: `Be present on the ${Math.min(thirdParty.length, 8)} sites Gemini cites for your market`,
        priority: "high",
        points: 0,
        detail: `Grounded answers cited ${thirdParty
          .slice(0, 8)
          .map((d) => `${d.domain} (${d.count}×)`)
          .join(
            ", ",
          )}. Engines repeat what these sources say, so a mention there travels into the answer.`,
        fix: {
          summary: "Earn a listing or mention on each cited source.",
          steps: [
            ...(review.length
              ? [
                  `Review platforms (${review.map((d) => d.domain).join(", ")}): claim or create your profile, fill every field and ask recent customers for reviews.`,
                ]
              : []),
            ...(community.length
              ? [
                  `Communities (${community.map((d) => d.domain).join(", ")}): answer existing threads about your category helpfully and disclose who you are.`,
                ]
              : []),
            ...(reference.length
              ? [
                  `Reference sites (${reference.map((d) => d.domain).join(", ")}): make sure your entry exists and is accurate.`,
                ]
              : []),
            ...thirdParty
              .filter(
                (d) =>
                  !review.includes(d) &&
                  !community.includes(d) &&
                  !reference.includes(d),
              )
              .slice(0, 5)
              .map(
                (d) =>
                  `${d.domain}: open the cited page and pitch an update. Many "best of" roundups accept submissions or data.`,
              ),
          ],
        },
      });
    }

    const branded = visibility.prompts.filter(
      (p) => p.status === "ok" && p.kind === "branded",
    );
    const unknown = branded.filter((p) => !p.mentioned);
    if (branded.length && unknown.length) {
      actions.push({
        id: "visibility-entity",
        source: "visibility",
        checkId: null,
        title: `Make Gemini recognise ${identity.brand} by name`,
        priority: unknown.length === branded.length ? "high" : "medium",
        points: 0,
        detail: `Asked directly about ${identity.brand}, Gemini ${unknown.length === branded.length ? "could not say who you are" : `failed ${unknown.length} of ${branded.length} times`}.`,
        fix: {
          summary: "Build an entity footprint engines can verify.",
          steps: [
            "Complete the Organization JSON-LD with sameAs links (see the Entity clarity checks).",
            "Create or update your Crunchbase, LinkedIn company page and, if you qualify, a Wikidata item, using exactly the same name and description.",
            "Get covered by a few independent sites: industry publications, partner pages, podcasts. An entity known only from its own website is weakly known.",
            "Keep your name, address and description identical everywhere.",
          ],
        },
      });
    }

    const wrong = visibility.prompts.flatMap((p) =>
      p.inaccuracies.map((text) => ({ p, text })),
    );
    if (wrong.length) {
      actions.push({
        id: "visibility-accuracy",
        source: "visibility",
        checkId: null,
        title: `Correct ${wrong.length} thing${wrong.length === 1 ? "" : "s"} Gemini gets wrong about you`,
        priority: "high",
        points: 0,
        detail: wrong.map((w) => w.text).join(" "),
        fix: {
          summary: "State the correct facts plainly on your own pages.",
          steps: [
            ...wrong.map((w) => `Correct: ${w.text}`),
            "Put each correct fact in a sentence on the about or product page, in the Organization or Product JSON-LD, and in llms.txt.",
            "Where a third-party page carries the wrong fact, ask its owner to update it.",
          ],
        },
      });
    }

    const grounded = visibility.groundedMeasured;
    if (grounded && visibility.citations === 0 && visibility.mentions > 0) {
      actions.push({
        id: "visibility-cite",
        source: "visibility",
        checkId: null,
        title: "You are mentioned but never cited",
        priority: "medium",
        points: 0,
        detail: `Gemini named ${identity.brand} but linked to other sites every time, so the traffic and authority go to them.`,
        fix: {
          summary: "Give engines a reason to cite your page as the source.",
          steps: [
            "Publish specific, quotable facts on your own pages: exact prices, numbers, dates, original data or benchmarks.",
            "Put each fact in a short, self-contained paragraph under a descriptive heading.",
            "Keep those pages fast and server-rendered (see Readable content).",
          ],
        },
      });
    }
  }

  if (readiness) {
    const possible = readiness.layers.reduce((a, l) => a + l.possible, 0) || 1;
    for (const check of readiness.checks) {
      if (check.status === "pass" || check.status === "na" || !check.fix)
        continue;
      const points =
        Math.round(((check.weight - check.earned) / possible) * 1000) / 10;
      actions.push({
        id: `check-${check.id}`,
        source: "readiness",
        checkId: check.id,
        title: check.fix.summary,
        priority: points >= 5 ? "high" : points >= 2 ? "medium" : "low",
        points,
        detail: check.found,
        fix: check.fix,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  // Being absent from answers is the outcome everything else serves, so at
  // equal priority visibility work leads; readiness work is then by points.
  return actions.sort(
    (a, b) =>
      rank[a.priority] - rank[b.priority] ||
      Number(b.source === "visibility") - Number(a.source === "visibility") ||
      b.points - a.points,
  );
}
