import { FormEvent, useEffect, useState } from "react";
import { auditSchema, type Audit } from "@spectra/schemas";
const API = import.meta.env.VITE_API_URL || "";
export function App() {
  const [audit, setAudit] = useState<Audit | null>(null),
    [url, setUrl] = useState(""),
    [progress, setProgress] = useState<{ stage: string; message: string }[]>(
      [],
    ),
    [error, setError] = useState("");
  const id = location.pathname.match(/^\/audits\/([a-f0-9-]{36})$/)?.[1];
  useEffect(() => {
    if (id)
      fetch(`${API}/api/audits/${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((x) => setAudit(auditSchema.parse(x)))
        .catch(() => setError("This audit could not be loaded."));
  }, [id]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setAudit(null);
    setProgress([]);
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
          }
          if (event.type === "error") throw new Error(event.message);
        }
        if (done) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Audit failed");
    }
  }
  return (
    <>
      <header className="top">
        <a href="/" className="brand" aria-label="SPECTRA home">
          <span className="mark" />
          SPECTRA
        </a>
        <span className="version">ENGINE v0.1</span>
      </header>
      <main>
        {!audit ? (
          <Landing
            url={url}
            setUrl={setUrl}
            submit={submit}
            progress={progress}
            error={error}
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
}: {
  url: string;
  setUrl: (x: string) => void;
  submit: (e: FormEvent) => void;
  progress: { stage: string; message: string }[];
  error: string;
}) {
  return (
    <section className="landing">
      <div className="eyebrow">AI SEARCH PERCEPTION SYSTEM</div>
      <h1>
        See what machines
        <br />
        <em>actually understand.</em>
      </h1>
      <p className="lede">
        SPECTRA traces important information from source code through crawling,
        semantic interpretation, and retrieval—then shows exactly where it
        disappears.
      </p>
      <form onSubmit={submit} className="analyze">
        <label htmlFor="target">Public website URL</label>
        <div className="inputRow">
          <input
            id="target"
            type="text"
            inputMode="url"
            placeholder="example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            aria-describedby="url-note"
          />
          <button
            disabled={
              progress.length > 0 && progress.at(-1)?.stage !== "complete"
            }
          >
            Analyze site <span>→</span>
          </button>
        </div>
        <small id="url-note">
          Only public HTTP and HTTPS targets are accepted.
        </small>
      </form>
      {progress.length > 0 && (
        <div className="progress" aria-live="polite">
          <div className="pulse" />
          <div>
            <b>{progress.at(-1)?.message}</b>
            <span>{progress.length} pipeline stages recorded</span>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="principles">
        <div>
          <b>01</b>
          <span>Evidence first</span>
          <p>Every conclusion traces back to source material.</p>
        </div>
        <div>
          <b>02</b>
          <span>Adaptive analysis</span>
          <p>Checks change with the site’s purpose and entity.</p>
        </div>
        <div>
          <b>03</b>
          <span>Explainable scores</span>
          <p>Visible checks, weights, failures, and denominators.</p>
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
        <section id="overview" className="hero">
          <div>
            <div className="eyebrow">
              {audit.status.replace("_", " ").toUpperCase()} ·{" "}
              {new URL(audit.target).hostname}
            </div>
            <h1>{entity?.name || "Unresolved entity"}</h1>
            <p>{audit.analysis?.primaryEntity.description}</p>
            <div className="tags">
              <span>{audit.analysis?.siteArchetype.replaceAll("_", " ")}</span>
              {audit.analysis?.purpose.slice(0, 2).map((x) => (
                <span key={x}>{x}</span>
              ))}
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
              <p className="quiet">
                Retrieval tests require evidence-backed claims and an active
                model provider.
              </p>
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
        </Section>
        <Section id="raw-evidence" label="10 / TRACE" title="Raw evidence">
          <details>
            <summary>Inspect {audit.evidence.length} evidence records</summary>
            <pre>{JSON.stringify(audit.evidence, null, 2)}</pre>
          </details>
        </Section>
      </article>
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
  return (
    <div className="score">
      <small>EXPLAINABLE SCORE</small>
      <strong>{metric?.score ?? "—"}</strong>
      <span>/{metric?.denominator.toFixed(1) ?? "0"} weight</span>
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
