import { describe, expect, it } from "vitest";

import {
  ModelVerdictSchema,
  TriageResponseSchema,
  triageJsonSchema,
} from "../../src/llm/schema.js";

describe("TriageResponseSchema", () => {
  const ok = {
    test_key: "abc",
    kind: "real_regression",
    confidence: "high",
    one_line_reason: "diff to pricing.ts broke the total calc",
    likely_cause: "off-by-one in the discount branch",
    suspect_location: "src/pricing.ts:42",
    suggested_next_step: "check the discount branch added in this commit",
  };

  it("accepts a well-formed verdict", () => {
    expect(ModelVerdictSchema.parse(ok)).toMatchObject({ kind: "real_regression" });
  });

  it("allows null suspect_location and unknown kind", () => {
    expect(
      ModelVerdictSchema.parse({ ...ok, kind: "unknown", suspect_location: null, likely_cause: "" }),
    ).toMatchObject({ kind: "unknown", suspect_location: null });
  });

  it("rejects an unknown kind value", () => {
    expect(() => ModelVerdictSchema.parse({ ...ok, kind: "definitely_flaky" })).toThrow();
  });

  it("rejects a missing field", () => {
    const { suggested_next_step: _omit, ...bad } = ok;
    expect(() => ModelVerdictSchema.parse(bad)).toThrow();
  });

  it("wraps verdicts in an array", () => {
    expect(TriageResponseSchema.parse({ verdicts: [ok, ok] }).verdicts).toHaveLength(2);
  });
});

describe("triageJsonSchema", () => {
  it("is a strict object schema OpenAI-compatible servers accept", () => {
    const s = triageJsonSchema() as {
      additionalProperties: boolean;
      properties: { verdicts: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.verdicts.items.additionalProperties).toBe(false);
    expect(s.properties.verdicts.items.required).toContain("test_key");
    expect(s.properties.verdicts.items.required).toHaveLength(7);
  });
});
