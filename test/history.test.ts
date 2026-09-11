import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { History } from "../src/core/history.js";
import type { RecordableResult, RunMeta } from "../src/core/history.js";
import { computeFlakyStats } from "../src/core/flakiness.js";
import type { TestStatus } from "../src/ingest/junit.js";

let h: History;
beforeEach(() => {
  h = History.open(":memory:");
});
afterEach(() => h.close());

function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    repo: "acme/widgets",
    commitSha: "c0ffee",
    parentSha: "beef",
    branch: "main",
    ciRunId: null,
    attempt: 1,
    startedAt: 1_000,
    changedFiles: [],
    ...over,
  };
}

function res(
  name: string,
  status: TestStatus,
  over: Partial<RecordableResult> = {},
): RecordableResult {
  return {
    suite: "acme.WidgetTest",
    testName: name,
    testKey: `key-${name}`,
    status,
    durationMs: 100,
    message: status === "passed" || status === "skipped" ? null : `${name} failed`,
    stack: null,
    fingerprint: status === "failed" || status === "error" ? `fp-${name}` : null,
    ...over,
  };
}

describe("History.recordRun + reads", () => {
  it("records a run and its results atomically, returning the run id", () => {
    const { runId, inserted } = h.recordRun(meta(), [res("a", "passed"), res("b", "failed")]);
    expect(runId).toBe(1);
    expect(inserted).toBe(true);
    const s = h.summary();
    expect(s).toMatchObject({ runs: 1, results: 2, distinctTests: 2 });
  });

  it("is idempotent on (repo, commit_sha, ci_run_id, attempt) — a re-run writes nothing", () => {
    const m = meta({ ciRunId: "gha-4242", attempt: 1 });
    const first = h.recordRun(m, [res("a", "failed")]);
    expect(first.inserted).toBe(true);

    const again = h.recordRun(m, [res("a", "failed"), res("b", "failed")]);
    expect(again).toEqual({ runId: first.runId, inserted: false });

    const s = h.summary();
    expect(s.runs).toBe(1);
    expect(s.results).toBe(1); // the 2nd call's extra result was NOT written
  });

  it("runExists checks the dedup tuple without a write — lets backfill skip re-fetching", () => {
    expect(h.runExists("acme/widgets", "SHA", "gha-1", 1)).toBe(false);
    h.recordRun(meta({ commitSha: "SHA", ciRunId: "gha-1", attempt: 1 }), [res("a", "passed")]);
    expect(h.runExists("acme/widgets", "SHA", "gha-1", 1)).toBe(true);
    expect(h.runExists("acme/widgets", "SHA", "gha-1", 2)).toBe(false); // different attempt
    expect(h.runExists("acme/widgets", "SHA", "gha-2", 1)).toBe(false); // different ci_run_id
    expect(h.runExists("other/repo", "SHA", "gha-1", 1)).toBe(false); // different repo
  });

  it("local runs (NULL ci_run_id) never dedupe, even for the same commit+attempt", () => {
    const m = meta({ ciRunId: null, commitSha: "LOCAL", attempt: 1 });
    expect(h.recordRun(m, [res("a", "failed")]).inserted).toBe(true);
    expect(h.recordRun(m, [res("a", "passed")]).inserted).toBe(true);
    expect(h.summary().runs).toBe(2);
  });

  it("timelineByTestKey returns results oldest-first with run context", () => {
    h.recordRun(meta({ commitSha: "c1", startedAt: 10 }), [res("a", "passed")]);
    h.recordRun(meta({ commitSha: "c2", startedAt: 20 }), [res("a", "failed")]);
    const tl = h.timelineByTestKey("key-a");
    expect(tl.map((t) => [t.commitSha, t.status])).toEqual([
      ["c1", "passed"],
      ["c2", "failed"],
    ]);
    expect(tl[1]!.fingerprint).toBe("fp-a");
    expect(tl[1]!.branch).toBe("main");
  });

  it("passedInAnotherAttempt detects a same-commit retry that went green", () => {
    h.recordRun(meta({ commitSha: "SHA", attempt: 1 }), [res("flaky", "failed")]);
    h.recordRun(meta({ commitSha: "SHA", attempt: 2 }), [res("flaky", "passed")]);
    expect(h.passedInAnotherAttempt("SHA", "key-flaky", 1)).toBe(true);
    expect(h.passedInAnotherAttempt("SHA", "key-flaky", 2)).toBe(false); // itself
    expect(h.passedInAnotherAttempt("OTHER", "key-flaky", 1)).toBe(false);
  });

  it("findTests resolves exact name, suite::name substring and key prefix", () => {
    h.recordRun(meta(), [res("renders widget", "passed"), res("adds", "passed")]);
    h.recordRun(meta({ startedAt: 2000 }), [res("renders widget", "failed")]);

    expect(h.findTests("renders widget")[0]).toMatchObject({
      testKey: "key-renders widget",
      runs: 2,
    });
    expect(h.findTests("WidgetTest::adds")).toHaveLength(1);
    expect(h.findTests("key-adds")).toHaveLength(1);
    expect(h.findTests("nope")).toEqual([]);
  });

  it("fingerprintSpread counts occurrences across branches and commits", () => {
    h.recordRun(meta({ branch: "feat-1", commitSha: "a" }), [
      res("x", "failed", { fingerprint: "SHARED" }),
    ]);
    h.recordRun(meta({ branch: "feat-2", commitSha: "b" }), [
      res("y", "failed", { fingerprint: "SHARED", testKey: "key-y" }),
    ]);
    h.recordRun(meta({ branch: "feat-2", commitSha: "c" }), [
      res("x", "failed", { fingerprint: "SHARED" }),
    ]);
    const spread = h.fingerprintSpread("SHARED");
    expect(spread).toMatchObject({
      occurrences: 3,
      distinctBranches: 2,
      distinctCommits: 3,
      distinctTestKeys: 2,
    });
    expect(h.fingerprintSpread("unknown")).toBeNull();
  });

  it("rowsForFlakiness feeds computeFlakyStats end-to-end", () => {
    const seq: TestStatus[] = ["passed", "failed", "passed", "failed", "passed"];
    seq.forEach((st, i) =>
      h.recordRun(meta({ commitSha: `c${i}`, startedAt: 100 + i }), [res("t", st)]),
    );
    const stats = computeFlakyStats(h.rowsForFlakiness(200), { minRuns: 3 });
    expect(stats[0]).toMatchObject({ testName: "t", runs: 5, flips: 4 });
  });

  it("rowsForFlakiness windows to the most recent N runs", () => {
    for (let i = 0; i < 10; i += 1) {
      h.recordRun(meta({ commitSha: `c${i}`, startedAt: 100 + i }), [res("t", "passed")]);
    }
    expect(new Set(h.rowsForFlakiness(3).map((r) => r.runId)).size).toBe(3);
  });

  it("wraps a write failure in a typed HistoryError", () => {
    const bad = [{ ...res("a", "passed"), status: null as unknown as TestStatus }];
    // status has a NOT NULL constraint
    expect(() => h.recordRun(meta(), bad)).toThrowError(/record run/i);
  });
});
