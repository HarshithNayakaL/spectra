import type {
  Check,
  CheckStatus,
  Fix,
  Layer,
  LayerId,
  PageSignals,
  Readiness,
  Scan,
} from "@spectra/schemas";
import { isAllowed, parseRobots } from "./robots";
import { buildLlmsTxt, type Identity } from "./site";

export const LAYERS: Record<LayerId, { label: string; question: string }> = {
  access: {
    label: "Crawler access",
    question: "Can AI crawlers reach your pages?",
  },
  content: {
    label: "Readable content",
    question: "Can they read your pages without running JavaScript?",
  },
  entity: {
    label: "Entity clarity",
    question: "Do they know exactly who you are and what you sell?",
  },
  agent: {
    label: "AI-ready files",
    question: "Have you written anything specifically for AI?",
  },
};

/** Crawlers that fetch pages to answer a user's question right now. */
export const SEARCH_BOTS = [
  { token: "OAI-SearchBot", engine: "ChatGPT search" },
  { token: "ChatGPT-User", engine: "ChatGPT browsing" },
  { token: "PerplexityBot", engine: "Perplexity" },
  { token: "Perplexity-User", engine: "Perplexity" },
  { token: "Claude-SearchBot", engine: "Claude search" },
  { token: "Claude-User", engine: "Claude browsing" },
  { token: "Googlebot", engine: "Google AI Overviews and AI Mode" },
  { token: "Bingbot", engine: "Copilot and ChatGPT (Bing index)" },
];
/** Crawlers that collect training data. Blocking them is a legitimate choice. */
export const TRAINING_BOTS = [
  { token: "GPTBot", engine: "OpenAI training" },
  { token: "ClaudeBot", engine: "Anthropic training" },
  { token: "Google-Extended", engine: "Gemini training and grounding" },
  { token: "Applebot-Extended", engine: "Apple Intelligence" },
  { token: "CCBot", engine: "Common Crawl (used by most models)" },
  { token: "meta-externalagent", engine: "Meta AI" },
];

type Draft = Omit<Check, "earned" | "fix" | "urls"> & {
  fix?: (Omit<Fix, "steps"> & { steps?: string[] }) | null;
  urls?: string[];
};

export function evaluateReadiness(scan: Scan, identity: Identity): Readiness {
  const pages = scan.pages;
  const home = pages[0];
  const drafts: Draft[] = [
    ...accessChecks(scan, identity),
    ...contentChecks(scan, pages, home),
    ...entityChecks(scan, pages, home, identity),
    ...agentChecks(scan, pages, identity),
  ];
  const checks: Check[] = drafts.map((draft) => ({
    ...draft,
    urls: draft.urls ?? [],
    fix:
      draft.status === "pass" || draft.status === "na" || !draft.fix
        ? null
        : { ...draft.fix, steps: draft.fix.steps ?? [] },
    earned: earnedFor(draft.status, draft.weight),
  }));
  const layers: Layer[] = (Object.keys(LAYERS) as LayerId[]).map((id) => {
    const applied = checks.filter((c) => c.layer === id && c.status !== "na");
    const possible = sum(applied.map((c) => c.weight));
    const earned = sum(applied.map((c) => c.earned));
    return {
      id,
      ...LAYERS[id],
      earned: round(earned),
      possible: round(possible),
      score: possible ? Math.round((earned / possible) * 100) : null,
    };
  });
  const possible = sum(layers.map((l) => l.possible));
  const score = possible
    ? Math.round((sum(layers.map((l) => l.earned)) / possible) * 100)
    : 0;
  return { score, grade: gradeOf(score), layers, checks };
}

export function earnedFor(status: CheckStatus, weight: number) {
  return status === "pass" ? weight : status === "warn" ? weight / 2 : 0;
}

export function gradeOf(score: number): Readiness["grade"] {
  return score >= 90
    ? "A"
    : score >= 80
      ? "B"
      : score >= 70
        ? "C"
        : score >= 55
          ? "D"
          : "F";
}

/* ------------------------------------------------------------------ access */

function accessChecks(scan: Scan, identity: Identity): Draft[] {
  const robotsText = scan.robots.status === 200 ? scan.robots.body : "";
  const root = new URL(scan.finalUrl);
  const blocked = (token: string) =>
    !isAllowed(parseRobots(robotsText, token), new URL("/", root));
  const searchBlocked = SEARCH_BOTS.filter((bot) => blocked(bot.token));
  const trainingBlocked = TRAINING_BOTS.filter((bot) => blocked(bot.token));
  const criticalSearch = searchBlocked.filter((bot) =>
    ["OAI-SearchBot", "PerplexityBot", "Googlebot", "Bingbot"].includes(
      bot.token,
    ),
  );
  const robotsUrl = `${root.origin}/robots.txt`;

  const browser = scan.bots.find((b) => b.agent === "Browser");
  const aiProbes = scan.bots.filter((b) => b.agent !== "Browser");
  const firewalled = aiProbes.filter((b) => b.blocked);
  const inconclusive = aiProbes.filter((b) => !b.blocked && b.status === null);
  const everyoneBlocked =
    browser?.blocked && firewalled.length === aiProbes.length;

  const noindexPages = scan.pages.filter((p) =>
    /noindex/i.test(`${p.metaRobots} ${p.xRobotsTag}`),
  );
  const homeNoindex = noindexPages.some((p) => p === scan.pages[0]);

  const sitemapOk = scan.sitemap.status === 200 && scan.sitemap.urls > 0;

  return [
    {
      id: "search-crawlers",
      layer: "access",
      label: "AI search crawlers are allowed",
      weight: 10,
      status: criticalSearch.length
        ? "fail"
        : searchBlocked.length
          ? "warn"
          : "pass",
      found: searchBlocked.length
        ? `robots.txt blocks ${searchBlocked.map((b) => `${b.token} (${b.engine})`).join(", ")}.`
        : scan.robots.status === 200
          ? `robots.txt allows all ${SEARCH_BOTS.length} answer-engine crawlers we check, including OAI-SearchBot, PerplexityBot, Claude-SearchBot and Googlebot.`
          : "No robots.txt, so every crawler is allowed by default.",
      why: "These crawlers fetch pages at the moment someone asks a question. A blocked one cannot quote or cite you, no matter how good the page is.",
      urls: [robotsUrl],
      fix: {
        summary: `Allow ${searchBlocked.map((b) => b.token).join(", ")} in robots.txt.`,
        steps: [
          "Open robots.txt at the root of the site.",
          "Add the groups below above any broader Disallow rules. A crawler follows the most specific group that names it.",
          "Deploy, then fetch /robots.txt to confirm the live file changed.",
        ],
        file: "robots.txt",
        language: "text",
        code: searchBlocked
          .map((b) => `User-agent: ${b.token}\nAllow: /`)
          .join("\n\n"),
      },
    },
    {
      id: "training-crawlers",
      layer: "access",
      label: "Training crawlers",
      weight: 3,
      status:
        trainingBlocked.length === 0
          ? "pass"
          : trainingBlocked.length >= 3
            ? "fail"
            : "warn",
      found: trainingBlocked.length
        ? `robots.txt blocks ${trainingBlocked.map((b) => `${b.token} (${b.engine})`).join(", ")}.`
        : "Training crawlers are allowed, so current facts about you can enter future models.",
      why: "Models answer from what they were trained on whenever they do not search. Blocking training keeps you out of those answers. It is a legitimate business choice, so this is weighted lightly.",
      urls: [robotsUrl],
      fix: {
        summary:
          "Decide deliberately. If you want models to know you, allow the training crawlers.",
        steps: [
          "Confirm with legal or leadership that training use is acceptable.",
          "Replace the blocking groups with the rules below.",
        ],
        file: "robots.txt",
        language: "text",
        code: trainingBlocked
          .map((b) => `User-agent: ${b.token}\nAllow: /`)
          .join("\n\n"),
      },
    },
    {
      id: "firewall",
      layer: "access",
      label: "Firewall lets AI crawlers in",
      weight: 10,
      status: !aiProbes.length
        ? "na"
        : firewalled.length
          ? "fail"
          : inconclusive.length
            ? "warn"
            : "pass",
      found: !firewalled.length
        ? inconclusive.length
          ? `${inconclusive.map((b) => b.agent).join(", ")} timed out after 10s while the other crawler signatures got a page. Not a confirmed block, but answer-time fetchers give up at similar limits.`
          : `Requested the homepage as ${aiProbes.map((b) => b.agent).join(", ")}: every one got a normal page.`
        : everyoneBlocked
          ? `Every automated request was refused, including a normal browser signature (${firewalled.map((b) => `${b.agent}: ${b.note}`).join("; ")}).`
          : `Browser got ${browser?.status ?? "a response"}, but ${firewalled.map((b) => `${b.agent} ${b.note}`).join(", ")}.`,
      why: "A CDN or bot-protection rule that refuses AI user agents overrides robots.txt entirely. This is the most common reason a site that allows crawlers is still invisible.",
      urls: [scan.finalUrl],
      fix: {
        summary:
          "Allow verified AI crawlers through your CDN or bot protection.",
        steps: [
          "Cloudflare: Security > Bots. Turn off 'Block AI bots' and, under AI Crawl Control, set the search crawlers (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot) to Allow.",
          "Other WAFs (Akamai, Vercel Firewall, Sucuri, Wordfence): add an allow rule for the user agents below, ideally combined with the vendors' published IP ranges.",
          `Verify: curl -A "OAI-SearchBot/1.0" -I ${scan.finalUrl} should return 200.`,
        ],
        language: "text",
        code: firewalled.map((b) => b.agent).join("\n"),
      },
    },
    {
      id: "robots-file",
      layer: "access",
      label: "robots.txt responds",
      weight: 2,
      status:
        scan.robots.status === 200
          ? "pass"
          : scan.robots.status === 404
            ? "warn"
            : "fail",
      found:
        scan.robots.status === 200
          ? `robots.txt returned 200 (${scan.robots.bytes} bytes).`
          : scan.robots.status === 404
            ? "No robots.txt (404). Crawlers assume everything is allowed, but you lose the place to point them at your sitemap."
            : `robots.txt ${scan.robots.status === null ? "did not respond" : `returned ${scan.robots.status}`}. Google treats a failing robots.txt as 'disallow everything' until it recovers.`,
      why: "robots.txt is the first file every crawler requests.",
      urls: [robotsUrl],
      fix: {
        summary: "Serve a robots.txt that returns 200.",
        file: "robots.txt",
        language: "text",
        code: `User-agent: *\nAllow: /\n\nSitemap: ${root.origin}/sitemap.xml`,
        steps: [
          "Place this file at the site root so it is served at /robots.txt.",
        ],
      },
    },
    {
      id: "sitemap",
      layer: "access",
      label: "XML sitemap",
      weight: 4,
      status: sitemapOk ? (scan.sitemap.referenced ? "pass" : "warn") : "fail",
      found: sitemapOk
        ? `${scan.sitemap.url} lists ${scan.sitemap.urls} URLs${scan.sitemap.referenced ? " and robots.txt points to it" : ", but robots.txt does not reference it"}.`
        : scan.sitemap.status === 422
          ? `${scan.sitemap.url} exists but is not a valid XML sitemap.`
          : "No sitemap at /sitemap.xml and none declared in robots.txt.",
      why: "The sitemap is how crawlers find pages that are not linked from your homepage, and how they learn a page changed.",
      urls: [scan.sitemap.url],
      fix: sitemapOk
        ? {
            summary: "Reference the sitemap from robots.txt.",
            file: "robots.txt",
            language: "text",
            code: `Sitemap: ${scan.sitemap.url}`,
            steps: ["Add this line anywhere in robots.txt."],
          }
        : {
            summary: "Publish /sitemap.xml and reference it from robots.txt.",
            file: "sitemap.xml",
            language: "xml",
            steps: [
              "Most frameworks and CMSs generate this: WordPress (Yoast or core), Next.js (app/sitemap.ts), Shopify and Webflow (built in).",
              "Include every indexable page with a <lastmod> date.",
              `Add "Sitemap: ${root.origin}/sitemap.xml" to robots.txt.`,
            ],
            code: sitemapXml(scan),
          },
    },
    {
      id: "indexable",
      layer: "access",
      label: "Pages are indexable",
      weight: 4,
      status: homeNoindex ? "fail" : noindexPages.length ? "warn" : "pass",
      found: noindexPages.length
        ? `${noindexPages.length} of ${scan.pages.length} pages carry noindex: ${noindexPages.map((p) => pathOf(p.url)).join(", ")}.`
        : `None of the ${scan.pages.length} pages scanned carry a noindex directive.`,
      why: "Search-grounded answers (Google AI Mode, Copilot, ChatGPT search) only draw on indexed pages. noindex removes a page from all of them.",
      urls: noindexPages.map((p) => p.url),
      fix: {
        summary: "Remove noindex from pages you want AI answers to use.",
        steps: [
          'Delete <meta name="robots" content="noindex"> from these pages, or remove the X-Robots-Tag: noindex header in your server or CDN config.',
          "Keep noindex only on thin or private pages such as thank-you and account pages.",
        ],
      },
    },
    {
      id: "https",
      layer: "access",
      label: "HTTPS",
      weight: 2,
      status: scan.https ? "pass" : "fail",
      found: scan.https
        ? `Served over HTTPS at ${scan.finalUrl}.`
        : `The site is served over plain HTTP (${scan.finalUrl}).`,
      why: "Answer engines and browsers down-rank or warn on insecure pages.",
      urls: [scan.finalUrl],
      fix: {
        summary: "Serve the site over HTTPS and redirect HTTP to it.",
        steps: [
          "Issue a certificate (Let's Encrypt, or your host's one-click TLS).",
          "301-redirect every http:// URL to https://.",
        ],
      },
    },
  ];
}

/* ----------------------------------------------------------------- content */

function contentChecks(
  scan: Scan,
  pages: PageSignals[],
  home: PageSignals,
): Draft[] {
  const shells = pages.filter((p) => p.appShell);
  const homeWords = home.words;
  const noTitle = pages.filter((p) => !p.title);
  const titleCounts = countBy(pages.map((p) => p.title).filter(Boolean));
  const dupTitles = pages.filter(
    (p) => p.title && titleCounts.get(p.title)! > 1,
  );
  const noDescription = pages.filter((p) => !p.description);
  const descriptionCoverage = 1 - noDescription.length / pages.length;
  const badH1 = pages.filter((p) => p.h1.length !== 1);
  const thinStructure = pages.filter(
    (p) => p.headings.filter((h) => h.level === 2).length < 2,
  );
  const questions = sum(pages.map((p) => p.questionHeadings));
  const images = sum(pages.map((p) => p.images));
  const withAlt = sum(pages.map((p) => p.imagesWithAlt));
  const altCoverage = images ? withAlt / images : 1;
  const slow = home.ms;

  return [
    {
      id: "server-rendered",
      layer: "content",
      label: "Content is in the HTML",
      weight: 10,
      status: home.appShell
        ? "fail"
        : homeWords < 150 || shells.length
          ? "warn"
          : "pass",
      found: home.appShell
        ? `The homepage HTML holds only ${homeWords} words of text; the rest is drawn by JavaScript. ${shells.length} of ${pages.length} pages look like empty app shells.`
        : shells.length
          ? `The homepage has ${homeWords} words in its HTML, but ${shells.length} page${shells.length === 1 ? "" : "s"} arrive empty until JavaScript runs: ${shells.map((p) => pathOf(p.url)).join(", ")}.`
          : `${homeWords.toLocaleString("en")} words on the homepage are present in the raw HTML${homeWords < 150 ? ", which is thin" : ""}. ${pages.length - shells.length} of ${pages.length} pages are server-rendered.`,
      why: "GPTBot, ClaudeBot and PerplexityBot do not execute JavaScript. Text that only appears after scripts run does not exist for them.",
      urls: (home.appShell ? [home, ...shells] : shells).map((p) => p.url),
      fix: {
        summary: "Server-render or pre-render the text of every public page.",
        steps: [
          "Next.js / Nuxt / SvelteKit / Remix: make these routes server-rendered or statically generated rather than client-only.",
          "Vite or Create React App SPA: add pre-rendering (vite-plugin-prerender, react-snap) or move marketing pages to a static site generator.",
          "Webflow, WordPress, Shopify: remove content widgets that load text via JavaScript embeds.",
          `Verify: curl -s ${home.url} | grep -c "<p" should show your paragraphs.`,
        ],
      },
    },
    {
      id: "titles",
      layer: "content",
      label: "Unique page titles",
      weight: 4,
      status: noTitle.length ? "fail" : dupTitles.length ? "warn" : "pass",
      found: noTitle.length
        ? `${noTitle.length} page${noTitle.length === 1 ? " has" : "s have"} no <title>: ${noTitle.map((p) => pathOf(p.url)).join(", ")}.`
        : dupTitles.length
          ? `${dupTitles.length} pages share a title ("${dupTitles[0].title}").`
          : `All ${pages.length} pages have a distinct title.`,
      why: "The title is the label an answer engine shows next to a citation, and the first signal of what a page is about.",
      urls: (noTitle.length ? noTitle : dupTitles).map((p) => p.url),
      fix: {
        summary: "Give each page a specific title: what it is, then the brand.",
        steps: [
          "Pattern: '<What this page offers> | <Brand>', 50 to 60 characters.",
          "Make every title unique across the site.",
        ],
      },
    },
    {
      id: "descriptions",
      layer: "content",
      label: "Meta descriptions",
      weight: 4,
      status:
        descriptionCoverage >= 0.9
          ? "pass"
          : descriptionCoverage >= 0.5
            ? "warn"
            : "fail",
      found: noDescription.length
        ? `${noDescription.length} of ${pages.length} pages have no meta description: ${noDescription
            .slice(0, 6)
            .map((p) => pathOf(p.url))
            .join(", ")}${noDescription.length > 6 ? "…" : ""}.`
        : `All ${pages.length} pages have a meta description.`,
      why: "Engines use the description as the summary of a page when deciding whether it answers a question.",
      urls: noDescription.map((p) => p.url),
      fix: {
        summary:
          "Write a factual 140 to 160 character description for each page.",
        steps: [
          "State what the page offers and to whom, with one concrete fact (a number, a price, a location).",
          "Avoid slogans; write it as the answer to 'what is this page?'",
        ],
        language: "html",
        code: '<meta name="description" content="…">',
      },
    },
    {
      id: "h1",
      layer: "content",
      label: "One H1 per page",
      weight: 3,
      status:
        badH1.length === 0
          ? "pass"
          : badH1.length / pages.length <= 0.3
            ? "warn"
            : "fail",
      found: badH1.length
        ? badH1
            .slice(0, 5)
            .map(
              (p) =>
                `${pathOf(p.url)} has ${p.h1.length} H1${p.h1.length === 1 ? "" : "s"}`,
            )
            .join("; ") + (badH1.length > 5 ? "…" : ".")
        : `Every page has exactly one H1.`,
      why: "The H1 tells a parser the page's subject. None, or several, makes the main topic ambiguous.",
      urls: badH1.map((p) => p.url),
      fix: {
        summary: "Use exactly one H1 per page that names the page's subject.",
        steps: [
          "Turn logo or decorative H1s into plain elements.",
          "Add a descriptive H1 where it is missing.",
        ],
      },
    },
    {
      id: "structure",
      layer: "content",
      label: "Sectioned with headings",
      weight: 3,
      status:
        thinStructure.length / pages.length <= 0.2
          ? "pass"
          : thinStructure.length / pages.length <= 0.5
            ? "warn"
            : "fail",
      found: `${pages.length - thinStructure.length} of ${pages.length} pages break their content into two or more H2 sections.`,
      why: "Answer engines lift passages, not pages. Clear H2 sections give them self-contained passages to quote.",
      urls: thinStructure.map((p) => p.url),
      fix: {
        summary:
          "Split long pages into H2 sections that each answer one thing.",
        steps: [
          "Give each section an H2 that states its topic plainly.",
          "Open each section with a one or two sentence direct answer, then the detail.",
        ],
      },
    },
    {
      id: "answer-format",
      layer: "content",
      label: "Question-and-answer content",
      weight: 3,
      status: questions >= 3 ? "pass" : questions > 0 ? "warn" : "fail",
      found: questions
        ? `${questions} heading${questions === 1 ? " is" : "s are"} phrased as a question across the scanned pages.`
        : "No headings are phrased as the questions buyers ask.",
      why: "People ask AI questions. Pages that pose the same question as a heading and answer it right below are the passages that get quoted.",
      fix: {
        summary: "Add an FAQ section built from real buyer questions.",
        steps: [
          "Collect 6 to 10 questions from sales calls, support tickets and the visibility results below.",
          "Use each question verbatim as an H2 or H3, and answer it in the first 40 to 60 words beneath.",
          "Mark it up with FAQPage structured data (see Entity clarity).",
        ],
      },
    },
    {
      id: "alt-text",
      layer: "content",
      label: "Image alt text",
      weight: 2,
      status: !images
        ? "na"
        : altCoverage >= 0.8
          ? "pass"
          : altCoverage >= 0.5
            ? "warn"
            : "fail",
      found: images
        ? `${withAlt} of ${images} images have alt text (${Math.round(altCoverage * 100)}%).`
        : "No images in the scanned HTML.",
      why: "Alt text is the only way a text model learns what a product photo, chart or diagram shows.",
      fix: {
        summary: "Describe informative images in their alt attribute.",
        steps: [
          "Describe what the image shows and why it matters; leave alt empty only for decoration.",
        ],
      },
    },
    {
      id: "lang",
      layer: "content",
      label: "Language declared",
      weight: 1,
      status: home.lang ? "pass" : "fail",
      found: home.lang
        ? `<html lang="${home.lang}">`
        : "The <html> element has no lang attribute.",
      why: "Declares which language, and often which market, the page serves.",
      urls: [home.url],
      fix: {
        summary: "Declare the page language.",
        language: "html",
        code: '<html lang="en">',
      },
    },
    {
      id: "speed",
      layer: "content",
      label: "Fast first response",
      weight: 2,
      status: slow < 1500 ? "pass" : slow < 4000 ? "warn" : "fail",
      found: `The homepage HTML took ${(slow / 1000).toFixed(1)}s to download.`,
      why: "Answer-time fetchers work under tight timeouts. A slow page is skipped for a faster source.",
      urls: [home.url],
      fix: {
        summary: "Cache HTML at the edge and cut server time.",
        steps: [
          "Serve public pages from a CDN cache.",
          "Remove blocking server-side calls from the page render.",
        ],
      },
    },
  ];
}

/* ------------------------------------------------------------------ entity */

const ORG_TYPES =
  /^(Organization|Corporation|LocalBusiness|OnlineBusiness|OnlineStore|NGO|EducationalOrganization|MedicalOrganization|ProfessionalService|Store|Restaurant|LegalService|FinancialService|.*Business)$/;
const OFFER_TYPES =
  /^(Product|Service|SoftwareApplication|WebApplication|MobileApplication|Offer|AggregateOffer|OfferCatalog|Course|Event|MenuItem|Menu|FinancialProduct|HowTo|Book|Recipe)$/;

function entityChecks(
  scan: Scan,
  pages: PageSignals[],
  home: PageSignals,
  identity: Identity,
): Draft[] {
  const allTypes = new Set(pages.flatMap((p) => p.jsonLdTypes));
  const org = findOrganization(pages);
  const orgFields = org
    ? ["name", "url", "logo", "description"].filter((key) => org[key])
    : [];
  const sameAs = org
    ? ([] as string[]).concat((org.sameAs as string | string[]) ?? [])
    : [];
  const social = [...new Set(pages.flatMap((p) => p.socialLinks))];
  const offerTypes = [...allTypes].filter((t) => OFFER_TYPES.test(t));
  const questions = sum(pages.map((p) => p.questionHeadings));
  const og = home.openGraph;
  const ogMissing = ["og:title", "og:description", "og:image"].filter(
    (key) => !og[key],
  );
  const links = pages
    .flatMap((p) => p.internalLinks)
    .map((l) => pathOf(l).toLowerCase());
  const hasAbout = links.some((l) =>
    /about|company|who-we-are|our-story/.test(l),
  );
  const hasContact = links.some((l) =>
    /contact|get-in-touch|locations?/.test(l),
  );
  const noCanonical = pages.filter((p) => !p.canonical);
  const jsonLdErrors = sum(pages.map((p) => p.jsonLdErrors));

  return [
    {
      id: "organization-schema",
      layer: "entity",
      label: "Organization structured data",
      weight: 8,
      status: !org ? "fail" : orgFields.length >= 3 ? "pass" : "warn",
      found: org
        ? `Found ${String(org["@type"])} markup with ${orgFields.join(", ") || "no core fields"}${orgFields.length < 4 ? `; missing ${["name", "url", "logo", "description"].filter((k) => !orgFields.includes(k)).join(", ")}` : ""}.`
        : `No Organization or LocalBusiness JSON-LD on any of ${pages.length} pages.${allTypes.size ? ` Types present: ${[...allTypes].slice(0, 6).join(", ")}.` : ""}`,
      why: "Organization markup is the machine-readable statement of who you are: your official name, site, logo and profiles. It is how engines tie mentions of you across the web to one entity.",
      urls: [home.url],
      fix: {
        summary: "Add Organization JSON-LD to the homepage.",
        steps: [
          "Paste this into the <head> of the homepage (or your site-wide layout).",
          "Check the values, especially the logo URL and the sameAs profiles.",
          "Validate at https://validator.schema.org.",
        ],
        file: "index.html <head>",
        language: "html",
        code: organizationJsonLd(identity, social),
      },
    },
    {
      id: "same-as",
      layer: "entity",
      label: "Official profiles linked (sameAs)",
      weight: 4,
      status: sameAs.length >= 2 ? "pass" : social.length ? "warn" : "fail",
      found: sameAs.length
        ? `sameAs lists ${sameAs.length} profile${sameAs.length === 1 ? "" : "s"}: ${sameAs.slice(0, 4).join(", ")}.`
        : social.length
          ? `The site links to ${social.length} profiles (${social.slice(0, 4).map(hostOf).join(", ")}), but no structured data declares them as yours.`
          : "No links to official profiles such as LinkedIn, Crunchbase or Wikipedia were found.",
      why: "sameAs lets an engine confirm that the LinkedIn page, the Crunchbase entry and this website are the same company, rather than guessing from a shared name.",
      urls: [home.url],
      fix: {
        summary:
          "List every official profile in the Organization sameAs array.",
        language: "json",
        code: `"sameAs": ${JSON.stringify(social.length ? social : ["https://www.linkedin.com/company/…", "https://www.crunchbase.com/organization/…"], null, 2)}`,
        steps: [
          "Add LinkedIn, Crunchbase, Wikipedia or Wikidata, G2 or Trustpilot, and GitHub if relevant.",
        ],
      },
    },
    {
      id: "offering-schema",
      layer: "entity",
      label: "Products or services marked up",
      weight: 4,
      status: offerTypes.length ? "pass" : "fail",
      found: offerTypes.length
        ? `Offer markup found: ${offerTypes.join(", ")}.`
        : "Nothing marks up what you sell (no Product, Service, SoftwareApplication or Offer).",
      why: "When someone asks 'who offers X', engines match the question against the offerings they can identify. Unmarked services are prose they may or may not extract.",
      fix: {
        summary: "Mark up each core product or service.",
        steps: [
          "Add one block per offering on its own page.",
          "Include price or priceRange where you publish it; engines answer pricing questions directly from it.",
        ],
        language: "html",
        code: serviceJsonLd(identity),
      },
    },
    {
      id: "faq-schema",
      layer: "entity",
      label: "FAQ structured data",
      weight: 2,
      status: allTypes.has("FAQPage") ? "pass" : questions ? "warn" : "fail",
      found: allTypes.has("FAQPage")
        ? "FAQPage markup is present."
        : questions
          ? `${questions} question headings exist, but none are marked up as FAQPage.`
          : "No FAQ content or FAQPage markup.",
      why: "FAQPage pairs each question with its exact answer, which is the shape answer engines quote.",
      fix: {
        summary: "Wrap your FAQ in FAQPage JSON-LD.",
        language: "html",
        code: faqJsonLd([
          [`What does ${identity.brand} do?`, identity.description || "…"],
          [`Who is ${identity.brand} for?`, "…"],
        ]),
      },
    },
    {
      id: "open-graph",
      layer: "entity",
      label: "Open Graph tags",
      weight: 3,
      status:
        ogMissing.length === 0
          ? "pass"
          : ogMissing.length < 3
            ? "warn"
            : "fail",
      found: ogMissing.length
        ? `The homepage is missing ${ogMissing.join(", ")}.`
        : `og:title, og:description and og:image are all set.`,
      why: "Open Graph is the summary card that chat interfaces and link previews render when your URL is shared or cited.",
      urls: [home.url],
      fix: {
        summary: "Add the missing Open Graph tags.",
        language: "html",
        code: [
          `<meta property="og:title" content="${escapeHtml(identity.brand)}">`,
          `<meta property="og:description" content="${escapeHtml(identity.description || "…")}">`,
          `<meta property="og:image" content="${identity.logo || `${identity.origin}/og-image.png`}">`,
          `<meta property="og:url" content="${identity.origin}/">`,
          `<meta property="og:type" content="website">`,
        ].join("\n"),
      },
    },
    {
      id: "about-contact",
      layer: "entity",
      label: "About and contact pages",
      weight: 2,
      status:
        hasAbout && hasContact
          ? "pass"
          : hasAbout || hasContact
            ? "warn"
            : "fail",
      found: `${hasAbout ? "An about page is linked" : "No about page is linked"}; ${hasContact ? "a contact page is linked" : "no contact page is linked"}.`,
      why: "Engines weigh whether a business is real and accountable. An about page and a reachable contact page are the basic trust signals.",
      fix: {
        summary:
          "Link an about page and a contact page from the main navigation.",
        steps: [
          "About: who you are, founded when, where, who runs it, what you do, notable customers or numbers.",
          "Contact: email, phone, address if you have one.",
        ],
      },
    },
    {
      id: "canonical",
      layer: "entity",
      label: "Canonical URLs",
      weight: 2,
      status:
        noCanonical.length === 0
          ? "pass"
          : noCanonical.length / pages.length <= 0.3
            ? "warn"
            : "fail",
      found: noCanonical.length
        ? `${noCanonical.length} of ${pages.length} pages declare no canonical URL.`
        : "Every page declares a canonical URL.",
      why: "Canonicals collapse duplicate URLs (tracking parameters, trailing slashes) so signals and citations accumulate on one address.",
      urls: noCanonical.map((p) => p.url),
      fix: {
        summary: "Add a self-referencing canonical to every page.",
        language: "html",
        code: `<link rel="canonical" href="${identity.origin}/current-page-path">`,
      },
    },
    {
      id: "jsonld-valid",
      layer: "entity",
      label: "Structured data parses",
      weight: 2,
      status:
        !allTypes.size && !jsonLdErrors ? "na" : jsonLdErrors ? "fail" : "pass",
      found: jsonLdErrors
        ? `${jsonLdErrors} JSON-LD block${jsonLdErrors === 1 ? " is" : "s are"} not valid JSON and will be ignored.`
        : `${allTypes.size} structured data types parse cleanly.`,
      why: "One stray comma makes a whole JSON-LD block unreadable.",
      fix: {
        summary: "Fix the invalid JSON-LD blocks.",
        steps: [
          "Paste each block into https://validator.schema.org and fix the reported syntax errors.",
        ],
      },
    },
  ];
}

/* ------------------------------------------------------------------- agent */

function agentChecks(
  scan: Scan,
  pages: PageSignals[],
  identity: Identity,
): Draft[] {
  const llms = scan.llmsTxt;
  const llmsValid =
    llms.status === 200 &&
    /^#\s+\S/m.test(llms.body) &&
    /\]\(https?:\/\//.test(llms.body);
  const articles = pages.filter((p) =>
    /\/(blog|news|articles?|insights|resources|posts?)\//i.test(p.url),
  );
  const dated = articles.filter((p) => p.hasDate);
  const origin = new URL(scan.finalUrl).origin;

  return [
    {
      id: "llms-txt",
      layer: "agent",
      label: "llms.txt",
      weight: 6,
      status: llmsValid ? "pass" : llms.status === 200 ? "warn" : "fail",
      found: llmsValid
        ? `/llms.txt is published (${llms.bytes} bytes) with a title and links.`
        : llms.status === 200
          ? "/llms.txt exists but lacks the expected structure (an H1 title and a list of Markdown links)."
          : "/llms.txt does not exist.",
      why: "llms.txt is a plain Markdown map of your site written for language models: who you are, and which pages hold the answers. It costs nothing, and assistants and coding agents already read it.",
      urls: [`${origin}/llms.txt`],
      fix: {
        summary:
          "Publish this llms.txt at the site root. It was generated from your pages.",
        steps: [
          "Save it as llms.txt in your public or static folder so it is served at /llms.txt.",
          "Edit the description and add any key pages we did not scan.",
          "Keep it current when you launch pages.",
        ],
        file: "llms.txt",
        language: "markdown",
        code: buildLlmsTxt(identity, pages),
      },
    },
    {
      id: "llms-full",
      layer: "agent",
      label: "llms-full.txt",
      weight: 1,
      status: scan.llmsFullTxt.status === 200 ? "pass" : "warn",
      found:
        scan.llmsFullTxt.status === 200
          ? `/llms-full.txt is published (${scan.llmsFullTxt.bytes.toLocaleString("en")} bytes).`
          : "/llms-full.txt does not exist. Optional, but useful for docs-heavy sites.",
      why: "The full-text companion to llms.txt lets an assistant load your key content in one request.",
      urls: [`${origin}/llms-full.txt`],
      fix: {
        summary:
          "Optionally publish your key pages as one Markdown file at /llms-full.txt.",
        steps: [
          "Concatenate the Markdown of your about, product, pricing and FAQ pages.",
          "Docs platforms (Mintlify, GitBook, Docusaurus plugins) can generate it automatically.",
        ],
      },
    },
    {
      id: "freshness",
      layer: "agent",
      label: "Articles show dates and authors",
      weight: 2,
      status: !articles.length
        ? "na"
        : dated.length === articles.length && articles.every((p) => p.hasAuthor)
          ? "pass"
          : dated.length
            ? "warn"
            : "fail",
      found: articles.length
        ? `${dated.length} of ${articles.length} article pages carry a machine-readable date; ${articles.filter((p) => p.hasAuthor).length} name an author.`
        : "No article or blog pages were in the scanned set.",
      why: "Engines prefer recent, attributable sources. Without a date, a page cannot win a 'latest' or 'this year' question.",
      urls: articles.map((p) => p.url),
      fix: {
        summary: "Add datePublished, dateModified and author to every article.",
        language: "html",
        code: `<script type="application/ld+json">\n${JSON.stringify(
          {
            "@context": "https://schema.org",
            "@type": "Article",
            headline: "…",
            datePublished: "2026-01-01",
            dateModified: "2026-01-01",
            author: { "@type": "Person", name: "…" },
            publisher: { "@type": "Organization", name: identity.brand },
          },
          null,
          2,
        )}\n</script>`,
      },
    },
  ];
}

/* ----------------------------------------------------------------- helpers */

export function findOrganization(
  pages: PageSignals[],
): Record<string, unknown> | null {
  for (const page of pages) {
    const found = walk(page.jsonLd, (node) =>
      []
        .concat((node["@type"] as never) ?? [])
        .some((t: string) => ORG_TYPES.test(t)),
    );
    if (found) return found;
  }
  return null;
}

function walk(
  value: unknown,
  match: (node: Record<string, unknown>) => boolean,
  depth = 0,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = walk(item, match, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const node = value as Record<string, unknown>;
  if (match(node)) return node;
  for (const [key, child] of Object.entries(node)) {
    if (key === "@context") continue;
    const found = walk(child, match, depth + 1);
    if (found) return found;
  }
  return null;
}

function organizationJsonLd(identity: Identity, social: string[]) {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: identity.brand,
    url: `${identity.origin}/`,
    logo: identity.logo || `${identity.origin}/logo.png`,
    description: identity.description || undefined,
    sameAs: social.length ? social : undefined,
  };
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
}

function serviceJsonLd(identity: Identity) {
  return `<script type="application/ld+json">\n${JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "Service",
      name: identity.category ? capitalise(identity.category) : "…",
      description: "…",
      provider: {
        "@type": "Organization",
        name: identity.brand,
        url: `${identity.origin}/`,
      },
      areaServed: identity.market || "…",
      offers: { "@type": "Offer", priceCurrency: "USD", price: "…" },
    },
    null,
    2,
  )}\n</script>`;
}

export function faqJsonLd(pairs: Array<[string, string]>) {
  return `<script type="application/ld+json">\n${JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: pairs.map(([question, answer]) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer },
      })),
    },
    null,
    2,
  )}\n</script>`;
}

function sitemapXml(scan: Scan) {
  const urls = scan.pages.map((p) => p.url).slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) =>
        `  <url><loc>${escapeHtml(u)}</loc><lastmod>${today}</lastmod></url>`,
    ),
    "</urlset>",
  ].join("\n");
}

function countBy(values: string[]) {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}
export function sum(values: number[]) {
  return values.reduce((a, b) => a + b, 0);
}
function round(value: number) {
  return Math.round(value * 10) / 10;
}
export function pathOf(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}
function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
