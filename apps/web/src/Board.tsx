import { useMemo, useState } from "react";
import type { Audit, Fanout, FanoutQuery } from "@spectra/schemas";
import {
  FANOUT_TYPE_LABEL,
  FANOUT_TYPE_WHY,
  buildBoard,
  type Gap,
  type Stage,
} from "@spectra/evaluation";
import { pathOf } from "./api";

/**
 * The board, and the fan-out it reports on.
 *
 * Every other section of the report answers "what did we find". These two
 * answer the questions a reader actually opens with: how far did this get,
 * and what is missing. Composed as a specification sheet — hairlines, mono
 * labels, no zebra striping — rather than a dashboard of tiles.
 */

const STATE_WORD: Record<Stage["state"], string> = {
  pass: "clear",
  partial: "gaps",
  fail: "failing",
  running: "running",
  skipped: "not measured",
};

export function BoardSection({ audit }: { audit: Audit }) {
  const board = useMemo(() => buildBoard(audit), [audit]);
  const [open, setOpen] = useState<string | null>(null);
  const high = board.gaps.filter((gap) => gap.severity === "high");

  return (
    <section className="block" id="board">
      <div className="blockHead">
        <h2>Where it stands</h2>
        <p>
          Every stage of the measurement, what it read, and what it could not.
          {board.live
            ? " The board fills in as the audit runs."
            : ` ${board.ran} of ${board.total} stages produced a measurement.`}
        </p>
      </div>

      <div className="boardSheet">
        <div className="boardHead mono" aria-hidden="true">
          <span>Stage</span>
          <span>Measured</span>
          <span className="boardHeadCoverage">Coverage</span>
          <span>Missing</span>
        </div>
        <ol className="boardRows">
          {board.stages.map((stage) => (
            <StageRow
              key={stage.id}
              stage={stage}
              open={open === stage.id}
              toggle={() => setOpen(open === stage.id ? null : stage.id)}
            />
          ))}
        </ol>
      </div>

      {high.length > 0 && (
        <div className="boardTop">
          <b className="mono">
            {high.length} thing{high.length === 1 ? "" : "s"} to deal with first
          </b>
          <ul>
            {high.slice(0, 6).map((gap, index) => (
              <li key={`${gap.text}-${index}`}>
                {gap.href ? <a href={gap.href}>{gap.text}</a> : gap.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function StageRow({
  stage,
  open,
  toggle,
}: {
  stage: Stage;
  open: boolean;
  toggle: () => void;
}) {
  const detail = stage.facts.length > 0 || stage.missing.length > 0;
  return (
    <li className={`boardRow ${stage.state} ${open ? "open" : ""}`}>
      <button
        type="button"
        onClick={() => detail && toggle()}
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
      >
        <span className="boardStage">
          <span className={`boardDot ${stage.state}`} aria-hidden="true" />
          <span className="boardLabel">{stage.label}</span>
          <span className="boardQuestion">{stage.question}</span>
        </span>
        <span className="boardMeasured mono">{stage.measured}</span>
        <span className="boardCoverage">
          {stage.coverage === null ? (
            <span className="mono muted">{STATE_WORD[stage.state]}</span>
          ) : (
            <>
              <span className="meter" aria-hidden="true">
                <i style={{ width: `${stage.coverage}%` }} />
              </span>
              <span className="mono">{stage.coverage}%</span>
            </>
          )}
        </span>
        <span className="boardMissing mono">
          {stage.missing.length
            ? `${stage.missing.length} gap${stage.missing.length === 1 ? "" : "s"}`
            : stage.state === "running" || stage.state === "skipped"
              ? "—"
              : "none"}
        </span>
      </button>
      {open && (
        <div className="boardDetail">
          {stage.facts.length > 0 && (
            <dl className="boardFacts">
              {stage.facts.map((fact) => (
                <div key={fact.label} className={fact.bad ? "bad" : ""}>
                  <dt>{fact.label}</dt>
                  <dd className="mono">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {stage.missing.length > 0 && (
            <ul className="boardGaps">
              {stage.missing.map((gap, index) => (
                <GapRow key={`${gap.text}-${index}`} gap={gap} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function GapRow({ gap }: { gap: Gap }) {
  return (
    <li className={gap.severity}>
      <span className="boardSeverity mono">{gap.severity}</span>
      <span>
        {gap.text}
        {gap.href && (
          <a className="boardGapLink" href={gap.href}>
            evidence
          </a>
        )}
      </span>
    </li>
  );
}

/* ============================================================ fan-out */

export function FanoutSection({ audit }: { audit: Audit }) {
  const fanout = audit.fanout;
  const [open, setOpen] = useState<string | null>(null);
  if (!fanout) return null;
  const reached = fanout.queries.filter(
    (query) => query.status === "ok" && (query.mentioned || query.cited),
  ).length;

  return (
    <section className="block" id="fanout">
      <div className="blockHead">
        <h2>What the engine really asks</h2>
        <p>
          An answer engine does not search your question. It expands it into
          synthetic sub-queries, runs those, and writes one answer from what
          comes back — so being reachable on the sub-queries is the measurement,
          not ranking for the question.
        </p>
      </div>

      {!fanout.measured ? (
        <div className="card empty">
          <b>The fan-out was not measured on this run</b>
          <p>{fanout.engineNote}</p>
        </div>
      ) : (
        <>
          <div className="grid">
            <section className="card span5 dark">
              <span className="scoreLabel">Fan-out coverage</span>
              <span className="scoreBig">{fanout.coverage}</span>
              <p className="scoreSub">
                Reached on <b>{reached}</b> of <b>{fanout.measured}</b>{" "}
                sub-queries: named in <b>{fanout.mentions}</b>, used as a source
                in <b>{fanout.cited}</b>.
              </p>
              <p className="scoreSub">
                Expanded from: <i>{fanout.seed}</i>
              </p>
            </section>

            <section className="card span7">
              <h3>Where the losses are</h3>
              <p className="muted small">
                Each kind of sub-query is a different slice of the same intent.
                A kind you never appear in is a kind of buyer you never reach.
              </p>
              <ul className="fanTypes">
                {fanout.byType.map((row) => (
                  <li key={row.type} className={row.hits ? "" : "lost"}>
                    <span className="fanTypeName">
                      {FANOUT_TYPE_LABEL[row.type]}
                      <span className="fanTypeWhy">
                        {FANOUT_TYPE_WHY[row.type]}
                      </span>
                    </span>
                    <span className="meter" aria-hidden="true">
                      <i
                        style={{ width: `${(row.hits / row.measured) * 100}%` }}
                      />
                    </span>
                    <span className="mono">
                      {row.hits}/{row.measured}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="qList fanList">
            {fanout.queries.map((query) => (
              <FanoutRow
                key={query.id}
                query={query}
                open={open === query.id}
                toggle={() => setOpen(open === query.id ? null : query.id)}
              />
            ))}
          </div>

          <div className="grid">
            <section className="card span6">
              <h3>Who answered instead</h3>
              <p className="muted small">
                The domains the search tool returned across these sub-queries.
              </p>
              {fanout.answeredBy.length ? (
                <ul className="domains">
                  {fanout.answeredBy.map((row) => (
                    <li key={row.domain} className={row.own ? "you" : ""}>
                      <span>
                        {row.domain}
                        {row.own && (
                          <span className="chip good">Your site</span>
                        )}
                      </span>
                      <span className="mono">{row.count}×</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No sources were returned.</p>
              )}
            </section>

            <section className="card span6">
              <h3>What the search tool typed</h3>
              <p className="muted small">
                Not our words and not yours: these are the queries Gemini's own
                search tool issued while answering. Nobody typed them.
              </p>
              {fanout.issued.length ? (
                <ol className="issuedList mono">
                  {fanout.issued.slice(0, 24).map((query) => (
                    <li key={query}>{query}</li>
                  ))}
                </ol>
              ) : (
                <p className="muted">
                  The engine did not report the queries it issued on this run.
                </p>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function FanoutRow({
  query,
  open,
  toggle,
}: {
  query: FanoutQuery;
  open: boolean;
  toggle: () => void;
}) {
  const verdict =
    query.status !== "ok"
      ? query.status === "skipped"
        ? "Not run"
        : "Failed"
      : query.mentioned
        ? query.position
          ? `Named #${query.position}`
          : "Named"
        : query.cited
          ? "Cited"
          : "Absent";
  const tone =
    query.status !== "ok"
      ? "neutral"
      : query.mentioned || query.cited
        ? "good"
        : "bad";
  return (
    <article className={`qRow fanRow ${open ? "open" : ""}`}>
      <button
        type="button"
        className="qMain"
        onClick={toggle}
        aria-expanded={open}
        disabled={query.status !== "ok" && !query.error}
      >
        <span className={`verdict ${tone}`}>{verdict}</span>
        <span className="qText">
          <span className="qKind">{FANOUT_TYPE_LABEL[query.type]}</span>
          {query.query}
          {query.covers && <span className="fanCovers">{query.covers}</span>}
        </span>
        <span className="qSide">
          {query.cited && <span className="chip good">Cited you</span>}
          {query.competitors.length > 0 && (
            <span className="qRivals">
              {query.competitors.slice(0, 3).join(", ")}
              {query.competitors.length > 3
                ? ` +${query.competitors.length - 3}`
                : ""}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="qDetail">
          {query.error && <p className="errorText">{query.error}</p>}
          {query.answer && <p className="fanAnswer">{query.answer}</p>}
          {query.issuedQueries.length > 0 && (
            <p className="fanIssued mono">
              <b>Searched for: </b>
              {query.issuedQueries.join(" · ")}
            </p>
          )}
          {query.sources.length > 0 && (
            <div className="sources">
              <b>Pages it answered from</b>
              <ol>
                {query.sources.map((source, index) => (
                  <li key={`${source.uri}-${index}`}>
                    <a
                      href={source.uri}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {source.domain || source.title || pathOf(source.uri)}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="qFoot mono">
            {query.durationMs ? `${(query.durationMs / 1000).toFixed(1)}s` : ""}
          </p>
        </div>
      )}
    </article>
  );
}
