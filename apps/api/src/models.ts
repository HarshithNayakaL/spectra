export type ModelOption = {
  id: string;
  label: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  /** Set on the model Google AI Mode itself runs on. */
  aiMode?: boolean;
  recommended?: boolean;
};

export const DEFAULT_MODEL = "gemini-3.1-flash-lite";
/** The model behind Google's AI Mode, offered as the heavier alternative. */
export const AI_MODE_MODEL = "gemini-3.8-flash";

/**
 * Output modalities this audit cannot use. Text in, text out is the contract:
 * a model that answers with audio, images or music cannot be graded against
 * evidence. Input modality is not filtered, so multimodal models are fine.
 */
const WRONG_OUTPUT =
  /-tts|-image$|-image-preview$|nano-banana|lyria|transcribe|robotics|computer-use|embedding|imagen|veo/i;

/** Agent products rather than models an audit can call directly. */
const NOT_A_MODEL = /antigravity|deep-research/i;

export function isUsableModel(name: string, methods: string[]): boolean {
  if (!methods.includes("generateContent")) return false;
  const id = name.replace(/^models\//, "");
  if (WRONG_OUTPUT.test(id) || NOT_A_MODEL.test(id)) return false;
  return /^(gemini|gemma)/i.test(id);
}

/**
 * Reads the live catalogue so a model Google ships next week is selectable
 * without a redeploy. Falls back to the two known-good ids when the catalogue
 * cannot be reached.
 */
export async function listModels(apiKey: string): Promise<ModelOption[]> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Gemini model list failed (${response.status})`);
  const body = (await response.json()) as {
    models?: Array<{
      name?: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
      inputTokenLimit?: number;
      outputTokenLimit?: number;
    }>;
  };
  const options = (body.models ?? [])
    .filter((m) =>
      isUsableModel(m.name ?? "", m.supportedGenerationMethods ?? []),
    )
    .map((m) => {
      const id = (m.name ?? "").replace(/^models\//, "");
      return {
        id,
        label: m.displayName || id,
        inputTokenLimit: m.inputTokenLimit ?? 0,
        outputTokenLimit: m.outputTokenLimit ?? 0,
        aiMode: id === AI_MODE_MODEL,
        recommended: id === DEFAULT_MODEL,
      };
    });
  return sortModels(options);
}

/** Default first, then the AI Mode model, then newest-looking ids. */
export function sortModels(options: ModelOption[]): ModelOption[] {
  const rank = (m: ModelOption) =>
    m.id === DEFAULT_MODEL
      ? 0
      : m.id === AI_MODE_MODEL
        ? 1
        : m.id.startsWith("gemini")
          ? 2
          : 3;
  const version = (id: string) =>
    Number.parseFloat(id.match(/(\d+(?:\.\d+)?)/)?.[1] ?? "0");
  return [...options].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      version(b.id) - version(a.id) ||
      a.id.localeCompare(b.id),
  );
}

export const FALLBACK_MODELS: ModelOption[] = [
  {
    id: DEFAULT_MODEL,
    label: "Gemini 3.1 Flash Lite",
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    recommended: true,
  },
  {
    id: AI_MODE_MODEL,
    label: "Gemini 3.8 Flash",
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    aiMode: true,
  },
];

/** Ids are passed to the Gemini REST path, so keep them to a safe shape. */
export function isValidModelId(id: string): boolean {
  return /^[a-z0-9][a-z0-9.\-]{2,63}$/i.test(id);
}
