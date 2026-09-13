/**
 * playwright.ts — Playwright JSON report (`reporter: [["json", …]]`) → TestResult[]
 *
 * Why a second format: Playwright's JUnit reporter writes a test that failed and
 * then passed on retry as a plain pass (no retry count, no flaky marker), so
 * in-run flakes are invisible in JUnit. The JSON report keeps every attempt.
 *
 * The mapping keeps test keys identical to Playwright's JUnit output for the
 * same run, so history carries over when a project switches formats:
 *  - suite: the spec file, testDir-relative (JUnit `classname`)
 *  - name:  describe titles + test title, joined by " › " (JUnit `name`)
 *  - one result per test per project; the project name is NOT part of the key
 *    (the JUnit reporter writes identical testcases for every project too)
 *  - durationMs: the sum of all attempts (JUnit `time`)
 *
 * A flaky test (`status: "flaky"`) becomes `passed` with its failed attempts in
 * `retries`, which the pipeline reports as `flake_confirmed`.
 *
 * Pure w.r.t. I/O: {@link parsePlaywrightJson} takes a string.
 * {@link parsePlaywrightFile} is the thin fs wrapper.
 */

import { readFileSync } from "node:fs";

import { PlaywrightReportParseError } from "../core/errors.js";
import { stableSuite, testKey } from "../core/keys.js";
import type { Failure, TestResult, TestStatus } from "./junit.js";

interface PwError {
  message?: string;
  stack?: string;
}

interface PwResult {
  status?: string;
  duration?: number;
  error?: PwError;
  errors?: PwError[];
}

interface PwAnnotation {
  type?: string;
  description?: string;
}

interface PwTest {
  status?: string;
  annotations?: PwAnnotation[];
  results?: PwResult[];
}

interface PwSpec {
  title?: string;
  file?: string;
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Attempt statuses that count as a failed attempt. */
const FAILED_ATTEMPT = new Set(["failed", "timedOut", "interrupted"]);

function stripAnsi(text: string | undefined): string | null {
  if (text === undefined) return null;
  const clean = text.replace(ANSI, "").trim();
  return clean.length > 0 ? clean : null;
}

function toFailure(result: PwResult | undefined): Failure {
  const error = result?.error ?? result?.errors?.[0];
  const text = stripAnsi(error?.message);
  const firstLine = text?.split(/\r?\n/)[0]?.trim() ?? null;
  return {
    // Playwright's JUnit `message` is the first line without the "Error: " prefix.
    message: firstLine ? firstLine.replace(/^Error:\s*/, "") : null,
    type: null,
    stack: stripAnsi(error?.stack) ?? text,
  };
}

function statusOf(test: PwTest, last: PwResult | undefined): TestStatus {
  switch (test.status) {
    case "skipped":
      return "skipped";
    case "expected":
    case "flaky":
      return "passed";
    default:
      // "unexpected": a timeout or interruption is an error, anything else a failure
      return last?.status === "timedOut" || last?.status === "interrupted" ? "error" : "failed";
  }
}

function toTestResult(spec: PwSpec, test: PwTest, describePath: string[]): TestResult {
  const results = test.results ?? [];
  const last = results[results.length - 1];
  const suite = stableSuite(spec.file ?? "<unknown-file>");
  const name = [...describePath, spec.title ?? "<unnamed>"].join(" › ");
  const status = statusOf(test, last);
  const failedAttempts = results.filter((r) => FAILED_ATTEMPT.has(r.status ?? ""));

  let failure: Failure | null = null;
  if (status === "failed" || status === "error") {
    failure = failedAttempts.length > 0
      ? toFailure(failedAttempts[failedAttempts.length - 1])
      : { message: "expected to fail, but passed", type: null, stack: null };
  }

  const skip = test.annotations?.find((a) => a.type === "skip" || a.type === "fixme");

  return {
    suite,
    name,
    testKey: testKey(suite, name),
    status,
    durationMs: results.length > 0 ? results.reduce((sum, r) => sum + (r.duration ?? 0), 0) : null,
    file: null,
    failure,
    skipReason: status === "skipped" ? (skip?.description?.trim() || "skipped") : null,
    retries: status === "passed" ? failedAttempts.map(toFailure) : [],
  };
}

function walkSuite(suite: PwSuite, describePath: string[], out: TestResult[]): void {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) out.push(toTestResult(spec, test, describePath));
  }
  for (const child of suite.suites ?? []) {
    walkSuite(child, [...describePath, child.title ?? ""], out);
  }
}

/**
 * Parse one Playwright JSON report. `source` is used only for error messages.
 * Throws {@link PlaywrightReportParseError} on malformed JSON or a non-Playwright document.
 */
export function parsePlaywrightJson(json: string, source?: string): TestResult[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (cause) {
    throw new PlaywrightReportParseError("malformed JSON", { cause, source: source ?? "" });
  }

  const report = doc as { config?: unknown; suites?: unknown };
  if (typeof report !== "object" || report === null || typeof report.config !== "object" || !Array.isArray(report.suites)) {
    throw new PlaywrightReportParseError(
      "not a Playwright JSON report (expected top-level `config` and `suites`)",
      { source: source ?? "" },
    );
  }

  const out: TestResult[] = [];
  // Top-level suites are spec files; their titles are not part of the test name.
  for (const fileSuite of report.suites as PwSuite[]) walkSuite(fileSuite, [], out);
  return out;
}

/** Read + parse a Playwright JSON report from disk (UTF-8). */
export function parsePlaywrightFile(path: string): TestResult[] {
  let json: string;
  try {
    json = readFileSync(path, "utf8");
  } catch (cause) {
    throw new PlaywrightReportParseError(`cannot read report: ${path}`, { cause, source: path });
  }
  if (json.charCodeAt(0) === 0xfeff) json = json.slice(1);
  return parsePlaywrightJson(json, path);
}
