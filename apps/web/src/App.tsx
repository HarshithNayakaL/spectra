import { FormEvent, useEffect, useState } from "react";
import { auditSchema, type Audit } from "@spectra/schemas";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight02Icon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import { ThinkingOrb } from "thinking-orbs";
const API = import.meta.env.VITE_API_URL || "";
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
    [running, setRunning] = useState(false);
  const id = location.pathname.match(/^\/audits\/([a-f0-9-]{36})$/)?.[1];
  useEffect(() => {
    if (id)
      fetch(`${API}/api/audits/${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((x) => setAudit(auditSchema.parse(x)))
        .catch(() =>
          setError(
            "This audit could not be loaded. Check the link or start a new audit.",
          ),
        )
        .finally(() => setLoadingAudit(false));
  }, [id]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setAudit(null);
    setProgress([]);
    setRunning(true);
    try {
      const res = await fetch(`${API}/api/audits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok || !res.body)
        throw new Error("The audit could not be started.");
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
              history.replaceState({}, "", `/audits/${event.auditId}`);
          }
          if (event.type === "result") {
            const next = auditSchema.parse(event.audit);
            setAudit(next);
            history.pushState({}, "", `/audits/${next.id}`);
            setRunning(false);
          }
          if (event.type === "error") throw new Error(event.message);
        }
        if (done) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
      setRunning(false);
    }
  }
  return (
    <>
      <a className="skipLink" href="#main-content">
        Skip to content
      </a>
      <header className="top">
        <a href="/" className="brand" aria-label="SPECTRA home">
          <span className="mark" />
          SPECTRA
        </a>
        <span className="version">ENGINE v0.1</span>
      </header>
      <main id="main-content">
        {loadingAudit ? (
          <ReportSkeleton />
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
      </main>
    </>
  );
}
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
      <div className="cloudField" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="landingGrid">
        <div className="landingCopy t-stagger is-shown">
          <div className="eyebrow">AI SEO AUDIT</div>
          <h1 className="t-stagger-line t-stagger-line--1">
            See how AI
            <br />
            <em>understands your site.</em>
          </h1>
          <p className="lede t-stagger-line t-stagger-line--2">
            Find what AI can understand, retrieve, and trust about your brand.
            Get clear fixes backed by evidence from your website.
          </p>
        </div>
        <div
          className="landingIndex traceReveal"
          aria-label="SPECTRA audit stages"
        >
          <div className="indexHead">
            <span>LIVE TRACE</span>
            <b>READY</b>
          </div>
          {[
            "Crawl public evidence",
            "Map entities + claims",
            "Test direct + search",
            "Trace failure stages",
          ].map((stage, index) => (
            <div className="indexRow" key={stage}>
              <small>{String(index + 1).padStart(2, "0")}</small>
              <span>{stage}</span>
              <i
                style={
                  { "--level": `${92 - index * 13}%` } as React.CSSProperties
                }
              />
            </div>
          ))}
        </div>
      </div>
      <form onSubmit={submit} className="analyze" aria-busy={running}>
        <label htmlFor="target">Public website URL</label>
        <div className="inputRow">
          <input
            id="target"
            type="url"
            inputMode="url"
            placeholder="example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            aria-describedby="url-note"
          />
          <button disabled={running}>
            {running ? "Analyzing…" : "Run perception audit"} <ArrowIcon />
          </button>
        </div>
        <small id="url-note">
          Only public HTTP and HTTPS targets are accepted.
        </small>
      </form>
      {progress.length > 0 && running && (
        <div className="progress" aria-live="polite" aria-atomic="true">
          <div className="progressHead">
            <ThinkingOrb
              state={
                progress.length < 2
                  ? "searching"
                  : progress.length < 4
                    ? "connecting"
                    : "solving"
              }
              size={64}
              theme="dark"
              aria-label="AI analysis in progress"
            />
            <div>
              <b>{progress.at(-1)?.message}</b>
              <span>{progress.length} pipeline stages recorded</span>
            </div>
          </div>
          <ol className="progressSteps">
            {progress.slice(-6).map((item, index) => (
              <li key={`${item.stage}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {item.stage.replaceAll("_", " ")}
              </li>
            ))}
          </ol>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          <b>Audit stopped</b>
          <p>{error}</p>
          <button
            type="button"
            className="textButton"
            onClick={() => document.getElementById("target")?.focus()}
          >
            Check the URL and try again
          </button>
        </div>
      )}
      <div className="principles">
        <div>
          <b>01</b>
          <span>See what AI sees</span>
          <p>Check how clearly your website explains your brand.</p>
        </div>
        <div>
          <b>02</b>
          <span>Find SEO gaps</span>
          <p>Spot information AI search cannot find or trust.</p>
        </div>
        <div>
          <b>03</b>
          <span>Know what to fix</span>
          <p>Get prioritized changes with evidence behind each one.</p>
        </div>
      </div>
    </section>
  );
}
function Report({ audit }: { audit: Audit }) {
  const overall = audit.metrics.find((m) => m.dimension === "overall"),
    entity = audit.analysis?.primaryEntity;
  return (
    <div className="report">
      <aside>
        <div className="auditLabel">AUDIT / {audit.id.slice(0, 8)}</div>
        <a className="newAudit" href="/">
          + New audit
        </a>
        <nav aria-label="Report sections">
          {[
            "Overview",
            "Primary entity",
            "AI understanding",
            "Information survival",
            "Entity map",
            "Retrievability",
            "Interpretation stability",
            "Structured evidence",
            "Positioning bugs",
            "Fixes",
            "Raw evidence",
          ].map((x) => (
            <a href={`#${slug(x)}`} key={x}>
              {x}
            </a>
          ))}
        </nav>
      </aside>
      <article>
        <div className="reportBar">
          <a href={audit.target} target="_blank" rel="noreferrer">
            {new URL(audit.target).hostname} <ExternalIcon />
          </a>
          <span>
            {audit.crawl?.pages.length ?? 0} pages · {audit.evidence.length}{" "}
            evidence records
          </span>
        </div>
        <section id="overview" className="hero">
          <div>
            <div className="eyebrow">
              {audit.status.replace("_", " ").toUpperCase()} ·{" "}
              {new URL(audit.target).hostname}
            </div>
            <h1>{entity?.name || "Unresolved entity"}</h1>
            <p>
              {audit.analysis?.primaryEntity.description ||
                "AI identity resolution did not complete. Crawl evidence remains available below."}
            </p>
            <div className="tags">
              {audit.analysis?.siteArchetype && (
                <span>{audit.analysis.siteArchetype.replaceAll("_", " ")}</span>
              )}
              {audit.analysis?.purpose.slice(0, 2).map((x) => (
                <span key={x}>{x}</span>
              ))}
            </div>
            <div className="heroStats" aria-label="Audit summary">
              <Stat value={audit.crawl?.pages.length ?? 0} label="Pages" />
              <Stat value={audit.evidence.length} label="Evidence" />
              <Stat value={audit.modelRuns.length} label="AI runs" />
              <Stat value={audit.graph?.claims.length ?? 0} label="Claims" />
            </div>
          </div>
          <Score metric={overall} />
        </section>
        {audit.warnings.length > 0 && (
          <section className="notice">
            <b>Partial analysis</b>
            {audit.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </section>
        )}
        <Section
          id="primary-entity"
          label="01 / IDENTIFICATION"
          title="Primary entity"
        >
          <div className="split">
            <div>
              <Term k="Name" v={entity?.name} />
              <Term k="Type" v={entity?.type} />
              <Term
                k="Confidence"
                v={`${Math.round((audit.analysis?.confidence.overall || 0) * 100)}%`}
              />
            </div>
            <div>
              <h3>Site purpose</h3>
              {audit.analysis?.purpose.map((x) => (
                <p key={x}>{x}</p>
              ))}
              <h3>Ambiguities</h3>
              {audit.analysis?.ambiguities.length ? (
                audit.analysis.ambiguities.map((x) => <p key={x}>{x}</p>)
              ) : (
                <p className="quiet">No material ambiguities reported.</p>
              )}
            </div>
          </div>
        </Section>
        <Section
          id="ai-understanding"
          label="02 / AI UNDERSTANDING"
          title="What Gemini understood"
        >
          {audit.analysis ? (
            <div className="split">
              <div>
                <h3>Intended audience</h3>
                {audit.analysis.intendedAudience.map((value) => (
                  <p key={value}>{value}</p>
                ))}
                <h3>Expected intents</h3>
                {audit.analysis.expectedUserIntents.map((value) => (
                  <p key={value}>{value}</p>
                ))}
              </div>
              <div>
                <h3>Evidence-backed claims</h3>
                {audit.graph?.claims.map((claim) => (
                  <p key={claim.id}>
                    <b>{claim.subject}</b> — {claim.predicate} → {claim.object}{" "}
                    <small>({claim.evidenceIds.length} sources)</small>
                  </p>
                ))}
              </div>
            </div>
          ) : (
            <p className="quiet">
              Gemini classification and semantic extraction did not complete. No
              substitute interpretation has been generated.
            </p>
          )}
        </Section>
        <Section
          id="information-survival"
          label="03 / PIPELINE"
          title="Information survival"
        >
          <div className="pipeline">
            {[
              "Source",
              "Crawler",
              "Extraction",
              "Semantic graph",
              "Model understanding",
              "Retrieval",
            ].map((x, i) => (
              <div
                key={x}
                className={
                  audit.survival.some((s) => s.stages[i]?.status === "failed")
                    ? "failed"
                    : ""
                }
              >
                <span>{String(i + 1).padStart(2, "0")}</span>
                <b>{x}</b>
                <small>{statusAt(audit, i)}</small>
              </div>
            ))}
          </div>
          {audit.survival.length === 0 && (
            <p className="quiet">
              No evidence-backed claims were available to trace through every
              stage.
            </p>
          )}
          {audit.survival.map((item) => (
            <div className="survivalRow" key={item.claimId}>
              <b>{item.claimId}</b>
              <span>{Math.round(item.survivalRate * 100)}% survived</span>
              <small>failure stage: {item.failedAt || "none measured"}</small>
            </div>
          ))}
        </Section>
        <Section id="entity-map" label="04 / SEMANTICS" title="Entity map">
          <div className="entityMap">
            {audit.graph?.entities.map((e) => (
              <div className="entity" key={e.id}>
                <small>{e.type}</small>
                <b>{e.name}</b>
                <span>{e.evidenceIds.length} evidence links</span>
              </div>
            ))}
            {audit.graph?.relationships.map((r) => (
              <div className="relationship" key={r.id}>
                {r.subjectId} <b>— {r.predicate} →</b> {r.objectId}
              </div>
            ))}
            {!audit.graph?.entities.length && (
              <EmptyState
                title="No entity graph yet"
                body="The model did not complete semantic mapping. Source evidence is still available for inspection."
                href="#raw-evidence"
                action="Inspect evidence"
              />
            )}
          </div>
        </Section>
        <Section
          id="retrievability"
          label="05 / QUERY TESTS"
          title="Retrievability"
        >
          <div className="records">
            {audit.retrievals.length ? (
              audit.retrievals.map((r) => (
                <div className="record" key={r.id}>
                  <span className={`state ${r.status}`}>{r.status}</span>
                  <div>
                    <b>{r.query}</b>
                    <p>{r.answer || r.error || "Not run"}</p>
                    {r.reason && <small>{r.reason}</small>}
                    {r.groundingSources.length > 0 && (
                      <div className="sources">
                        {r.groundingSources.map((source) => (
                          <a
                            key={source.uri}
                            href={source.uri}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {source.title || new URL(source.uri).hostname}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                  <small>{r.mode.replace("_", " ")}</small>
                </div>
              ))
            ) : (
              <EmptyState
                title="No retrieval results yet"
                body="Retrieval starts after the model produces evidence-backed claims."
                href="#raw-evidence"
                action="Inspect source evidence"
              />
            )}
          </div>
        </Section>
        <Section
          id="interpretation-stability"
          label="06 / CONSISTENCY"
          title="Interpretation stability"
        >
          <div className="metrics">
            {audit.stability.map((item) => (
              <div key={`${item.claimId}-${item.mode}`}>
                <span>{item.mode.replaceAll("_", " ")}</span>
                <b>
                  {item.stabilityRatio === null
                    ? "N/A"
                    : `${Math.round(item.stabilityRatio * 100)}%`}
                </b>
                <small>
                  {item.successfulVariants} passed · {item.failedVariants}{" "}
                  failed · {item.unavailableVariants} unavailable
                </small>
                <p>{item.uncertainty}</p>
              </div>
            ))}
          </div>
          {!audit.stability.length && (
            <EmptyState
              title="Stability not measured"
              body="Question variants require a completed semantic graph and retrieval run."
              href="#ai-understanding"
              action="Review AI status"
            />
          )}
        </Section>
        <Section
          id="structured-evidence"
          label="07 / SIGNALS"
          title="Measurements"
        >
          <div className="metrics">
            {audit.metrics
              .filter((m) => m.dimension !== "overall")
              .map((m) => (
                <div key={m.dimension}>
                  <span>{m.dimension.replaceAll("_", " ")}</span>
                  <b>{m.score === null ? "N/A" : m.score}</b>
                  <small>
                    {m.earned.toFixed(1)} / {m.denominator.toFixed(1)} weighted
                    points
                  </small>
                  <details>
                    <summary>Why</summary>
                    <p>{m.calculation}</p>
                    <p>
                      {m.applied.length} applied · {m.notApplicable.length} N/A
                    </p>
                  </details>
                </div>
              ))}
          </div>
        </Section>
        <Section
          id="positioning-bugs"
          label="08 / DIAGNOSIS"
          title="Positioning bugs"
        >
          <div className="issues">
            {audit.issues.length ? (
              audit.issues.map((x) => (
                <article key={x.id}>
                  <span className={`severity ${x.severity}`}>{x.severity}</span>
                  <h3>{x.title}</h3>
                  <p>{x.description}</p>
                  <dl>
                    <dt>Likely cause</dt>
                    <dd>{x.likelyCause}</dd>
                    <dt>Evidence</dt>
                    <dd>
                      {x.evidenceIds.join(", ") || "No supporting record"}
                    </dd>
                  </dl>
                </article>
              ))
            ) : (
              <p className="quiet">
                No positioning bugs were produced from the available evidence.
              </p>
            )}
          </div>
        </Section>
        <Section id="fixes" label="09 / REPAIR" title="Recommended fixes">
          {audit.recommendations.map((x, i) => (
            <div className="fix" key={x.id}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3>{x.change}</h3>
                <p>
                  <b>What failed:</b> {x.whatFailed}
                </p>
                <p>
                  <b>Why this helps:</b> {x.rationale}
                </p>
              </div>
            </div>
          ))}
          {!audit.recommendations.length && (
            <EmptyState
              title="No repairs generated"
              body="There are no evidence-backed repairs in this audit."
              href="#structured-evidence"
              action="Review measurements"
            />
          )}
        </Section>
        <Section id="raw-evidence" label="10 / TRACE" title="Raw evidence">
          <details>
            <summary>Inspect {audit.evidence.length} evidence records</summary>
            <pre>{JSON.stringify(audit.evidence, null, 2)}</pre>
          </details>
        </Section>
      </article>
      <nav className="mobileNav" aria-label="Report shortcuts">
        <a href="#overview">Overview</a>
        <a href="#information-survival">Signals</a>
        <a href="#raw-evidence">Evidence</a>
        <a href="#fixes">Fixes</a>
      </nav>
    </div>
  );
}

function EmptyState({
  title,
  body,
  href,
  action,
}: {
  title: string;
  body: string;
  href: string;
  action: string;
}) {
  return (
    <div className="emptyState">
      <b>{title}</b>
      <p>{body}</p>
      <a href={href}>
        {action} <ArrowIcon />
      </a>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function ArrowIcon() {
  return (
    <HugeiconsIcon
      icon={ArrowRight02Icon}
      size={18}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

function ExternalIcon() {
  return (
    <HugeiconsIcon
      icon={ArrowUpRight01Icon}
      size={16}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

function ReportSkeleton() {
  return (
    <div className="reportSkeleton" aria-live="polite" aria-busy="true">
      <div className="skeletonSide" />
      <div className="skeletonMain">
        <span>Loading audit</span>
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}
function Section({
  id,
  label,
  title,
  children,
}: {
  id: string;
  label: string;
  title: string;
  children: any;
}) {
  return (
    <section className="section" id={id}>
      <div className="sectionHead">
        <span>{label}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}
function Score({ metric }: { metric: Audit["metrics"][number] | undefined }) {
  const score = metric?.score;
  const verdict =
    score == null
      ? "Pending"
      : score >= 80
        ? "Strong"
        : score >= 60
          ? "Mixed"
          : "Weak";
  return (
    <div className="score">
      <small>PERCEPTION SCORE</small>
      <div>
        <strong>{score ?? "—"}</strong>
        <b>{verdict}</b>
      </div>
      <i aria-hidden="true">
        <span style={{ width: `${score ?? 0}%` }} />
      </i>
      <span>
        {metric?.earned.toFixed(1) ?? "0.0"} /{" "}
        {metric?.denominator.toFixed(1) ?? "0.0"} weighted points
      </span>
    </div>
  );
}
function Term({ k, v }: { k: string; v?: string }) {
  return (
    <div className="term">
      <small>{k}</small>
      <b>{v || "Not established"}</b>
    </div>
  );
}
function slug(x: string) {
  return x.toLowerCase().replaceAll(" ", "-");
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
