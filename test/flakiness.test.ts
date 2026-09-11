import { describe, expect, it } from "vitest";

import { computeFlakyStats } from "../src/core/flakiness.js";
import type { TimelineRow } from "../src/core/flakiness.js";
import type { TestStatus } from "../src/ingest/junit.js";

/** Build a timeline for one test from a compact status string, e.g. "PPFPF". */
function timeline(
  key: string,
  seq: string,
  opts: { suite?: string; name?: string; fp?: (i: number) => string | null } = {},
): TimelineRow[] {
  const map: Record<string, TestStatus> = {
    P: "passed",
    F: "failed",
    E: "error",
    S: "skipped",
  };
  return [...seq].map((ch, i) => ({
    testKey: key,
    suite: opts.suite ?? "suite",
    testName: opts.name ?? key,
    status: map[ch]!,
    startedAt: 1_000 + i,
    runId: i + 1,
    fingerprint: map[ch] === "passed" || map[ch] === "skipped" ? null : (opts.fp?.(i) ?? "fp0"),
  }));
}

describe("computeFlakyStats", () => {
  it("counts consecutive pass↔fail transitions", () => {
    const [s] = computeFlakyStats(timeline("t", "PFPFPF"));
    expect(s).toMatchObject({ runs: 6, flips: 5, passes: 3, failures: 3 });
    expect(s!.flipRate).toBeCloseTo(1);
  });

  it("a stable-then-broken test has a low flip rate", () => {
    const [s] = computeFlakyStats(timeline("t", "PPPFFF"));
    expect(s).toMatchObject({ flips: 1, runs: 6 });
    expect(s!.flipRate).toBeCloseTo(0.2);
    expect(s!.lastStatus).toBe("failed");
  });

  it("treats `error` as a failure outcome and ignores `skipped`", () => {
    const [s] = computeFlakyStats(timeline("t", "PSESP"));
    // outcomes after dropping S: P E P  → flips P→E, E→P = 2 over 2 transitions
    expect(s).toMatchObject({ runs: 3, flips: 2, passes: 2, failures: 1 });
  });

  it("drops tests below minRuns (non-skipped)", () => {
    expect(computeFlakyStats(timeline("t", "PF"), { minRuns: 3 })).toEqual([]);
    expect(computeFlakyStats(timeline("t", "PFP"), { minRuns: 3 })).toHaveLength(1);
    expect(computeFlakyStats(timeline("t", "PSFSP"), { minRuns: 3 })).toHaveLength(1);
  });

  it("orders flakiest-first (flip rate, then flips, then run count)", () => {
    const rows = [
      ...timeline("stable", "PPPPP"),
      ...timeline("veryFlaky", "PFPFP"),
      ...timeline("someFlaky", "PPFPP"),
    ];
    expect(computeFlakyStats(rows).map((s) => s.testKey)).toEqual([
      "veryFlaky",
      "someFlaky",
      "stable",
    ]);
  });

  it("sorts each test's runs by time then runId before counting", () => {
    const shuffled: TimelineRow[] = [
      { testKey: "t", suite: "s", testName: "t", status: "failed", startedAt: 30, runId: 3, fingerprint: "a" },
      { testKey: "t", suite: "s", testName: "t", status: "passed", startedAt: 10, runId: 1, fingerprint: null },
      { testKey: "t", suite: "s", testName: "t", status: "passed", startedAt: 20, runId: 2, fingerprint: null },
    ];
    const [s] = computeFlakyStats(shuffled);
    expect(s).toMatchObject({ flips: 1, lastStatus: "failed" });
  });

  it("reports distinct fingerprints across a test's failures", () => {
    const rows = timeline("t", "FFFF", { fp: (i) => (i < 2 ? "aaa" : "bbb") });
    const [s] = computeFlakyStats(rows);
    expect(s!.distinctFingerprints).toBe(2);
  });
});
