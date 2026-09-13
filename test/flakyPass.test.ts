import { describe, expect, it } from "vitest";

import { classifyPassedTest } from "../src/core/flakyPass.js";
import type { PassedTestInput } from "../src/core/flakyPass.js";

/** classifyPassedTest() is pure, so the tests just assemble facts. */

function input(over: Partial<PassedTestInput> = {}): PassedTestInput {
  return {
    commitSha: "c0ffee1234567",
    attempt: 2,
    retries: [],
    failedAttemptsOnCommit: [],
    ...over,
  };
}

describe("classifyPassedTest", () => {
  it("returns null for a clean pass", () => {
    expect(classifyPassedTest(input())).toBeNull();
  });

  it("in-run retries prove a flake, citing the first failure's first line", () => {
    const v = classifyPassedTest(
      input({ retries: [{ message: "Error: timed out after 5000ms\n  at x", type: null, stack: null }] }),
    );
    expect(v).toMatchObject({ kind: "flake_confirmed", confidence: "high", source: "history" });
    expect(v!.evidence).toEqual([
      "failed once, then passed on retry in this run (attempt 2) — first failure: Error: timed out after 5000ms",
    ]);
  });

  it("counts several in-run retries and falls back to the stack, then the type", () => {
    const fromStack = classifyPassedTest(
      input({
        retries: [
          { message: null, type: null, stack: "\n  AssertionError: boom\n  at y" },
          { message: "again", type: null, stack: null },
          { message: "and again", type: null, stack: null },
        ],
      }),
    );
    expect(fromStack!.evidence[0]).toMatch(/^failed 3 times, then passed on retry.*first failure: AssertionError: boom$/);

    const fromType = classifyPassedTest(
      input({ retries: [{ message: null, type: "java.lang.AssertionError", stack: null }] }),
    );
    expect(fromType!.evidence[0]).toMatch(/first failure: java\.lang\.AssertionError$/);
  });

  it("a failing attempt of the same commit proves a flake", () => {
    expect(classifyPassedTest(input({ failedAttemptsOnCommit: [1] }))!.evidence).toEqual([
      "failed in attempt 1 of the same commit c0ffee1 and passed in attempt 2 — the code did not change between attempts",
    ]);
  });

  it("lists several failing attempts", () => {
    const v = classifyPassedTest(input({ attempt: 4, failedAttemptsOnCommit: [1, 3] }));
    expect(v!.evidence[0]).toMatch(/^failed in attempts 1, 3 of the same commit c0ffee1 and passed in attempt 4/);
  });

  it("combines both kinds of evidence", () => {
    const v = classifyPassedTest(
      input({ retries: [{ message: "x", type: null, stack: null }], failedAttemptsOnCommit: [1] }),
    );
    expect(v!.evidence).toHaveLength(2);
  });

  it("truncates a very long first failure line", () => {
    const v = classifyPassedTest(input({ retries: [{ message: "e".repeat(500), type: null, stack: null }] }));
    expect(v!.evidence[0]!.endsWith("…")).toBe(true);
    expect(v!.evidence[0]!.length).toBeLessThan(260);
  });
});
