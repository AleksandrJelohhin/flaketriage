import { describe, expect, it, vi } from "vitest";

import type { TriagedResult } from "../../src/pipeline.js";
import type { LlmCallResult, LlmProvider } from "../../src/llm/providers/types.js";
import type { ModelVerdict } from "../../src/llm/schema.js";
import { escalate, TOKEN_GUARDRAIL } from "../../src/llm/triage.js";
import { analyzedResult, gitContext, verdict } from "../helpers/factories.js";

const git = gitContext({ changedFiles: ["src/a.ts"] });

function ambiguous(name: string, evidenceLen = 0): TriagedResult {
  return {
    result: analyzedResult(name, {
      suite: "acme.S",
      failure: { message: `${name} failed`, type: null, stack: "at f (src/a.ts:1)" },
    }),
    // evidenceLen only affects the ranker; kind stays ambiguous
    verdict:
      evidenceLen > 0
        ? verdict("flake_likely", { confidence: "medium", evidence: Array(evidenceLen).fill("e") })
        : verdict("ambiguous"),
  };
}

function fakeProvider(
  over: Partial<LlmProvider> & { verdicts?: (system: string, payload: string) => ModelVerdict[] } = {},
): LlmProvider & { calls: number } {
  const calls = { n: 0 };
  const p: LlmProvider = {
    name: "local",
    model: "fake-1",
    enabled: true,
    countTokens: over.countTokens ?? (async () => 500),
    triage:
      over.triage ??
      (async (system, payload): Promise<LlmCallResult> => {
        calls.n += 1;
        const verdicts = (over.verdicts ?? (() => []))(system, payload);
        return {
          verdicts,
          usage: { inputTokens: 500, outputTokens: 40, cachedInputTokens: 0 },
          usd: 0.01,
          cacheHit: false,
          model: "fake-1",
        };
      }),
  };
  return Object.defineProperty(p, "calls", {
    get: () => calls.n,
  }) as LlmProvider & { calls: number };
}

describe("escalate", () => {
  it("does nothing (no call) when there are no ambiguous failures", async () => {
    const p = fakeProvider();
    const out = await escalate([], git, 1, p);
    expect(p.calls).toBe(0);
    expect(out.verdicts.size).toBe(0);
  });

  it("sends ONE batched request for many failures and maps verdicts by test_key", async () => {
    const p = fakeProvider({
      verdicts: () => [
        {
          test_key: "key-a",
          kind: "real_regression",
          confidence: "high",
          one_line_reason: "r",
          likely_cause: "c",
          suspect_location: "src/a.ts:1",
          suggested_next_step: "look",
        },
        {
          test_key: "key-b",
          kind: "unknown",
          confidence: "low",
          one_line_reason: "not enough",
          likely_cause: "",
          suspect_location: null,
          suggested_next_step: "gather more history",
        },
      ],
    });
    const out = await escalate([ambiguous("a"), ambiguous("b")], git, 1, p);
    expect(p.calls).toBe(1);
    expect(out.verdicts.get("key-a")?.kind).toBe("real_regression");
    expect(out.verdicts.get("key-b")?.kind).toBe("unknown");
    expect(out.escalated).toBe(2);
    expect(out.usd).toBe(0.01);
  });

  it("defers failures beyond maxFailures (no model opinion) and still sends one request", async () => {
    const p = fakeProvider({ verdicts: () => [] });
    const many = Array.from({ length: 20 }, (_v, i) => ambiguous(`t${i}`));
    const out = await escalate(many, git, 1, p, { limits: { maxFailures: 15, maxStackLines: 30, maxMessageChars: 2000, maxDiffLines: 400 } });
    expect(p.calls).toBe(1);
    expect(out.escalated).toBe(15);
    expect(out.deferred).toHaveLength(5);
  });

  it("hard-fails the escalation (error, no throw, no call) when the payload is over the token guardrail", async () => {
    const p = fakeProvider({ countTokens: async () => TOKEN_GUARDRAIL + 1 });
    const out = await escalate([ambiguous("a")], git, 1, p);
    expect(p.calls).toBe(0);
    expect(out.error).toMatch(/over the 100000 guardrail/);
    expect(out.verdicts.size).toBe(0);
  });

  it("records a provider failure as `error` and never throws", async () => {
    const p = fakeProvider({
      triage: async () => {
        throw new Error("network down");
      },
    });
    const out = await escalate([ambiguous("a")], git, 1, p);
    expect(out.error).toBe("network down");
    expect(out.verdicts.size).toBe(0);
  });

  it("passes the diff into the provider payload", async () => {
    let seenPayload = "";
    const p = fakeProvider({
      triage: async (_s, payload) => {
        seenPayload = payload;
        return {
          verdicts: [],
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          usd: 0,
          cacheHit: false,
          model: "fake-1",
        };
      },
    });
    await escalate([ambiguous("a")], git, 1, p, { diff: "diff --git a/x b/x\n+boom" });
    expect(seenPayload).toMatch(/commit diff/);
    expect(seenPayload).toMatch(/\+boom/);
  });
});
