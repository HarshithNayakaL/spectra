import { FormEvent, useEffect, useRef, useState } from "react";
import {
  journeySchema,
  type Journey,
  type JourneyIssue,
  type JourneyStep,
} from "@spectra/schemas";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight02Icon,
  ArrowUpRight01Icon,
  GoogleGeminiIcon,
  Loading03Icon,
  Robot01Icon,
  Search01Icon,
  Route01Icon,
} from "@hugeicons/core-free-icons";
import { Picker } from "./Picker";
import {
  API,
  modelBadge,
  modelMeta,
  pathOf,
  readNdjson,
  useJourneyCatalogue,
  useModels,
} from "./api";

const CUSTOM = "custom";
const DEFAULT_MODEL = "gemini-3.1-flash-lite";

/**
 * Journey: one agent, one job, one site, recorded move by move.
 *
 * The audit asks whether AI knows you exist. This asks the next question — can
 * an agent that arrives with something to do actually finish it here — and it
 * answers with the responses, not with an opinion.
 */
export function JourneyPage({
  id,
  navigate,
}: {
  id?: string;
  navigate: (path: string, replace?: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [intent, setIntent] = useState("pricing");
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState("ChatGPT-User");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const [error, setError] = useState("");
  const catalogue = useJourneyCatalogue();
  const models = useModels();
  const chosenAgent = useRef(false);

  // The API owns the default agent, so the picker follows it rather than
  // hard-coding a name that could drift.
  useEffect(() => {
    if (catalogue?.defaultAgent && !chosenAgent.current)
      setAgent(catalogue.defaultAgent);
  }, [catalogue]);

  const loadedId = journey?.id;
  useEffect(() => {
    if (!id) {
      setLoading(false);
      if (!running) setJourney(null);
      return;
    }
    if (running || loadedId === id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`${API}/api/journeys/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("not found"))))
      .then((body) => {
        if (!cancelled) setJourney(journeySchema.parse(body));
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "This journey could not be loaded. Journeys are kept for a short while on this deployment, so run a new one.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, loadedId, running]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running) return;
    setError("");
    setJourney(null);
    setRunning(true);
    let sawResult = false;
    try {
      const response = await fetch(`${API}/api/journeys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, intent, task, agent, model }),
      });
      if (!response.ok || !response.body) {
        const reason = await response
          .json()
          .then((body) => (body as { error?: string })?.error)
          .catch(() => undefined);
        throw new Error(reason || "The journey could not be started.");
      }
      await readNdjson(response.body, (event) => {
        if (event.type === "progress" && event.journey) {
          const next = journeySchema.parse(event.journey);
          setJourney(next);
          if (!location.pathname.startsWith("/journeys/"))
            navigate(`/journeys/${next.id}`, true);
        }
        if (event.type === "result") {
          sawResult = true;
          const next = journeySchema.parse(event.journey);
          setJourney(next);
          navigate(`/journeys/${next.id}`, true);
        }
        if (event.type === "error")
          throw new Error(event.message || "The journey failed.");
      });
      if (!sawResult)
        throw new Error(
          "The connection closed before the journey finished. Reload this page in a minute to see the saved trail.",
        );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The journey failed.",
      );
    } finally {
      setRunning(false);
    }
  }

  const intents = catalogue?.intents ?? [];
  const jobOptions = [
    ...intents.map((row) => ({
      value: row.id,
      label: row.label,
      meta: row.task,
    })),
    {
      value: CUSTOM,
      label: "Something else",
      meta: "Describe the job yourself",
    },
  ];
  const agentOptions = (catalogue?.agents ?? []).map((row) => ({
    value: row.name,
    label: row.name,
    meta: row.label,
  }));
  const modelOptions = models.length
    ? models.map((row) => ({
        value: row.id,
        label: row.label,
        badge: modelBadge(row),
        meta: modelMeta(row),
      }))
    : [{ value: model, label: model }];

  function reset() {
    setJourney(null);
    setError("");
    navigate("/journey");
    window.scrollTo({ top: 0 });
  }

  if (loading) return <JourneySkeleton />;
  // Once a journey exists the trail replaces the form, and keeps filling while
  // the agent is still walking.
  if (journey)
    return <JourneyReport journey={journey} live={running} onReset={reset} />;

  return (
    <section className="landing">
      <div className="bento">
        <div className="cell cellHero reveal" style={{ "--d": "0ms" } as never}>
          <div className="kicker">
            <span>Journey</span>
            <span>Agent walkthrough</span>
          </div>
          <h1 className="heroType">
            <span>Can an agent</span> <span>do the job?</span>
          </h1>
          <p className="heroLede">
            Point a real AI agent at your domain with a job to do. SPECTRA
            records every move it makes — what it fetched, what came back, where
            it stalled, whether it finished — and checks its answer against the
            pages it actually read.
          </p>

          <form onSubmit={submit} className="analyze" aria-busy={running}>
            <div className="fieldRow">
              <label htmlFor="journey-target">
                Your site
                <span className="labelHint">public HTTP or HTTPS</span>
              </label>
              <div className="field">
                <input
                  id="journey-target"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="example.com"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                />
              </div>
            </div>

            <Picker
              label="The job"
              value={intent}
              options={jobOptions}
              onChange={setIntent}
              icon={Route01Icon}
              empty="Reading the job list…"
            />
            {intent === CUSTOM && (
              <div className="fieldRow">
                <label htmlFor="journey-task">
                  What should it do?
                  <span className="labelHint">
                    {task.trim().length < 3
                      ? "at least 3 characters"
                      : `${task.length}/280`}
                  </span>
                </label>
                <div className="field">
                  <input
                    id="journey-task"
                    type="text"
                    maxLength={280}
                    placeholder="Find out whether they support SSO on the team plan"
                    value={task}
                    onChange={(event) => setTask(event.target.value)}
                    required
                  />
                </div>
              </div>
            )}

            <Picker
              label="Arrive as"
              value={agent}
              options={agentOptions}
              onChange={(next) => {
                chosenAgent.current = true;
                setAgent(next);
              }}
              icon={Robot01Icon}
              empty="Reading the agent list…"
            />

            <Picker
              label="Model"
              hint="chooses the route"
              value={model}
              options={modelOptions}
              onChange={setModel}
              icon={GoogleGeminiIcon}
              empty="Reading the Gemini catalogue…"
            />

            <button
              className="runButton"
              disabled={
                running || (intent === CUSTOM && task.trim().length < 3)
              }
            >
              <span>{running ? "Walking" : "Run the journey"}</span>
              <HugeiconsIcon
                className={running ? "runIcon spin" : "runIcon"}
                icon={running ? Loading03Icon : ArrowRight02Icon}
                size={20}
                strokeWidth={2}
                aria-hidden="true"
              />
            </button>
            <p className="analyzeNote">
              Up to 8 page fetches and about a minute. The agent never signs in,
              submits a form or runs JavaScript, because a real one cannot.
            </p>
          </form>
        </div>

        <div
          className="cell cellStat reveal"
          style={{ "--d": "60ms" } as never}
        >
          <span className="statNum">8</span>
          <span className="statLabel">fetches, 1 job, 1 verdict</span>
          <p>
            The agent reads the raw HTML your server sends, obeys robots.txt for
            the crawler it arrives as, and stays on your domain.
          </p>
          <p className="statProof">
            <b>The verdict is not the agent's opinion.</b> A preset job carries
            its own proof — a price, an address, an endpoint — and an answer no
            page confirms is reported as unverified, not as a pass.
          </p>
        </div>

        {error && (
          <div className="cell cellError cellWide" role="alert">
            <div className="notice">
              <b>Journey stopped</b>
              <p>{error}</p>
              <button
                type="button"
                className="noticeAction"
                onClick={() =>
                  document.getElementById("journey-target")?.focus()
                }
              >
                Check the URL and try again
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ============================================================ the trail */

const OUTCOME: Record<
  string,
  { word: string; tone: "good" | "bad" | "warn"; line: string }
> = {
  completed: {
    word: "Finished",
    tone: "good",
    line: "The agent did the job, and a page it read carried the proof.",
  },
  partial: {
    word: "Unconfirmed",
    tone: "warn",
    line: "The agent produced an answer, but no page it read confirmed it. That answer came from the model, not from your site.",
  },
  stalled: {
    word: "Stalled",
    tone: "bad",
    line: "The agent read your site and could not finish the job.",
  },
  blocked: {
    word: "Blocked",
    tone: "bad",
    line: "The agent never got a readable page, so nothing on the site could reach an answer.",
  },
  failed: {
    word: "Failed",
    tone: "bad",
    line: "The journey could not run.",
  },
};

function JourneyReport({
  journey,
  live,
  onReset,
}: {
  journey: Journey;
  live: boolean;
  onReset: () => void;
}) {
  const outcome = journey.outcome ? OUTCOME[journey.outcome] : null;
  const blockers = journey.issues.filter(
    (issue) => issue.severity === "blocker",
  );
  return (
    <div className="jReport">
      <section className="block" id="journey-verdict">
        <div className="blockHead jReportHead">
          <div>
            <h2>{journey.host}</h2>
            <p>
              <b>{journey.intent.label}.</b> {journey.intent.task}
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={onReset}>
            New journey
          </button>
        </div>
        <div className="grid">
          {live && (
            <div className="card span12 liveBanner" aria-live="polite">
              <span className="liveDot" aria-hidden="true" />
              {journey.stage}
            </div>
          )}
          <header
            className={`card span7 jVerdict ${live ? "live" : (outcome?.tone ?? "warn")}`}
          >
            <span className="scoreLabel">{live ? "So far" : "Outcome"}</span>
            <p className="jBig">
              {live ? "Walking" : (outcome?.word ?? "Done")}
            </p>
            <p className="jVerdictLine">
              {live
                ? `${journey.agent.name} is reading ${journey.host} now. Every move it makes appears below as it happens.`
                : outcome?.line}
            </p>
            {journey.answer && (
              <div className="jAnswer">
                <b>
                  {journey.verified
                    ? "What it found, and the page that proved it"
                    : "What it reported"}
                </b>
                <p>{clip(journey.answer, 700)}</p>
                {journey.answerUrl && (
                  <a
                    href={journey.answerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mono jAnswerLink"
                  >
                    {pathOf(journey.answerUrl)}
                    <HugeiconsIcon
                      icon={ArrowUpRight01Icon}
                      size={13}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </a>
                )}
              </div>
            )}
            {blockers.length > 0 && (
              <p className="jBlockerLine">
                {blockers.length === 1
                  ? "One thing stopped it: "
                  : `${blockers.length} things stopped it: `}
                {blockers.map((issue) => issue.detail).join(" ")}
              </p>
            )}
          </header>

          <section className="card span5 jFacts">
            <span className="scoreLabel">What it cost</span>
            <dl className="jMetrics">
              <Metric label="Steps" value={journey.metrics.steps} />
              <Metric label="Pages fetched" value={journey.metrics.fetches} />
              <Metric
                label="Web searches"
                value={journey.metrics.searches}
                bad={journey.metrics.searches > 0}
              />
              <Metric
                label="Blocked"
                value={journey.metrics.blocked}
                bad={journey.metrics.blocked > 0}
              />
              <Metric
                label="Broken"
                value={journey.metrics.broken}
                bad={journey.metrics.broken > 0}
              />
              <Metric
                label="Slowest page"
                value={`${(journey.metrics.slowestMs / 1000).toFixed(1)}s`}
                bad={journey.metrics.slowestMs > 2500}
              />
              <Metric
                label="Time on site"
                value={`${(journey.metrics.siteMs / 1000).toFixed(1)}s`}
              />
              <Metric label="Downloaded" value={size(journey.metrics.bytes)} />
            </dl>
            <p className="jIdentity mono">
              <span>{journey.agent.name}</span>
              <span>
                {journey.navigator === "gemini"
                  ? journey.model
                  : "rule-based walker"}
              </span>
              <span>
                {journey.durationMs
                  ? `${(journey.durationMs / 1000).toFixed(1)}s`
                  : "running"}
              </span>
            </p>
          </section>
        </div>
      </section>

      <section className="block" id="journey-steps">
        <div className="blockHead">
          <h2>Every move it made</h2>
          <p>
            One row per request, in order. The reason is the agent's own,
            written before the move; everything to the right of it is what came
            back.
          </p>
        </div>
        <ol className="jSteps">
          {journey.steps.map((step) => (
            <StepRow key={step.n} step={step} host={journey.host} />
          ))}
          {live && (
            <li className="jStep jStepPending">
              <span className="mono jStepIndex">
                {String(journey.steps.length + 1).padStart(2, "0")}
              </span>
              <span className="jStepBody">
                <span className="jStepReason">{journey.stage}…</span>
              </span>
            </li>
          )}
        </ol>
      </section>

      {journey.issues.length > 0 && (
        <section className="block" id="journey-issues">
          <div className="blockHead">
            <h2>What to fix</h2>
            <p>
              {journey.metrics.blockers} stopping the agent,{" "}
              {journey.metrics.friction} slowing it down. Each one names the
              step it was observed on.
            </p>
          </div>
          <div className="jIssues">
            {journey.issues.map((issue, index) => (
              <IssueRow key={`${issue.code}-${index}`} issue={issue} />
            ))}
          </div>
        </section>
      )}

      {journey.warnings.length > 0 && (
        <details className="card span12 notes jNotes">
          <summary>
            <b>Notes on this run</b>
            <span className="mono">{journey.warnings.length}</span>
          </summary>
          <ul>
            {journey.warnings.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  bad,
}: {
  label: string;
  value: string | number;
  bad?: boolean;
}) {
  return (
    <div className={`jMetric ${bad ? "bad" : ""}`}>
      <dt>{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

const ISSUE_LABEL: Record<string, string> = {
  robots_blocked: "Blocked by robots.txt",
  firewall_blocked: "Blocked by the edge",
  auth_wall: "Behind a sign-in",
  not_found: "Dead route",
  server_error: "Server error",
  unreachable: "No response",
  javascript_only: "Needs JavaScript",
  thin_content: "Too little text",
  slow_response: "Slow",
  wrong_content_type: "Unreadable format",
  redirected: "Redirected",
  left_the_site: "Answer was off-site",
  no_route: "No route to the job",
  unverified_answer: "Answer not on the page",
  budget_exhausted: "Ran out of steps",
};

function IssueRow({ issue }: { issue: JourneyIssue }) {
  const [open, setOpen] = useState(issue.severity === "blocker");
  return (
    <article className={`jIssue ${issue.severity} ${open ? "open" : ""}`}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`prio ${issue.severity}`}>{issue.severity}</span>
        <span className="jIssueTitle">
          {ISSUE_LABEL[issue.code] ?? issue.code}
          <span className="jIssueDetail">{issue.detail}</span>
        </span>
        <span className="mono jIssueStep">
          {issue.step === null ? "run" : `step ${issue.step}`}
        </span>
      </button>
      {open && (
        <div className="jIssueBody">
          <p>
            <b>Why it matters. </b>
            {issue.why}
          </p>
          <p>
            <b>Fix. </b>
            {issue.fix}
          </p>
          {issue.url && (
            <p className="mono checkUrls">
              <a href={issue.url} target="_blank" rel="noreferrer noopener">
                {pathOf(issue.url)}
              </a>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function StepRow({ step, host }: { step: JourneyStep; host: string }) {
  const [open, setOpen] = useState(false);
  const detail = Boolean(
    step.reason || step.found || step.evidence || step.error,
  );
  return (
    <li
      className={`jStep ${open ? "open" : ""} ${step.issues.length ? "flagged" : ""}`}
      data-action={step.action}
    >
      <button
        type="button"
        onClick={() => detail && setOpen(!open)}
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
      >
        <span className="mono jStepIndex">
          {String(step.n).padStart(2, "0")}
        </span>
        <span className="jStepAction">
          {step.action === "search" ? (
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={2}
              aria-hidden="true"
            />
          ) : null}
          {step.action}
        </span>
        <span className="jStepBody">
          <span className="jStepWhere">
            {step.action === "fetch" ? (
              <>
                <a
                  href={step.finalUrl || step.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(event) => event.stopPropagation()}
                >
                  {pathOf(step.url)}
                </a>
                {step.finalUrl &&
                  pathOf(step.finalUrl) !== pathOf(step.url) && (
                    <span className="jStepRedirect mono">
                      → {pathOf(step.finalUrl)}
                    </span>
                  )}
              </>
            ) : step.action === "search" ? (
              <i>“{step.query}”</i>
            ) : (
              <b>
                {step.action === "answer"
                  ? "Answered the job"
                  : "Gave up on the job"}
              </b>
            )}
          </span>
          {step.title && <span className="jStepTitle">{step.title}</span>}
        </span>
        <span className="jStepFacts mono">
          {step.status !== null && (
            <span className={step.status >= 400 ? "bad" : ""}>
              {step.status}
            </span>
          )}
          {step.words > 0 && <span>{step.words.toLocaleString("en")}w</span>}
          {step.ms > 0 && <span>{(step.ms / 1000).toFixed(1)}s</span>}
          {step.evidence && <span className="ok">proof</span>}
        </span>
        <span className="jStepFlags">
          {step.issues.map((code) => (
            <span key={code} className="chip bad">
              {ISSUE_LABEL[code] ?? code}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <div className="jStepDetail">
          {step.reason && (
            <p className="jStepReason">
              <b>Why it went here. </b>
              {step.reason}
            </p>
          )}
          {step.error && <p className="errorText">{step.error}</p>}
          {step.found && (
            <p className="jStepFound">
              <b>What it took away. </b>
              {clip(step.found, 900)}
            </p>
          )}
          {step.evidence && (
            <blockquote className="jEvidence">
              <span className="mono">from {host}</span>
              {clip(step.evidence, 400)}
            </blockquote>
          )}
        </div>
      )}
    </li>
  );
}

function JourneySkeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <div className="skeletonMain">
        <span>Loading journey</span>
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

/** Bytes an agent had to pull down, in the unit a reader thinks in. */
function size(bytes: number) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function clip(text: string, limit: number) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
