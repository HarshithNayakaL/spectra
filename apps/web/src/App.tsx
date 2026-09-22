import {
  Component,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  auditSchema,
  type Action,
  type Audit,
  type Check,
  type PromptResult,
} from "@spectra/schemas";
import { buildFixPrompt, estimateTokens } from "@spectra/evaluation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight02Icon,
  ArrowUpRight01Icon,
  GoogleGeminiIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import {
  FloatingCloudee,
  useCloudeeMood,
  type Mood,
  type PageState,
} from "./avatar/Cloudee";
import { BoardSection, FanoutSection } from "./Board";
import { JourneyPage } from "./Journey";
import { Picker } from "./Picker";
import { API, modelBadge, modelMeta, useModels, type ModelOption } from "./api";

const TERMINAL = new Set(["complete", "partial", "failed"]);

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
    [prompts, setPrompts] = useState<string[]>([""]),
    [model, setModel] = useState("gemini-3.1-flash-lite"),
    [path, setPath] = useState(location.pathname);
  const headline = audit?.visibility?.score ?? audit?.readiness?.score ?? null;
  const pageState: PageState = error
    ? "error"
    : running
      ? "running"
      : url.trim().length > 3 && !audit
        ? "typing"
        : "idle";
  const verdictMood: Mood | undefined = audit
    ? headline === null
      ? "confused"
      : headline >= 75
        ? "proud"
        : headline >= 45
          ? "curious"
          : "sad"
    : undefined;
  const { mood, poke } = useCloudeeMood(
    pageState,
    progress.length,
    verdictMood,
  );
  const id = path.match(/^\/audits\/([a-f0-9-]{36})$/)?.[1];
  // Journey is the other half of the product: one agent, one job, one site.
  const onJourney = path === "/journey" || path.startsWith("/journeys/");
  const journeyId = path.match(/^\/journeys\/([a-f0-9-]{36})$/)?.[1];

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
    if (running || loadedId === id) {
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
            "This audit could not be loaded. It may be from an older version of SPECTRA, or the link is wrong. Run a new audit.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoadingAudit(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, loadedId, running]);

  // A report opened while its audit is still running keeps itself current.
  useEffect(() => {
    if (!audit || running || TERMINAL.has(audit.status)) return;
    const timer = setTimeout(() => {
      fetch(`${API}/api/audits/${audit.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((x) => x && setAudit(auditSchema.parse(x)))
        .catch(() => {});
    }, 4000);
    return () => clearTimeout(timer);
  }, [audit, running]);

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
        body: JSON.stringify({
          url,
          model,
          prompts: prompts.map((t) => t.trim()).filter((t) => t.length >= 3),
        }),
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
          "The connection closed before the report finished. Reload this page in a minute to see the saved report.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "The audit failed.");
      if (location.pathname.startsWith("/audits/")) navigate("/", true);
    } finally {
      setRunning(false);
    }
  }

  function rerun(target: string, customPrompts: string[]) {
    setUrl(target);
    setPrompts(customPrompts.length ? customPrompts : [""]);
    setAudit(null);
    navigate("/");
    window.scrollTo({ top: 0 });
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
        <nav className="topNav" aria-label="Sections">
          <a
            href="/"
            aria-current={onJourney ? undefined : "page"}
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            Audit
          </a>
          <a
            href="/journey"
            aria-current={onJourney ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate("/journey");
            }}
          >
            Journey
          </a>
        </nav>
        <span className="topMeta">
          <HugeiconsIcon
            icon={GoogleGeminiIcon}
            size={15}
            strokeWidth={1.9}
            aria-hidden="true"
          />
          <span className="topLong">Measured with Google Gemini + Search</span>
          <span className="topShort">Gemini + Search</span>
        </span>
      </header>
      <main id="main">
        <ErrorBoundary>
          {onJourney ? (
            <JourneyPage id={journeyId} navigate={navigate} />
          ) : loadingAudit ? (
            <Skeleton />
          ) : !audit ? (
            <Landing
              url={url}
              setUrl={setUrl}
              prompts={prompts}
              setPrompts={setPrompts}
              model={model}
              setModel={setModel}
              submit={submit}
              progress={progress}
              error={error}
              running={running}
            />
          ) : (
            <Report audit={audit} onRerun={rerun} />
          )}
        </ErrorBoundary>
      </main>
      <FloatingCloudee mood={mood} onPoke={poke} />
    </>
  );
}

export type { ModelOption };

const STEPS = [
  {
    name: "Crawl like an AI",
    detail:
      "Robots rules for 14 AI crawlers, a firewall test as GPTBot and PerplexityBot, raw HTML with no JavaScript, sitemap, llms.txt.",
  },
  {
    name: "Ask like a buyer",
    detail:
      "Your questions plus the ones buyers ask about your category go to Gemini with live Google Search, the retrieval behind AI Mode.",
  },
  {
    name: "Fan the question out",
    detail:
      "An engine never searches your question. We expand it into the synthetic sub-queries it would issue and run each one, so you see which kinds reach you and which never do.",
  },
  {
    name: "Read the answer",
    detail:
      "Were you named? At what rank? Which competitors and which sources were used instead? What did it get wrong?",
  },
  {
    name: "Fix with code",
    detail:
      "Every gap becomes a task with ready-to-paste robots rules, JSON-LD and a generated llms.txt, plus one prompt for your coding agent.",
  },
];

function Landing({
  url,
  setUrl,
  prompts,
  setPrompts,
  model,
  setModel,
  submit,
  progress,
  error,
  running,
}: {
  url: string;
  setUrl: (x: string) => void;
  prompts: string[];
  setPrompts: (x: string[]) => void;
  model: string;
  setModel: (x: string) => void;
  submit: (e: FormEvent) => void;
  progress: { stage: string; message: string }[];
  error: string;
  running: boolean;
}) {
  const models = useModels();
  const filled = prompts.filter((x) => x.trim().length > 2).length;
  const latest = progress.at(-1);

  return (
    <section className="landing">
      <div className="bento">
        <div className="cell cellHero reveal" style={{ "--d": "0ms" } as never}>
          <div className="kicker">
            <span>AEO</span>
            <span>AI search visibility audit</span>
          </div>
          <h1 className="heroType">
            <span>Are you in</span> <span>the answer?</span>
          </h1>
          <p className="heroLede">
            Type the questions your buyers ask AI. SPECTRA asks Gemini with live
            Google Search, shows whether you were named and who was named
            instead, and tells you exactly what to change.
          </p>

          <form onSubmit={submit} className="analyze" aria-busy={running}>
            <div className="fieldRow">
              <label htmlFor="target">Your site</label>
              <div className="field">
                <input
                  id="target"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="fieldRow">
              <label htmlFor="prompt-0">
                Questions your buyers ask AI
                <span className="labelHint">
                  {filled
                    ? `${filled} of 5`
                    : "optional, we add category questions either way"}
                </span>
              </label>
              {prompts.map((value, index) => (
                <div className="intentRow" key={index}>
                  <div className="field">
                    <input
                      id={`prompt-${index}`}
                      type="text"
                      maxLength={280}
                      placeholder={
                        index === 0
                          ? "Best B2B data provider for startups"
                          : "Cheaper alternative to ZoomInfo"
                      }
                      value={value}
                      onChange={(event) => {
                        const next = [...prompts];
                        next[index] = event.target.value;
                        setPrompts(next);
                      }}
                    />
                  </div>
                  {prompts.length > 1 && (
                    <button
                      type="button"
                      className="rowDrop"
                      onClick={() =>
                        setPrompts(prompts.filter((_, i) => i !== index))
                      }
                      aria-label={`Remove question ${index + 1}`}
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
              {prompts.length < 5 && (
                <button
                  type="button"
                  className="rowAdd"
                  onClick={() => setPrompts([...prompts, ""])}
                >
                  + Add question
                </button>
              )}
            </div>

            <Picker
              label="Model"
              hint={models.length ? `${models.length} available` : undefined}
              value={model}
              options={
                models.length
                  ? models.map((m) => ({
                      value: m.id,
                      label: m.label,
                      badge: modelBadge(m),
                      meta: modelMeta(m),
                    }))
                  : [{ value: model, label: model }]
              }
              onChange={setModel}
              icon={GoogleGeminiIcon}
              empty="Reading the Gemini catalogue…"
            />

            <button className="runButton" disabled={running}>
              <span>{running ? "Auditing" : "Run audit"}</span>
              <HugeiconsIcon
                className={running ? "runIcon spin" : "runIcon"}
                icon={running ? Loading03Icon : ArrowRight02Icon}
                size={20}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
            <p className="analyzeNote">
              Takes 1 to 3 minutes. Public sites only. No account needed.
            </p>
          </form>
        </div>

        {running ? (
          <div
            className="cell cellStat cellLive"
            aria-live="polite"
            style={{ "--d": "0ms" } as never}
          >
            <span className="liveDot" aria-hidden="true" />
            <span className="statLabel">
              {latest ? stageLabel(latest.stage) : "Starting"}
            </span>
            <p className="liveMessage">
              {latest?.message ?? "Connecting to the site"}
            </p>
            <ol className="liveSteps">
              {["scanning", "profiling", "asking", "expanding"].map((s) => (
                <li
                  key={s}
                  data-state={
                    latest?.stage === s
                      ? "active"
                      : progress.some((p) => p.stage === s)
                        ? "done"
                        : "todo"
                  }
                >
                  {stageLabel(s)}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div
            className="cell cellStat reveal"
            style={{ "--d": "60ms" } as never}
          >
            <span className="statNum">27</span>
            <span className="statLabel">checks, 4 layers, 1 score</span>
            <p>
              Crawler access, readable content, entity clarity and AI-ready
              files. Deterministic: the same site gets the same score, and every
              point is traceable to what we fetched.
            </p>
            <p className="statProof">
              <b>Real answers, not a simulation.</b> We never hand Gemini your
              pages and ask if it understood them. We ask what a buyer would
              ask, exactly as they would, and read what comes back.
            </p>
          </div>
        )}

        {error && (
          <div className="cell cellError" role="alert">
            <div className="notice">
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
          </div>
        )}

        <a
          className="cell cellJourney reveal"
          href="/journey"
          style={{ "--d": "100ms" } as never}
        >
          <span className="kicker">
            <span>Journey</span>
          </span>
          <b className="journeyPitch">Watch an agent use your site.</b>
          <p>
            The audit asks whether AI knows you exist. A journey asks the next
            question: point a real agent at your domain with a job to do, and
            watch every move it makes until it finishes or gives up.
          </p>
          <span className="journeyGo">
            Run a journey
            <HugeiconsIcon
              icon={ArrowRight02Icon}
              size={16}
              strokeWidth={2}
              aria-hidden="true"
            />
          </span>
        </a>

        <div
          className="cell cellSteps reveal"
          style={{ "--d": "130ms" } as never}
        >
          <h2 className="stepsTitle">How the audit works</h2>
          <ol className="steps4">
            {STEPS.map((step, index) => (
              <li key={step.name}>
                <span className="stageIndex">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <b className="stageName">{step.name}</b>
                <p className="stageLoss">{step.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function stageLabel(stage: string) {
  return (
    {
      scanning: "Crawling",
      profiling: "Profiling",
      asking: "Asking Gemini",
      analysing: "Reading answers",
      expanding: "Fanning out",
    }[stage] ?? stage
  );
}

/* ================================================================ report */

/**
 * The rail lists what this report actually contains. A section that did not
 * run has no anchor to jump to, so it is not offered.
 */
function sectionsOf(audit: Audit) {
  return [
    { id: "board", label: "Where it stands" },
    ...(audit.fanout ? [{ id: "fanout", label: "Fan-out" }] : []),
    { id: "questions", label: "Buyer questions" },
    { id: "competitors", label: "Competitors & sources" },
    { id: "fixes", label: "Fix list" },
    { id: "checks", label: "Readiness checks" },
    { id: "pages", label: "Pages scanned" },
  ];
}

function Report({
  audit,
  onRerun,
}: {
  audit: Audit;
  onRerun: (target: string, prompts: string[]) => void;
}) {
  const v = audit.visibility;
  const r = audit.readiness;
  const sections = useMemo(() => sectionsOf(audit), [audit]);
  const active = useActiveSection(sections.map((s) => s.id));
  useEffect(() => {
    const tab = document.querySelector<HTMLElement>(
      `.railNav a[href="#${active}"]`,
    );
    const bar = tab?.closest<HTMLElement>(".rail");
    if (tab && bar && bar.scrollWidth > bar.clientWidth)
      bar.scrollTo({
        left: tab.offsetLeft - bar.clientWidth / 2 + tab.offsetWidth / 2,
        behavior: "smooth",
      });
  }, [active]);
  const live = !TERMINAL.has(audit.status);
  const brand = audit.profile?.brand ?? audit.host;

  if (audit.status === "failed")
    return (
      <section className="landing">
        <div className="bento">
          <div className="cell cellError cellWide" role="alert">
            <div className="notice">
              <b>The audit of {audit.host} could not run</b>
              <p>{audit.error}</p>
              <button
                type="button"
                className="noticeAction"
                onClick={() => onRerun(audit.target, audit.customPrompts)}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </section>
    );

  const rival = v?.shareOfVoice.find((s) => !s.brand && s.mentions > 0);
  const verdict =
    v && v.categoryMeasured
      ? `Gemini named ${brand} in ${v.categoryMentions} of ${v.categoryMeasured} buyer questions.${rival ? ` ${rival.name} was named in ${rival.mentions}.` : ""}`
      : r
        ? `AI readiness ${r.score}/100. Visibility was not measured on this run.`
        : "";
  const notes = [
    ...(v?.engine === "gemini_model" ? [v.engineNote] : []),
    ...audit.warnings.map(tidyWarning),
  ];

  return (
    <div className="report">
      <aside className="rail" aria-label="Report sections">
        <span className="railLabel">{audit.host}</span>
        <a className="railNew" href="/">
          New audit
        </a>
        <nav className="railNav">
          <a href="#overview" aria-current={active === "overview"}>
            Overview
          </a>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} aria-current={active === s.id}>
              {s.label}
            </a>
          ))}
        </nav>
      </aside>

      <div className="sheet">
        <div className="grid" id="overview">
          <header className="card cardHead span8">
            <p className="eyebrow">
              <span>{audit.host}</span>
              {audit.profile?.category && <span>{audit.profile.category}</span>}
            </p>
            <h1>{brand}</h1>
            {verdict && <p className="verdictLine">{verdict}</p>}
            {audit.profile?.description && (
              <p className="lede">{audit.profile.description}</p>
            )}
            <p className="metaLine mono">
              <span>{audit.scan?.pages.length ?? 0} pages</span>
              <span>{v?.measured ?? 0} questions</span>
              <span>
                {audit.durationMs
                  ? `${Math.round(audit.durationMs / 1000)}s`
                  : "running"}
              </span>
              <span>{audit.model}</span>
            </p>
            <div className="headActions">
              <FixAllButton audit={audit} />
              {audit.llmsTxt && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => download("llms.txt", audit.llmsTxt!)}
                >
                  Download llms.txt
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => onRerun(audit.target, audit.customPrompts)}
              >
                Re-run
              </button>
            </div>
          </header>

          <section className="card cardScore span4 dark">
            <span className="scoreLabel">AI visibility</span>
            {v && v.score !== null ? (
              <>
                <span className="scoreBig">{v.score}</span>
                <p className="scoreSub">
                  Named in <b>{v.categoryMentions}</b> of{" "}
                  <b>{v.categoryMeasured}</b> unbranded buyer questions
                  {v.groundedMeasured ? (
                    <>
                      , cited as a source in <b>{v.citations}</b> of{" "}
                      <b>{v.groundedMeasured}</b> answers
                    </>
                  ) : null}
                  .
                </p>
                {v.averagePosition !== null && (
                  <p className="scoreSub">
                    Average rank when listed: <b>#{v.averagePosition}</b>
                  </p>
                )}
              </>
            ) : (
              <>
                <span className="scoreBig muted">{live ? "…" : "–"}</span>
                <p className="scoreSub">
                  {live
                    ? "Asking Gemini now."
                    : "Not measured. See the notes below."}
                </p>
              </>
            )}
          </section>

          {live && (
            <div className="card span12 liveBanner" aria-live="polite">
              <span className="liveDot" aria-hidden="true" />
              {audit.stage || "Running"}
            </div>
          )}

          {r && (
            <section className="card span12 cardLayers">
              <div className="readinessScore">
                <span className="scoreLabel">AI readiness</span>
                <span className="scoreMid">
                  {r.score}
                  <small>/100</small>
                </span>
                <span className={`grade grade${r.grade}`}>Grade {r.grade}</span>
              </div>
              <div className="layers">
                {r.layers.map((layer) => (
                  <a
                    href={`#layer-${layer.id}`}
                    className="layer"
                    key={layer.id}
                  >
                    <span className="layerTop">
                      <b>{layer.label}</b>
                      <span className="mono">
                        {layer.earned}/{layer.possible}
                      </span>
                    </span>
                    <span className="meter" aria-hidden="true">
                      <i style={{ width: `${layer.score ?? 0}%` }} />
                    </span>
                    <span className="layerQ">{layer.question}</span>
                  </a>
                ))}
              </div>
            </section>
          )}

          {notes.length > 0 && (
            <details className="card span12 notes">
              <summary>
                <b>Notes on this run</b>
                <span className="mono">{notes.length}</span>
              </summary>
              <ul>
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <BoardSection audit={audit} />
        <FanoutSection audit={audit} />
        <Questions audit={audit} />
        <Competitors audit={audit} />
        <Fixes audit={audit} />
        <Checks audit={audit} />
        <Pages audit={audit} />
      </div>

      {/* Phones: the one action that matters stays under the thumb. */}
      {audit.actions.length > 0 && (
        <div className="mobileBar">
          <FixAllButton audit={audit} short />
          {audit.llmsTxt && (
            <button
              type="button"
              className="btn"
              onClick={() => download("llms.txt", audit.llmsTxt!)}
            >
              llms.txt
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Warnings are written for logs; on screen, drop the host and jargon. */
function tidyWarning(text: string) {
  return text
    .replace(/https?:\/\/[^/\s]+(\/[^\s:]*)?/g, (_, path) => path || "/")
    .replace(/The operation was aborted due to timeout/gi, "timed out")
    .replace(/Timed out after 10s/gi, "timed out");
}

function Questions({ audit }: { audit: Audit }) {
  const v = audit.visibility;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="block" id="questions">
      <div className="blockHead">
        <h2>Buyer questions</h2>
        <p>
          Each question was sent to Gemini exactly as written
          {v?.engine === "gemini_search" ? ", with Google Search on" : ""}. Open
          one to read the full answer and its sources.
        </p>
      </div>
      {!v || !v.prompts.length ? (
        <Empty
          title={
            TERMINAL.has(audit.status) ? "No questions were asked" : "Asking…"
          }
          body={
            TERMINAL.has(audit.status)
              ? "Gemini was not available for this audit. The readiness checks below are complete."
              : "Results appear here as each answer comes back."
          }
        />
      ) : (
        <div className="qList">
          {v.prompts.map((p) => (
            <QuestionRow
              key={p.id}
              p={p}
              open={open === p.id}
              toggle={() => setOpen(open === p.id ? null : p.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function QuestionRow({
  p,
  open,
  toggle,
}: {
  p: PromptResult;
  open: boolean;
  toggle: () => void;
}) {
  const verdict =
    p.status !== "ok"
      ? p.status === "skipped"
        ? "Not asked"
        : "Failed"
      : p.mentioned
        ? p.position
          ? `Named #${p.position}`
          : "Named"
        : "Not named";
  const tone = p.status !== "ok" ? "neutral" : p.mentioned ? "good" : "bad";
  return (
    <article className={`qRow ${open ? "open" : ""}`}>
      <button
        type="button"
        className="qMain"
        onClick={toggle}
        aria-expanded={open}
        disabled={p.status !== "ok" && !p.error}
      >
        <span className={`verdict ${tone}`}>{verdict}</span>
        <span className="qText">
          <span className="qKind">
            {p.kind === "custom"
              ? "Your question"
              : p.kind === "branded"
                ? "About you"
                : "Category"}
          </span>
          {p.text}
        </span>
        <span className="qSide">
          {p.cited && <span className="chip good">Cited you</span>}
          {p.sentiment === "negative" && (
            <span className="chip bad">Negative</span>
          )}
          {p.inaccuracies.length > 0 && (
            <span className="chip bad">{p.inaccuracies.length} wrong</span>
          )}
          {p.competitors.length > 0 && (
            <span className="qRivals">
              {p.competitors.slice(0, 3).join(", ")}
              {p.competitors.length > 3 ? ` +${p.competitors.length - 3}` : ""}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="qDetail">
          {p.error && <p className="errorText">{p.error}</p>}
          {p.inaccuracies.length > 0 && (
            <div className="wrong">
              <b>Gets wrong</b>
              <ul>
                {p.inaccuracies.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          {p.answer && <AnswerText text={p.answer} />}
          {p.sources.length > 0 && (
            <div className="sources">
              <b>Sources Gemini used</b>
              <ol>
                {p.sources.map((s, i) => (
                  <li key={`${s.uri}-${i}`}>
                    <a href={s.uri} target="_blank" rel="noreferrer noopener">
                      {s.domain || s.title || "source"}
                      <ExternalMark />
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="qFoot mono">
            {p.engine === "gemini_search"
              ? "Gemini + Google Search"
              : "Gemini, model knowledge only"}
            {p.durationMs ? ` · ${(p.durationMs / 1000).toFixed(1)}s` : ""}
          </p>
        </div>
      )}
    </article>
  );
}

/** Minimal Markdown: headings, bullets, numbered items and bold. */
function AnswerText({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const blocks = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*([-*_])\1{2,}\s*$/.test(line));
  // Long answers are previewed; the verdict above already says what matters.
  const long = text.length > 900;
  return (
    <div className={`answer ${long && !full ? "clamped" : ""}`}>
      {blocks.map((line, i) => {
        const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
        const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
        const nested = /^\s{2,}/.test(line);
        if (heading) return <h4 key={i}>{inline(heading[1])}</h4>;
        if (bullet)
          return (
            <p key={i} className={nested ? "li nested" : "li"}>
              {inline(bullet[1])}
            </p>
          );
        return <p key={i}>{inline(line)}</p>;
      })}
      {long && (
        <button
          type="button"
          className="answerToggle"
          onClick={() => setFull(!full)}
          aria-expanded={full}
        >
          {full ? "Show less" : "Read the full answer"}
        </button>
      )}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <b key={i}>{part.slice(2, -2)}</b>
      ) : (
        part.replace(/\*/g, "")
      ),
    );
}

function Competitors({ audit }: { audit: Audit }) {
  const v = audit.visibility;
  if (!v || !v.measured) return null;
  const top = Math.max(1, ...v.shareOfVoice.map((s) => s.mentions));
  // Reports saved before the brand was pinned can lack its row.
  const sov = v.shareOfVoice.some((s) => s.brand)
    ? v.shareOfVoice
    : [
        ...v.shareOfVoice.slice(0, 8),
        {
          name: audit.profile?.brand ?? audit.host,
          mentions: v.categoryMentions,
          brand: true,
        },
      ];
  return (
    <section className="block" id="competitors">
      <div className="blockHead">
        <h2>Who AI recommends</h2>
        <p>
          How many of the {v.categoryMeasured} unbranded answers named each
          company, and which sites those answers were built from.
        </p>
      </div>
      <div className="grid">
        <div className="card span7">
          <h3>Share of voice</h3>
          {v.shareOfVoice.length <= 1 && !v.shareOfVoice[0]?.mentions ? (
            <p className="muted">No companies were named in these answers.</p>
          ) : (
            <ul className="sov">
              {sov.map((s) => (
                <li key={s.name} className={s.brand ? "you" : ""}>
                  <span className="sovName">
                    {s.name}
                    {s.brand && <span className="chip">You</span>}
                  </span>
                  <span className="meter" aria-hidden="true">
                    <i style={{ width: `${(s.mentions / top) * 100}%` }} />
                  </span>
                  <span className="mono">
                    {s.mentions}/{v.categoryMeasured}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card span5">
          <h3>Sources Gemini cited</h3>
          {v.citedDomains.length ? (
            <ul className="domains">
              {v.citedDomains.map((d) => (
                <li key={d.domain} className={d.own ? "you" : ""}>
                  <span>
                    {d.domain}
                    {d.own && <span className="chip good">Your site</span>}
                  </span>
                  <span className="mono">{d.count}×</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {v.engine === "gemini_model"
                ? "Search grounding was unavailable on this run, so no sources were returned. Answers came from what Gemini already knows."
                : "No sources were returned."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Fixes({ audit }: { audit: Audit }) {
  const [open, setOpen] = useState<string | null>(audit.actions[0]?.id ?? null);
  const [all, setAll] = useState(false);
  const shown = all ? audit.actions : audit.actions.slice(0, 5);
  return (
    <section className="block" id="fixes">
      <div className="blockHead">
        <h2>Fix list</h2>
        <p>
          Highest impact first. Readiness fixes show the exact points they add;
          visibility fixes come from the answers above.
        </p>
      </div>
      {!audit.actions.length ? (
        <Empty
          title="Nothing to fix"
          body="Every check passed and you were named in every answer."
        />
      ) : (
        <div className="fixList">
          {shown.map((a, i) => (
            <FixRow
              key={a.id}
              index={i}
              action={a}
              audit={audit}
              open={open === a.id}
              toggle={() => setOpen(open === a.id ? null : a.id)}
            />
          ))}
          {audit.actions.length > shown.length && (
            <button
              type="button"
              className="btn showMore"
              onClick={() => setAll(true)}
            >
              Show {audit.actions.length - shown.length} more fixes
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function FixRow({
  action,
  audit,
  index,
  open,
  toggle,
}: {
  action: Action;
  audit: Audit;
  index: number;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <article className={`fixRow ${open ? "open" : ""}`}>
      <button
        type="button"
        className="fixMain"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="mono fixIndex">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className={`prio ${action.priority}`}>{action.priority}</span>
        <span className="fixTitle">{action.title}</span>
        <span className="mono fixGain">
          {action.points
            ? `+${action.points} pts`
            : action.source === "visibility"
              ? "visibility"
              : ""}
        </span>
      </button>
      {open && (
        <div className="fixDetail">
          <p className="found">{action.detail}</p>
          {action.fix.steps.length > 0 && (
            <ol className="steps">
              {action.fix.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {action.fix.code && (
            <CodeBlock
              code={action.fix.code}
              file={action.fix.file}
              language={action.fix.language}
            />
          )}
          <div className="fixActions">
            <CopyButton
              label="Copy prompt for this fix"
              text={() => buildFixPrompt(audit, [action])}
            />
          </div>
        </div>
      )}
    </article>
  );
}

function Checks({ audit }: { audit: Audit }) {
  const r = audit.readiness;
  const [open, setOpen] = useState<string | null>(null);
  if (!r) return null;
  return (
    <section className="block" id="checks">
      <div className="blockHead">
        <h2>Readiness checks</h2>
        <p>
          {r.checks.filter((c) => c.status === "pass").length} of{" "}
          {r.checks.filter((c) => c.status !== "na").length} passed. Each check
          reports what we actually fetched.
        </p>
      </div>
      <div className="grid">
        {r.layers.map((layer) => (
          <div
            className="card span6 layerCard"
            key={layer.id}
            id={`layer-${layer.id}`}
          >
            <div className="layerCardHead">
              <h3>{layer.label}</h3>
              <span className="mono">
                {layer.earned}/{layer.possible}
              </span>
            </div>
            <p className="muted small">{layer.question}</p>
            <ul className="checkList">
              {r.checks
                .filter((c) => c.layer === layer.id)
                .map((c) => (
                  <CheckRow
                    key={c.id}
                    check={c}
                    open={open === c.id}
                    toggle={() => setOpen(open === c.id ? null : c.id)}
                  />
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function CheckRow({
  check,
  open,
  toggle,
}: {
  check: Check;
  open: boolean;
  toggle: () => void;
}) {
  return (
    <li className={`check ${check.status}`}>
      <button type="button" onClick={toggle} aria-expanded={open}>
        <span className={`dot ${check.status}`} aria-label={check.status} />
        <span className="checkLabel">{check.label}</span>
        <span className="mono checkPts">
          {check.status === "na" ? "n/a" : `${check.earned}/${check.weight}`}
        </span>
      </button>
      <p className="checkFound">{check.found}</p>
      {open && (
        <div className="checkDetail">
          <p>
            <b>Why it matters. </b>
            {check.why}
          </p>
          {check.fix?.code && (
            <CodeBlock
              code={check.fix.code}
              file={check.fix.file}
              language={check.fix.language}
            />
          )}
          {check.urls.length > 0 && (
            <p className="checkUrls mono">
              {check.urls.slice(0, 6).map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer noopener">
                  {pathOf(u)}
                </a>
              ))}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Pages({ audit }: { audit: Audit }) {
  const pages = audit.scan?.pages ?? [];
  if (!pages.length) return null;
  return (
    <section className="block" id="pages">
      <div className="blockHead">
        <h2>Pages scanned</h2>
        <p>
          The raw HTML each page returned, before any JavaScript ran. This is
          what AI crawlers get.
        </p>
      </div>
      <div className="card span12 tableCard">
        <div className="tableScroll">
          <table className="pageTable">
            <thead>
              <tr>
                <th>Page</th>
                <th className="num">Words</th>
                <th>Title</th>
                <th>Description</th>
                <th>Structured data</th>
                <th className="num">Load</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.url}>
                  <td data-label="Page">
                    <a href={p.url} target="_blank" rel="noreferrer noopener">
                      {pathOf(p.url)}
                    </a>
                  </td>
                  <td
                    data-label="Words"
                    className={`num ${p.appShell ? "bad" : ""}`}
                  >
                    {p.words.toLocaleString("en")}
                  </td>
                  <td data-label="Title" className={p.title ? "" : "bad"}>
                    {p.title || "missing"}
                  </td>
                  <td
                    data-label="Description"
                    className={p.description ? "ok" : "bad"}
                  >
                    {p.description ? "yes" : "missing"}
                  </td>
                  <td data-label="Schema">
                    {p.jsonLdTypes.slice(0, 4).join(", ") || "none"}
                  </td>
                  <td data-label="Load" className="num">
                    {(p.ms / 1000).toFixed(1)}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ================================================================ parts */

function FixAllButton({ audit, short }: { audit: Audit; short?: boolean }) {
  const prompt = useMemo(() => buildFixPrompt(audit), [audit]);
  if (!audit.actions.length) return null;
  return (
    <CopyButton
      primary
      label={
        short
          ? `Copy fix prompt · ${audit.actions.length} tasks`
          : `Copy fix prompt (${audit.actions.length} tasks, ~${Math.round(estimateTokens(prompt) / 100) / 10}k tokens)`
      }
      text={() => prompt}
    />
  );
}

function CopyButton({
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
          download("spectra-fix-prompt.md", text());
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

function CodeBlock({
  code,
  file,
  language,
}: {
  code: string;
  file?: string;
  language?: string;
}) {
  return (
    <div className="code">
      <div className="codeHead">
        <span className="mono">{file ?? language ?? "code"}</span>
        <CopyButton label="Copy" text={() => code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="card empty">
      <b>{title}</b>
      <p>{body}</p>
    </div>
  );
}

function ExternalMark() {
  return (
    <HugeiconsIcon
      icon={ArrowUpRight01Icon}
      size={13}
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
        <div className="bento">
          <div className="cell cellError cellWide" role="alert">
            <div className="notice">
              <b>This report could not be displayed</b>
              <p>{this.state.error.message}</p>
              <button
                type="button"
                className="noticeAction"
                onClick={() => location.assign("/")}
              >
                Start a new audit
              </button>
            </div>
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
      // Below the sticky header and tab bar, whatever the screen height.
      const line = Math.max(window.innerHeight * 0.3, 170);
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

function download(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}
