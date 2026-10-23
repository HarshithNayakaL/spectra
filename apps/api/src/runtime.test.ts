import { describe, expect, it } from "vitest";
import { runtimePatched } from "./runtime";

describe("runtimePatched", () => {
  it.each([
    ["v22.22.0", false],
    ["v22.23.3", false],
    ["v22.23.4", true],
    ["v22.24.0", true],
    ["v24.22.0", false],
    ["v24.22.1", true],
    ["v26.12.0", false],
    ["v26.12.1", true],
    ["v20.19.0", false],
    ["v23.11.0", false],
    ["v27.0.0", true],
  ])("%s is patched: %s", (version, expected) => {
    expect(runtimePatched(version, {})).toBe(expected);
  });

  it("does not guess about runtimes that only emulate Node", () => {
    expect(runtimePatched("v24.3.0", { bun: "1.2.22" })).toBeNull();
  });
});
