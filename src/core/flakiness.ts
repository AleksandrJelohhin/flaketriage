/**
 * flakiness.ts — pure flip-rate / flakiness math over a test's timeline.
 *
 * "Flip rate" = how often a test's outcome changes between consecutive runs,
 * ignoring skips. A test that goes P F P F P F over 6 runs has 5 flips / 5
 * transitions = 100%. A test that goes P P P F F F has 1 flip / 5 = 20%.
 *
 * No I/O, no clock — {@link computeFlakyStats} takes rows already read from the
 * history store and sorts them itself.
 */

import type { TestStatus } from "../ingest/junit.js";

/** One recorded result, as needed for flakiness math. */
export interface TimelineRow {
  testKey: string;
  suite: string;
  testName: string;
  status: TestStatus;
  /** epoch ms — used only for ordering. */
  startedAt: number;
  /** tie-breaker when two runs share a timestamp (e.g. CI retries). */
  runId: number;
  fingerprint: string | null;
}

export interface FlakyStat {
  testKey: string;
  suite: string;
  testName: string;
  /** non-skipped runs considered. */
  runs: number;
  /** consecutive pass↔fail transitions. */
  flips: number;
  /** flips / (runs - 1); 0 when runs < 2. */
  flipRate: number;
  passes: number;
  failures: number;
  lastStatus: TestStatus;
  /** distinct non-null fingerprints seen across the failures. */
  distinctFingerprints: number;
}

export interface FlakyStatsOptions {
  /** Ignore tests with fewer than this many non-skipped runs. Default 3. */
  minRuns?: number;
}

type Outcome = "pass" | "fail";

function outcome(status: TestStatus): Outcome | null {
  if (status === "passed") return "pass";
  if (status === "failed" || status === "error") return "fail";
  return null; // skipped — not a data point
}

function byOrder(a: TimelineRow, b: TimelineRow): number {
  return a.startedAt - b.startedAt || a.runId - b.runId;
}

/**
 * Group rows by `testKey`, order each group by time, and compute flip stats.
 * Returns every test with `runs >= minRuns`, sorted flakiest-first
 * (flip rate desc, then flips desc, then more runs first).
 */
export function computeFlakyStats(
  rows: TimelineRow[],
  opts: FlakyStatsOptions = {},
): FlakyStat[] {
  const minRuns = opts.minRuns ?? 3;

  const groups = new Map<string, TimelineRow[]>();
  for (const row of rows) {
    let g = groups.get(row.testKey);
    if (!g) groups.set(row.testKey, (g = []));
    g.push(row);
  }

  const out: FlakyStat[] = [];
  for (const [testKey, groupRows] of groups) {
    groupRows.sort(byOrder);

    const outcomes: Outcome[] = [];
    let passes = 0;
    let failures = 0;
    const fps = new Set<string>();
    for (const r of groupRows) {
      const o = outcome(r.status);
      if (o === null) continue;
      outcomes.push(o);
      if (o === "pass") passes += 1;
      else failures += 1;
      if (r.fingerprint) fps.add(r.fingerprint);
    }

    if (outcomes.length < minRuns) continue;

    let flips = 0;
    for (let i = 1; i < outcomes.length; i += 1) {
      if (outcomes[i] !== outcomes[i - 1]) flips += 1;
    }

    const last = groupRows[groupRows.length - 1]!;
    out.push({
      testKey,
      suite: last.suite,
      testName: last.testName,
      runs: outcomes.length,
      flips,
      flipRate: outcomes.length > 1 ? flips / (outcomes.length - 1) : 0,
      passes,
      failures,
      lastStatus: last.status,
      distinctFingerprints: fps.size,
    });
  }

  out.sort(
    (a, b) =>
      b.flipRate - a.flipRate || b.flips - a.flips || b.runs - a.runs,
  );
  return out;
}
