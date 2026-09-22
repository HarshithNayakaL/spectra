import { useMemo, useState } from "react";
import type { Audit } from "@spectra/schemas";
import {
  buildBriefs,
  buildCitability,
  type Brief,
  type PageCitability,
} from "@spectra/evaluation";
import { pathOf } from "./api";

/**
 * The content half of the report: what to write, and whether what is already
 * written can be quoted. Both are derived from the saved audit, never stored,
 * so an older audit still renders them, or says what it cannot show.
 */

const REASON_WORD: Record<Brief["reason"], string> = {
  lost: "rival wins",
  missing: "no page",
  weak: "thin page",
};

export function BriefsSection({ audit }: { audit: Audit }) {
  const briefs = useMemo(() => buildBriefs(audit), [audit]);
  const [open, setOpen] = useState<string | null>(null);
  if (!audit.fanout?.queries.some((query) => query.retrieval)) return null;
  const all = briefs.map((brief) => brief.markdown).join("\n\n---\n\n");

  return (
    <section className="block" id="briefs">
      <div className="blockHead">
        <h2>What to write</h2>
        <p>
          The sub-queries none of your pages could answer, or a rival's page
          answered better, each turned into a page brief: the words it must
          carry, the page it has to beat, an outline and its FAQ markup. The
          facts are yours to supply.
        </p>
      </div>

      {!briefs.length ? (
        <div className="card empty">
          <b>Nothing to write</b>
          <p>
            Every sub-query had a page of yours that carries its words, and no
            rival page beat it.
          </p>
        </div>
      ) : (
        <>
          <div className="briefBar">
            <span className="mono">
              {briefs.filter((b) => b.action === "write").length} new ·{" "}
              {briefs.filter((b) => b.action === "extend").length} to extend
            </span>
            <Copy
              primary
              label={`Copy all ${briefs.length} briefs`}
              text={() => all}
            />
          </div>
          <div className="qList">
            {briefs.map((brief) => (
              <BriefRow
                key={brief.id}
                brief={brief}
                open={open === brief.id}
                toggle={() => setOpen(open === brief.id ? null : brief.id)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function BriefRow({
  brief,
  open,
  toggle,
}: {
  brief: Brief;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <article className={`qRow ${open ? "open" : ""}`}>
      <button
        type="button"
        className="qMain"
        onClick={toggle}
        aria-expanded={open}
      >
        <span
          className={`verdict ${brief.action === "write" ? "bad" : "neutral"}`}
        >
          {brief.action === "write" ? "Write" : "Extend"}
        </span>
        <span className="qText">
          <span className="qKind">{brief.kind}</span>
          {brief.title}
          <span className="fanCovers mono">{pathOf(brief.target)}</span>
        </span>
        <span className="qSide">
          <span
            className={`chip ${brief.reason === "weak" ? "" : "bad"} fanLost`}
          >
            {brief.reason === "lost" && brief.rival
              ? `${brief.rival.host} wins`
              : REASON_WORD[brief.reason]}
          </span>
        </span>
      </button>
      {open && (
        <div className="qDetail">
          <div className={`fanRet ${brief.reason === "weak" ? "" : "missing"}`}>
            <b>The page must carry</b>
            <p className="fanRetTerms">
              {brief.mustCover.length ? (
                brief.mustCover.map((term) => <code key={term}>{term}</code>)
              ) : (
                <span className="muted">
                  The query as asked, in the first paragraph.
                </span>
              )}
            </p>
            {brief.alreadyHas.length > 0 && (
              <p className="fanRetTerms">
                <b>Already has: </b>
                {brief.alreadyHas.map((term) => (
                  <code key={term}>{term}</code>
                ))}
              </p>
            )}
          </div>
          {brief.rival && (
            <p className={`fanRival ${brief.reason === "lost" ? "lost" : ""}`}>
              <b>Page to beat: </b>
              <a
                href={brief.rival.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {brief.rival.title || brief.rival.url}
              </a>{" "}
              <span className="mono">
                {brief.rival.host} · {Math.round(brief.rival.coverage * 100)}%
                of the words
              </span>
            </p>
          )}
          <ol className="briefOutline">
            {brief.outline.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
          <p className="muted small">{brief.why}</p>
          <div className="code">
            <div className="codeHead">
              <span className="mono">FAQPage JSON-LD</span>
              <Copy label="Copy" text={() => brief.schema} />
            </div>
            <pre>
              <code>{brief.schema}</code>
            </pre>
          </div>
          <div className="briefActions">
            <Copy label="Copy this brief" text={() => brief.markdown} />
          </div>
        </div>
      )}
    </article>
  );
}

/* ============================================================ citability */

export function CitabilitySection({ audit }: { audit: Audit }) {
  const citability = useMemo(() => buildCitability(audit), [audit]);
  const [open, setOpen] = useState<string | null>(null);
  if (!citability) return null;
  const pages = citability.pages;
  const liftable = pages.reduce((total, page) => total + page.liftable, 0);
  const paragraphs = pages.reduce((total, page) => total + page.paragraphs, 0);
  // The one quote an engine is likeliest to take from the whole site today.
  // Only a passage that passed the liftable test is offered as the quote.
  const best = pages
    .filter((page) => page.liftable > 0)
    .sort((a, b) => b.score! - a.score!)[0];

  return (
    <section className="block" id="citability">
      <div className="blockHead">
        <h2>Could it be quoted?</h2>
        <p>
          Being retrieved is not being cited. Engines lift a few sentences that
          stand on their own and say something checkable. Scored from the raw
          HTML, passage by passage, with no model in the loop.
        </p>
      </div>

      {citability.score === null ? (
        <div className="card empty">
          <b>Citability was not measured on this scan</b>
          <p>
            These pages were read before SPECTRA recorded their paragraphs.
            Re-run the audit to score them.
          </p>
        </div>
      ) : (
        <>
          <div className="grid">
            <section className="card span3 dark">
              <span className="scoreLabel">Citability</span>
              <span className="scoreBig">{citability.score}</span>
              <p className="scoreSub">
                <b>{liftable}</b> of <b>{paragraphs}</b> paragraphs are
                quote-sized and stand on their own, across <b>{pages.length}</b>{" "}
                {pages.length === 1 ? "page" : "pages"}.
              </p>
            </section>
            <section className="card span9">
              <h3>The passage most likely to be quoted</h3>
              {best?.best ? (
                <>
                  <blockquote className="fanRetSnippet">{best.best}</blockquote>
                  <p className="muted small mono">
                    <a
                      href={best.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {pathOf(best.url)}
                    </a>
                  </p>
                </>
              ) : (
                <p className="muted">
                  No page has a paragraph an engine could lift as it stands.
                </p>
              )}
            </section>
          </div>
          <div className="qList">
            {pages.map((page) => (
              <CitabilityRow
                key={page.url}
                page={page}
                open={open === page.url}
                toggle={() => setOpen(open === page.url ? null : page.url)}
              />
            ))}
          </div>
          {citability.unmeasured.length > 0 && (
            <p className="muted small">
              Not scored:{" "}
              {citability.unmeasured.map((row) => pathOf(row.url)).join(", ")}.{" "}
              {citability.unmeasured[0].reason}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function CitabilityRow({
  page,
  open,
  toggle,
}: {
  page: PageCitability;
  open: boolean;
  toggle: () => void;
}) {
  const score = page.score!;
  return (
    <article className={`qRow ${open ? "open" : ""}`}>
      <button
        type="button"
        className="qMain"
        onClick={toggle}
        aria-expanded={open}
      >
        <span
          className={`verdict ${score >= 70 ? "good" : score >= 40 ? "neutral" : "bad"}`}
        >
          {score}/100
        </span>
        <span className="qText">
          <span className="mono">{pathOf(page.url)}</span>
          <span className="fanCovers">{page.next}</span>
        </span>
        <span className="qSide">
          <span className="chip">
            {page.liftable}/{page.paragraphs} quotable
          </span>
        </span>
      </button>
      {open && (
        <div className="qDetail">
          {page.shell && (
            <p className="muted small">
              Scored 0: this page ships under 120 words of HTML and builds the
              rest with JavaScript, which AI crawlers do not run. The checks
              below describe the little that is there.
            </p>
          )}
          <ul className="citeChecks">
            {page.checks.map((check) => (
              <li
                key={check.id}
                className={check.earned < check.possible ? "short" : ""}
              >
                <span className="citeName">
                  {check.label}
                  <span className="citeDetail">{check.detail}</span>
                </span>
                <span className="meter" aria-hidden="true">
                  <i
                    style={{
                      width: `${(check.earned / check.possible) * 100}%`,
                    }}
                  />
                </span>
                <span className="mono">
                  {check.earned}/{check.possible}
                </span>
              </li>
            ))}
          </ul>
          {page.best && (
            <>
              <p className="muted small">What an engine would lift today:</p>
              <blockquote className="fanRetSnippet">{page.best}</blockquote>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function Copy({
  label,
  text,
  primary,
}: {
  label: string;
  text: () => string;
  primary?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={primary ? "btn primary" : "btn"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text());
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          const link = document.createElement("a");
          link.href = URL.createObjectURL(
            new Blob([text()], { type: "text/markdown" }),
          );
          link.download = "spectra-briefs.md";
          link.click();
          URL.revokeObjectURL(link.href);
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
