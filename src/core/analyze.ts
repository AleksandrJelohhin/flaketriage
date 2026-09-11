/**
 * analyze.ts — attach a fingerprint to each parsed {@link TestResult}.
 *
 * This is the `normalize → fingerprint` step of the pipeline, applied to a whole
 * report. Pure: no I/O, no clock.
 */

import type { NormalizeOptions } from "./normalize.js";
import { fingerprintFailure } from "./fingerprint.js";
import type { TestResult } from "../ingest/junit.js";

export interface AnalyzedResult extends TestResult {
  /** sha256-16 of the normalised failure. `null` when the test passed or was skipped. */
  fingerprint: string | null;
}

export function analyzeResults(
  results: TestResult[],
  opts: NormalizeOptions = {},
): AnalyzedResult[] {
  return results.map((r) => ({
    ...r,
    fingerprint:
      r.failure && (r.status === "failed" || r.status === "error")
        ? fingerprintFailure(r.failure, opts)
        : null,
  }));
}
