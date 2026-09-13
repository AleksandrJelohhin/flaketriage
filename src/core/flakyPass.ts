/**
 * flakyPass.ts — flakes hiding in PASSING tests.
 *
 * {@link classify} only ever sees failures, so a test that failed and then passed
 * never reaches it. Two facts prove a flake on a passing test, without inference:
 *
 *   1. in-run retries  — the report records failed attempts before the pass
 *                        (Surefire `<flakyFailure>` / `<rerunFailure>` …)
 *   2. another attempt — the same commit has a recorded failing attempt, i.e. a
 *                        CI re-run went green on unchanged code
 *
 * Pure: no I/O, no clock, no randomness.
 */

import type { Verdict } from "./classify.js";
import type { Failure } from "../ingest/junit.js";

export interface PassedTestInput {
  commitSha: string;
  /** the attempt being triaged, in which the test passed. */
  attempt: number;
  /** failures from earlier attempts of THIS run, as recorded in the report. */
  retries: Failure[];
  /** other attempts of this commit in which the test failed or errored. */
  failedAttemptsOnCommit: number[];
}

const MAX_REASON = 160;

/** `flake_confirmed` when a passing test carries proof of an earlier failure, else `null`. */
export function classifyPassedTest(input: PassedTestInput): Verdict | null {
  const evidence: string[] = [];

  if (input.retries.length > 0) {
    const n = input.retries.length;
    const first = input.retries[0]!;
    const reason = firstLine(first.message ?? first.stack ?? first.type);
    evidence.push(
      `failed ${n === 1 ? "once" : `${n} times`}, then passed on retry in this run ` +
        `(attempt ${input.attempt})${reason ? ` — first failure: ${reason}` : ""}`,
    );
  }

  const failed = input.failedAttemptsOnCommit;
  if (failed.length > 0) {
    evidence.push(
      `failed in attempt${failed.length === 1 ? "" : "s"} ${failed.join(", ")} of the same commit ` +
        `${input.commitSha.slice(0, 7)} and passed in attempt ${input.attempt} — ` +
        `the code did not change between attempts`,
    );
  }

  if (evidence.length === 0) return null;
  // Deterministic proof from the report or the recorded history, never the model.
  return { kind: "flake_confirmed", confidence: "high", source: "history", evidence };
}

function firstLine(text: string | null): string | null {
  if (!text) return null;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}
