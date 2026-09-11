import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { History } from "../src/core/history.js";
import type { RunMeta } from "../src/core/history.js";
import { analyzeResults } from "../src/core/analyze.js";
import { parseJUnitXml } from "../src/ingest/junit.js";
import type { GitContext } from "../src/ingest/git.js";
import { applyEscalation, referencedFiles, triageRun } from "../src/pipeline.js";
import { testKey } from "../src/core/keys.js";
import type { EscalationOutcome } from "../src/llm/triage.js";
import type { ModelVerdict } from "../src/llm/schema.js";

const T_KEY = testKey("acme.Suite", "t");

let h: History;
beforeEach(() => (h = History.open(":memory:")));
afterEach(() => h.close());

const git = (over: Partial<GitContext> = {}): GitContext => ({
  repoRoot: "/repo",
  repoSlug: "acme/app",
  commitSha: "c8commit",
  parentSha: "c7parent",
  branch: "main",
  changedFiles: [],
  diffHunks: [],
  ...over,
});

function suiteXml(
  cases: { name: string; status: "pass" | "fail"; file?: string; body?: string }[],
): string {
  const tc = cases
    .map((c) => {
      const attrs = `classname="acme.Suite" name="${c.name}"${c.file ? ` file="${c.file}"` : ""}`;
      if (c.status === "pass") return `<testcase ${attrs}/>`;
      return `<testcase ${attrs}><failure message="boom">${c.body ?? "AssertionError: boom\n    at fn (src/x.py:3)"}</failure></testcase>`;
    })
    .join("");
  return `<testsuite name="acme.Suite">${tc}</testsuite>`;
}

/** Record a run the way the CLI does (analyze → recordRun). */
function record(
  metaOver: Partial<RunMeta>,
  xml: string,
): void {
  const results = parseJUnitXml(xml);
  const meta: RunMeta = {
    repo: "acme/app",
    commitSha: "x",
    parentSha: null,
    branch: "main",
    ciRunId: null,
    attempt: 1,
    startedAt: Date.now(),
    changedFiles: [],
    ...metaOver,
  };
  h.recordRun(
    meta,
    analyzeResults(results).map((r) => ({
      suite: r.suite,
      testName: r.name,
      testKey: r.testKey,
      status: r.status,
      durationMs: r.durationMs,
      message: r.failure?.message ?? null,
      stack: r.failure?.stack ?? null,
      fingerprint: r.fingerprint,
    })),
  );
}

describe("triageRun", () => {
  it("summarises totals and only triages failures/errors", () => {
    const results = parseJUnitXml(
      suiteXml([
        { name: "a", status: "pass" },
        { name: "b", status: "pass" },
        { name: "c", status: "fail" },
      ]),
    );
    const run = triageRun(results, git(), 1, h);
    expect(run).toMatchObject({ total: 3, passed: 2, skipped: 0 });
    expect(run.triaged).toHaveLength(1);
    expect(run.triaged[0]!.result.name).toBe("c");
  });

  it("flake_confirmed: same commit, other attempt already recorded a pass", () => {
    record(
      { commitSha: "SHA", attempt: 1, startedAt: 1 },
      suiteXml([{ name: "t", status: "pass" }]),
    );
    const results = parseJUnitXml(suiteXml([{ name: "t", status: "fail" }]));
    const run = triageRun(results, git({ commitSha: "SHA" }), 2, h);
    expect(run.triaged[0]!.verdict.kind).toBe("flake_confirmed");
  });

  it("always_failing: recorded before, never green", () => {
    record({ commitSha: "c1", startedAt: 1 }, suiteXml([{ name: "t", status: "fail" }]));
    record({ commitSha: "c2", startedAt: 2 }, suiteXml([{ name: "t", status: "fail" }]));
    const results = parseJUnitXml(suiteXml([{ name: "t", status: "fail" }]));
    const run = triageRun(results, git({ commitSha: "c3", parentSha: "c2" }), 1, h);
    expect(run.triaged[0]!.verdict.kind).toBe("always_failing");
  });

  it("real_regression high: green on parent + a failing frame on a line this PR changed", () => {
    record(
      { commitSha: "c7parent", startedAt: 1 },
      suiteXml([{ name: "t", status: "pass", file: "src/pricing.py" }]),
    );
    const results = parseJUnitXml(
      suiteXml([
        {
          name: "t",
          status: "fail",
          file: "src/pricing.py",
          body: "AssertionError: expected 90 but got -10\n    at apply (src/pricing/discount.py:2)",
        },
      ]),
    );
    const run = triageRun(
      results,
      git({
        changedFiles: ["src/pricing/discount.py", "README.md"],
        diffHunks: [
          { file: "src/pricing/discount.py", newStart: 1, newLines: 3, changedLines: [1, 2, 3] },
        ],
      }),
      1,
      h,
    );
    const v = run.triaged[0]!.verdict;
    expect(v).toMatchObject({ kind: "real_regression", confidence: "high" });
    expect(v.blame?.[0]).toMatchObject({ proximity: "exact_line", changedFile: "src/pricing/discount.py" });
  });

  it("no blame link ⇒ a green-on-parent failure is ambiguous, not a regression", () => {
    record({ commitSha: "c7parent", startedAt: 1 }, suiteXml([{ name: "t", status: "pass" }]));
    const results = parseJUnitXml(suiteXml([{ name: "t", status: "fail" }]));
    const run = triageRun(
      results,
      git({ changedFiles: ["unrelated/other.ts"], diffHunks: [] }),
      1,
      h,
    );
    expect(run.triaged[0]!.verdict.kind).toBe("ambiguous");
  });

  it("flake_likely: repeated flips while the test file is untouched", () => {
    const seq: ("pass" | "fail")[] = ["pass", "fail", "pass", "fail", "pass"];
    seq.forEach((st, i) =>
      record(
        { commitSha: `c${i}`, startedAt: i, changedFiles: ["docs/readme.md"] },
        suiteXml([{ name: "t", status: st, file: "e2e/spec.ts" }]),
      ),
    );
    const results = parseJUnitXml(
      suiteXml([{ name: "t", status: "fail", file: "e2e/spec.ts" }]),
    );
    const run = triageRun(
      results,
      git({ commitSha: "cX", parentSha: "c4", changedFiles: ["docs/readme.md"] }),
      1,
      h,
    );
    expect(run.triaged[0]!.verdict.kind).toBe("flake_likely");
  });

  it("ambiguous: a lone failure with no parent record and no signal", () => {
    const results = parseJUnitXml(suiteXml([{ name: "t", status: "fail" }]));
    const run = triageRun(results, git({ parentSha: null, changedFiles: [] }), 1, h);
    expect(run.triaged[0]!.verdict.kind).toBe("ambiguous");
    expect(run.ambiguousCount).toBe(1);
  });
});

describe("applyEscalation", () => {
  const mv = (over: Partial<ModelVerdict>): ModelVerdict => ({
    test_key: T_KEY,
    kind: "real_regression",
    confidence: "high",
    one_line_reason: "the new sort() call is not stable",
    likely_cause: "sort comparator added in this commit is non-deterministic",
    suspect_location: "src/sort.ts:12",
    suggested_next_step: "make the comparator total",
    ...over,
  });

  function ambiguousRun(): ReturnType<typeof triageRun> {
    const results = parseJUnitXml(suiteXml([{ name: "t", status: "fail" }]));
    return triageRun(results, git({ parentSha: null }), 1, h);
  }

  function outcome(verdicts: ModelVerdict[], over: Partial<EscalationOutcome> = {}): EscalationOutcome {
    return {
      verdicts: new Map(verdicts.map((v) => [v.test_key, v])),
      deferred: [],
      usage: { inputTokens: 900, outputTokens: 60, cachedInputTokens: 0 },
      usd: 0.03,
      cacheHit: true,
      model: "claude-opus-5",
      provider: "anthropic",
      escalated: verdicts.length,
      ...over,
    };
  }

  it("replaces an ambiguous verdict with a model-sourced one", () => {
    const run = ambiguousRun();
    expect(run.triaged[0]!.verdict.kind).toBe("ambiguous");
    const updated = applyEscalation(run, outcome([mv({})]));
    const t = updated.triaged[0]!;
    expect(t.verdict.source).toBe("model");
    expect(t.verdict).toMatchObject({ kind: "real_regression", confidence: "high" });
    expect(t.model?.suggested_next_step).toBe("make the comparator total");
    expect(updated.ambiguousCount).toBe(0);
    expect(updated.escalation).toMatchObject({ usd: 0.03, model: "claude-opus-5", cacheHit: true });
  });

  it("keeps `unknown` as ambiguous but attaches the model's reasoning", () => {
    const run = ambiguousRun();
    const updated = applyEscalation(
      run,
      outcome([mv({ kind: "unknown", likely_cause: "", one_line_reason: "not enough history" })]),
    );
    const t = updated.triaged[0]!;
    expect(t.verdict.kind).toBe("ambiguous");
    expect(t.verdict.source).toBe("model");
    expect(t.model?.one_line_reason).toBe("not enough history");
    expect(updated.ambiguousCount).toBe(1);
  });

  it("carries the escalation error through without changing verdicts", () => {
    const run = ambiguousRun();
    const updated = applyEscalation(run, outcome([], { error: "network down", escalated: 0 }));
    expect(updated.triaged[0]!.verdict.kind).toBe("ambiguous");
    expect(updated.escalation?.error).toBe("network down");
  });

  it("does not touch a deterministic verdict even if the model returns one for it", () => {
    // record history so the failure classifies as always_failing, not ambiguous
    record({ commitSha: "c1", startedAt: 1 }, suiteXml([{ name: "t", status: "fail" }]));
    const results = parseJUnitXml(suiteXml([{ name: "t", status: "fail" }]));
    const run = triageRun(results, git({ commitSha: "c2", parentSha: "c1" }), 1, h);
    expect(run.triaged[0]!.verdict.kind).toBe("always_failing");
    const updated = applyEscalation(run, outcome([mv({ kind: "flake_likely" })]));
    expect(updated.triaged[0]!.verdict.kind).toBe("always_failing");
    expect(updated.triaged[0]!.verdict.source).toBe("history");
  });
});

describe("referencedFiles", () => {
  it("pulls source paths out of a stack and a message", () => {
    const files = referencedFiles(
      "at apply (src/pricing/discount.py:2)\n at run (D:/a/proj/e2e/spec.ts:9:1)",
      "failed in tests/test_x.py",
    );
    expect(files).toContain("src/pricing/discount.py");
    expect(files).toContain("tests/test_x.py");
    expect(files.some((f) => f.endsWith("e2e/spec.ts"))).toBe(true);
  });
});
