import { useEffect, useState } from "react";

export const API = import.meta.env.VITE_API_URL || "";

export type ModelOption = {
  id: string;
  label: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  aiMode?: boolean;
  recommended?: boolean;
};

/** The catalogue is read from Gemini, so new models appear without a deploy. */
export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/models`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no models"))))
      .then((body: { models: ModelOption[] }) => {
        if (!cancelled) setModels(body.models ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return models;
}

/** One row in the model picker: the name, then what it can hold. */
export function modelMeta(model: ModelOption) {
  if (!model.inputTokenLimit) return "";
  return `${tokens(model.inputTokenLimit)} in · ${tokens(model.outputTokenLimit)} out`;
}

function tokens(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export function modelBadge(model: ModelOption) {
  if (model.recommended) return "Default";
  if (model.aiMode) return "Google AI Mode";
  return undefined;
}

export type JourneyCatalogue = {
  intents: Array<{ id: string; label: string; task: string }>;
  agents: Array<{ name: string; label: string }>;
  defaultAgent: string;
};

/** The jobs and agents a journey can use, served by the API that runs them. */
export function useJourneyCatalogue() {
  const [catalogue, setCatalogue] = useState<JourneyCatalogue | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/journeys/catalogue`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error("no catalogue")),
      )
      .then((body: JourneyCatalogue) => {
        if (!cancelled) setCatalogue(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return catalogue;
}

/** Reads an NDJSON stream, handing each parsed line to `onEvent`. */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: any) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
    if (done) break;
  }
}

export function pathOf(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}
