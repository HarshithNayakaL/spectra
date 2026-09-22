import { randomUUID } from "node:crypto";
import {
  compareSites,
  deriveIdentity,
  type Comparison,
} from "@spectra/evaluation";
import { GeminiProvider } from "@spectra/model-gateway";
import type { Scan } from "@spectra/schemas";
import { scanSite, ScanError } from "./scan";
import { saveCompare } from "./store";

export type CompareRecord = Comparison & {
  id: string;
  status: "running" | "complete";
  stage: string;
  createdAt: string;
  durationMs: number;
  model: string;
  /** Where the questions came from, so the report can say. */
  questionSource: "yours" | "expanded" | "none";
  questionNote: string;
  topic: string;
  /** Sites still being crawled while the comparison runs. */
  pending: string[];
};

export const MAX_SITES = 4;

export function hostsOf(values: string[]) {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const value of values) {
    const raw = value.trim();
    if (!raw) continue;
    let host: string;
    try {
      host = new URL(
        /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
      ).hostname
        .toLowerCase()
        .replace(/^www\./, "");
    } catch {
      continue;
    }
    if (!host.includes(".") || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts.slice(0, MAX_SITES);
}

/**
 * Crawls every site in parallel and scores them the same way. The only model
 * call is optional and only chooses questions: when none were given and a topic
 * was, the topic is expanded into the sub-queries an engine would issue. The
 * verdict on each question is still retrieval over the crawl.
 */
export async function runCompare(
  input: { sites: string[]; questions: string[]; topic: string; model: string },
  progress: (record: CompareRecord) => void,
  options: { apiKey?: string } = {},
): Promise<CompareRecord> {
  const started = Date.now();
  const hosts = hostsOf(input.sites);
  const scans = new Map<string, { scan: Scan | null; error: string }>();
  const record: CompareRecord = {
    id: randomUUID(),
    status: "running",
    stage: `Crawling ${hosts.length} sites as AI crawlers see them`,
    createdAt: new Date().toISOString(),
    durationMs: 0,
    model: input.model,
    questionSource: "none",
    questionNote: "",
    topic: input.topic,
    pending: [...hosts],
    ...compareSites({ sites: [], questions: [] }),
  };
  const publish = () => {
    record.durationMs = Date.now() - started;
    Object.assign(
      record,
      compareSites({
        sites: hosts
          .filter((host) => scans.has(host))
          .map((host) => ({ host, ...scans.get(host)! })),
        questions: [],
      }),
    );
    progress(structuredClone(record));
  };
  publish();

  const crawled = Promise.all(
    hosts.map(async (host) => {
      try {
        scans.set(host, { scan: await scanSite(host), error: "" });
      } catch (error) {
        scans.set(host, {
          scan: null,
          error:
            error instanceof ScanError
              ? error.message
              : error instanceof Error
                ? error.message
                : String(error),
        });
      }
      record.pending = record.pending.filter((item) => item !== host);
      record.stage = record.pending.length
        ? `Crawled ${host}; waiting on ${record.pending.join(", ")}`
        : "Scoring every site the same way";
      publish();
    }),
  );

  // Questions are chosen while the crawls run, never after them.
  let questions = input.questions
    .map((question) => question.trim())
    .filter((question) => question.length >= 3)
    .slice(0, 8);
  if (questions.length) record.questionSource = "yours";
  const key = options.apiKey ?? process.env.GEMINI_API_KEY;
  const expansion =
    !questions.length && input.topic.trim().length >= 3
      ? key
        ? (async () => {
            await crawled.catch(() => {});
            const lead = scans.get(hosts[0])?.scan;
            const identity = lead ? deriveIdentity(lead) : null;
            const provider = new GeminiProvider(key, input.model, {
              deadline: Date.now() + 45_000,
            });
            const result = await provider.expandFanout({
              profile: {
                brand: identity?.brand || hosts[0],
                aliases: [],
                category: input.topic.trim(),
                description: identity?.description || input.topic.trim(),
                audience: "",
                market: "",
                facts: [],
              },
              seed: input.topic.trim(),
              count: 6,
            });
            return result.value.map((plan) => plan.query);
          })().catch((error) => {
            record.questionNote = `The topic could not be expanded (${error instanceof Error ? error.message : String(error)}), so no questions were compared.`;
            return [] as string[];
          })
        : Promise.resolve(
            (() => {
              record.questionNote =
                "No model key is configured, so the topic was not expanded. Add questions to compare them.";
              return [] as string[];
            })(),
          )
      : Promise.resolve([] as string[]);

  await crawled;
  if (!questions.length) {
    questions = (await expansion).slice(0, 8);
    if (questions.length) {
      record.questionSource = "expanded";
      record.questionNote = `Expanded from “${input.topic.trim()}” by ${input.model}: the model chose the questions, the crawl decided who answers them.`;
    } else if (!record.questionNote)
      record.questionNote =
        "No questions were given, so only the sites themselves were compared.";
  }

  Object.assign(
    record,
    compareSites({
      sites: hosts.map((host) => ({ host, ...scans.get(host)! })),
      questions,
    }),
  );
  record.status = "complete";
  record.stage = "Complete";
  record.pending = [];
  record.durationMs = Date.now() - started;
  await saveCompare(record).catch(() => {});
  return record;
}
