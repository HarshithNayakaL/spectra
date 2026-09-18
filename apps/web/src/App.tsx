import {
  Component,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { auditSchema, type Audit } from "@spectra/schemas";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";

const API = import.meta.env.VITE_API_URL || "";

const SECTIONS = [
  { id: "primary-entity", label: "Primary entity" },
  { id: "understanding", label: "Model understanding" },
  { id: "survival", label: "Information survival" },
  { id: "entities", label: "Entity map" },
  { id: "retrievability", label: "Retrievability" },
  { id: "stability", label: "Interpretation stability" },
  { id: "measurements", label: "Measurements" },
  { id: "bugs", label: "Positioning bugs" },
  { id: "fixes", label: "Recommended fixes" },
  { id: "evidence", label: "Evidence" },
];

const PIPELINE = [
  "Source",
  "Crawler",
  "Extraction",
  "Semantic graph",
  "Model understanding",
  "Retrieval",
];

export function App() {
  const [audit, setAudit] = useState<Audit | null>(null),
    [url, setUrl] = useState(""),
    [progress, setProgress] = useState<{ stage: string; message: string }[]>(
      [],
    ),
    [error, setError] = useState(""),
    [loadingAudit, setLoadingAudit] = useState(
      Boolean(location.pathname.match(/^\/audits\/[a-f0-9-]{36}$/)),
    ),
    [running, setRunning] = useState(false),
    [path, setPath] = useState(location.pathname);
  const id = path.match(/^\/audits\/([a-f0-9-]{36})$/)?.[1];

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((next: string, replace = false) => {
    if (next === location.pathname) return;
    if (replace) history.replaceState({}, "", next);
    else history.pushState({}, "", next);
    setPath(next);
  }, []);

  const loadedId = audit?.id;
  useEffect(() => {
    if (!id) {
      setLoadingAudit(false);
      setAudit(null);
      setProgress([]);
      setError("");
      return;
    }
    // A live audit rewrites the URL as soon as it has an ID; fetching then
    // would replace the progress list with a half-finished record.
    if (running) {
      setLoadingAudit(false);
      return;
    }
    if (loadedId === id) {
      setLoadingAudit(false);
      return;
    }
    let cancelled = false;
    setLoadingAudit(true);
    setError("");
    fetch(`${API}/api/audits/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then((x) => {
        if (!cancelled) setAudit(auditSchema.parse(x));
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "This audit could not be loaded. Check the link, or start a new audit.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoadingAudit(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, loadedId, running]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (running) return;
    setError("");
    setAudit(null);
    setProgress([]);
    setRunning(true);
    let sawResult = false;
    try {
      const res = await fetch(`${API}/api/audits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const reason = await res
          .json()
          .then((body) => (body as { error?: string })?.error)
          .catch(() => undefined);
        throw new Error(reason || "The audit could not be started.");
      }
      if (!res.body) throw new Error("The audit could not be started.");
      const reader = res.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === "progress") {
            setProgress((p) => [...p, event]);
            if (event.auditId && !location.pathname.startsWith("/audits/"))
              navigate(`/audits/${event.auditId}`, true);
          }
          if (event.type === "result") {
            const next = auditSchema.parse(event.audit);
            sawResult = true;
            setAudit(next);
            navigate(`/audits/${next.id}`);
          }
          if (event.type === "error")
            throw new Error(event.message || "The audit failed.");
        }
        if (done) break;
      }
      if (!sawResult)
        throw new Error(
          "The connection closed before the report finished. Reload the audit link to check for a saved report.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "The audit failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <a className="skipLink" href="#main">
        Skip to content
      </a>
      <header className="top">
        <a href="/" className="brand" aria-label="SPECTRA home">
          <span className="brandRule" aria-hidden="true" />
          SPECTRA
        </a>
        <span className="topMeta">AI search perception, measured</span>
      </header>
      <main id="main">
        <ErrorBoundary>
          {loadingAudit ? (
            <Skeleton />
          ) : !audit ? (
            <Landing
              url={url}
              setUrl={setUrl}
              submit={submit}
              progress={progress}
              error={error}
              running={running}
            />
          ) : (
            <Report audit={audit} />
          )}
        </ErrorBoundary>
      </main>
    </>
  );
}

const LOSSES = [
  {
    name: "Source",
    detail: "The fact is written somewhere a machine can reach.",
  },
  {
    name: "Crawler",
    detail:
      "Robots rules, redirects and client-rendered markup decide what is fetched at all.",
  },
  {
    name: "Extraction",
    detail:
      "Navigation, scripts and boilerplate are stripped. Real content sometimes goes with them.",
  },
  {
    name: "Semantic graph",
    detail:
      "Entities, relationships and claims are built, each one cited back to a source record.",
  },
  {
    name: "Model understanding",
    detail:
      "The model is asked what it learned. A claim it cannot state did not survive.",
  },
  {
    name: "Retrieval",
    detail:
      "The same question goes to grounded search. Understanding and findability are separate results.",
  },
];

function Landing({
  url,
  setUrl,
  submit,
  progress,
  error,
  running,
}: {
  url: string;
  setUrl: (x: string) => void;
  submit: (e: FormEvent) => void;
  progress: { stage: string; message: string }[];
  error: string;
  running: boolean;
}) {
  return (
    <section className="landing">
      <div className="landingInner">
        <h1>Measure what AI search understands about your site.</h1>
        <p className="landingLede">
          SPECTRA crawls your pages, asks a model what it learned, and traces
          each answer back to the evidence that supported it.
        </p>

        <form onSubmit={submit} className="analyze" aria-busy={running}>
          <label htmlFor="target">Public website URL</label>
          <div className="field">
            <input
              id="target"
              type="url"
              inputMode="url"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              aria-describedby="target-note"
            />
            <button disabled={running}>
              {running ? "Running" : "Run audit"}
            </button>
          </div>
          <p className="analyzeNote" id="target-note">
            Public HTTP and HTTPS sites only. No account needed.
          </p>
        </form>

        {running && progress.length > 0 && (
          <div className="progress" aria-live="polite">
            <div className="progressHead">
              <b>{progress.at(-1)?.message}</b>
              <span className="progressCount">
                {progress.length} of 8 stages
              </span>
            </div>
            <ol className="progressSteps">
              {progress.slice(-5).map((item, index) => (
                <li key={`${item.stage}-${index}`}>
                  <span>
                    {String(progress.length - 4 + index).padStart(2, "0")}
                  </span>
                  {item.stage.replaceAll("_", " ")}
                </li>
              ))}
            </ol>
          </div>
        )}

        {error && (
          <div className="notice" role="alert">
            <b>Audit stopped</b>
            <p>{error}</p>
            <button
              type="button"
              className="noticeAction"
              onClick={() => document.getElementById("target")?.focus()}
            >
              Check the URL and try again
            </button>
          </div>
        )}

        <section className="stages">
          <div className="stagesHead">
            <h2>Where information disappears</h2>
            <p>
              A fact can sit in your HTML and still be missing from the answer.
              SPECTRA measures every handover between the page and the model,
              and keeps the evidence at each one.
            </p>
          </div>
          {LOSSES.map((stage, index) => (
            <div className="stageRow" key={stage.name}>
              <span className="stageIndex">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="stageName">{stage.name}</span>
              <p className="stageLoss">{stage.detail}</p>
            </div>
          ))}
        </section>

        <p className="landingFoot">
          Deterministic measurements, not a model-authored score. Checks that
          cannot be evaluated are reported as not applicable rather than
          guessed.
        </p>
      </div>
    </section>
  );
}

function Report({ audit }: { audit: Audit }) {
  const overall = audit.metrics.find((m) => m.dimension === "overall"),
    entity = audit.analysis?.primaryEntity,
    host = safeHost(audit.target),
    incomplete = audit.status !== "complete",
    active = useActiveSection(SECTIONS.map((s) => s.id));

  return (
    <div className="report">
      <aside className="rail">
        <div className="railLabel">AUDIT {audit.id.slice(0, 8)}</div>
        <a className="railNew" href="/">
          New audit
        </a>
        <nav className="railNav" aria-label="Report sections">
          <a
            href="#overview"
            aria-current={active === "overview" || !active ? "true" : undefined}
          >
            Overview
          </a>
          {SECTIONS.map((section) => (
            <a
              href={`#${section.id}`}
              key={section.id}
              aria-current={active === section.id ? "true" : undefined}
            >
              {section.label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="sheet">
        <div className="bar">
          <a href={audit.target} target="_blank" rel="noreferrer">
            {host}
            <ExternalMark />
          </a>
          <span className="barMeta">
            {audit.crawl?.pages.length ?? 0} pages, {audit.evidence.length}{" "}
            evidence records
          </span>
        </div>

        <section className="masthead" id="overview">
          <div className="mastheadMain">
            <div className="statusLine">
              <span className={incomplete ? "failing" : undefined}>
                {audit.status.replaceAll("_", " ")}
              </span>
            </div>
            <h1>{entity?.name || "Unresolved entity"}</h1>
            <p className="mastheadSummary">
              {entity?.description ||
                "Identity resolution did not complete. Crawl evidence is still recorded below."}
            </p>
            <dl className="spec">
              <SpecRow
                k="Archetype"
                v={audit.analysis?.siteArchetype?.replaceAll("_", " ")}
              />
              <SpecRow k="Entity type" v={entity?.type} />
              <SpecRow
                k="Confidence"
                v={
                  audit.analysis
                    ? `${Math.round(audit.analysis.confidence.overall * 100)}%`
                    : undefined
                }
                tabular
              />
              <SpecRow
                k="Pages"
                v={String(audit.crawl?.pages.length ?? 0)}
                tabular
              />
              <SpecRow k="Evidence" v={String(audit.evidence.length)} tabular />
              <SpecRow
                k="Model runs"
                v={String(audit.modelRuns.length)}
                tabular
              />
              <SpecRow
                k="Claims"
                v={String(audit.graph?.claims.length ?? 0)}
                tabular
              />
            </dl>
          </div>
          <div className="score">
            <div className="scoreLabel">Perception score</div>
            <div
              className={`scoreValue${verdictOf(overall?.score) === "Weak" ? " failing" : ""}`}
            >
              {overall?.score ?? "N/A"}
            </div>
            <div className="scoreVerdict">{verdictOf(overall?.score)}</div>
            <div className="scoreFraction">
              {overall?.earned.toFixed(1) ?? "0.0"} of{" "}
              {overall?.denominator.toFixed(1) ?? "0.0"} weighted points
            </div>
            {incomplete && (
              <p className="scoreCaveat">
                Part of the analysis did not finish. The score covers only the
                checks that could be measured.
              </p>
            )}
          </div>
        </section>

        {audit.warnings.length > 0 && (
          <section className="noticeBand">
            <div className="notice">
              <b>Partial analysis</b>
              {audit.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          </section>
        )}

        <section className="section" id="primary-entity">
          <h2>Primary entity</h2>
          <div className="spread">
            <div>
              <h3>Site purpose</h3>
              {audit.analysis?.purpose.length ? (
                <ul className="listBlock">
                  {audit.analysis.purpose.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Not established.</p>
              )}
            </div>
            <div>
              <h3>Ambiguities</h3>
              {audit.analysis?.ambiguities.length ? (
                <ul className="listBlock">
                  {audit.analysis.ambiguities.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None reported.</p>
              )}
            </div>
          </div>
        </section>

        <section className="section" id="understanding">
          <h2>Model understanding</h2>
          {audit.analysis ? (
            <div className="spread">
              <div>
                <h3>Intended audience</h3>
                <ul className="listBlock">
                  {audit.analysis.intendedAudience.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Expected intents</h3>
                <ul className="listBlock">
                  {audit.analysis.expectedUserIntents.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Evidence-backed claims</h3>
                {audit.graph?.claims.length ? (
                  <ul className="listBlock">
                    {audit.graph.claims.map((claim) => (
                      <li className="claimLine" key={claim.id}>
                        <b>{claim.subject}</b> {claim.predicate} {claim.object}{" "}
                        <span>{claim.evidenceIds.length} sources</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No claims were extracted.</p>
                )}
              </div>
            </div>
          ) : (
            <p className="muted">
              Classification and semantic extraction did not complete. No
              substitute interpretation has been generated.
            </p>
          )}
        </section>

        <section className="section" id="survival">
          <h2>Information survival</h2>
          <p className="sectionNote">
            Each claim is traced through the pipeline. The first stage that
            fails is where the fact stopped being available.
          </p>
          <div className="chain">
            {PIPELINE.map((stage, i) => {
              const state = statusAt(audit, i);
              return (
                <div
                  className={`chainStage ${state.replace(" ", "-")}`}
                  key={stage}
                >
                  <span className="stageIndex">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <b>{stage}</b>
                  <span className="stageState">{state}</span>
                </div>
              );
            })}
          </div>
          {audit.survival.length ? (
            <div className="tableScroll">
              <table className="sheetTable" style={{ marginTop: 26 }}>
                <thead>
                  <tr>
                    <th>Claim</th>
                    <th className="num">Survived</th>
                    <th>Failed at</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.survival.map((item) => (
                    <tr key={item.claimId}>
                      <td className="name">{item.claimId}</td>
                      <td className="num">
                        {Math.round(item.survivalRate * 100)}%
                      </td>
                      <td className={item.failedAt ? "state failed" : "na"}>
                        {item.failedAt?.replaceAll("_", " ") || "none measured"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No claims to trace"
              body="Tracing needs evidence-backed claims from the semantic graph."
              href="#evidence"
              action="Inspect evidence"
            />
          )}
        </section>

        <section className="section" id="entities">
          <h2>Entity map</h2>
          {audit.graph?.entities.length ? (
            <div className="tableScroll">
              <table className="sheetTable">
                <thead>
                  <tr>
                    <th>Entity</th>
                    <th>Type</th>
                    <th className="num">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.graph.entities.map((e) => (
                    <tr key={e.id}>
                      <td className="name">{e.name}</td>
                      <td>{e.type}</td>
                      <td className="num">{e.evidenceIds.length}</td>
                    </tr>
                  ))}
                  {audit.graph.relationships.map((r) => (
                    <tr key={r.id}>
                      <td className="name">{r.subjectId}</td>
                      <td>
                        {r.predicate.replaceAll("_", " ")} {r.objectId}
                      </td>
                      <td className="num">{r.evidenceIds.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No entity graph"
              body="Semantic mapping did not complete. Source evidence is still available for inspection."
              href="#evidence"
              action="Inspect evidence"
            />
          )}
        </section>

        <section className="section" id="retrievability">
          <h2>Retrievability</h2>
          {audit.retrievals.length ? (
            <div className="entries">
              {audit.retrievals.map((r) => (
                <div className="entry" key={r.id}>
                  <div className="entryAside">
                    <div className={`state ${r.status}`}>{r.status}</div>
                    <div className="entryIndex">
                      {r.mode.replaceAll("_", " ")}
                    </div>
                  </div>
                  <div>
                    <h3>{r.query}</h3>
                    <p>{r.answer || r.error || "Not run"}</p>
                    {r.reason && <p className="rowReason">{r.reason}</p>}
                    {r.groundingSources.length > 0 && (
                      <dl className="entryFacts">
                        <dt>Grounding sources</dt>
                        <dd>
                          {r.groundingSources.map((s) => (
                            <a
                              key={s.uri}
                              href={s.uri}
                              target="_blank"
                              rel="noreferrer"
                              style={{ marginRight: 12 }}
                            >
                              {s.title || safeHost(s.uri)}
                            </a>
                          ))}
                        </dd>
                      </dl>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No retrieval results"
              body="Retrieval runs once the model has produced evidence-backed claims."
              href="#understanding"
              action="Review model understanding"
            />
          )}
        </section>

        <section className="section" id="stability">
          <h2>Interpretation stability</h2>
          <p className="sectionNote">
            The same claim is asked several ways. A claim that only survives one
            phrasing is not reliably understood.
          </p>
          {audit.stability.length ? (
            <div className="tableScroll">
              <table className="sheetTable">
                <thead>
                  <tr>
                    <th>Mode</th>
                    <th className="num">Stable</th>
                    <th className="num">Passed</th>
                    <th className="num">Failed</th>
                    <th className="num">Unavailable</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.stability.map((item) => (
                    <tr key={`${item.claimId}-${item.mode}`}>
                      <td className="name">{item.mode.replaceAll("_", " ")}</td>
                      <td className="num">
                        {item.stabilityRatio === null
                          ? "N/A"
                          : `${Math.round(item.stabilityRatio * 100)}%`}
                      </td>
                      <td className="num">{item.successfulVariants}</td>
                      <td className="num">{item.failedVariants}</td>
                      <td className="num">{item.unavailableVariants}</td>
                      <td className="rowReason">{item.uncertainty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="Stability not measured"
              body="Question variants need a completed semantic graph and a retrieval run."
              href="#understanding"
              action="Review model understanding"
            />
          )}
        </section>

        <section className="section" id="measurements">
          <h2>Measurements</h2>
          <div className="tableScroll">
            <table className="sheetTable">
              <thead>
                <tr>
                  <th>Dimension</th>
                  <th className="num">Score</th>
                  <th className="num">Earned</th>
                  <th className="num">Weight</th>
                  <th>Basis</th>
                </tr>
              </thead>
              <tbody>
                {audit.metrics
                  .filter((m) => m.dimension !== "overall")
                  .map((m) => (
                    <tr key={m.dimension}>
                      <td className="name">
                        {m.dimension.replaceAll("_", " ")}
                      </td>
                      <td className={m.score === null ? "num na" : "num"}>
                        {m.score === null ? "N/A" : m.score}
                      </td>
                      <td className="num">{m.earned.toFixed(1)}</td>
                      <td className="num">{m.denominator.toFixed(1)}</td>
                      <td>
                        <span className="rowReason">
                          {m.applied.length} applied, {m.notApplicable.length}{" "}
                          not applicable
                        </span>
                        <details className="why">
                          <summary>How this was calculated</summary>
                          <p>{m.calculation}</p>
                          {m.notApplicable.map((c) => (
                            <p key={c.id}>
                              {c.label}: {c.limitation}
                            </p>
                          ))}
                        </details>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section" id="bugs">
          <h2>Positioning bugs</h2>
          {audit.issues.length ? (
            <div className="entries">
              {audit.issues.map((x) => (
                <article className="entry" key={x.id}>
                  <div className="entryAside">
                    <div className={`severity ${x.severity}`}>{x.severity}</div>
                  </div>
                  <div>
                    <h3>{x.title}</h3>
                    <p>{x.description}</p>
                    <dl className="entryFacts">
                      <dt>Likely cause</dt>
                      <dd>{x.likelyCause}</dd>
                      <dt>Evidence</dt>
                      <dd className="ids">
                        {x.evidenceIds.join(", ") || "No supporting record"}
                      </dd>
                    </dl>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">
              No positioning bugs were produced from the available evidence.
            </p>
          )}
        </section>

        <section className="section" id="fixes">
          <h2>Recommended fixes</h2>
          {audit.recommendations.length ? (
            <div className="entries">
              {audit.recommendations.map((x, i) => (
                <div className="entry" key={x.id}>
                  <div className="entryAside">
                    <div className="entryIndex">
                      {String(i + 1).padStart(2, "0")}
                    </div>
                  </div>
                  <div>
                    <h3>{x.change}</h3>
                    <dl className="entryFacts">
                      <dt>What failed</dt>
                      <dd>{x.whatFailed}</dd>
                      <dt>Why this helps</dt>
                      <dd>{x.rationale}</dd>
                    </dl>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No repairs generated"
              body="There are no evidence-backed repairs in this audit."
              href="#measurements"
              action="Review measurements"
            />
          )}
        </section>

        <section className="section" id="evidence">
          <h2>Evidence</h2>
          <p className="sectionNote">
            Every record the audit collected, with the selector and page it came
            from. Claims above cite these identifiers.
          </p>
          <EvidenceExplorer evidence={audit.evidence} />
        </section>
      </article>
    </div>
  );
}

function EvidenceExplorer({ evidence }: { evidence: Audit["evidence"] }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const types = [...new Set(evidence.map((item) => item.evidenceType))];
  const normalized = query.trim().toLowerCase();
  const filtered = evidence.filter(
    (item) =>
      (type === "all" || item.evidenceType === type) &&
      (!normalized ||
        `${item.text} ${item.url} ${item.evidenceType}`
          .toLowerCase()
          .includes(normalized)),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pageCount - 1);
  const records = filtered.slice(currentPage * 12, currentPage * 12 + 12);
  const selected = records.find((item) => item.id === selectedId) ?? records[0];
  const selectedText = selected
    ? selected.text.trim() ||
      (selected.value === undefined
        ? "No extractable text in this record."
        : typeof selected.value === "string"
          ? selected.value
          : JSON.stringify(selected.value, null, 2))
    : "";

  return (
    <div className="evidence">
      <div className="evidenceTools">
        <div>
          <label htmlFor="evidence-search">Search</label>
          <input
            id="evidence-search"
            type="search"
            placeholder="Text, page or signal"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div>
          <label htmlFor="evidence-type">Record type</label>
          <select
            id="evidence-type"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All types</option>
            {types.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="evidenceCount" role="status">
        {filtered.length} of {evidence.length} records
      </div>
      {selected ? (
        <div className="evidenceSplit">
          <div className="evidenceList" aria-label="Evidence records">
            {records.map((item) => (
              <button
                key={item.id}
                type="button"
                className="evidenceItem"
                aria-pressed={item.id === selected.id}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="evidenceMeta">
                  {item.evidenceType.replaceAll("_", " ")}
                </span>
                <b>{item.text || item.url}</b>
                <span className="evidenceMeta">{safeHost(item.url)}</span>
              </button>
            ))}
          </div>
          <article className="evidenceDetail" aria-live="polite">
            <div className="evidenceDetailHead">
              <span>{selected.id}</span>
              <span>{Math.round(selected.confidence * 100)}% confidence</span>
            </div>
            <p className="evidenceExtract">{selectedText}</p>
            {selected.selector && (
              <div className="evidenceSelector">
                Selector {selected.selector}
              </div>
            )}
            <a href={selected.url} target="_blank" rel="noreferrer">
              Open source page
              <ExternalMark />
            </a>
          </article>
        </div>
      ) : (
        <Empty
          title="No matching evidence"
          body="Try a broader term, or choose all record types."
        />
      )}
      {pageCount > 1 && (
        <div className="pager">
          <span className="pagerText">
            Page {currentPage + 1} of {pageCount}
          </span>
          <div>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={currentPage === pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
      <details
        className="rawJson"
        onToggle={(event) => setRawOpen(event.currentTarget.open)}
      >
        <summary>Raw JSON</summary>
        {rawOpen && <pre>{JSON.stringify(evidence, null, 2)}</pre>}
      </details>
    </div>
  );
}

function SpecRow({
  k,
  v,
  tabular,
}: {
  k: string;
  v?: string;
  tabular?: boolean;
}) {
  return (
    <div className="specRow">
      <dt className="specKey">{k}</dt>
      <dd className={tabular ? "specValue tabular" : "specValue"}>
        {v || "Not established"}
      </dd>
    </div>
  );
}

function Empty({
  title,
  body,
  href,
  action,
}: {
  title: string;
  body: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="empty">
      <b>{title}</b>
      <p>{body}</p>
      {href && action && <a href={href}>{action}</a>}
    </div>
  );
}

function ExternalMark() {
  return (
    <HugeiconsIcon
      icon={ArrowUpRight01Icon}
      size={14}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <div className="skeletonRail" />
      <div className="skeletonMain">
        <span>Loading audit</span>
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("SPECTRA render failure", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="landing">
        <div className="landingInner">
          <div className="notice" role="alert">
            <b>This report could not be displayed</b>
            <p>{this.state.error.message}</p>
            <button
              type="button"
              className="noticeAction"
              onClick={() => location.reload()}
            >
              Reload the page
            </button>
          </div>
        </div>
      </section>
    );
  }
}

function useActiveSection(ids: string[]) {
  const key = ids.join("|");
  const list = useMemo(() => ["overview", ...key.split("|")], [key]);
  const [active, setActive] = useState(list[0]);
  useEffect(() => {
    function update() {
      const line = window.innerHeight * 0.3;
      let current = list[0];
      for (const id of list) {
        const node = document.getElementById(id);
        if (node && node.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [list]);
  return active;
}

function verdictOf(score: number | null | undefined) {
  return score == null
    ? "Not measured"
    : score >= 80
      ? "Strong"
      : score >= 60
        ? "Mixed"
        : "Weak";
}

function safeHost(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function statusAt(a: Audit, i: number) {
  const states = a.survival.map((s) => s.stages[i]?.status).filter(Boolean);
  return !states.length
    ? "not tested"
    : states.every((x) => x === "survived")
      ? "survived"
      : states.some((x) => x === "failed")
        ? "failed"
        : "partial";
}
