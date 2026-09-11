import { describe, expect, it } from "vitest";

import { estimateEscalationCost, MAX_FAILURES_PER_BATCH } from "../../src/llm/cost.js";

describe("estimateEscalationCost", () => {
  it("one batch of ambiguous failures ≈ $0.05 at Opus 5 rates", () => {
    const c = estimateEscalationCost(3);
    expect(c.batches).toBe(1);
    expect(c.usd).toBeCloseTo(0.05, 2);
    expect(c.perBatchUsd).toBeCloseTo(0.05, 2);
    expect(c.free).toBe(false);
  });

  it("batches at 15 failures per request", () => {
    expect(estimateEscalationCost(MAX_FAILURES_PER_BATCH).batches).toBe(1);
    expect(estimateEscalationCost(MAX_FAILURES_PER_BATCH + 1).batches).toBe(2);
    expect(estimateEscalationCost(40).batches).toBe(3);
  });

  it("zero failures costs nothing", () => {
    expect(estimateEscalationCost(0)).toMatchObject({ batches: 0, usd: 0 });
  });

  it("cheaper models are priced lower", () => {
    expect(estimateEscalationCost(15, { model: "claude-haiku-4-5" }).usd).toBeLessThan(
      estimateEscalationCost(15, { model: "claude-opus-5" }).usd,
    );
  });

  it("free / local providers are $0", () => {
    expect(estimateEscalationCost(30, { free: true })).toMatchObject({
      usd: 0,
      free: true,
      batches: 2,
    });
  });

  it("an unknown model falls back to Opus 5 rates", () => {
    expect(estimateEscalationCost(3, { model: "some-local-llm" }).usd).toBeCloseTo(0.05, 2);
  });
});
