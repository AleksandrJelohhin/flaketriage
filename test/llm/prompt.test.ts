import { describe, expect, it } from "vitest";

import type { AnalyzedResult } from "../../src/core/analyze.js";
import type { TriagedResult } from "../../src/pipeline.js";
import { buildUserPayload, DEFAULT_LIMITS, SYSTEM_PROMPT } from "../../src/llm/prompt.js";
import { analyzedResult, gitContext, verdict } from "../helpers/factories.js";

const git = gitContext({ changedFiles: ["src/a.ts", "src/b.ts"] });

function ambiguous(name: string, over: Partial<AnalyzedResult> = {}): TriagedResult {
  return {
    result: analyzedResult(name, {
      suite: "acme.S",
      file: "test/s.spec.ts",
      failure: { message: `${name} failed`, type: null, stack: "at f (src/a.ts:3)" },
      ...over,
    }),
    verdict: verdict("ambiguous"),
  };
}

describe("SYSTEM_PROMPT", () => {
  it("is frozen — no interpolation, timestamps, ids, or repo names", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{|\bnew Date\b|\d{4}-\d{2}-\d{2}|run[_-]?id/i);
    // stable across calls (it's a const, but assert the contract)
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
  });

  it("tells the model that `unknown` is valid and rewarded", () => {
    expect(SYSTEM_PROMPT).toMatch(/unknown.*valid.*rewarded|rewarded.*unknown/is);
    expect(SYSTEM_PROMPT).toMatch(/do not guess/i);
  });
});

describe("buildUserPayload", () => {
  it("includes run context, one block per failure, and the diff", () => {
    const p = buildUserPayload({
      git,
      attempt: 2,
      ambiguous: [ambiguous("a"), ambiguous("b")],
      diff: "diff --git a/src/a.ts b/src/a.ts\n+ boom",
    });
    expect(p).toMatch(/commit: c0ffee/);
    expect(p).toMatch(/attempt: 2/);
    expect(p).toMatch(/test_key: key-a/);
    expect(p).toMatch(/test_key: key-b/);
    expect(p).toMatch(/## commit diff/);
  });

  it("caps the batch at maxFailures and notes the remainder", () => {
    const many = Array.from({ length: 20 }, (_v, i) => ambiguous(`t${i}`));
    const p = buildUserPayload({ git, attempt: 1, ambiguous: many });
    expect((p.match(/### test_key:/g) ?? [])).toHaveLength(DEFAULT_LIMITS.maxFailures);
    expect(p).toMatch(/5 further ambiguous failure\(s\) omitted/);
  });

  it("truncates a long stack to the line budget", () => {
    const stack = Array.from({ length: 100 }, (_v, i) => `  at frame${i} (x.ts:${i})`).join("\n");
    const p = buildUserPayload(
      { git, attempt: 1, ambiguous: [ambiguous("x", { failure: { message: "m", type: null, stack } })] },
      { ...DEFAULT_LIMITS, maxStackLines: 10 },
    );
    expect(p).toMatch(/90 more lines truncated/);
  });

  it("truncates a huge message to the char budget", () => {
    const msg = "x".repeat(5000);
    const p = buildUserPayload(
      { git, attempt: 1, ambiguous: [ambiguous("x", { failure: { message: msg, type: null, stack: "" } })] },
      { ...DEFAULT_LIMITS, maxMessageChars: 100 },
    );
    expect(p).toMatch(/x{100}… \(truncated\)/);
  });
});
