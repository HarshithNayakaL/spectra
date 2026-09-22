import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import type {
  Comparison,
  HistoryEntry,
  PageReport,
  SiteColumn,
} from "@spectra/evaluation";
import { diffEntries } from "@spectra/evaluation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight02Icon,
  ArrowUpRight01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { API, pathOf, readNdjson } from "./api";

/**
 * The three tools beside the audit and the journey:
 *
 *   Page     one URL, as each AI crawler receives it
 *   Compare  your site against up to three rivals, measured the same way
 *   Track    every finished audit of one site, and what moved between them
 *
 * All three show measurements only. Where something could not be measured the
 * screen says so, in words, instead of drawing a zero.
 */

type Navigate = (path: string, replace?: boolean) => void;

function param(name: string) {
  return new URLSearchParams(location.search).get(name) ?? "";
}

/* ============================================================ shell */

function ToolLanding({
  kicker,
  title,
  lede,
  children,
  stat,
  error,
  errorTitle,
}: {
  kicker: [string, string];
  title: [string, string];
  lede: string;
  children: ReactNode;
  stat: ReactNode;
  error: string;
  errorTitle: string;
}) {
  return (
    <section className="landing">
      <div className="bento">
        <div className="cell cellHero reveal" style={{ "--d": "0ms" } as never}>
          <div className="kicker">
            <span>{kicker[0]}</span>
            <span>{kicker[1]}</span>
          </div>
          <h1 className="heroType">
            <span>{title[0]}</span> <span>{title[1]}</span>
          </h1>
          <p className="heroLede">{lede}</p>
          {children}
        </div>
        <div
          className="cell cellStat reveal"
          style={{ "--d": "60ms" } as never}
        >
          {stat}
        </div>
        {error && (
          <div className="cell cellError cellWide" role="alert">
            <div className="notice">
              <b>{errorTitle}</b>
              <p>{error}</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  required,
  url,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  url?: boolean;
}) {
  return (
    <div className="fieldRow">
      <label htmlFor={id}>
        {label}
        {hint && <span className="labelHint">{hint}</span>}
      </label>
      <div className="field">
        <input
          id={id}
          type="text"
          inputMode={url ? "url" : undefined}
          autoComplete={url ? "url" : "off"}
          maxLength={url ? 2048 : 280}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
        />
      </div>
    </div>
  );
}

function RunButton({
  busy,
  idle,
  working,
}: {
  busy: boolean;
  idle: string;
  working: string;
}) {
  return (
    <button className="runButton" disabled={busy}>
      <span>{busy ? working : idle}</span>
      <HugeiconsIcon
        className={busy ? "runIcon spin" : "runIcon"}
        icon={busy ? Loading03Icon : ArrowRight02Icon}
        size={20}
        strokeWidth={2}
        aria-hidden="true"
      />
    </button>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="extLink"
    >
      {children}
      <HugeiconsIcon
        icon={ArrowUpRight01Icon}
        size={12}
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </a>
  );
}

function Internal({
  href,
  navigate,
  children,
  className = "btn ghost",
}: {
  href: string;
  navigate: Navigate;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(href);
        window.scrollTo({ top: 0 });
      }}
    >
      {children}
    </a>
  );
}

const SEVERITY_WORD = { high: "Blocks", medium: "Weakens", low: "Minor" };

/* ============================================================ page */

export function PageTool({ navigate }: { navigate: Navigate }) {
  const [url, setUrl] = useState(param("url"));
  const [question, setQuestion] = useState(param("q"));
  const [report, setReport] = useState<PageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(target = url, ask = question) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/api/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target, question: ask }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body.error || "The page could not be inspected.");
      setReport(body as PageReport);
      const next = `/page?url=${encodeURIComponent(target)}${ask.trim() ? `&q=${encodeURIComponent(ask.trim())}` : ""}`;
      navigate(next, true);
      window.scrollTo({ top: 0 });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  // A shared link opens straight on its report.
  useEffect(() => {
    if (param("url")) void run(param("url"), param("q"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (report)
    return (
      <PageReportView
        report={report}
        navigate={navigate}
        onReset={() => {
          setReport(null);
          navigate("/page", true);
        }}
      />
    );

  return (
    <ToolLanding
      kicker={["Page", "Single-URL inspector"]}
      title={["What AI sees", "on one page"]}
      lede="Paste any URL. SPECTRA fetches it the way an answer engine does — raw HTML, no JavaScript, robots.txt read for that exact path, and a live request as each AI crawler — and shows what it can take, what it may quote, and what stops it."
      error={error}
      errorTitle="Inspection stopped"
      stat={
        <>
          <span className="statNum">14</span>
          <span className="statLabel">crawlers checked, 6 fetched live</span>
          <p>
            Robots rules for every search and training crawler, snippet controls
            such as nosnippet and max-snippet, structured-data completeness, and
            passage-level citability.
          </p>
          <p className="statProof">
            <b>Nothing is guessed.</b> Every line is read from the response your
            server gave, and a question you add is matched against the page by
            retrieval, not by a model's opinion.
          </p>
        </>
      }
    >
      <form
        className="analyze"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void run();
        }}
      >
        <Field
          id="page-url"
          label="Page URL"
          hint="any public page"
          value={url}
          onChange={setUrl}
          placeholder="example.com/pricing"
          required
          url
        />
        <Field
          id="page-question"
          label="A question it should answer"
          hint="optional"
          value={question}
          onChange={setQuestion}
          placeholder="How much does it cost per seat?"
        />
        <RunButton busy={busy} idle="Inspect the page" working="Fetching" />
        <p className="analyzeNote">
          About ten seconds. One fetch of the page, one of robots.txt, and one
          as each of six agents.
        </p>
      </form>
    </ToolLanding>
  );
}

function PageReportView({
  report,
  navigate,
  onReset,
}: {
  report: PageReport;
  navigate: Navigate;
  onReset: () => void;
}) {
  const cite = report.citability;
  const reach = report.crawlers.filter((row) => row.kind === "search");
  const reached = reach.filter((row) => row.reaches).length;
  const c = report.controls;
  return (
    <div className="toolReport">
      <section className="block" id="page-verdict">
        <div className="blockHead jReportHead">
          <div>
            <h2>{pathOf(report.url)}</h2>
            <p>
              <Ext href={report.url}>{report.host}</Ext> · {report.status} ·{" "}
              {(report.ms / 1000).toFixed(1)}s ·{" "}
              {Math.round(report.bytes / 1024)} KB · {report.words} words in the
              HTML
            </p>
          </div>
          <div className="toolActions">
            <Internal
              href={`/?site=${encodeURIComponent(report.host)}`}
              navigate={navigate}
            >
              Audit {report.host}
            </Internal>
            <button type="button" className="btn ghost" onClick={onReset}>
              New page
            </button>
          </div>
        </div>
        <div className="grid">
          <section className="card span3 dark">
            <span className="scoreLabel">Citability</span>
            {cite.score === null ? (
              <span className="scoreNone mono">Not measured</span>
            ) : (
              <span className="scoreBig">{cite.score}</span>
            )}
            <p className="scoreSub">
              {cite.paragraphs ? (
                <>
                  <b>{cite.liftable}</b> of <b>{cite.paragraphs}</b>{" "}
                  {cite.paragraphs === 1
                    ? "paragraph is quote-sized and stands on its own."
                    : "paragraphs are quote-sized and stand on their own."}
                </>
              ) : (
                "No paragraphs in the main content to quote."
              )}
            </p>
            <p className="scoreSub">
              <b>{reached}</b> of <b>{reach.length}</b> search crawlers can
              fetch it.
            </p>
          </section>
          <section className="card span9">
            <h3>What stops an engine using this page</h3>
            {report.findings.length ? (
              <ul className="findList">
                {report.findings.map((finding) => (
                  <li key={finding.text} className={finding.severity}>
                    <span
                      className={`chip ${finding.severity === "low" ? "" : "bad"}`}
                    >
                      {SEVERITY_WORD[finding.severity]}
                    </span>
                    <span>{finding.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                Nothing. Every crawler gets the page, nothing forbids quoting
                it, and its markup is complete.
              </p>
            )}
            {cite.best && cite.liftable > 0 && (
              <>
                <p className="muted small">
                  The passage most likely to be quoted:
                </p>
                <blockquote className="fanRetSnippet">{cite.best}</blockquote>
              </>
            )}
          </section>
        </div>
      </section>

      {report.match && (
        <section className="block" id="page-match">
          <div className="blockHead">
            <h2>Does it answer the question?</h2>
            <p>
              Retrieved over this page alone, by the same scorer the audit uses.
              The verdict is term coverage: which of the question's words the
              page carries.
            </p>
          </div>
          <div className={`card fanRet ${report.match.status}`}>
            <b>
              {report.match.status === "answered"
                ? "Answers it"
                : report.match.status === "weak"
                  ? "Close, but thin"
                  : "Does not answer it"}{" "}
              · {Math.round(report.match.coverage * 100)}% of the words
            </b>
            <p className="fanRetPage">“{report.match.question}”</p>
            <p className="fanRetTerms">
              {report.match.matched.length > 0 && (
                <>
                  <b>Has: </b>
                  {report.match.matched.map((term) => (
                    <code key={term}>{term}</code>
                  ))}
                </>
              )}
              {report.match.missingTerms.length > 0 && (
                <>
                  {" "}
                  <b>Never mentions: </b>
                  {report.match.missingTerms.map((term) => (
                    <code key={term}>{term}</code>
                  ))}
                </>
              )}
            </p>
            {report.match.snippet && (
              <blockquote className="fanRetSnippet">
                {report.match.snippet}
              </blockquote>
            )}
          </div>
        </section>
      )}

      <section className="block" id="page-crawlers">
        <div className="blockHead">
          <h2>Who can fetch it</h2>
          <p>
            robots.txt read for this exact path, and a live request as each
            crawler we can impersonate. A firewall that refuses a crawler blocks
            it whatever robots.txt says.
          </p>
        </div>
        <div className="card span12 tableCard">
          <div className="tableScroll">
            <table className="pageTable">
              <thead>
                <tr>
                  <th>Crawler</th>
                  <th>Used for</th>
                  <th>robots.txt</th>
                  <th>Live request</th>
                  <th>Gets the page</th>
                </tr>
              </thead>
              <tbody>
                {report.crawlers.map((row) => (
                  <tr key={row.token}>
                    <td data-label="Crawler" className="mono">
                      {row.token}
                    </td>
                    <td data-label="Used for">
                      {row.engine}
                      {row.kind === "training" && (
                        <span className="chip">training</span>
                      )}
                    </td>
                    <td
                      data-label="robots.txt"
                      className={row.robots === "blocked" ? "bad" : ""}
                    >
                      {row.robots === "no-file" ? "no robots.txt" : row.robots}
                    </td>
                    <td
                      data-label="Live request"
                      className={row.live?.blocked ? "bad" : ""}
                    >
                      {row.live
                        ? row.live.blocked
                          ? row.live.note || "refused"
                          : `${row.live.status ?? "no answer"}${row.live.note ? ` · ${row.live.note}` : ""}`
                        : "not sent"}
                    </td>
                    <td
                      data-label="Gets the page"
                      className={row.reaches ? "ok" : "bad"}
                    >
                      {row.reaches ? "yes" : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="block" id="page-controls">
        <div className="blockHead">
          <h2>What it is allowed to quote</h2>
          <p>
            Directives that decide whether an engine may show the page, and how
            much of it, whatever the page says.
          </p>
        </div>
        <div className="card span12">
          <dl className="factGrid">
            <Fact
              label="Indexing"
              value={c.noindex ? "noindex" : "allowed"}
              bad={c.noindex}
            />
            <Fact
              label="Snippets"
              value={c.nosnippet ? "nosnippet" : "allowed"}
              bad={c.nosnippet}
            />
            <Fact
              label="max-snippet"
              value={
                c.maxSnippet === null
                  ? "not set"
                  : c.maxSnippet === -1
                    ? "unlimited"
                    : `${c.maxSnippet} characters`
              }
              bad={
                c.maxSnippet !== null && c.maxSnippet >= 0 && c.maxSnippet < 50
              }
            />
            <Fact
              label="data-nosnippet blocks"
              value={String(c.nosnippetBlocks)}
            />
            <Fact label="noai" value={c.noai ? "set" : "not set"} />
            <Fact
              label="Canonical"
              value={
                c.canonical
                  ? c.canonicalElsewhere
                    ? pathOf(c.canonical)
                    : "this page"
                  : "not set"
              }
              bad={c.canonicalElsewhere}
            />
            <Fact
              label="Language"
              value={report.lang || "not declared"}
              bad={!report.lang}
            />
            <Fact
              label="Rendered by JavaScript"
              value={report.appShell ? "yes" : "no"}
              bad={report.appShell}
            />
          </dl>
          {c.source && (
            <p className="muted small">Directives read from the {c.source}.</p>
          )}
        </div>
      </section>

      <section className="block" id="page-schema">
        <div className="blockHead">
          <h2>Structured data</h2>
          <p>
            Each JSON-LD node checked against the properties its type needs to
            be usable. A block that parses is not a block that works.
          </p>
        </div>
        {report.schema.length ? (
          <div className="qList">
            {report.schema.map((node, index) => (
              <div key={`${node.type}-${index}`} className="card schemaRow">
                <span className={`verdict ${node.ok ? "good" : "bad"}`}>
                  {node.ok ? "Complete" : "Incomplete"}
                </span>
                <div>
                  <b>{node.type}</b>
                  {node.label && <span className="muted"> · {node.label}</span>}
                  {node.missingRequired.length > 0 && (
                    <p className="small">
                      Missing: {node.missingRequired.join(", ")}
                    </p>
                  )}
                  {node.problems.map((problem) => (
                    <p className="small" key={problem}>
                      {problem}
                    </p>
                  ))}
                  {node.missingRecommended.length > 0 && (
                    <p className="small muted">
                      Recommended, not present:{" "}
                      {node.missingRecommended.join(", ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="card empty">
            <b>
              {report.schemaTypes.length
                ? `Declares ${report.schemaTypes.slice(0, 4).join(", ")}`
                : "No structured data"}
            </b>
            <p>
              {report.schemaTypes.length
                ? "None of these types has a property list SPECTRA checks, so completeness was not measured."
                : "Nothing on this page is machine-labelled, so an engine has to infer what it is."}
              {report.schemaErrors
                ? ` ${report.schemaErrors} block${report.schemaErrors === 1 ? "" : "s"} did not parse.`
                : ""}
            </p>
          </div>
        )}
      </section>

      <section className="block" id="page-text">
        <div className="blockHead">
          <h2>What the crawler reads</h2>
          <p>
            The headings and the main text exactly as the HTML delivers them,
            before any JavaScript. If it is not here, an AI crawler never saw
            it.
          </p>
        </div>
        <div className="grid">
          <section className="card span4">
            <h3>Outline</h3>
            {report.headings.length ? (
              <ol className="outline">
                {report.headings.slice(0, 40).map((heading, index) => (
                  <li key={index} className={`h${heading.level}`}>
                    <span className="mono">H{heading.level}</span>{" "}
                    {heading.text}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No headings in the HTML.</p>
            )}
          </section>
          <section className="card span8">
            <h3>Main text</h3>
            {report.text ? (
              <p className="crawlText">{report.text}</p>
            ) : (
              <p className="muted">No text in the main content.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function Fact({
  label,
  value,
  bad,
}: {
  label: string;
  value: string;
  bad?: boolean;
}) {
  return (
    <div className={bad ? "bad" : ""}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

/* ============================================================ compare */

type CompareRecord = Comparison & {
  id: string;
  status: "running" | "complete";
  stage: string;
  createdAt: string;
  durationMs: number;
  model: string;
  questionSource: "yours" | "expanded" | "none";
  questionNote: string;
  topic: string;
  pending: string[];
};

export function CompareTool({
  id,
  navigate,
}: {
  id?: string;
  navigate: Navigate;
}) {
  const initial = param("sites").split(",").filter(Boolean);
  const [sites, setSites] = useState<string[]>(
    [...initial, "", "", "", ""].slice(
      0,
      Math.max(2, Math.min(4, initial.length + 1)),
    ),
  );
  const [topic, setTopic] = useState(param("topic"));
  const [questions, setQuestions] = useState(param("q"));
  const [record, setRecord] = useState<CompareRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id || record?.id === id) return;
    setLoading(true);
    fetch(`${API}/api/compares/${id}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body) => setRecord(body as CompareRecord))
      .catch(() =>
        setError("This comparison could not be loaded. Run a new one."),
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function run(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}/api/compares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sites: sites.filter((site) => site.trim()),
          topic,
          questions: questions
            .split(/\n|;/)
            .map((line) => line.trim())
            .filter(Boolean),
        }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "The comparison could not start.");
      }
      let failed = "";
      await readNdjson(response.body, (event) => {
        if (event.type === "progress" || event.type === "result")
          setRecord(event.compare as CompareRecord);
        if (event.type === "result")
          navigate(`/compares/${(event.compare as CompareRecord).id}`, true);
        if (event.type === "error") failed = event.message;
      });
      if (failed) throw new Error(failed);
    } catch (failure) {
      setRecord(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return <div className="toolLoading mono">Loading the comparison…</div>;
  if (record)
    return (
      <CompareView
        record={record}
        live={busy}
        navigate={navigate}
        onReset={() => {
          setRecord(null);
          navigate("/compare", true);
        }}
      />
    );

  return (
    <ToolLanding
      kicker={["Compare", "Head to head"]}
      title={["You against", "your rivals"]}
      lede="Your site and up to three competitors, crawled the same way on the same day and scored by the same checks: who AI crawlers can reach, who is readable, who can be quoted, and whose page a retriever would pick for each buyer question."
      error={error}
      errorTitle="Comparison stopped"
      stat={
        <>
          <span className="statNum">4</span>
          <span className="statLabel">sites, 1 crawl each, 1 index</span>
          <p>
            Every question is retrieved over one index holding all the sites'
            pages, so the answer is whichever page in the market carries it
            best.
          </p>
          <p className="statProof">
            <b>No model picks the winner.</b> A topic can be expanded into
            questions by Gemini; who answers them is decided by the crawl.
          </p>
        </>
      }
    >
      <form className="analyze" aria-busy={busy} onSubmit={run}>
        {sites.map((site, index) => (
          <Field
            key={index}
            id={`compare-site-${index}`}
            label={index === 0 ? "Your site" : `Rival ${index}`}
            hint={
              index === 1 ? "at least one" : index > 1 ? "optional" : undefined
            }
            value={site}
            onChange={(value) => {
              const next = [...sites];
              next[index] = value;
              setSites(next);
            }}
            placeholder={index === 0 ? "yourcompany.com" : "rival.com"}
            required={index < 2}
            url
          />
        ))}
        {sites.length < 4 && (
          <button
            type="button"
            className="rowAdd"
            onClick={() => setSites([...sites, ""])}
          >
            + Add a rival
          </button>
        )}
        <Field
          id="compare-topic"
          label="What you sell, in a few words"
          hint="expanded into buyer questions"
          value={topic}
          onChange={setTopic}
          placeholder="Issue tracking for software teams"
        />
        <Field
          id="compare-questions"
          label="Or your own questions"
          hint="separate with ;"
          value={questions}
          onChange={setQuestions}
          placeholder="Best Jira alternative; issue tracker pricing per user"
        />
        <RunButton busy={busy} idle="Compare the sites" working="Crawling" />
        <p className="analyzeNote">
          Up to twelve pages per site, crawled in parallel. Usually under a
          minute.
        </p>
      </form>
    </ToolLanding>
  );
}

function CompareView({
  record,
  live,
  navigate,
  onReset,
}: {
  record: CompareRecord;
  live: boolean;
  navigate: Navigate;
  onReset: () => void;
}) {
  const sites = record.sites;
  const measured = sites.filter((site) => site.measured);
  const rows: Array<{
    label: string;
    value: (site: SiteColumn) => number | null;
    show: (site: SiteColumn) => string;
    lowerIsBetter?: boolean;
  }> = [
    {
      label: "AI readiness",
      value: (s) => s.readiness,
      show: (s) => `${s.readiness}/100 · ${s.grade}`,
    },
    ...(["access", "content", "entity", "agent"] as const).map((layer) => ({
      label:
        measured[0]?.layers.find((item) => item.id === layer)?.label ?? layer,
      value: (s: SiteColumn) =>
        s.layers.find((item) => item.id === layer)?.score ?? null,
      show: (s: SiteColumn) => {
        const score = s.layers.find((item) => item.id === layer)?.score;
        return score === null || score === undefined ? "n/a" : `${score}`;
      },
    })),
    {
      label: "Citability",
      value: (s) => s.citability,
      show: (s) =>
        s.citability === null ? "not measured" : `${s.citability}/100`,
    },
    {
      label: "Quotable paragraphs",
      value: (s) => s.quotable,
      show: (s) => `${s.quotable} of ${s.paragraphs}`,
    },
    {
      label: "Search crawlers let in",
      value: (s) => s.searchReach,
      show: (s) => `${s.searchReach}/${s.searchTotal}`,
    },
    {
      label: "Firewall refuses",
      value: (s) => s.firewallBlocks.length,
      show: (s) =>
        s.firewallBlocks.length ? s.firewallBlocks.join(", ") : "none",
      lowerIsBetter: true,
    },
    {
      label: "llms.txt",
      value: (s) => (s.llmsTxt ? 1 : 0),
      show: (s) => (s.llmsTxt ? "published" : "none"),
    },
    {
      label: "Structured data types",
      value: (s) => s.schemaTypes.length,
      show: (s) =>
        s.schemaTypes.length ? String(s.schemaTypes.length) : "none",
    },
    {
      label: "Pages rendered by JavaScript",
      value: (s) => s.appShellPages,
      show: (s) => `${s.appShellPages} of ${s.pages}`,
      lowerIsBetter: true,
    },
    ...(record.questions.length
      ? [
          {
            label: "Questions won",
            value: (s: SiteColumn) => s.wins,
            show: (s: SiteColumn) => `${s.wins}/${record.questions.length}`,
          },
        ]
      : []),
  ];

  const best = (row: (typeof rows)[number]) => {
    const values = measured
      .map((site) => row.value(site))
      .filter((value): value is number => value !== null);
    if (values.length < 2) return null;
    const top = row.lowerIsBetter ? Math.min(...values) : Math.max(...values);
    // A row everyone ties on has no leader to mark.
    return values.every((value) => value === top) ? null : top;
  };

  return (
    <div className="toolReport">
      <section className="block" id="compare-head">
        <div className="blockHead jReportHead">
          <div>
            <h2>{sites.map((site) => site.host).join(" vs ")}</h2>
            <p>
              Crawled and scored the same way
              {record.durationMs
                ? `, in ${Math.round(record.durationMs / 1000)}s`
                : ""}
              . The first site is yours.
            </p>
          </div>
          <div className="toolActions">
            <button type="button" className="btn ghost" onClick={onReset}>
              New comparison
            </button>
          </div>
        </div>
        <div className="grid">
          {live && (
            <div className="card span12 liveBanner" aria-live="polite">
              <span className="liveDot" aria-hidden="true" />
              {record.stage}
            </div>
          )}
          {record.takeaways.length > 0 && (
            <section className="card span12">
              <h3>What {record.you} should take from this</h3>
              <ul className="findList">
                {record.takeaways.map((line) => (
                  <li key={line}>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </section>

      <section className="block" id="compare-board">
        <div className="blockHead">
          <h2>Side by side</h2>
          <p>The leader of each row is marked. A tie marks no one.</p>
        </div>
        <div className="card span12 tableCard">
          <div className="tableScroll">
            <table className="pageTable compareTable">
              <thead>
                <tr>
                  <th>Measure</th>
                  {sites.map((site, index) => (
                    <th key={site.host}>
                      {site.host}
                      {index === 0 && <span className="chip">you</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const top = best(row);
                  return (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {sites.map((site) => (
                        <td
                          key={site.host}
                          data-label={site.host}
                          className={
                            !site.measured
                              ? "muted"
                              : top !== null && row.value(site) === top
                                ? "lead"
                                : ""
                          }
                        >
                          {!site.measured
                            ? record.pending.includes(site.host)
                              ? "crawling…"
                              : "not measured"
                            : row.show(site)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        {sites
          .filter(
            (site) => !site.measured && !record.pending.includes(site.host),
          )
          .map((site) => (
            <p className="muted small" key={site.host}>
              <b>{site.host}</b> was not measured: {site.error}
            </p>
          ))}
      </section>

      <section className="block" id="compare-questions">
        <div className="blockHead">
          <h2>Whose page answers it</h2>
          <p>
            Each question retrieved over every site's pages at once. The share
            is how many of the question's words that site's best page carries.
          </p>
        </div>
        {record.questions.length ? (
          <div className="card span12 tableCard">
            <div className="tableScroll">
              <table className="pageTable compareTable">
                <thead>
                  <tr>
                    <th>Question</th>
                    {measured.map((site) => (
                      <th key={site.host}>{site.host}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {record.questions.map((row) => (
                    <tr key={row.question}>
                      <th scope="row">{row.question}</th>
                      {measured.map((site) => {
                        const hit = row.results.find(
                          (item) => item.host === site.host,
                        );
                        return (
                          <td
                            key={site.host}
                            data-label={site.host}
                            className={
                              row.winner === site.host
                                ? "lead"
                                : hit?.status === "missing"
                                  ? "muted"
                                  : ""
                            }
                          >
                            {hit && hit.url ? (
                              <>
                                {Math.round(hit.coverage * 100)}%{" "}
                                <Ext href={hit.url}>{pathOf(hit.url)}</Ext>
                              </>
                            ) : (
                              "no page"
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="card empty">
            <b>
              {live ? "Waiting for the crawls" : "No questions were compared"}
            </b>
            <p>
              {live
                ? "Questions are retrieved once every site is crawled."
                : record.questionNote}
            </p>
          </div>
        )}
        {record.questions.length > 0 && record.questionNote && (
          <p className="muted small">{record.questionNote}</p>
        )}
      </section>

      {!live && measured[0]?.host === record.you && (
        <section className="block">
          <div className="toolActions">
            <Internal
              href={`/?site=${encodeURIComponent(record.you)}`}
              navigate={navigate}
              className="btn primary"
            >
              Audit {record.you} in full
            </Internal>
            <Internal
              href={`/track?host=${encodeURIComponent(record.you)}`}
              navigate={navigate}
            >
              Track {record.you}
            </Internal>
          </div>
        </section>
      )}
    </div>
  );
}

/* ============================================================ track */

export function TrackTool({ navigate }: { navigate: Navigate }) {
  const [host, setHost] = useState(param("host"));
  const [data, setData] = useState<{
    host: string;
    durable?: boolean;
    entries: HistoryEntry[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(target = host) {
    const clean = target
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./i, "")
      .toLowerCase();
    if (!clean) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `${API}/api/history/${encodeURIComponent(clean)}`,
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body.error || "The history could not be read.");
      setData(body);
      navigate(`/track?host=${encodeURIComponent(clean)}`, true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (param("host")) void load(param("host"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (data)
    return (
      <TrackView
        data={data}
        navigate={navigate}
        onReset={() => {
          setData(null);
          navigate("/track", true);
        }}
      />
    );

  return (
    <ToolLanding
      kicker={["Track", "Over time"]}
      title={["Is it", "getting better?"]}
      lede="Every finished audit of a site is kept as one row: readiness, visibility, citability, answerable sub-queries and the checks that failed. Open a site to see what moved between runs, and which fixes landed."
      error={error}
      errorTitle="History unavailable"
      stat={
        <>
          <span className="statNum">60</span>
          <span className="statLabel">runs kept per site</span>
          <p>
            A run that could not measure something shows it as not measured, so
            a missing number never reads as a drop.
          </p>
          <p className="statProof">
            <b>Re-run after every change.</b> The comparison between two runs is
            the only proof a fix did anything.
          </p>
        </>
      }
    >
      <form
        className="analyze"
        aria-busy={busy}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void load();
        }}
      >
        <Field
          id="track-host"
          label="Site"
          value={host}
          onChange={setHost}
          placeholder="example.com"
          required
          url
        />
        <RunButton busy={busy} idle="Open its history" working="Reading" />
        <p className="analyzeNote">
          History starts with the first audit run after this feature shipped.
        </p>
      </form>
    </ToolLanding>
  );
}

function TrackView({
  data,
  navigate,
  onReset,
}: {
  data: { host: string; durable?: boolean; entries: HistoryEntry[] };
  navigate: Navigate;
  onReset: () => void;
}) {
  const entries = data.entries;
  const latest = entries[0];
  const previous = entries[1];
  const first = entries.at(-1);
  const recent = useMemo(
    () => (latest && previous ? diffEntries(previous, latest) : null),
    [latest, previous],
  );
  const overall = useMemo(
    () =>
      latest && first && first !== latest ? diffEntries(first, latest) : null,
    [latest, first],
  );

  return (
    <div className="toolReport">
      <section className="block" id="track-head">
        <div className="blockHead jReportHead">
          <div>
            <h2>{data.host}</h2>
            <p>
              {entries.length
                ? `${entries.length} ${entries.length === 1 ? "audit" : "audits"}, newest first.`
                : "No audits recorded yet."}
            </p>
          </div>
          <div className="toolActions">
            <Internal
              href={`/?site=${encodeURIComponent(data.host)}`}
              navigate={navigate}
              className="btn primary"
            >
              Run a new audit
            </Internal>
            <button type="button" className="btn ghost" onClick={onReset}>
              Another site
            </button>
          </div>
        </div>

        {data.durable === false && (
          <div className="card notes durability" role="note">
            <b>This history is not durable yet.</b> This deployment has no
            lasting store connected, so runs are kept on one server instance and
            can disappear when it restarts. Connect a Vercel Blob store to keep
            every run.
          </div>
        )}
        {!entries.length ? (
          <div className="card empty">
            <b>Nothing to track yet</b>
            <p>
              Every audit of {data.host} that finishes from now on is recorded
              here. Run one, fix something, run another, and this page shows
              what moved.
            </p>
          </div>
        ) : (
          <div className="grid">
            <ChangeCard
              title="Since the last run"
              diff={recent}
              empty="Only one run so far. The next audit shows what moved."
            />
            <ChangeCard
              title={`Since the first run${first ? ` · ${dateOf(first.completedAt)}` : ""}`}
              diff={overall}
              empty="Only one run so far."
            />
          </div>
        )}
      </section>

      {entries.length > 0 && (
        <section className="block" id="track-runs">
          <div className="blockHead">
            <h2>Every run</h2>
            <p>The arrow is the change from the run below it.</p>
          </div>
          <div className="card span12 tableCard">
            <div className="tableScroll">
              <table className="pageTable">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th className="num">Readiness</th>
                    <th className="num">Visibility</th>
                    <th className="num">Citability</th>
                    <th className="num">Answerable</th>
                    <th className="num">Lost to rivals</th>
                    <th className="num">Failing checks</th>
                    <th>Report</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => {
                    const before = entries[index + 1];
                    return (
                      <tr key={entry.id}>
                        <td data-label="Run" className="mono">
                          {dateOf(entry.completedAt)}
                        </td>
                        <Num
                          label="Readiness"
                          value={entry.readiness}
                          before={before?.readiness}
                        />
                        <Num
                          label="Visibility"
                          value={entry.visibility}
                          before={before?.visibility}
                        />
                        <Num
                          label="Citability"
                          value={entry.citability}
                          before={before?.citability}
                        />
                        <Num
                          label="Answerable"
                          value={entry.answerable}
                          before={before?.answerable}
                          unit="%"
                        />
                        <Num
                          label="Lost to rivals"
                          value={entry.lost}
                          before={before?.lost}
                          lowerIsBetter
                        />
                        <Num
                          label="Failing checks"
                          value={entry.failing.length}
                          before={before?.failing.length}
                          lowerIsBetter
                        />
                        <td data-label="Report">
                          <Internal
                            href={`/audits/${entry.id}`}
                            navigate={navigate}
                            className="textLink"
                          >
                            Open
                          </Internal>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ChangeCard({
  title,
  diff,
  empty,
}: {
  title: string;
  diff: ReturnType<typeof diffEntries> | null;
  empty: string;
}) {
  return (
    <section className="card span6">
      <h3>{title}</h3>
      {!diff ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          <dl className="factGrid">
            {diff.changes.map((change) => (
              <div
                key={change.metric}
                className={
                  change.delta !== null && change.delta < 0 ? "bad" : ""
                }
              >
                <dt>{change.metric}</dt>
                <dd className="mono">
                  {change.delta === null
                    ? change.to === null
                      ? "not measured"
                      : `${change.to} (was not measured)`
                    : `${change.from} → ${change.to}${change.delta ? ` (${change.delta > 0 ? "better" : "worse"} by ${Math.abs(change.delta)})` : ""}`}
                </dd>
              </div>
            ))}
          </dl>
          {diff.fixed.length > 0 && (
            <p className="small">
              <b>Fixed:</b> {diff.fixed.map((check) => check.label).join(", ")}
            </p>
          )}
          {diff.broke.length > 0 && (
            <p className="small bad">
              <b>Newly failing:</b>{" "}
              {diff.broke.map((check) => check.label).join(", ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Num({
  label,
  value,
  before,
  unit = "",
  lowerIsBetter,
}: {
  label: string;
  value: number | null;
  before?: number | null;
  unit?: string;
  lowerIsBetter?: boolean;
}) {
  const delta =
    value !== null && before !== null && before !== undefined
      ? value - before
      : null;
  const better =
    delta !== null && delta !== 0 && (lowerIsBetter ? delta < 0 : delta > 0);
  return (
    <td data-label={label} className="num">
      {value === null ? (
        <span className="muted">n/a</span>
      ) : (
        <>
          {value}
          {unit}
          {delta !== null && delta !== 0 && (
            <span className={`delta ${better ? "up" : "down"}`}>
              {delta > 0 ? "▲" : "▼"}
              {Math.abs(delta)}
            </span>
          )}
        </>
      )}
    </td>
  );
}

function dateOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
}
