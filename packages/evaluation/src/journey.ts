import type {
  JourneyIssue,
  JourneyIssueCode,
  JourneyMetrics,
  JourneyOutcome,
  JourneyStep,
  NavigatorContext,
  NavigatorMove,
} from "@spectra/schemas";

/**
 * A journey measures whether an agent that arrives with a job can finish it.
 * Everything in this file is deterministic: the same responses always produce
 * the same issues, the same metrics and the same verdict. The model chooses
 * where to go; it never decides whether the site passed.
 */

export type JourneyIntentSpec = {
  id: string;
  label: string;
  /** The sentence handed to the agent. */
  task: string;
  custom: boolean;
  /** Paths and link text that lead toward this job, best first. */
  routes: RegExp[];
  /** Page text that proves the job was done. Null when it cannot be proven. */
  proof: RegExp | null;
  /** What that proof is, for the report. */
  proofLabel: string;
};

const PRICE =
  /(?:[$€£¥₹]\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|EUR|GBP|INR)\b|\bfree\s+(?:plan|tier|forever)\b|\bper\s+(?:month|year|seat|user|device)\b|\/\s?(?:mo|month|yr|year|seat|user)\b|\bstarting\s+at\b|\bcontact\s+(?:us|sales)\s+for\s+pricing\b)/i;
const CONTACT =
  /(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\btalk\s+to\s+sales\b|\bbook\s+a\s+(?:demo|call|meeting)\b|\bcontact\s+form\b|\bsupport@|\bhello@|\bsales@)/i;
const DOCS =
  /(?:\bAPI\s+(?:key|reference|token|endpoint|docs?)\b|\bAuthorization:\s|\bBearer\s+(?:token|<)|\bcurl\s+-|https?:\/\/api\.|\bbase\s+URL\b|\bnpm\s+install\b|\bpip\s+install\b|\bSDK\b)/i;
const SIGNUP =
  /(?:\bsign\s?up\b|\bcreate\s+(?:an?\s+)?account\b|\bstart\s+(?:your\s+)?(?:free\s+)?trial\b|\bget\s+started\s+free\b|\badd\s+to\s+(?:cart|basket)\b|\bcheckout\b|\bbuy\s+now\b|\brequest\s+access\b)/i;
const POLICY =
  /(?:\brefund\b|\breturns?\s+(?:policy|within)\b|\bcancel(?:lation)?\s+(?:policy|any\s?time)\b|\bmoney[-\s]?back\b|\b\d+[-\s]?day\s+(?:refund|return|trial|guarantee)\b|\bSLA\b|\buptime\s+guarantee\b)/i;
const WHAT =
  /(?:\bwe\s+(?:are|help|build|make|provide|offer)\b|\bour\s+(?:platform|product|mission|customers?)\b|\bfor\s+(?:teams|developers|businesses|enterprises|agencies)\b|\btrusted\s+by\b|\bfounded\s+in\b)/i;

/** The jobs on offer, in the order they are shown. */
export const JOURNEY_INTENTS: JourneyIntentSpec[] = [
  {
    id: "pricing",
    label: "Find the price",
    task: "Find out what this costs. Report the actual numbers, plan names and billing periods, or the exact reason no price is published.",
    custom: false,
    routes: [
      /\/(pricing|plans?|prices?|packages?|cost|subscriptions?)\b/i,
      /\b(pricing|plans|price|cost|how much)\b/i,
      /\/(products?|features?|store|shop|buy)\b/i,
    ],
    proof: PRICE,
    proofLabel: "a price, plan rate or a stated reason pricing is not public",
  },
  {
    id: "contact",
    label: "Reach a human",
    task: "Find how a customer reaches a person here. Report the email address, phone number, form or sales route you would actually use.",
    custom: false,
    routes: [
      /\/(contact|contact-us|get-in-touch|support|help|sales|demo|book)\b/i,
      /\b(contact|support|talk to|get in touch|sales|help)\b/i,
      /\/(about|company|team|locations?)\b/i,
    ],
    proof: CONTACT,
    proofLabel: "an email address, phone number or booking route",
  },
  {
    id: "what",
    label: "Work out what they do",
    task: "Work out what this company sells, who it sells to, and what it claims makes it different. Report it in three sentences.",
    custom: false,
    routes: [
      /\/(about|about-us|company|who-we-are|our-story|mission)\b/i,
      /\/(products?|services?|solutions?|platform|features?)\b/i,
      /\b(about|what we do|products|platform|solutions)\b/i,
    ],
    proof: WHAT,
    proofLabel: "a first-person description of the business",
  },
  {
    id: "docs",
    label: "Find the API docs",
    task: "Find the developer documentation. Report the API base URL and how a request is authenticated, or say plainly that there is no public API.",
    custom: false,
    routes: [
      /\/(docs?|documentation|developers?|api|reference|guides?)\b/i,
      /\b(docs|documentation|developers|api|reference)\b/i,
      /\/(resources|support|help)\b/i,
    ],
    proof: DOCS,
    proofLabel: "an endpoint, install line or authentication header",
  },
  {
    id: "signup",
    label: "Start a trial or buy",
    task: "Work out how a customer starts using this: trial, sign-up or purchase. Report the exact steps and where they begin.",
    custom: false,
    routes: [
      /\/(signup|sign-up|register|start|trial|get-started|checkout|cart|order|buy)\b/i,
      /\b(sign up|get started|start free|try|buy|order|subscribe)\b/i,
      /\/(pricing|plans?|products?)\b/i,
    ],
    proof: SIGNUP,
    proofLabel: "a sign-up, trial or checkout route",
  },
  {
    id: "policy",
    label: "Check the refund policy",
    task: "Find the refund, returns, cancellation or service-level policy. Report the window, the conditions and anything excluded.",
    custom: false,
    routes: [
      /\/(refund|returns?|cancel|cancellation|policy|policies|terms|sla|guarantee|warranty)\b/i,
      /\b(refund|return|cancel|policy|terms|sla|guarantee)\b/i,
      /\/(support|help|faq|legal)\b/i,
    ],
    proof: POLICY,
    proofLabel: "a stated refund, return, cancellation or SLA term",
  },
];

export function findIntent(id: string): JourneyIntentSpec | undefined {
  return JOURNEY_INTENTS.find((intent) => intent.id === id);
}

/**
 * A typed-in job. There is no pattern that can prove an arbitrary sentence was
 * satisfied, so a custom journey reports the agent's own claim and says so.
 */
export function customIntent(text: string): JourneyIntentSpec {
  const task = text.trim();
  const words = [...task.toLowerCase().matchAll(/[a-z][a-z0-9-]{3,}/g)]
    .map((match) => match[0])
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, 6);
  return {
    id: "custom",
    label: task.length > 48 ? `${task.slice(0, 47)}…` : task,
    task,
    custom: true,
    routes: words.length
      ? [new RegExp(`\\b(${words.map(escapeRegExp).join("|")})`, "i")]
      : [],
    proof: null,
    proofLabel: "",
  };
}

const STOPWORDS = new Set([
  "find",
  "what",
  "where",
  "when",
  "which",
  "does",
  "their",
  "they",
  "this",
  "that",
  "with",
  "from",
  "about",
  "into",
  "your",
  "have",
  "much",
  "many",
  "page",
  "site",
  "website",
  "company",
  "there",
  "would",
  "should",
  "could",
  "tell",
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Looks for the intent's proof in page text and returns the sentence that
 * carries it. An empty string means the page did not prove anything, whatever
 * the agent went on to claim.
 */
export function proveIntent(spec: JourneyIntentSpec, text: string): string {
  if (!spec.proof || !text) return "";
  const match = spec.proof.exec(text);
  if (!match) return "";
  const start = Math.max(0, match.index - 90);
  const end = Math.min(text.length, match.index + match[0].length + 90);
  const window = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${window}${end < text.length ? "…" : ""}`;
}

/* ============================================================ the walker */

export type FetchOutcome = {
  url: string;
  finalUrl: string;
  status: number | null;
  contentType: string;
  ms: number;
  bytes: number;
  words: number;
  /** Raw HTML carried a mount point and no text: nothing without JavaScript. */
  appShell: boolean;
  /** robots.txt told this agent not to read the URL. */
  robotsBlocked: boolean;
  /** The response looked like a bot challenge rather than the page. */
  challenge: boolean;
  /** The page is a sign-in wall. */
  loginWall: boolean;
  error: string;
};

/** How slow a response has to be before an agent's budget notices. */
export const SLOW_MS = 2500;
/** Below this, a 200 carries too little text to answer anything. */
export const THIN_WORDS = 120;

export function classifyFetch(result: FetchOutcome): JourneyIssueCode[] {
  const codes: JourneyIssueCode[] = [];
  if (result.robotsBlocked) codes.push("robots_blocked");
  if (result.error) {
    codes.push("unreachable");
    return codes;
  }
  const status = result.status ?? 0;
  if (result.challenge) codes.push("firewall_blocked");
  else if (status === 401 || status === 407 || result.loginWall)
    codes.push("auth_wall");
  else if (status === 403 || status === 429) codes.push("firewall_blocked");
  else if (status === 404 || status === 410) codes.push("not_found");
  else if (status >= 500) codes.push("server_error");
  const html = /html|xml|text\/plain|json|markdown/i.test(result.contentType);
  if (status >= 200 && status < 300) {
    if (!result.contentType || html) {
      if (result.appShell) codes.push("javascript_only");
      else if (result.words < THIN_WORDS) codes.push("thin_content");
    } else codes.push("wrong_content_type");
  }
  if (result.ms > SLOW_MS) codes.push("slow_response");
  if (result.finalUrl && !samePlace(result.url, result.finalUrl))
    codes.push("redirected");
  return [...new Set(codes)];
}

/**
 * One URL, one key. Identity ignores the scheme, "www." and a trailing slash,
 * so the same page reached two ways is never read twice. The runner uses this
 * too, so the walker and the fetcher agree on what "already visited" means.
 */
export function urlKey(href: string): string {
  try {
    const url = new URL(href);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
  } catch {
    return href;
  }
}

/** True when two URLs are the same page reached over the same scheme. */
function samePlace(a: string, b: string) {
  if (urlKey(a) !== urlKey(b)) return false;
  try {
    return new URL(a).protocol === new URL(b).protocol;
  } catch {
    return a === b;
  }
}

/* ============================================================ the verdict */

const SEVERITY: Record<JourneyIssueCode, JourneyIssue["severity"]> = {
  robots_blocked: "blocker",
  firewall_blocked: "blocker",
  auth_wall: "blocker",
  not_found: "friction",
  server_error: "blocker",
  unreachable: "blocker",
  javascript_only: "blocker",
  thin_content: "friction",
  slow_response: "friction",
  wrong_content_type: "friction",
  redirected: "note",
  left_the_site: "friction",
  no_route: "blocker",
  unverified_answer: "note",
  budget_exhausted: "friction",
};

const COPY: Record<JourneyIssueCode, { why: string; fix: string }> = {
  robots_blocked: {
    why: "robots.txt tells this agent not to read the URL, so it never sees the page even though a browser can.",
    fix: "Allow the agent's user-agent token for this path in robots.txt, or move the content to a path that is already allowed.",
  },
  firewall_blocked: {
    why: "The edge answered the agent instead of the page. Bot protection that fires on a known AI user-agent removes the site from the answer, not just from the crawl.",
    fix: "Allow-list the published AI agent user-agents and their IP ranges at the CDN or WAF, and serve them the same HTML a browser gets.",
  },
  auth_wall: {
    why: "The information sits behind a sign-in, so no agent acting for a prospect can read it.",
    fix: "Publish the part a buyer needs to decide on a public URL and keep the account-only detail behind the wall.",
  },
  not_found: {
    why: "The route the agent took does not exist. Agents guess conventional paths and follow stale links, and a 404 costs a step from a small budget.",
    fix: "Serve the expected path or a 301 to the page that replaced it, and keep internal links current.",
  },
  server_error: {
    why: "The server failed on a URL the agent needed. An error is indistinguishable from an absent page.",
    fix: "Fix the error, and make sure the error response carries a correct status code rather than a 200.",
  },
  unreachable: {
    why: "The request did not complete: no response inside the agent's timeout, or the connection was refused.",
    fix: "Check DNS, TLS and edge availability for non-browser clients, and keep time-to-first-byte inside a few seconds.",
  },
  javascript_only: {
    why: "The HTML the server sent carried a mount point and almost no text. Agents read the raw response and do not run JavaScript, so this page is blank to them.",
    fix: "Server-render or pre-render the content, or add it to the initial HTML. A static fallback inside the shell is enough.",
  },
  thin_content: {
    why: "The page answered with too little text to act on, so the agent has to spend another step guessing where the real content is.",
    fix: "Put the substance in the HTML of the page that owns the topic rather than splitting it across tabs, accordions or a later request.",
  },
  slow_response: {
    why: "The response was slow enough to eat the agent's time budget. Agents abandon a task rather than wait.",
    fix: "Cache the HTML at the edge and keep server response time under about a second for non-browser clients.",
  },
  wrong_content_type: {
    why: "The URL returned something the agent cannot read as text, so the step produced nothing.",
    fix: "Serve HTML, Markdown, plain text or JSON on routes a reader is expected to follow, with a matching content-type header.",
  },
  redirected: {
    why: "The URL redirected before answering. It works, but every hop costs the agent latency and can drop query parameters.",
    fix: "Link the final URL directly and keep redirect chains to one hop.",
  },
  left_the_site: {
    why: "The site offered no route, so the agent went to a search engine. Whatever it finds there is somebody else's page: a directory, a review site or a competitor, and possibly out of date.",
    fix: "Put the answer on your own site and link it from the navigation, so the agent never has to leave to find it.",
  },
  no_route: {
    why: "Nothing on the pages the agent could read pointed toward the job. There was no link, no heading and no conventional path to follow.",
    fix: "Link the page that answers this from the homepage navigation, name it in plain words, and list it in the sitemap and llms.txt.",
  },
  unverified_answer: {
    why: "The agent reported an answer, but no page it read contained text that confirms it. The answer came from the model, not from the site.",
    fix: "State the fact in words on the page, in the HTML, so the answer can be read rather than inferred.",
  },
  budget_exhausted: {
    why: "The agent ran out of steps before it finished. A real assistant gives up sooner than this one did.",
    fix: "Shorten the path: the answer to a common job should be reachable in two or three hops from the homepage.",
  },
};

export type JourneyVerdictInput = {
  steps: JourneyStep[];
  spec: JourneyIntentSpec;
  /** True when the agent produced an answer rather than giving up. */
  answered: boolean;
  /** True when a page the agent read carried the intent's proof. */
  verified: boolean;
  /** True when the run stopped because it hit the step or time budget. */
  exhausted: boolean;
};

/**
 * One journey in, one verdict out. The outcome is decided by what the steps
 * show, never by the agent's own confidence: an answer no page confirms is
 * partial, not complete.
 */
export function judgeJourney(input: JourneyVerdictInput): {
  outcome: JourneyOutcome;
  issues: JourneyIssue[];
  metrics: JourneyMetrics;
} {
  const { steps, spec, answered, verified, exhausted } = input;
  const issues: JourneyIssue[] = [];
  const seen = new Set<string>();
  const push = (issue: JourneyIssue) => {
    // One row per code and URL: ten slow pages are one finding, not ten.
    const key = `${issue.code}|${issue.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const step of steps)
    for (const code of step.issues)
      push({
        code,
        severity: SEVERITY[code],
        step: step.n,
        url: step.finalUrl || step.url,
        detail: detailOf(code, step),
        why: COPY[code].why,
        fix: COPY[code].fix,
      });

  const fetches = steps.filter((step) => step.action === "fetch");
  const readable = fetches.filter(
    (step) =>
      step.status !== null &&
      step.status < 400 &&
      !step.issues.includes("javascript_only") &&
      step.words >= THIN_WORDS,
  );
  const gaveUp = steps.some((step) => step.action === "giveup");

  // A site that never returned a readable page is blocked, not routeless: the
  // agent had nothing to find a route in.
  if (gaveUp && !answered && readable.length)
    push({
      code: "no_route",
      severity: SEVERITY.no_route,
      step: steps.at(-1)?.n ?? null,
      url: "",
      detail: `The agent read ${readable.length} usable ${readable.length === 1 ? "page" : "pages"} and found no route toward "${spec.label.toLowerCase()}", so it stopped.`,
      why: COPY.no_route.why,
      fix: COPY.no_route.fix,
    });
  if (exhausted && !answered)
    push({
      code: "budget_exhausted",
      severity: SEVERITY.budget_exhausted,
      step: null,
      url: "",
      detail: `The agent spent all ${fetches.length} of the page ${fetches.length === 1 ? "fetch" : "fetches"} it had and still did not finish.`,
      why: COPY.budget_exhausted.why,
      fix: COPY.budget_exhausted.fix,
    });
  if (answered && !verified && !spec.custom)
    push({
      code: "unverified_answer",
      severity: SEVERITY.unverified_answer,
      step: steps.find((step) => step.action === "answer")?.n ?? null,
      url: "",
      detail: `No page the agent read contained ${spec.proofLabel}, so the answer could not be confirmed against the site.`,
      why: COPY.unverified_answer.why,
      fix: COPY.unverified_answer.fix,
    });

  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const friction = issues.filter((issue) => issue.severity === "friction");
  const outcome: JourneyOutcome = !readable.length
    ? "blocked"
    : answered && (verified || spec.custom)
      ? "completed"
      : answered
        ? "partial"
        : "stalled";

  // Blockers first, then friction, then notes; earliest step first inside each.
  const order = { blocker: 0, friction: 1, note: 2 } as const;
  issues.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (a.step ?? 99) - (b.step ?? 99) ||
      a.code.localeCompare(b.code),
  );

  return {
    outcome,
    issues,
    metrics: {
      steps: steps.length,
      fetches: fetches.length,
      searches: steps.filter((step) => step.action === "search").length,
      blocked: fetches.filter((step) =>
        step.issues.some((code) =>
          ["robots_blocked", "firewall_blocked", "auth_wall"].includes(code),
        ),
      ).length,
      broken: fetches.filter((step) =>
        step.issues.some((code) =>
          ["not_found", "server_error", "unreachable"].includes(code),
        ),
      ).length,
      bytes: fetches.reduce((total, step) => total + step.bytes, 0),
      siteMs: fetches.reduce((total, step) => total + step.ms, 0),
      slowestMs: fetches.reduce((most, step) => Math.max(most, step.ms), 0),
      blockers: blockers.length,
      friction: friction.length,
    },
  };
}

function detailOf(code: JourneyIssueCode, step: JourneyStep): string {
  const where = step.finalUrl || step.url || "the request";
  switch (code) {
    case "robots_blocked":
      return `robots.txt disallows ${path(where)} for this agent.`;
    case "firewall_blocked":
      return `${path(where)} answered ${step.status ?? "nothing"}: a block, not the page.`;
    case "auth_wall":
      return `${path(where)} answered ${step.status ?? 200} and asked the agent to sign in.`;
    case "not_found":
      return `${path(where)} answered ${step.status}.`;
    case "server_error":
      return `${path(where)} answered ${step.status}.`;
    case "unreachable":
      return `${path(where)} did not respond: ${step.error || "no response"}.`;
    case "javascript_only":
      return `${path(where)} returned ${step.words} ${step.words === 1 ? "word" : "words"} of text in its HTML; the content needs JavaScript.`;
    case "thin_content":
      return `${path(where)} returned only ${step.words} ${step.words === 1 ? "word" : "words"} of text.`;
    case "slow_response":
      return `${path(where)} took ${(step.ms / 1000).toFixed(1)}s to answer.`;
    case "wrong_content_type":
      return `${path(where)} returned ${step.contentType || "an unreadable type"}.`;
    case "redirected":
      return `${path(step.url)} redirected to ${path(step.finalUrl)}.`;
    case "left_the_site":
      return `The agent left the site and searched the web for "${step.query}".`;
    default:
      return `${path(where)}.`;
  }
}

function path(href: string) {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return href;
  }
}

/* ============================================================ fallback walk */

/**
 * The navigator used when no model is configured, and the floor the model is
 * measured against. It scores the links on the page against the intent's own
 * route patterns and takes the best unvisited one, exactly as a rule-based
 * crawler would.
 */
export function heuristicMove(
  spec: JourneyIntentSpec,
  context: NavigatorContext,
): NavigatorMove {
  const page = context.current;
  if (!page)
    return {
      action: "fetch",
      url: context.startUrl,
      query: "",
      reason: "Start at the homepage, the only URL known in advance.",
      found: "",
      answer: "",
    };

  const proof = proveIntent(spec, `${page.title} ${page.text}`);
  if (proof)
    return {
      action: "answer",
      url: "",
      query: "",
      reason: `${page.url} carries ${spec.proofLabel}.`,
      found: proof,
      answer: proof,
    };

  const visited = new Set(
    context.trail
      .filter((step) => step.action === "fetch")
      .map((step) => urlKey(step.url)),
  );
  const best = rankRoutes(spec, page.links, visited, context.host)[0];
  if (best && context.fetchesLeft > 0)
    return {
      action: "fetch",
      url: best.href,
      query: "",
      reason: `"${best.text || path(best.href)}" is the closest link to the job on this page.`,
      found: page.title ? `Read ${page.title}.` : "",
      answer: "",
    };
  return {
    action: "giveup",
    url: "",
    query: "",
    reason: "No link on the pages read so far leads toward the job.",
    found: "",
    answer: "",
  };
}

/** Links that lead toward the intent, best first. Exported for the tests. */
export function rankRoutes(
  spec: JourneyIntentSpec,
  links: Array<{ href: string; text: string }>,
  visited: Set<string>,
  host?: string,
): Array<{ href: string; text: string; score: number }> {
  const scored: Array<{ href: string; text: string; score: number }> = [];
  const seen = new Set<string>();
  for (const link of links) {
    const key = urlKey(link.href);
    if (visited.has(key) || seen.has(key)) continue;
    seen.add(key);
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    // A journey stays on the site it was pointed at. A link that leaves is a
    // finding for the report, never the agent's next step.
    if (host) {
      const name = url.hostname.replace(/^www\./, "").toLowerCase();
      if (name !== host && !name.endsWith(`.${host}`)) continue;
    }
    const subject = `${url.pathname} ${link.text}`;
    // Earlier patterns are stronger: the first is the page that owns the job,
    // the last is a place it is often filed under.
    const rank = spec.routes.findIndex((route) => route.test(subject));
    if (rank < 0) continue;
    const depth = url.pathname.split("/").filter(Boolean).length;
    scored.push({
      href: link.href,
      text: link.text,
      score: (spec.routes.length - rank) * 10 - depth,
    });
  }
  return scored.sort(
    (a, b) => b.score - a.score || a.href.localeCompare(b.href),
  );
}
