import { describe, expect, it } from "vitest";
import { scoreChecks } from "./index";
describe("scoreChecks", () => {
  it("excludes N/A checks from the denominator", () => {
    const result = scoreChecks([
      {
        id: "a",
        dimension: "machine_accessibility",
        label: "a",
        status: "pass",
        value: 1,
        weight: 2,
        evidenceIds: [],
      },
      {
        id: "b",
        dimension: "machine_accessibility",
        label: "b",
        status: "na",
        value: 0,
        weight: 8,
        evidenceIds: [],
      },
    ]);
    expect(result.find((m) => m.dimension === "overall")?.score).toBe(100);
    expect(result.find((m) => m.dimension === "overall")?.denominator).toBe(2);
  });
});
