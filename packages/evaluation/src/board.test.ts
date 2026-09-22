import { describe, expect, it } from "vitest";
import type { Audit } from "@spectra/schemas";
import { buildBoard } from "./board";

function audit(overrides: Partial<Audit> = {}): Audit {
  return {
    id: "a1",
    version: "spectra-v2",
    target: "acme.test",
    host: "acme.test",
    status: "complete",
    stage: "",
    createdAt: "",
    completedAt: null,
    durationMs: 0,
    model: "m",
    customPrompts: [],
    scan: null,
    readiness: null,
    profile: null,
    visibility: null,
    fanout: null,
    actions: [],
    llmsTxt: null,
    warnings: [],
    error: null,
    ...overrides,
  };
}

describe("buildBoard", () => {
  it("reports every stage, even on an audit that measured nothing", () => {
    const board = buildBoard(audit());
    expect(board.stages.map((stage) => stage.id)).toEqual([
      "crawl",
      "content",
      "entity",
      "agent",
      "fanout",
      "answers",
      "fixes",
    ]);
    expect(board.total).toBe(7);
    expect(board.live).toBe(false);
  });

  it("separates a stage that has not run yet from one that could not", () => {
    const running = buildBoard(audit({ status: "scanning" }));
    expect(running.live).toBe(true);
    expect(running.stages[0].state).toBe("running");
    // Nothing is called missing while it is still being measured.
    expect(running.stages[0].missing).toEqual([]);

    const done = buildBoard(audit({ status: "failed", error: "403 on /" }));
    expect(done.stages[0].state).toBe("skipped");
    expect(done.stages[0].missing[0].text).toBe("403 on /");
  });

  it("names the crawler that was refused, and says a browser got in", () => {
    const board = buildBoard(
      audit({
        scan: {
          target: "https://acme.test/",
          finalUrl: "https://acme.test/",
          https: true,
          robots: { url: "", status: 200, bytes: 0, contentType: "", body: "" },
          sitemap: {
            url: "",
            status: 200,
            bytes: 0,
            contentType: "",
            body: "",
            urls: 40,
            referenced: true,
          },
          llmsTxt: {
            url: "",
            status: 404,
            bytes: 0,
            contentType: "",
            body: "",
          },
          llmsFullTxt: {
            url: "",
            status: 404,
            bytes: 0,
            contentType: "",
            body: "",
          },
          bots: [
            { agent: "Browser", status: 200, blocked: false, note: "" },
            {
              agent: "GPTBot",
              status: 403,
              blocked: true,
              note: "answered 403",
            },
          ],
          pages: [],
          failures: [],
          durationMs: 0,
        },
      }),
    );
    const crawl = board.stages[0];
    expect(crawl.state).toBe("fail");
    expect(crawl.missing[0].text).toContain("GPTBot was refused");
    expect(crawl.missing[0].text).toContain("while a browser was let in");
    expect(
      crawl.facts.find((f) => f.label === "AI crawlers allowed")?.value,
    ).toBe("0/1");
  });

  it("turns a fan-out with a lost kind into a gap that names the kind", () => {
    const board = buildBoard(
      audit({
        fanout: {
          seed: "best b2b data",
          engine: "gemini_search",
          engineNote: "",
          queries: [],
          measured: 6,
          mentions: 2,
          cited: 0,
          coverage: 33,
          byType: [
            { type: "comparison", measured: 2, hits: 0 },
            { type: "equivalent", measured: 4, hits: 2 },
          ],
          answeredBy: [{ domain: "g2.com", count: 5, own: false }],
          issued: [],
        },
      }),
    );
    const fanout = board.stages.find((stage) => stage.id === "fanout")!;
    expect(fanout.state).toBe("partial");
    expect(fanout.coverage).toBe(33);
    expect(fanout.missing.map((gap) => gap.text)).toContain(
      'Absent from every "versus and alternatives" sub-query (2 run).',
    );
    // Losing every comparison sub-query outranks a missing meta description.
    expect(fanout.missing[0].severity).toBe("high");
    expect(
      fanout.missing.some((gap) => gap.text.includes("never used as a source")),
    ).toBe(true);
  });

  it("never calls a stage clear while it is listing gaps", () => {
    const board = buildBoard(
      audit({
        visibility: {
          score: 80,
          engine: "gemini_model",
          engineNote: "",
          prompts: [],
          measured: 5,
          mentions: 5,
          categoryMeasured: 5,
          categoryMentions: 5,
          citations: 0,
          groundedMeasured: 0,
          averagePosition: 2,
          shareOfVoice: [],
          citedDomains: [],
        },
      }),
    );
    const answers = board.stages.find((stage) => stage.id === "answers")!;
    // Named in every question, but live search was unavailable: a gap remains.
    expect(answers.missing.length).toBeGreaterThan(0);
    expect(answers.state).toBe("partial");
  });

  it("sorts the whole board's gaps worst first", () => {
    const board = buildBoard(
      audit({
        status: "failed",
        error: "unreachable",
        visibility: {
          score: 0,
          engine: "gemini_model",
          engineNote: "",
          prompts: [],
          measured: 3,
          mentions: 0,
          categoryMeasured: 3,
          categoryMentions: 0,
          citations: 0,
          groundedMeasured: 0,
          averagePosition: null,
          shareOfVoice: [],
          citedDomains: [],
        },
      }),
    );
    expect(board.gaps[0].severity).toBe("high");
    expect(board.gaps.at(-1)?.severity).toBe("medium");
    expect(board.ran).toBeLessThan(board.total);
  });
});
