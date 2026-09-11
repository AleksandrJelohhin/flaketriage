/**
 * history.ts — the persistent run history.
 *
 * This is the one module in `core/` that does I/O: it is the SQLite persistence
 * layer. Everything it returns is plain data that the pure modules
 * ({@link computeFlakyStats}) and the CLI consume.
 *
 * Schema is created on open (idempotent). `test_key` / `fingerprint` are indexed —
 * those two lookups are the hot path for the classifier.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { HistoryError } from "./errors.js";
import type { TimelineRow } from "./flakiness.js";
import type { TestStatus } from "../ingest/junit.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY,
  repo          TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  parent_sha    TEXT,
  branch        TEXT,
  ci_run_id     TEXT,
  attempt       INTEGER NOT NULL DEFAULT 1,
  started_at    INTEGER NOT NULL,
  changed_files TEXT               -- newline-joined repo-relative paths from the diff
);
CREATE TABLE IF NOT EXISTS results (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  suite         TEXT NOT NULL,
  test_name     TEXT NOT NULL,
  test_key      TEXT NOT NULL,
  status        TEXT NOT NULL,
  duration_ms   INTEGER,
  message       TEXT,
  stack         TEXT,
  fingerprint   TEXT
);
CREATE INDEX IF NOT EXISTS idx_results_testkey ON results(test_key);
CREATE INDEX IF NOT EXISTS idx_results_fp      ON results(fingerprint);
CREATE INDEX IF NOT EXISTS idx_results_run     ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_commit     ON runs(commit_sha);
-- backfill idempotency. NULLs are distinct in SQLite, so local CLI
-- runs (ci_run_id NULL) are never blocked; only runs with a real ci_run_id dedupe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dedup
  ON runs(repo, commit_sha, ci_run_id, attempt);
`;

// Roll several `<testcase>` rows that share a test_key within one run into a
// single run-level outcome (parametrised tests, in-report retries, dupes).
const ROLLUP_STATUS = `CASE
  WHEN SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'failed'
  WHEN SUM(CASE WHEN r.status = 'error'  THEN 1 ELSE 0 END) > 0 THEN 'error'
  WHEN SUM(CASE WHEN r.status = 'passed' THEN 1 ELSE 0 END) > 0 THEN 'passed'
  ELSE 'skipped' END`;
const ROLLUP_FINGERPRINT = `MAX(CASE WHEN r.status IN ('failed','error') THEN r.fingerprint END)`;
const ROLLUP_MESSAGE = `MAX(CASE WHEN r.status IN ('failed','error') THEN r.message END)`;

function splitFiles(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Idempotent additive migrations for DBs created by an earlier version. */
function migrate(db: Database.Database): void {
  const idx = db.prepare(`PRAGMA index_list(runs)`).all() as { name: string }[];
  if (!idx.some((i) => i.name === "idx_runs_dedup")) {
    // may fail if the existing DB already has duplicate (repo,sha,ci_run_id,attempt)
    // rows — tolerate it, the index is best-effort on legacy data.
    try {
      db.exec(
        `CREATE UNIQUE INDEX idx_runs_dedup ON runs(repo, commit_sha, ci_run_id, attempt)`,
      );
    } catch {
      /* legacy DB with dup rows — leave unindexed */
    }
  }
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "changed_files")) {
    db.exec(`ALTER TABLE runs ADD COLUMN changed_files TEXT`);
  }
}

export interface RunMeta {
  repo: string;
  commitSha: string;
  parentSha: string | null;
  branch: string | null;
  ciRunId: string | null;
  attempt: number;
  /** epoch ms — injected by the caller, never read from a clock here. */
  startedAt: number;
  /** repo-relative paths changed between parent and commit (from git.ts). */
  changedFiles: string[];
}

export interface RecordableResult {
  suite: string;
  testName: string;
  testKey: string;
  status: TestStatus;
  durationMs: number | null;
  message: string | null;
  stack: string | null;
  fingerprint: string | null;
}

export interface TimelineEntry {
  runId: number;
  commitSha: string;
  parentSha: string | null;
  branch: string | null;
  attempt: number;
  startedAt: number;
  status: TestStatus;
  durationMs: number | null;
  fingerprint: string | null;
  message: string | null;
  /** repo-relative paths changed in this run's commit (may be empty). */
  changedFiles: string[];
}

export interface TestIdentity {
  testKey: string;
  suite: string;
  testName: string;
  runs: number;
}

export interface LatestFailure {
  suite: string;
  testName: string;
  status: TestStatus;
  message: string | null;
  stack: string | null;
  fingerprint: string | null;
  runId: number;
  commitSha: string;
  parentSha: string | null;
  branch: string | null;
  attempt: number;
  startedAt: number;
  changedFiles: string[];
}

export interface FingerprintSpread {
  fingerprint: string;
  occurrences: number;
  distinctBranches: number;
  distinctCommits: number;
  distinctTestKeys: number;
  firstSeen: number;
  lastSeen: number;
  sampleMessage: string | null;
}

export interface HistorySummary {
  runs: number;
  results: number;
  distinctTests: number;
  distinctFingerprints: number;
  firstRun: number | null;
  lastRun: number | null;
}

interface RunRow {
  id: number;
  commit_sha: string;
  parent_sha: string | null;
  branch: string | null;
  attempt: number;
  started_at: number;
}

export class History {
  private readonly db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  /** Open (creating parent dirs + schema). Pass `:memory:` for tests. */
  static open(path: string): History {
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.exec(SCHEMA);
      migrate(db);
      return new History(db);
    } catch (cause) {
      throw new HistoryError(`cannot open history store at ${path}`, { cause });
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Insert one run and all its results atomically.
   *
   * Idempotent on `(repo, commit_sha, ci_run_id, attempt)` — when that tuple is
   * already recorded (a backfill re-run), nothing is written and the existing
   * run id is returned with `inserted: false`. Local CLI runs have a NULL
   * `ci_run_id`, which SQLite treats as always-distinct, so they never dedupe.
   */
  recordRun(meta: RunMeta, results: RecordableResult[]): { runId: number; inserted: boolean } {
    const insertRun = this.db.prepare<
      [
        string,
        string,
        string | null,
        string | null,
        string | null,
        number,
        number,
        string | null,
      ]
    >(
      `INSERT OR IGNORE INTO runs
        (repo, commit_sha, parent_sha, branch, ci_run_id, attempt, started_at, changed_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findRun = this.db.prepare<[string, string, string | null, number]>(
      `SELECT id FROM runs
        WHERE repo = ? AND commit_sha = ? AND ci_run_id IS ? AND attempt = ?`,
    );
    const insertResult = this.db.prepare(
      `INSERT INTO results
        (run_id, suite, test_name, test_key, status, duration_ms, message, stack, fingerprint)
       VALUES (@runId, @suite, @testName, @testKey, @status, @durationMs, @message, @stack, @fingerprint)`,
    );

    const tx = this.db.transaction((): { runId: number; inserted: boolean } => {
      const info = insertRun.run(
        meta.repo,
        meta.commitSha,
        meta.parentSha,
        meta.branch,
        meta.ciRunId,
        meta.attempt,
        meta.startedAt,
        meta.changedFiles.length > 0 ? meta.changedFiles.join("\n") : null,
      );
      if (info.changes === 0) {
        // already recorded — return the existing id, write nothing
        const existing = findRun.get(
          meta.repo,
          meta.commitSha,
          meta.ciRunId,
          meta.attempt,
        ) as { id: number } | undefined;
        return { runId: existing?.id ?? -1, inserted: false };
      }
      const runId = Number(info.lastInsertRowid);
      for (const r of results) {
        insertResult.run({
          runId,
          suite: r.suite,
          testName: r.testName,
          testKey: r.testKey,
          status: r.status,
          durationMs: r.durationMs,
          message: r.message,
          stack: r.stack,
          fingerprint: r.fingerprint,
        });
      }
      return { runId, inserted: true };
    });

    try {
      return tx();
    } catch (cause) {
      throw new HistoryError("failed to record run", { cause });
    }
  }

  /**
   * True when `(repo, commit_sha, ci_run_id, attempt)` is already recorded — the
   * same tuple `recordRun` dedupes on. Lets a caller (backfill) skip re-fetching
   * artifacts it already has instead of downloading and then discarding them.
   */
  runExists(repo: string, commitSha: string, ciRunId: string | null, attempt: number): boolean {
    const row = this.db
      .prepare<[string, string, string | null, number]>(
        `SELECT 1 FROM runs WHERE repo = ? AND commit_sha = ? AND ci_run_id IS ? AND attempt = ?`,
      )
      .get(repo, commitSha, ciRunId, attempt);
    return row !== undefined;
  }

  /** True when the same `testKey` already passed in another attempt of `commitSha`. */
  passedInAnotherAttempt(commitSha: string, testKey: string, attempt: number): boolean {
    const row = this.db
      .prepare<[string, string, number]>(
        `SELECT 1
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.commit_sha = ? AND r.test_key = ? AND ru.attempt != ?
            AND r.status = 'passed'
          LIMIT 1`,
      )
      .get(commitSha, testKey, attempt);
    return row !== undefined;
  }

  /**
   * Full pass/fail timeline for one test, oldest first — one entry per recorded
   * run. Parametrised/repeated `<testcase>` entries that share a `test_key`
   * within a run are rolled up: the run counts as `failed` if any entry failed
   * or errored, else `passed` if any passed, else `skipped`.
   */
  timelineByTestKey(testKey: string): TimelineEntry[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT ru.id AS runId, ru.commit_sha AS commitSha, ru.parent_sha AS parentSha,
                ru.branch AS branch, ru.attempt AS attempt, ru.started_at AS startedAt,
                ${ROLLUP_STATUS} AS status,
                SUM(r.duration_ms) AS durationMs,
                ${ROLLUP_FINGERPRINT} AS fingerprint,
                ${ROLLUP_MESSAGE} AS message,
                ru.changed_files AS changedFilesRaw
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.test_key = ?
          GROUP BY ru.id
          ORDER BY ru.started_at ASC, ru.id ASC`,
      )
      .all(testKey) as (Omit<TimelineEntry, "changedFiles"> & {
      changedFilesRaw: string | null;
    })[];
    return rows.map(({ changedFilesRaw, ...rest }) => ({
      ...rest,
      changedFiles: splitFiles(changedFilesRaw),
    }));
  }

  /** The most recent recorded failure/error for a test, with full stack + run context. */
  latestFailure(testKey: string): LatestFailure | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT r.suite AS suite, r.test_name AS testName, r.status AS status,
                r.message AS message, r.stack AS stack, r.fingerprint AS fingerprint,
                ru.id AS runId, ru.commit_sha AS commitSha, ru.parent_sha AS parentSha,
                ru.branch AS branch, ru.attempt AS attempt, ru.started_at AS startedAt,
                ru.changed_files AS changedFilesRaw
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.test_key = ? AND r.status IN ('failed','error')
          ORDER BY ru.started_at DESC, ru.id DESC
          LIMIT 1`,
      )
      .get(testKey) as
      | (Omit<LatestFailure, "changedFiles"> & { changedFilesRaw: string | null })
      | undefined;
    if (!row) return null;
    const { changedFilesRaw, ...rest } = row;
    return { ...rest, changedFiles: splitFiles(changedFilesRaw) };
  }

  /** Rollup outcome for a test on a specific commit; `null` if never recorded there. */
  outcomeOnCommit(commitSha: string, testKey: string): "pass" | "fail" | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT ${ROLLUP_STATUS} AS status
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.commit_sha = ? AND r.test_key = ?`,
      )
      .get(commitSha, testKey) as { status: TestStatus | null } | undefined;
    if (!row || row.status === null) return null;
    if (row.status === "passed") return "pass";
    if (row.status === "failed" || row.status === "error") return "fail";
    return null; // only skipped rows recorded
  }

  /** Distinct prior runs that recorded this test at all. */
  runCountForTest(testKey: string): number {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(DISTINCT run_id) AS n FROM results WHERE test_key = ?`,
      )
      .get(testKey) as { n: number };
    return row.n;
  }

  /** True when this test has ever been recorded as passing. */
  everPassed(testKey: string): boolean {
    const row = this.db
      .prepare<[string]>(
        `SELECT 1 FROM results WHERE test_key = ? AND status = 'passed' LIMIT 1`,
      )
      .get(testKey);
    return row !== undefined;
  }

  /**
   * Resolve a user-supplied string to test identities: exact test name, then
   * substring of `suite::name`, then `test_key` prefix. Ordered by run count desc.
   */
  findTests(query: string): TestIdentity[] {
    const rows = this.db
      .prepare<[string, string, string]>(
        `SELECT r.test_key AS testKey,
                MAX(r.suite) AS suite, MAX(r.test_name) AS testName,
                COUNT(DISTINCT r.run_id) AS runs
           FROM results r
          WHERE r.test_name = ?
             OR (r.suite || '::' || r.test_name) LIKE ?
             OR r.test_key LIKE ?
          GROUP BY r.test_key
          ORDER BY runs DESC, suite ASC, testName ASC`,
      )
      .all(query, `%${query}%`, `${query}%`) as TestIdentity[];
    return rows;
  }

  /**
   * One row per (test, run) for flakiness math, most-recent `window` runs only.
   * Parametrised entries are rolled up (see {@link timelineByTestKey}).
   * Skipped rows are included; {@link computeFlakyStats} filters them.
   */
  rowsForFlakiness(window = 200): TimelineRow[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT r.test_key AS testKey,
                MAX(r.suite) AS suite, MAX(r.test_name) AS testName,
                ${ROLLUP_STATUS} AS status,
                ru.started_at AS startedAt, ru.id AS runId,
                ${ROLLUP_FINGERPRINT} AS fingerprint
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.id > (SELECT COALESCE(MAX(id), 0) - ? FROM runs)
          GROUP BY r.test_key, ru.id
          ORDER BY ru.started_at ASC, ru.id ASC`,
      )
      .all(window) as TimelineRow[];
    return rows;
  }

  /** How widely a single failure fingerprint has spread. */
  fingerprintSpread(fingerprint: string): FingerprintSpread | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(*) AS occurrences,
                COUNT(DISTINCT ru.branch) AS distinctBranches,
                COUNT(DISTINCT ru.commit_sha) AS distinctCommits,
                COUNT(DISTINCT r.test_key) AS distinctTestKeys,
                MIN(ru.started_at) AS firstSeen,
                MAX(ru.started_at) AS lastSeen
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.fingerprint = ?`,
      )
      .get(fingerprint) as Omit<FingerprintSpread, "fingerprint" | "sampleMessage"> & {
      occurrences: number;
    };
    if (!row || row.occurrences === 0) return null;
    const sample = this.db
      .prepare<[string]>(
        `SELECT message FROM results WHERE fingerprint = ? AND message IS NOT NULL LIMIT 1`,
      )
      .get(fingerprint) as { message: string | null } | undefined;
    return { fingerprint, sampleMessage: sample?.message ?? null, ...row };
  }

  summary(): HistorySummary {
    const runs = this.db.prepare(`SELECT COUNT(*) c FROM runs`).get() as { c: number };
    const res = this.db
      .prepare(
        `SELECT COUNT(*) results,
                COUNT(DISTINCT test_key) tests,
                COUNT(DISTINCT fingerprint) fps
           FROM results`,
      )
      .get() as { results: number; tests: number; fps: number };
    const span = this.db
      .prepare(`SELECT MIN(started_at) lo, MAX(started_at) hi FROM runs`)
      .get() as { lo: number | null; hi: number | null };
    return {
      runs: runs.c,
      results: res.results,
      distinctTests: res.tests,
      distinctFingerprints: res.fps,
      firstRun: span.lo,
      lastRun: span.hi,
    };
  }

  /** Every recorded run, newest first — used by `history` with no argument. */
  recentRuns(limit = 20): RunRow[] {
    return this.db
      .prepare<[number]>(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`)
      .all(limit) as RunRow[];
  }
}
