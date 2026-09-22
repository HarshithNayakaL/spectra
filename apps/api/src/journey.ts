import { randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import {
  classifyFetch,
  customIntent,
  findIntent,
  heuristicMove,
  isAllowed,
  judgeJourney,
  parseRobots,
  proveIntent,
  urlKey,
  type JourneyIntentSpec,
  type Robots,
} from "@spectra/evaluation";
import {
  DeadlineError,
  GeminiProvider,
  GroundingUnavailableError,
  PermanentModelError,
  type AgentProvider,
} from "@spectra/model-gateway";
import {
  SCHEMA_VERSION,
  type Journey,
  type JourneyStep,
  type NavigatorContext,
  type NavigatorMove,
} from "@spectra/schemas";
import { timeBudgetMs } from "./audit";
import { DEFAULT_MODEL } from "./models";
import { fetchPublic } from "./net";
import { AI_AGENTS } from "./scan";
import { saveJourney } from "./store";

/** Pages the agent may open. A real assistant gives up well before this. */
const MAX_FETCHES = 8;
/** Trips to a search engine, allowed only once the site has failed to answer. */
const MAX_SEARCHES = 2;
/** Hard stop on loop turns, so a navigator that dithers still terminates. */
const MAX_TURNS = 14;
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_MAX_BYTES = 600_000;

/** robots.txt user-agent tokens, and how each agent is described on screen. */
const IDENTITY: Record<string, { token: string; label: string }> = {
  "ChatGPT-User": {
    token: "chatgpt-user",
    label: "ChatGPT opening a page for someone",
  },
  PerplexityBot: { token: "perplexitybot", label: "Perplexity" },
  ClaudeBot: { token: "claudebot", label: "Claude" },
  "OAI-SearchBot": { token: "oai-searchbot", label: "ChatGPT Search" },
  GPTBot: { token: "gptbot", label: "OpenAI's crawler" },
};

export type JourneyAgent = {
  name: string;
  label: string;
  token: string;
  ua: string;
};

/** The agents a journey can run as, in the order the picker shows them. */
export const JOURNEY_AGENTS: JourneyAgent[] = Object.keys(IDENTITY).flatMap(
  (name) => {
    const agent = AI_AGENTS.find((candidate) => candidate.name === name);
    return agent ? [{ ...agent, ...IDENTITY[name] }] : [];
  },
);

export const DEFAULT_AGENT = "ChatGPT-User";

export function findAgent(name: string): JourneyAgent | undefined {
  return JOURNEY_AGENTS.find((agent) => agent.name === name);
}

/** Turns a request's intent id and free text into one job specification. */
export function resolveIntent(
  id: string,
  text: string,
): JourneyIntentSpec | null {
  if (id !== "custom") return findIntent(id) ?? null;
  return text.trim().length >= 3 ? customIntent(text) : null;
}

export class JourneyError extends Error {}

/**
 * Called after every move with the whole journey as it stands, so a caller can
 * stream it and the page can be watched rather than waited on.
 */
export type JourneyProgress = (journey: Journey) => void;

/**
 * Points one AI agent at a site with one job and records every move it makes:
 * what it fetched, what came back, where it stalled, whether it finished.
 *
 * The model chooses where to go. It never decides whether the site passed: the
 * verdict comes from the responses, and an answer that no page it read confirms
 * is reported as unverified.
 */
export async function runJourney(
  rawTarget: string,
  intent: JourneyIntentSpec,
  progress: JourneyProgress,
  requestedModel?: string,
  agentName: string = DEFAULT_AGENT,
  options: { provider?: AgentProvider | null; apiKey?: string } = {},
): Promise<Journey> {
  const started = Date.now();
  const deadline = started + timeBudgetMs();
  const timeLeft = () => deadline - Date.now();
  const model = requestedModel || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const agent = findAgent(agentName) ?? JOURNEY_AGENTS[0];
  const start = startUrlOf(rawTarget);
  const host = start.hostname.replace(/^www\./, "");

  const key = options.apiKey ?? process.env.GEMINI_API_KEY;
  const provider =
    options.provider !== undefined
      ? options.provider
      : key
        ? new GeminiProvider(key, model, { deadline })
        : null;

  const journey: Journey = {
    id: randomUUID(),
    version: SCHEMA_VERSION,
    target: start.href,
    host,
    status: "starting",
    stage: `Arriving at ${host} as ${agent.name}`,
    createdAt: new Date().toISOString(),
    completedAt: null,
    durationMs: 0,
    model: provider ? model : "none",
    intent: {
      id: intent.id,
      label: intent.label,
      task: intent.task,
      custom: intent.custom,
    },
    agent: { name: agent.name, userAgent: agent.ua },
    navigator: provider ? "gemini" : "heuristic",
    outcome: null,
    answer: "",
    answerUrl: "",
    verified: false,
    steps: [],
    issues: [],
    metrics: {
      steps: 0,
      fetches: 0,
      searches: 0,
      blocked: 0,
      broken: 0,
      bytes: 0,
      siteMs: 0,
      slowestMs: 0,
      blockers: 0,
      friction: 0,
    },
    warnings: [],
    error: null,
  };
  if (!provider)
    journey.warnings.push(
      "No model is configured, so the route was chosen by SPECTRA's own rule-based walker rather than by an agent. Every response recorded below is still a real one.",
    );

  const publish = async (status: Journey["status"], stage: string) => {
    journey.status = status;
    journey.stage = stage;
    progress(journey);
    await saveJourney(journey).catch(() => {});
  };
  await publish("starting", journey.stage);

  // An agent that honours robots.txt reads it before anything else, so this
  // request belongs to the journey even though it is not one of its steps.
  const robots = await readRobots(start, agent);
  if (robots.status === null)
    journey.warnings.push(
      "robots.txt could not be read, so the agent assumed every path was allowed.",
    );

  let current: PageRead | null = null;
  let fetches = 0;
  let searches = 0;
  let answered = false;
  let exhausted = false;
  const visited = new Set<string>();
  let move: NavigatorMove = {
    action: "fetch",
    url: start.href,
    query: "",
    reason: `Arrive at ${host}: the only URL known before anything has been read.`,
    found: "",
    answer: "",
  };

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (timeLeft() < 8_000) {
      exhausted = true;
      break;
    }
    const n = journey.steps.length + 1;
    const at = Date.now() - started;

    if (move.action === "answer") {
      journey.steps.push({
        ...blank(n, "answer", at),
        url: current?.url ?? "",
        reason: move.reason,
        found: move.answer || move.found,
        evidence: current?.evidence ?? "",
      });
      journey.answer = (move.answer || move.found).trim();
      journey.answerUrl = current?.url ?? "";
      answered = true;
      await publish(
        "reading",
        "The agent answered; checking it against what it read",
      );
      break;
    }
    if (move.action === "giveup") {
      journey.steps.push({
        ...blank(n, "giveup", at),
        reason: move.reason,
        found: move.found,
      });
      await publish("reading", "The agent gave up; reading the trail");
      break;
    }

    if (move.action === "search") {
      const step = await runSearch(move, journey, provider, n, at, host);
      journey.steps.push(step);
      searches += 1;
      if (!step.error)
        current = {
          url: "",
          title: step.title,
          description: "",
          headings: [],
          text: step.found,
          links: [],
          evidence: "",
        };
      await publish(
        "walking",
        `Step ${n}: searched the web for "${step.query}"`,
      );
    } else {
      const { step, read } = await runFetch(
        move,
        intent,
        agent,
        robots.rules,
        visited,
        n,
        at,
      );
      journey.steps.push(step);
      fetches += 1;
      if (read) {
        current = read;
        if (read.evidence) journey.verified = true;
      }
      await publish(
        "walking",
        `Step ${n}: ${shortPath(step.url)} answered ${step.status ?? "nothing"}`,
      );
    }

    // The verdict is recomputed on every step, so a report opened while the
    // journey is still walking reads correctly.
    const interim = judgeJourney({
      steps: journey.steps,
      spec: intent,
      answered,
      verified: journey.verified,
      exhausted,
    });
    journey.outcome = interim.outcome;
    journey.issues = interim.issues;
    journey.metrics = interim.metrics;
    progress(journey);
    await saveJourney(journey).catch(() => {});

    const fetchesLeft = Math.max(0, MAX_FETCHES - fetches);
    const searchesLeft = provider ? Math.max(0, MAX_SEARCHES - searches) : 0;
    if (!fetchesLeft && !searchesLeft) exhausted = true;
    if (turn === MAX_TURNS) {
      exhausted = true;
      break;
    }
    move = await chooseMove({
      intent,
      provider,
      journey,
      current,
      host,
      startUrl: start.href,
      fetchesLeft,
      searchesLeft,
      visited,
      timeLeft,
    });
  }

  const verdict = judgeJourney({
    steps: journey.steps,
    spec: intent,
    answered,
    verified: journey.verified,
    exhausted,
  });
  journey.outcome = verdict.outcome;
  journey.issues = verdict.issues;
  journey.metrics = verdict.metrics;
  journey.completedAt = new Date().toISOString();
  journey.durationMs = Date.now() - started;
  if (!journey.steps.length) {
    journey.status = "failed";
    journey.stage = "The journey could not start";
    journey.error = `Nothing could be read from ${host}.`;
  } else {
    journey.status = "complete";
    journey.stage = STAGE[verdict.outcome];
  }
  await saveJourney(journey);
  return journey;
}

const STAGE: Record<NonNullable<Journey["outcome"]>, string> = {
  completed: "The agent finished the job",
  partial: "The agent answered, but no page confirmed it",
  stalled: "The agent could not finish",
  blocked: "The agent could not read the site",
  failed: "The journey failed",
};

export function startUrlOf(rawTarget: string): URL {
  const raw = rawTarget.trim();
  // A scheme that is not http(s) must be refused rather than prefixed: without
  // this, "ftp://acme.test" becomes https://ftp//acme.test and walks a host the
  // caller never named.
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1]))
    throw new JourneyError("Only HTTP and HTTPS URLs can be walked.");
  try {
    const url = new URL(scheme ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
      throw new Error("unusable");
    if (url.username || url.password)
      throw new JourneyError("Remove the embedded credentials from the URL.");
    return url;
  } catch (error) {
    if (error instanceof JourneyError) throw error;
    throw new JourneyError("Enter a valid public HTTP or HTTPS URL.");
  }
}

/* ============================================================ one move */

type PageRead = {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  links: Array<{ href: string; text: string }>;
  /** Page text that satisfies the intent, when the page carried any. */
  evidence: string;
};

function blank(
  n: number,
  action: JourneyStep["action"],
  at: number,
): JourneyStep {
  return {
    n,
    action,
    url: "",
    query: "",
    reason: "",
    status: null,
    finalUrl: "",
    contentType: "",
    ms: 0,
    bytes: 0,
    words: 0,
    title: "",
    found: "",
    evidence: "",
    issues: [],
    error: "",
    at,
  };
}

async function runFetch(
  move: NavigatorMove,
  intent: JourneyIntentSpec,
  agent: JourneyAgent,
  robots: Robots,
  visited: Set<string>,
  n: number,
  at: number,
): Promise<{ step: JourneyStep; read: PageRead | null }> {
  const step: JourneyStep = {
    ...blank(n, "fetch", at),
    url: move.url,
    reason: move.reason,
  };
  let url: URL;
  try {
    url = new URL(move.url);
  } catch {
    step.error = "The agent asked for a URL that cannot be fetched.";
    step.issues = ["unreachable"];
    return { step, read: null };
  }
  url.hash = "";
  step.url = url.href;
  visited.add(urlKey(url.href));

  if (!isAllowed(robots, url)) {
    // A well-behaved agent stops here, and that refusal is the measurement:
    // the page was never fetched, so nothing on it can reach an answer.
    step.issues = ["robots_blocked"];
    step.found = `robots.txt disallows this path for ${agent.name}, so the page was not fetched.`;
    return { step, read: null };
  }

  try {
    const response = await fetchPublic(url, {
      userAgent: agent.ua,
      maxBytes: FETCH_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const seen = readForAgent(response.url, response.body, contentType);
    visited.add(urlKey(response.url));
    step.status = response.status;
    step.finalUrl = response.url;
    step.contentType = contentType.split(";")[0].trim();
    step.ms = response.ms;
    step.bytes = response.bytes;
    step.words = seen.words;
    step.title = seen.page.title;
    step.issues = classifyFetch({
      url: url.href,
      finalUrl: response.url,
      status: response.status,
      contentType,
      ms: response.ms,
      bytes: response.bytes,
      words: seen.words,
      appShell: seen.appShell,
      robotsBlocked: false,
      challenge: seen.challenge,
      loginWall: seen.loginWall,
      error: "",
    });
    const usable =
      response.status < 400 &&
      seen.readable &&
      seen.words > 0 &&
      !seen.challenge;
    if (!usable) return { step, read: null };
    const read = {
      ...seen.page,
      evidence: proveIntent(intent, `${seen.page.title} ${seen.page.text}`),
    };
    step.evidence = read.evidence;
    return { step, read };
  } catch (error) {
    step.error = messageOf(error);
    step.issues = classifyFetch({
      url: url.href,
      finalUrl: "",
      status: null,
      contentType: "",
      ms: 0,
      bytes: 0,
      words: 0,
      appShell: false,
      robotsBlocked: false,
      challenge: false,
      loginWall: false,
      error: step.error,
    });
    return { step, read: null };
  }
}

async function runSearch(
  move: NavigatorMove,
  journey: Journey,
  provider: AgentProvider | null,
  n: number,
  at: number,
  host: string,
): Promise<JourneyStep> {
  const step: JourneyStep = {
    ...blank(n, "search", at),
    query: move.query.slice(0, 200),
    reason: move.reason,
    issues: ["left_the_site"],
  };
  if (!provider) {
    step.error = "No model is configured, so the agent could not search.";
    return step;
  }
  const began = Date.now();
  try {
    const result = await provider.ask(
      `${step.query}\n\nAnswer from the web, and name the page each fact came from.`,
      true,
    );
    step.ms = Date.now() - began;
    step.words = result.value.answer.split(/\s+/).filter(Boolean).length;
    const domains = [
      ...new Set(result.value.sources.map(sourceDomain).filter(Boolean)),
    ].slice(0, 6);
    step.title = domains.length
      ? `Results from ${domains.join(", ")}`
      : "Results with no cited pages";
    step.found = result.value.answer.slice(0, 2000);
    if (domains.length && !domains.some((domain) => onSite(domain, host)))
      journey.warnings.push(
        `The search for "${step.query}" was answered from ${domains.join(", ")}, not from ${host}.`,
      );
    return step;
  } catch (error) {
    step.ms = Date.now() - began;
    step.error =
      error instanceof GroundingUnavailableError
        ? `Search was unavailable to the agent: ${messageOf(error)}.`
        : messageOf(error);
    return step;
  }
}

function sourceDomain(source: { uri: string; title?: string }) {
  // Grounding chunks carry a redirect URI and the real domain in the title.
  const title = (source.title ?? "").trim().toLowerCase();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(title))
    return title.replace(/^www\./, "");
  try {
    return new URL(source.uri).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function onSite(candidate: string, host: string) {
  const name = candidate.replace(/^www\./, "").toLowerCase();
  return name === host || name.endsWith(`.${host}`);
}

/* ============================================================ the navigator */

async function chooseMove(input: {
  intent: JourneyIntentSpec;
  provider: AgentProvider | null;
  journey: Journey;
  current: PageRead | null;
  host: string;
  startUrl: string;
  fetchesLeft: number;
  searchesLeft: number;
  visited: Set<string>;
  timeLeft: () => number;
}): Promise<NavigatorMove> {
  const { intent, provider, journey, current } = input;
  const context: NavigatorContext = {
    task: intent.task,
    host: input.host,
    startUrl: input.startUrl,
    trail: journey.steps.map((step) => ({
      n: step.n,
      action: step.action,
      url: step.url,
      query: step.query,
      status: step.status,
      title: step.title,
      words: step.words,
      found: step.found,
      issues: step.issues,
      error: step.error,
    })),
    current: current
      ? {
          url: current.url,
          title: current.title,
          description: current.description,
          headings: current.headings,
          text: current.text,
          links: current.links,
        }
      : null,
    fetchesLeft: input.fetchesLeft,
    searchesLeft: input.searchesLeft,
  };
  // The rule-based walker is both the fallback and the floor the model is
  // measured against, so it is always available.
  const fallback = () =>
    clamp(heuristicMove(intent, context), input) ??
    giveup("No move was left that the agent had not already made.");

  if (!provider || input.timeLeft() < 20_000) return fallback();
  try {
    const move = (await provider.navigate(context)).value;
    const clamped = clamp(move, input);
    if (clamped) return clamped;
    journey.warnings.push(
      `The agent asked to ${describe(move)} on step ${journey.steps.length + 1}, which is not a move it can make here, so SPECTRA's own walker chose that step.`,
    );
    return fallback();
  } catch (error) {
    journey.warnings.push(
      error instanceof PermanentModelError || error instanceof DeadlineError
        ? `The model stopped choosing moves (${messageOf(error)}), so the rest of the walk was rule-based.`
        : `One step was chosen by SPECTRA's own walker because the model did not answer (${messageOf(error)}).`,
    );
    return fallback();
  }
}

function describe(move: NavigatorMove) {
  if (move.action === "fetch") return `fetch ${move.url || "nothing"}`;
  if (move.action === "search") return `search for "${move.query}"`;
  return move.action;
}

function giveup(reason: string): NavigatorMove {
  return {
    action: "giveup",
    url: "",
    query: "",
    reason,
    found: "",
    answer: "",
  };
}

/**
 * The only gate between a chosen move and the network. A fetch has to be an
 * absolute URL on the site, unvisited, and inside the remaining budget; a
 * search needs terms and a budget. Anything else is refused, so a hallucinated
 * field cannot become a request.
 */
export function clamp(
  move: NavigatorMove,
  limits: {
    host: string;
    visited: Set<string>;
    fetchesLeft: number;
    searchesLeft: number;
  },
): NavigatorMove | null {
  if (move.action === "answer" || move.action === "giveup") return move;
  if (move.action === "search")
    return limits.searchesLeft > 0 && move.query.trim().length >= 3
      ? { ...move, query: move.query.trim() }
      : null;
  if (limits.fetchesLeft <= 0) return null;
  let url: URL;
  try {
    url = new URL(move.url, `https://${limits.host}/`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (!onSite(url.hostname, limits.host)) return null;
  url.hash = "";
  if (limits.visited.has(urlKey(url.href))) return null;
  return { ...move, url: url.href };
}

/* ============================================================ reading */

async function readRobots(start: URL, agent: JourneyAgent) {
  try {
    const response = await fetchPublic(new URL("/robots.txt", start), {
      userAgent: agent.ua,
      accept: "text/plain,*/*;q=0.1",
      maxBytes: 200_000,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    // A site that serves its homepage for /robots.txt has no rules, not a
    // rule that happens to parse out of HTML.
    const text =
      response.status === 200 && !/^\s*<(!doctype|html)/i.test(response.body)
        ? response.body
        : "";
    return { status: response.status, rules: parseRobots(text, agent.token) };
  } catch {
    return { status: null, rules: parseRobots("", agent.token) };
  }
}

const CHALLENGE =
  /cf-chl|challenge-platform|just a moment\.\.\.|attention required|enable javascript and cookies|captcha|are you a robot/i;
const TEXTUAL = /html|xml|text\/plain|json|markdown|javascript/i;
/** Elements that render on their own line, so their text needs a separator. */
const BLOCKS =
  "address,article,aside,blockquote,button,dd,details,dialog,div,dl,dt," +
  "fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hgroup," +
  "hr,label,legend,li,main,nav,ol,option,p,pre,section,summary,table," +
  "tbody,td,tfoot,th,thead,tr,ul";

/**
 * What the agent actually has after one response: the text that was in the
 * HTML the server sent, the links that were in it, and nothing that needed
 * JavaScript to exist.
 */
export function readForAgent(
  url: string,
  body: string,
  contentType: string,
): {
  page: PageRead;
  words: number;
  /** The response was text an agent can read at all. */
  readable: boolean;
  appShell: boolean;
  challenge: boolean;
  loginWall: boolean;
} {
  const html = /html|xml/i.test(contentType) || /<html[\s>]/i.test(body);
  if (!html) {
    const text = clean(body);
    const words = text ? text.split(" ").length : 0;
    return {
      page: {
        url,
        title: "",
        description: "",
        headings: [],
        text: text.slice(0, 16_000),
        links: [],
        evidence: "",
      },
      words,
      readable: !contentType || TEXTUAL.test(contentType),
      appShell: false,
      challenge: false,
      loginWall: false,
    };
  }

  const $ = cheerio.load(body);
  const title = clean($("title").first().text());
  const description = clean(
    $("meta[name='description']").attr("content") ??
      $("meta[property='og:description']").attr("content") ??
      "",
  );
  const headings: string[] = [];
  $("h1,h2,h3").each((_, element) => {
    const text = clean($(element).text());
    if (text && headings.length < 40) headings.push(text);
  });

  const links: Array<{ href: string; text: string }> = [];
  const seen = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || /^\s*(javascript|mailto|tel|data|#)/i.test(href)) return;
    if (links.length >= 150) return;
    let link: URL;
    try {
      link = new URL(href, url);
    } catch {
      return;
    }
    link.hash = "";
    if (!["http:", "https:"].includes(link.protocol)) return;
    if (seen.has(link.href)) return;
    seen.add(link.href);
    links.push({
      href: link.href,
      text: clean($(element).text()).slice(0, 90),
    });
  });

  const scripts = $("script[src]").length;
  const mount = $(
    "#root, #app, #__next, #__nuxt, [data-reactroot], app-root",
  ).length;
  const password = $("input[type='password']").length > 0;
  $("script,style,noscript,svg,template,iframe").remove();
  // Text nodes are concatenated with nothing between them, so "…in person"
  // followed by a heading becomes "personEnable". A separator after every
  // element that renders on its own line keeps the words apart, which matters
  // twice over: the agent reads this, and the intent's proof is matched
  // against it with word boundaries.
  $("br").replaceWith(" ");
  $(BLOCKS).after(" ");
  const bodyText = clean($("body").text() || $.root().text());
  const words = bodyText ? bodyText.split(" ").length : 0;
  const main = clean($("main").first().text() || $("article").first().text());

  return {
    page: {
      url,
      title,
      description,
      headings,
      text: (main || bodyText).slice(0, 16_000),
      links,
      evidence: "",
    },
    words,
    readable: true,
    appShell: words < 120 && (mount > 0 || scripts >= 3),
    challenge: CHALLENGE.test(body.slice(0, 20_000)) && words < 400,
    loginWall:
      password &&
      words < 500 &&
      /sign\s?in|log\s?in|password/i.test(`${title} ${bodyText.slice(0, 600)}`),
  };
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function shortPath(href: string) {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return href;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof DeadlineError) return "the time limit was reached";
  const text = error instanceof Error ? error.message : String(error);
  return text === "fetch failed" && error instanceof Error && error.cause
    ? messageOf(error.cause)
    : text;
}
