import { describe, expect, it } from "vitest";
import {
  AI_MODE_MODEL,
  DEFAULT_MODEL,
  isUsableModel,
  isValidModelId,
  sortModels,
  type ModelOption,
} from "./models";

const gen = ["generateContent"];

describe("model filtering", () => {
  it("keeps text-answering Gemini and Gemma models", () => {
    for (const id of [
      "models/gemini-3.1-flash-lite",
      "models/gemini-3.8-flash",
      "models/gemini-2.5-pro",
      "models/gemma-4-31b-it",
      "models/gemini-flash-latest",
    ])
      expect(isUsableModel(id, gen)).toBe(true);
  });

  it("drops models whose output is not text", () => {
    for (const id of [
      "models/gemini-2.5-flash-preview-tts",
      "models/gemini-3-pro-image",
      "models/nano-banana-pro-preview",
      "models/lyria-3.5",
      "models/gemini-3.5-transcribe",
      "models/gemini-2.5-flash-image",
    ])
      expect(isUsableModel(id, gen)).toBe(false);
  });

  it("drops agent products and non-Google ids", () => {
    for (const id of [
      "models/antigravity-preview-09-2026",
      "models/deep-research-max-preview-04-2026",
      "models/gemini-2.5-computer-use-preview-10-2025",
      "models/gemini-robotics-er-2-preview",
      "models/some-other-vendor",
    ])
      expect(isUsableModel(id, gen)).toBe(false);
  });

  it("requires generateContent support", () =>
    expect(isUsableModel("models/gemini-3.8-flash", ["embedContent"])).toBe(
      false,
    ));
});

describe("model ordering", () => {
  const opt = (id: string): ModelOption => ({
    id,
    label: id,
    inputTokenLimit: 0,
    outputTokenLimit: 0,
    aiMode: id === AI_MODE_MODEL,
    recommended: id === DEFAULT_MODEL,
  });

  it("puts the default first, then the AI Mode model, then newest Gemini", () => {
    const ids = sortModels(
      ["gemma-4-31b-it", "gemini-3.5-flash", AI_MODE_MODEL, DEFAULT_MODEL].map(
        opt,
      ),
    ).map((m) => m.id);
    expect(ids[0]).toBe(DEFAULT_MODEL);
    expect(ids[1]).toBe(AI_MODE_MODEL);
    expect(ids[2]).toBe("gemini-3.5-flash");
    expect(ids[3]).toBe("gemma-4-31b-it");
  });
});

describe("model id validation", () => {
  it("accepts real ids", () => {
    for (const id of ["gemini-3.1-flash-lite", "gemma-4-31b-it"])
      expect(isValidModelId(id)).toBe(true);
  });
  it("rejects anything that could escape the REST path", () => {
    for (const id of [
      "../secrets",
      "gemini/../../x",
      "a b",
      "x",
      "gemini?key=leak",
      "",
    ])
      expect(isValidModelId(id)).toBe(false);
  });
});
