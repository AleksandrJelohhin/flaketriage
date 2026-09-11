import type { Verdict, VerdictKind } from "../../src/core/classify.js";
import type { AnalyzedResult } from "../../src/core/analyze.js";
import type { GitContext } from "../../src/ingest/git.js";
import type { TriagedResult } from "../../src/pipeline.js";

export function gitContext(over: Partial<GitContext> = {}): GitContext {
  return {
    repoRoot: "/repo",
    repoSlug: "acme/app",
    commitSha: "c0ffee1234567",
    parentSha: "beef7654321",
    branch: "main",
    changedFiles: [],
    diffHunks: [],
    ...over,
  };
}

export function verdict(kind: VerdictKind, over: Partial<Verdict> = {}): Verdict {
  return {
    kind,
    confidence: kind === "ambiguous" ? "low" : "high",
    evidence: kind === "ambiguous" ? ["no deterministic signal"] : ["because reasons"],
    source: "history",
    ...over,
  };
}

export function analyzedResult(
  name: string,
  over: Partial<AnalyzedResult> = {},
): AnalyzedResult {
  return {
    suite: "acme.Suite",
    name,
    testKey: `key-${name}`,
    status: "failed",
    durationMs: 1,
    file: null,
    failure: { message: `${name} failed`, type: null, stack: "at f (src/x.py:3)" },
    skipReason: null,
    retries: [],
    fingerprint: `fp-${name}`,
    ...over,
  };
}

export function triagedResult(
  name: string,
  v: Verdict,
  over: Partial<TriagedResult> = {},
): TriagedResult {
  return { result: analyzedResult(name), verdict: v, ...over };
}
