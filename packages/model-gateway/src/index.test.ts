import { describe, expect, it } from "vitest";
import { entitySchema, relationshipSchema } from "@spectra/schemas";
import { retryAfterMs, stripJsonFence } from "./index";

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

describe("response schema matches the validating schema", () => {
  it("offers Gemini exactly the entity types the parser accepts", () => {
    expect(entitySchema.shape.type.options).toContain("Organization");
    expect(entitySchema.shape.type.options.length).toBeGreaterThan(0);
  });

  it("offers Gemini exactly the predicates the parser accepts", () => {
    expect(relationshipSchema.shape.predicate.options).toContain("created");
    expect(relationshipSchema.shape.predicate.options.length).toBeGreaterThan(
      0,
    );
  });
});
