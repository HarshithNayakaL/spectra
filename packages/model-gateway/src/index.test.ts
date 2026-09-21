import { describe, expect, it } from "vitest";
import { readableError, retryAfterMs, stripJsonFence } from "./index";

const header = (value: string | null) => ({ headers: { get: () => value } });

describe("Retry-After parsing", () => {
  it("reads delta-seconds", () => {
    expect(retryAfterMs(header("3"))).toBe(3000);
    expect(retryAfterMs(header(" 12 "))).toBe(12_000);
  });

  it("reads an HTTP date in the future", () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    expect(retryAfterMs(header(future))).toBeGreaterThan(10_000);
  });

  it("treats a past date as no delay rather than a negative one", () => {
    expect(retryAfterMs(header("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(0);
  });

  it("returns zero for an absent or unparseable value", () => {
    expect(retryAfterMs(header(null))).toBe(0);
    // A NaN here used to defeat Math.max and collapse the backoff.
    expect(retryAfterMs(header("soon"))).toBe(0);
    expect(Number.isNaN(retryAfterMs(header("soon")))).toBe(false);
  });
});

describe("fenced JSON", () => {
  it("unwraps a Markdown fence", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("leaves bare JSON untouched", () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("readable errors", () => {
  it("keeps only Google's sentence, not the JSON envelope", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan. For more information on this error, head to: https://ai.google.dev",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(readableError(body)).toBe(
      "You exceeded your current quota, please check your plan.",
    );
  });

  it("falls back to trimmed text for non-JSON bodies", () => {
    expect(readableError("  upstream\n timeout ")).toBe("upstream timeout");
  });
});
