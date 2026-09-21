import{createRequire}from'node:module';const require=createRequire(import.meta.url);

// action/index.ts
import { relative as relative2 } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";

// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// src/core/errors.ts
var FlakeTriageError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
};
var JUnitParseError = class extends FlakeTriageError {
  /** Path or label of the offending report, when known. */
  source;
  constructor(message, options) {
    super("JUNIT_PARSE", message, options);
    this.source = options?.source;
  }
};
var PlaywrightReportParseError = class extends FlakeTriageError {
  /** Path or label of the offending report, when known. */
  source;
  constructor(message, options) {
    super("PLAYWRIGHT_PARSE", message, options);
    this.source = options?.source;
  }
};
var GitContextError = class extends FlakeTriageError {
  constructor(message, options) {
    super("GIT_CONTEXT", message, options);
  }
};
var HistoryError = class extends FlakeTriageError {
  constructor(message, options) {
    super("HISTORY_IO", message, options);
  }
};
var LlmError = class extends FlakeTriageError {
  constructor(message, options) {
    super("LLM_FAILURE", message, options);
  }
};

// src/config.ts
var ConfigSchema = z.object({
  llm: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    base_url: z.string().optional()
  }).strict().optional(),
  redact: z.object({
    patterns: z.array(z.string()).optional()
  }).strict().optional()
});
var CONFIG_FILENAMES = [".flaketriage.yml", ".flaketriage.yaml"];
var EMPTY = { config: {}, path: null };
function loadConfig(repoPath) {
  for (const name of CONFIG_FILENAMES) {
    const path = join(repoPath, name);
    if (!existsSync(path)) continue;
    let raw;
    try {
      raw = parseYaml(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new FlakeTriageError("CONFIG_INVALID", `${name}: invalid YAML`, { cause });
    }
    const result = ConfigSchema.safeParse(raw ?? {});
    if (!result.success) {
      const detail = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
      throw new FlakeTriageError("CONFIG_INVALID", `${name}: ${detail}`);
    }
    return { config: result.data, path };
  }
  return EMPTY;
}

// src/llm/payload.ts
var REDACTED = "[REDACTED]";
var DEFAULT_REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-_.=]+/gi,
  /(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
];
function redact(text, extraPatterns = []) {
  let out = text;
  for (const pattern of [...DEFAULT_REDACT_PATTERNS, ...extraPatterns]) {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    out = out.replace(global, REDACTED);
  }
  return out;
}
function compilePatterns(sources) {
  return sources.map((source) => new RegExp(source, "gi"));
}

// src/run.ts
import { resolve as resolve2 } from "node:path";

// src/core/fingerprint.ts
import { createHash } from "node:crypto";

// src/core/normalize.ts
var DEFAULT_MAX_FRAMES = 5;
var ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
var RULE_RUN = /[\u2500-\u257F\u2580-\u259F\u2014\u2015=_*.\u00b7\u2022\u2013]{4,}/g;
var ISO_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
var EPOCH_MS = /\b\d{13}\b/g;
var UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
var WIN_TEMP = /[A-Za-z]:\\(?:Users\\[^\\/\r\n]+\\AppData\\Local\\Temp|Windows\\Temp|Temp)\\[^\s"'()\]]*/gi;
var NIX_TEMP = /(?:\/private)?\/(?:tmp|var\/folders\/[^\s"':]+|var\/tmp)\/[^\s"':()\]]*/g;
var CI_ROOTS = [
  /\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g,
  // GitHub Actions (linux/mac)
  /[A-Za-z]:\\a\\[^\\/\s]+\\[^\\/\s]+\\/g,
  // GitHub Actions (windows: D:\a\repo\repo\)
  /\/github\/workspace\//g,
  /\/builds\/[^/\s]+\/[^/\s]+\//g,
  // GitLab CI
  /\/__w\/[^/\s]+\/[^/\s]+\//g
  // GitHub Actions container
];
var WIN_ABS = /[A-Za-z]:\\(?:[^\s"'()\]:*?<>|\\]+\\)+([^\s"'()\]:*?<>|\\]+)/g;
var NIX_ABS = /(?<![\w.])\/(?:usr|opt|home|Users|root|app|workspace|srv|private|mnt)\/(?:[^\s"':()\]/]+\/)+([^\s"':()\]/]+)/g;
var HEX_0X = /\b0x[0-9a-fA-F]{4,}\b/g;
var HEX_BARE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,}\b/gi;
var HOSTPORT = /(\/\/[a-z0-9._-]+|(?<![\w.])localhost|(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{2,5}\b/gi;
var URL_CRED = /(\/\/)[^/\s:@]+:[^/\s:@]+@/g;
var VENDOR_FRAME = /node_modules[\\/]|[\\/](?:site-packages|dist-packages)[\\/]|\bat (?:java|javax|jdk|sun|com\.sun|scala|kotlin)\.|\b(?:org\.junit|org\.testng|org\.gradle|org\.apache\.maven\.surefire|jdk\.internal|java\.base\/|org\.hamcrest|org\.mockito)|internal\/(?:process|modules)\/|node:internal|\bat new Promise \(<anonymous>\)|\bat Promise\.|\bReflectionMethod\b|<frozen |\/usr\/lib\/python|_pytest[\\/]/;
function replaceTokens(text, opts) {
  let s = text.replace(ANSI, "");
  if (opts.repoRoot) {
    for (const variant of repoRootVariants(opts.repoRoot)) {
      s = s.split(variant).join("");
    }
  }
  s = s.replace(ISO_TIME, "<TIME>").replace(EPOCH_MS, "<TIME>");
  s = s.replace(UUID, "<UUID>");
  s = s.replace(WIN_TEMP, "<TMP>").replace(NIX_TEMP, "<TMP>");
  for (const re of CI_ROOTS) s = s.replace(re, "");
  s = s.replace(WIN_ABS, "$1").replace(NIX_ABS, "$1");
  s = s.replace(HEX_0X, "<HEX>").replace(HEX_BARE, "<HEX>");
  s = s.replace(URL_CRED, "$1<CRED>@");
  s = s.replace(HOSTPORT, (_m, host) => `${host}:<PORT>`);
  s = s.replace(/\b\d+m\d+(?:\.\d+)?s\b/g, "<DUR>");
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms)\b/g, "<DUR>");
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:secs?|seconds?)\b/g, "<DUR>");
  s = s.replace(/\bp\(\d{1,3}(?:\.\d+)?\)/g, "p(<N>)");
  s = s.replace(RULE_RUN, " ");
  return s;
}
function repoRootVariants(root) {
  const trimmed = root.replace(/[\\/]+$/, "");
  const fwd = trimmed.replace(/\\/g, "/");
  const back = trimmed.replace(/\//g, "\\");
  const set = /* @__PURE__ */ new Set();
  for (const base of [fwd, back]) {
    set.add(base + "/");
    set.add(base + "\\");
  }
  return [...set];
}
function squishLine(line) {
  return line.replace(/[ \t\u00a0]+/g, " ").trim();
}
function normalizeMessage(raw, opts = {}) {
  const replaced = replaceTokens(raw, opts);
  const lines = replaced.split(/\r?\n/).map(squishLine).filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  const eLines = lines.filter((l) => /^E\s+\S/.test(l)).map((l) => l.replace(/^E\s+/, ""));
  const picked = eLines.length > 0 ? eLines : lines;
  const cleaned = picked.filter(
    (l) => !/^\[[^\]]+\]\s*›/.test(l) && !/^›/.test(l)
  );
  const finalLines = (cleaned.length > 0 ? cleaned : picked).slice(0, 4);
  return finalLines.join("\n").trim();
}
var DRIVE = "(?:[A-Za-z]:[\\\\/])?";
var FRAME_MATCHERS = [
  /^\s*at\s+\S/,
  // JS / Java / .NET / Kotlin
  /^\s*File\s+".+",\s+line\s+\d+/,
  // Python "File "x", line N"
  new RegExp(`^\\s*${DRIVE}[\\w./\\\\-]+\\.[A-Za-z]{1,5}:\\d+:(?:\\s|$)`),
  // "x.py:12: in fn" / "x.py:15: AssertionError"
  new RegExp(`^\\s*#?\\s*${DRIVE}[\\w./\\\\-]+\\.rb:\\d+:in\\s+`),
  // ruby "x.rb:3:in `m'"
  new RegExp(`^\\s*${DRIVE}[\\w./\\\\-]+\\.php:\\d+$`),
  // phpunit "x.php:42"
  new RegExp(`^\\s*${DRIVE}[\\w./\\\\-]+_test\\.go:\\d+`)
  // go "x_test.go:12"
];
function looksLikeFrame(line) {
  return FRAME_MATCHERS.some((re) => re.test(line));
}
function normalizeFrame(rawFrame, opts = {}) {
  let f = squishLine(replaceTokens(rawFrame, opts));
  f = f.replace(
    /^File\s+"(.+?)",\s+line\s+\d+(?:,\s+in\s+(\S+))?.*$/,
    (_m, file, fn) => fn ? `at ${fn} (${file})` : `at ${file}`
  );
  f = f.replace(/^#?\s*([\w./\\-]+\.\w+):\d+:\s*in\s+(\S+).*$/, "at $2 ($1)");
  f = f.replace(/^([\w./\\-]+\.\w+):\d+:\s*([A-Za-z][\w.]*Error|[A-Za-z][\w.]*Exception)\b.*$/, "at $1 ($2)");
  f = f.replace(/^([\w./\\-]+\.\w+):\d+:?\s*$/, "at $1");
  f = f.replace(/^#?\s*([\w./\\-]+\.rb):\d+:in\s+[`']?([^'"]+?)['"]?$/, "at $2 ($1)");
  f = f.replace(/(\.[A-Za-z]{1,6}|<PATH>|<TMP>)(?::\d+){1,2}\b/g, "$1");
  f = f.replace(/\\(?=[\w.])/g, "/").replace(/(^|\()\.\.?\//g, "$1");
  f = f.replace(/\s+›.*$/, "").replace(/\s*[-—]{2,}>?\s*$/, "");
  return squishLine(f);
}
function extractFrames(stack, opts = {}) {
  const max = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const out = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    if (!looksLikeFrame(line)) continue;
    if (VENDOR_FRAME.test(line)) continue;
    const norm2 = normalizeFrame(line, opts);
    if (norm2.length === 0) continue;
    if (out.length > 0 && out[out.length - 1] === norm2) continue;
    out.push(norm2);
    if (out.length >= max) break;
  }
  return out;
}
function isWeakMessage(m) {
  if (m.length === 0) return true;
  const first = m.split(/\r?\n/, 1)[0].trim();
  return /^[\w.\-/\\]+\.[a-z0-9]+:\d+(?::\d+)?\s/i.test(first) || // "spec.ts:29:3 title"
  /^[\w.\-/\\]+\.[a-z0-9]+:\d+(?::\d+)?$/i.test(first);
}
function firstErrorLine(body) {
  const lines = body.split(/\r?\n/).map((l) => l.replace(ANSI, ""));
  const candidates = lines.filter(
    (l) => l.trim().length > 0 && !looksLikeFrame(l) && !/^\s*[|>]/.test(l) && // pytest/jest code-echo gutter
    !/^\s*\d+\s*[|]/.test(l) && // numbered code frame
    !/^\[[^\]]+\]\s*›/.test(l) && !/^\s*›/.test(l) && !/^[\s\-—_=~.·•*]+$/.test(l)
    // rule / separator line
  );
  const strong = candidates.find(
    (l) => /(?:^|\b)(?:[A-Z]\w*(?:Error|Exception)|assert|expect\(|expected |unexpected |timeout|timed out|net::|ECONN|ETIMEDOUT|not found|failed)\b/i.test(
      l
    )
  );
  return (strong ?? candidates[0] ?? "").trim();
}
function normalizeFailure(input, opts = {}) {
  const rawMessage = (input.message ?? "").trim();
  const rawStack = (input.stack ?? "").trim();
  let messageSource;
  if (rawMessage.length > 0 && !isWeakMessage(rawMessage)) {
    messageSource = rawMessage;
  } else if (rawStack.length > 0) {
    messageSource = firstErrorLine(rawStack) || rawStack.split(/\r?\n/).filter((l) => !looksLikeFrame(l)).join("\n");
  } else {
    messageSource = rawMessage;
  }
  const message = normalizeMessage(messageSource, opts);
  const frames = extractFrames(rawStack.length > 0 ? rawStack : rawMessage, opts);
  const canonical = `${message}|${frames.join("\n")}`;
  return { message, frames, canonical };
}

// src/core/fingerprint.ts
var FINGERPRINT_LENGTH = 16;
function fingerprintCanonical(canonical) {
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}
function fingerprintFailure(input, opts) {
  return fingerprintCanonical(normalizeFailure(input, opts).canonical);
}

// src/core/analyze.ts
function analyzeResults(results, opts = {}) {
  return results.map((r) => ({
    ...r,
    fingerprint: r.failure && (r.status === "failed" || r.status === "error") ? fingerprintFailure(r.failure, opts) : null
  }));
}

// src/core/history.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
var SCHEMA = `
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
var ROLLUP_STATUS = `CASE
  WHEN SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'failed'
  WHEN SUM(CASE WHEN r.status = 'error'  THEN 1 ELSE 0 END) > 0 THEN 'error'
  WHEN SUM(CASE WHEN r.status = 'passed' THEN 1 ELSE 0 END) > 0 THEN 'passed'
  ELSE 'skipped' END`;
var ROLLUP_FINGERPRINT = `MAX(CASE WHEN r.status IN ('failed','error') THEN r.fingerprint END)`;
var ROLLUP_MESSAGE = `MAX(CASE WHEN r.status IN ('failed','error') THEN r.message END)`;
function splitFiles(raw) {
  if (!raw) return [];
  return raw.split("\n").map((s) => s.trim()).filter(Boolean);
}
function migrate(db) {
  const idx = db.prepare(`PRAGMA index_list(runs)`).all();
  if (!idx.some((i) => i.name === "idx_runs_dedup")) {
    try {
      db.exec(
        `CREATE UNIQUE INDEX idx_runs_dedup ON runs(repo, commit_sha, ci_run_id, attempt)`
      );
    } catch {
    }
  }
  const cols = db.prepare(`PRAGMA table_info(runs)`).all();
  if (!cols.some((c) => c.name === "changed_files")) {
    db.exec(`ALTER TABLE runs ADD COLUMN changed_files TEXT`);
  }
}
var History = class _History {
  db;
  constructor(db) {
    this.db = db;
  }
  /** Open (creating parent dirs + schema). Pass `:memory:` for tests. */
  static open(path) {
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.exec(SCHEMA);
      migrate(db);
      return new _History(db);
    } catch (cause) {
      throw new HistoryError(`cannot open history store at ${path}`, { cause });
    }
  }
  close() {
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
  recordRun(meta, results) {
    const insertRun = this.db.prepare(
      `INSERT OR IGNORE INTO runs
        (repo, commit_sha, parent_sha, branch, ci_run_id, attempt, started_at, changed_files)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const findRun = this.db.prepare(
      `SELECT id FROM runs
        WHERE repo = ? AND commit_sha = ? AND ci_run_id IS ? AND attempt = ?`
    );
    const insertResult = this.db.prepare(
      `INSERT INTO results
        (run_id, suite, test_name, test_key, status, duration_ms, message, stack, fingerprint)
       VALUES (@runId, @suite, @testName, @testKey, @status, @durationMs, @message, @stack, @fingerprint)`
    );
    const tx = this.db.transaction(() => {
      const info2 = insertRun.run(
        meta.repo,
        meta.commitSha,
        meta.parentSha,
        meta.branch,
        meta.ciRunId,
        meta.attempt,
        meta.startedAt,
        meta.changedFiles.length > 0 ? meta.changedFiles.join("\n") : null
      );
      if (info2.changes === 0) {
        const existing = findRun.get(
          meta.repo,
          meta.commitSha,
          meta.ciRunId,
          meta.attempt
        );
        return { runId: existing?.id ?? -1, inserted: false };
      }
      const runId = Number(info2.lastInsertRowid);
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
          fingerprint: r.fingerprint
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
  runExists(repo, commitSha, ciRunId, attempt) {
    const row = this.db.prepare(
      `SELECT 1 FROM runs WHERE repo = ? AND commit_sha = ? AND ci_run_id IS ? AND attempt = ?`
    ).get(repo, commitSha, ciRunId, attempt);
    return row !== void 0;
  }
  /** True when the same `testKey` already passed in another attempt of `commitSha`. */
  passedInAnotherAttempt(commitSha, testKey2, attempt) {
    const row = this.db.prepare(
      `SELECT 1
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.commit_sha = ? AND r.test_key = ? AND ru.attempt != ?
            AND r.status = 'passed'
          LIMIT 1`
    ).get(commitSha, testKey2, attempt);
    return row !== void 0;
  }
  /**
   * Other attempts of `commitSha` in which `testKey` failed or errored, ascending.
   * The mirror of {@link passedInAnotherAttempt}: a test that passes now after
   * failing in another attempt of the same commit is a confirmed flake.
   */
  failedAttemptsOnCommit(commitSha, testKey2, attempt) {
    const rows = this.db.prepare(
      `SELECT DISTINCT ru.attempt AS attempt
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.commit_sha = ? AND r.test_key = ? AND ru.attempt != ?
            AND r.status IN ('failed', 'error')
          ORDER BY ru.attempt`
    ).all(commitSha, testKey2, attempt);
    return rows.map((r) => r.attempt);
  }
  /**
   * Full pass/fail timeline for one test, oldest first — one entry per recorded
   * run. Parametrised/repeated `<testcase>` entries that share a `test_key`
   * within a run are rolled up: the run counts as `failed` if any entry failed
   * or errored, else `passed` if any passed, else `skipped`.
   */
  timelineByTestKey(testKey2) {
    const rows = this.db.prepare(
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
          ORDER BY ru.started_at ASC, ru.id ASC`
    ).all(testKey2);
    return rows.map(({ changedFilesRaw, ...rest }) => ({
      ...rest,
      changedFiles: splitFiles(changedFilesRaw)
    }));
  }
  /** The most recent recorded failure/error for a test, with full stack + run context. */
  latestFailure(testKey2) {
    const row = this.db.prepare(
      `SELECT r.suite AS suite, r.test_name AS testName, r.status AS status,
                r.message AS message, r.stack AS stack, r.fingerprint AS fingerprint,
                ru.id AS runId, ru.commit_sha AS commitSha, ru.parent_sha AS parentSha,
                ru.branch AS branch, ru.attempt AS attempt, ru.started_at AS startedAt,
                ru.changed_files AS changedFilesRaw
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.test_key = ? AND r.status IN ('failed','error')
          ORDER BY ru.started_at DESC, ru.id DESC
          LIMIT 1`
    ).get(testKey2);
    if (!row) return null;
    const { changedFilesRaw, ...rest } = row;
    return { ...rest, changedFiles: splitFiles(changedFilesRaw) };
  }
  /** Rollup outcome for a test on a specific commit; `null` if never recorded there. */
  outcomeOnCommit(commitSha, testKey2) {
    const row = this.db.prepare(
      `SELECT ${ROLLUP_STATUS} AS status
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.commit_sha = ? AND r.test_key = ?`
    ).get(commitSha, testKey2);
    if (!row || row.status === null) return null;
    if (row.status === "passed") return "pass";
    if (row.status === "failed" || row.status === "error") return "fail";
    return null;
  }
  /** Distinct prior runs that recorded this test at all. */
  runCountForTest(testKey2) {
    const row = this.db.prepare(
      `SELECT COUNT(DISTINCT run_id) AS n FROM results WHERE test_key = ?`
    ).get(testKey2);
    return row.n;
  }
  /** True when this test has ever been recorded as passing. */
  everPassed(testKey2) {
    const row = this.db.prepare(
      `SELECT 1 FROM results WHERE test_key = ? AND status = 'passed' LIMIT 1`
    ).get(testKey2);
    return row !== void 0;
  }
  /**
   * Resolve a user-supplied string to test identities: exact test name, then
   * substring of `suite::name`, then `test_key` prefix. Ordered by run count desc.
   */
  findTests(query) {
    const rows = this.db.prepare(
      `SELECT r.test_key AS testKey,
                MAX(r.suite) AS suite, MAX(r.test_name) AS testName,
                COUNT(DISTINCT r.run_id) AS runs
           FROM results r
          WHERE r.test_name = ?
             OR (r.suite || '::' || r.test_name) LIKE ?
             OR r.test_key LIKE ?
          GROUP BY r.test_key
          ORDER BY runs DESC, suite ASC, testName ASC`
    ).all(query, `%${query}%`, `${query}%`);
    return rows;
  }
  /**
   * One row per (test, run) for flakiness math, most-recent `window` runs only.
   * Parametrised entries are rolled up (see {@link timelineByTestKey}).
   * Skipped rows are included; {@link computeFlakyStats} filters them.
   */
  rowsForFlakiness(window = 200) {
    const rows = this.db.prepare(
      `SELECT r.test_key AS testKey,
                MAX(r.suite) AS suite, MAX(r.test_name) AS testName,
                ${ROLLUP_STATUS} AS status,
                ru.started_at AS startedAt, ru.id AS runId,
                ${ROLLUP_FINGERPRINT} AS fingerprint
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE ru.id > (SELECT COALESCE(MAX(id), 0) - ? FROM runs)
          GROUP BY r.test_key, ru.id
          ORDER BY ru.started_at ASC, ru.id ASC`
    ).all(window);
    return rows;
  }
  /** How widely a single failure fingerprint has spread. */
  fingerprintSpread(fingerprint) {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS occurrences,
                COUNT(DISTINCT ru.branch) AS distinctBranches,
                COUNT(DISTINCT ru.commit_sha) AS distinctCommits,
                COUNT(DISTINCT r.test_key) AS distinctTestKeys,
                MIN(ru.started_at) AS firstSeen,
                MAX(ru.started_at) AS lastSeen
           FROM results r JOIN runs ru ON ru.id = r.run_id
          WHERE r.fingerprint = ?`
    ).get(fingerprint);
    if (!row || row.occurrences === 0) return null;
    const sample = this.db.prepare(
      `SELECT message FROM results WHERE fingerprint = ? AND message IS NOT NULL LIMIT 1`
    ).get(fingerprint);
    return { fingerprint, sampleMessage: sample?.message ?? null, ...row };
  }
  summary() {
    const runs = this.db.prepare(`SELECT COUNT(*) c FROM runs`).get();
    const res = this.db.prepare(
      `SELECT COUNT(*) results,
                COUNT(DISTINCT test_key) tests,
                COUNT(DISTINCT fingerprint) fps
           FROM results`
    ).get();
    const span = this.db.prepare(`SELECT MIN(started_at) lo, MAX(started_at) hi FROM runs`).get();
    return {
      runs: runs.c,
      results: res.results,
      distinctTests: res.tests,
      distinctFingerprints: res.fps,
      firstRun: span.lo,
      lastRun: span.hi
    };
  }
  /** Every recorded run, newest first — used by `history` with no argument. */
  recentRuns(limit = 20) {
    return this.db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`).all(limit);
  }
};

// src/ingest/discover.ts
import { readdirSync, statSync } from "node:fs";
import { join as join2, relative, sep } from "node:path";
var DEFAULT_REPORT_GLOBS = ["**/junit*.xml", "**/TEST-*.xml"];
var IGNORED_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  ".flaketriage"
]);
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
function discoverReports(root, patterns = DEFAULT_REPORT_GLOBS) {
  const matchers = patterns.map(globToRegExp);
  const found = /* @__PURE__ */ new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join2(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(entry)) walk(abs);
      } else if (st.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (matchers.some((m) => m.test(rel))) found.add(abs);
      }
    }
  };
  walk(root);
  return [...found].sort();
}

// src/ingest/git.ts
import { basename } from "node:path";
import { simpleGit } from "simple-git";
function parseSlug(remoteUrl) {
  if (!remoteUrl) return null;
  const m = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
async function tryRevparse(git, ...args) {
  try {
    const out = (await git.revparse(args)).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
async function readGitContext(repoPath, overrides = {}) {
  const git = simpleGit(repoPath);
  let isRepo = false;
  try {
    isRepo = await git.checkIsRepo();
  } catch (cause) {
    throw new GitContextError(`not a git repository: ${repoPath}`, { cause });
  }
  if (!isRepo) throw new GitContextError(`not a git repository: ${repoPath}`);
  const repoRoot = (await git.revparse(["--show-toplevel"])).trim();
  const commitSha = (overrides.commit ? await tryRevparse(git, overrides.commit) : null) ?? await tryRevparse(git, "HEAD");
  if (!commitSha) {
    throw new GitContextError(
      overrides.commit ? `cannot resolve --commit ${overrides.commit}` : "cannot resolve HEAD (empty repository?)"
    );
  }
  const parentSha = overrides.parent ? await tryRevparse(git, overrides.parent) : await tryRevparse(git, `${commitSha}^`);
  let branch = await tryRevparse(git, "--abbrev-ref", "HEAD");
  if (branch === "HEAD" || branch === null) {
    branch = process.env["GITHUB_HEAD_REF"] || process.env["GITHUB_REF_NAME"] || process.env["GIT_BRANCH"] || null;
  }
  let slug = null;
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
    slug = parseSlug(origin?.refs.fetch ?? origin?.refs.push);
  } catch {
    slug = null;
  }
  const repoSlug = slug ?? basename(repoRoot);
  const changedFiles = await resolveChangedFiles(git, commitSha, parentSha);
  const diffHunks = await readDiffHunks(repoPath, commitSha, parentSha);
  return {
    repoRoot,
    repoSlug,
    commitSha,
    parentSha,
    branch,
    changedFiles,
    diffHunks
  };
}
var DIFF_HEADER = /^\+\+\+ b\/(.+)$/;
var HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
async function readDiffHunks(repoPath, commitSha, parentSha, paths = []) {
  const git = simpleGit(repoPath);
  const range = parentSha ? [parentSha, commitSha] : [`${commitSha}^!`];
  let raw;
  try {
    raw = await git.raw([
      "diff",
      "--no-color",
      "--no-renames",
      "--unified=0",
      "--diff-filter=d",
      // ignore deletions — no new-file lines to blame
      ...range,
      ...paths.length ? ["--", ...paths] : []
    ]);
  } catch {
    return [];
  }
  const hunks = [];
  let file = null;
  let cursor = 0;
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const fh = line.match(DIFF_HEADER);
    if (fh) {
      file = fh[1];
      current = null;
      continue;
    }
    const hh = line.match(HUNK_HEADER);
    if (hh && file) {
      const newStart = Number(hh[1]);
      const newLines = hh[2] === void 0 ? 1 : Number(hh[2]);
      current = { file, newStart, newLines, changedLines: [] };
      hunks.push(current);
      cursor = newStart;
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.changedLines.push(cursor);
      cursor += 1;
    }
  }
  return hunks;
}
async function resolveChangedFiles(git, commitSha, parentSha) {
  try {
    if (parentSha) {
      const out2 = await git.raw([
        "diff",
        "--name-only",
        "--no-renames",
        `${parentSha}`,
        `${commitSha}`
      ]);
      return splitPaths(out2);
    }
    const out = await git.raw([
      "show",
      "--name-only",
      "--no-renames",
      "--pretty=format:",
      commitSha
    ]);
    return splitPaths(out);
  } catch {
    return [];
  }
}
function splitPaths(raw) {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}
async function readCommitDiff(repoPath, commitSha, parentSha, prioritisePaths = []) {
  const git = simpleGit(repoPath);
  const range = parentSha ? [parentSha, commitSha] : [`${commitSha}^!`];
  const priority = [...new Set(prioritisePaths.map((p) => p.replace(/\\/g, "/")))];
  try {
    if (priority.length > 0) {
      const focused = await git.raw(["diff", "--no-color", "--unified=3", ...range, "--", ...priority]).catch(() => "");
      const rest = await git.raw(["diff", "--no-color", "--unified=3", ...range]).catch(() => "");
      return focused.trim().length > 0 ? `${focused}
${rest}` : rest;
    }
    return await git.raw(["diff", "--no-color", "--unified=3", ...range]);
  } catch {
    return "";
  }
}

// src/ingest/junit.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { XMLParser } from "fast-xml-parser";

// src/core/keys.ts
import { createHash as createHash2 } from "node:crypto";
function testKey(suite, name) {
  return createHash2("sha256").update(`${suite}::${name}`, "utf8").digest("hex");
}
function stableSuite(raw) {
  return raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
}

// src/ingest/junit.ts
var FAILURE_TAGS = ["failure", "error"];
var RETRY_TAGS = [
  "flakyFailure",
  "flakyError",
  "rerunFailure",
  "rerunError"
];
var parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  // preserve stack-trace indentation
  parseAttributeValue: false,
  parseTagValue: false,
  cdataPropName: "#cdata",
  // Treat failure/error bodies as opaque text so unescaped `<` in a stack trace
  // cannot break the parse.
  stopNodes: [
    "*.failure",
    "*.error",
    "*.flakyFailure",
    "*.flakyError",
    "*.rerunFailure",
    "*.rerunError",
    "*.system-out",
    "*.system-err"
  ],
  isArray: (name) => ["testsuite", "testcase", "failure", "error", ...RETRY_TAGS].includes(name)
});
function asArray(v) {
  if (v === void 0 || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function attr(node, key) {
  if (!node) return null;
  const v = node[`@_${key}`];
  if (v === void 0 || v === null) return null;
  return String(v);
}
var XML_ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#10;": "\n",
  "&#13;": "\r",
  "&#9;": "	",
  "&amp;": "&"
  // must be last
};
function decodeEntities(s) {
  let out = s.replace(
    /&#(\d+);/g,
    (_m, d) => String.fromCodePoint(Number(d))
  );
  out = out.replace(
    /&#x([0-9a-fA-F]+);/g,
    (_m, h) => String.fromCodePoint(parseInt(h, 16))
  );
  for (const [ent, ch] of Object.entries(XML_ENTITIES)) {
    out = out.split(ent).join(ch);
  }
  return out;
}
function bodyText(raw) {
  if (raw === void 0 || raw === null) return null;
  let text;
  if (typeof raw === "string") {
    text = decodeEntities(raw);
  } else if (typeof raw === "object") {
    const node = raw;
    const parts = [];
    if (typeof node["#text"] === "string") parts.push(decodeEntities(node["#text"]));
    if (typeof node["#cdata"] === "string") parts.push(node["#cdata"]);
    for (const c of asArray(node["#cdata"])) {
      if (typeof c === "string" && !parts.includes(c)) parts.push(c);
    }
    text = parts.join("\n");
  } else {
    text = String(raw);
  }
  text = text.replace(/<\/?stackTrace>/gi, "").replace(/<system-(?:out|err)>[\s\S]*?<\/system-(?:out|err)>/gi, "").replace(/<system-(?:out|err)\s*\/>/gi, "");
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  text = text.replace(/^\s*<!\[CDATA\[/i, "").replace(/\]\]>\s*$/i, "");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function parseTimeToMs(raw) {
  if (raw === null) return null;
  const n = Number(raw.trim().replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e3);
}
function toFailure(node) {
  const obj = typeof node === "object" && node !== null ? node : {};
  const message = attr(obj, "message");
  const type = attr(obj, "type");
  const stack = bodyText(node);
  return {
    message: message ?? (stack ? null : type),
    type,
    stack
  };
}
function collectFailures(testcase, tags) {
  const out = [];
  for (const tag of tags) {
    for (const n of asArray(testcase[tag])) {
      const f = toFailure(n);
      if (f.message || f.stack || f.type) out.push(f);
    }
  }
  return out;
}
function walkSuite(suite, inheritedName, ctx) {
  const suiteName = attr(suite, "name") ?? inheritedName;
  for (const tc of asArray(suite["testcase"])) {
    if (typeof tc !== "object" || tc === null) continue;
    ctx.results.push(toTestResult(tc, suiteName));
  }
  for (const child of asArray(suite["testsuite"])) {
    if (typeof child === "object" && child !== null) {
      walkSuite(child, suiteName, ctx);
    }
  }
}
function toTestResult(tc, suiteName) {
  const name = (attr(tc, "name") ?? "").trim() || "<unnamed>";
  const classname = attr(tc, "classname")?.trim() || null;
  const suite = stableSuite(classname || suiteName || "<unknown-suite>");
  const failures = collectFailures(tc, FAILURE_TAGS);
  const retries = collectFailures(tc, RETRY_TAGS);
  const skipped = "skipped" in tc;
  let status;
  let failure = null;
  let skipReason = null;
  const hasError = asArray(tc["error"]).length > 0;
  const hasFailure = asArray(tc["failure"]).length > 0;
  if (hasError) {
    status = "error";
    failure = failures.find((f) => f.type !== null || f.stack !== null) ?? failures[0] ?? null;
  } else if (hasFailure) {
    status = "failed";
    failure = failures[0] ?? null;
  } else if (skipped) {
    status = "skipped";
    skipReason = bodyText(tc["skipped"]) ?? attr(tc["skipped"], "message") ?? "skipped";
  } else {
    status = "passed";
  }
  if (status === "passed" && retries.length > 0) {
  }
  return {
    suite,
    name,
    testKey: testKey(suite, name),
    status,
    durationMs: parseTimeToMs(attr(tc, "time")),
    file: attr(tc, "file"),
    failure,
    skipReason,
    retries
  };
}
function parseJUnitXml(xml, source) {
  if (xml.trim().length === 0) {
    throw new JUnitParseError("empty report", { source: source ?? "" });
  }
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (cause) {
    throw new JUnitParseError("malformed XML", { cause, source: source ?? "" });
  }
  const root = doc;
  const suites = [];
  for (const s of asArray(root["testsuites"])) {
    if (typeof s === "object" && s !== null) {
      const wrapper = s;
      for (const inner of asArray(wrapper["testsuite"])) {
        if (typeof inner === "object" && inner !== null) suites.push(inner);
      }
      if (asArray(wrapper["testcase"]).length > 0) suites.push(wrapper);
    }
  }
  for (const s of asArray(root["testsuite"])) {
    if (typeof s === "object" && s !== null) suites.push(s);
  }
  if (suites.length === 0) {
    throw new JUnitParseError(
      "no <testsuite> found \u2014 not a JUnit XML report",
      { source: source ?? "" }
    );
  }
  const ctx = { results: [] };
  for (const suite of suites) walkSuite(suite, null, ctx);
  return ctx.results;
}
function parseJUnitFile(path) {
  let xml;
  try {
    xml = readFileSync2(path, "utf8");
  } catch (cause) {
    throw new JUnitParseError(`cannot read report: ${path}`, { cause, source: path });
  }
  if (xml.charCodeAt(0) === 65279) xml = xml.slice(1);
  return parseJUnitXml(xml, path);
}

// src/ingest/playwright.ts
import { readFileSync as readFileSync3 } from "node:fs";
var ANSI2 = /\u001b\[[0-9;]*[A-Za-z]/g;
var FAILED_ATTEMPT = /* @__PURE__ */ new Set(["failed", "timedOut", "interrupted"]);
function stripAnsi(text) {
  if (text === void 0) return null;
  const clean = text.replace(ANSI2, "").trim();
  return clean.length > 0 ? clean : null;
}
function toFailure2(result) {
  const error = result?.error ?? result?.errors?.[0];
  const text = stripAnsi(error?.message);
  const firstLine2 = text?.split(/\r?\n/)[0]?.trim() ?? null;
  return {
    // Playwright's JUnit `message` is the first line without the "Error: " prefix.
    message: firstLine2 ? firstLine2.replace(/^Error:\s*/, "") : null,
    type: null,
    stack: stripAnsi(error?.stack) ?? text
  };
}
function statusOf(test, last) {
  switch (test.status) {
    case "skipped":
      return "skipped";
    case "expected":
    case "flaky":
      return "passed";
    default:
      return last?.status === "timedOut" || last?.status === "interrupted" ? "error" : "failed";
  }
}
function toTestResult2(spec, test, describePath) {
  const results = test.results ?? [];
  const last = results[results.length - 1];
  const suite = stableSuite(spec.file ?? "<unknown-file>");
  const name = [...describePath, spec.title ?? "<unnamed>"].join(" \u203A ");
  const status = statusOf(test, last);
  const failedAttempts = results.filter((r) => FAILED_ATTEMPT.has(r.status ?? ""));
  let failure = null;
  if (status === "failed" || status === "error") {
    failure = failedAttempts.length > 0 ? toFailure2(failedAttempts[failedAttempts.length - 1]) : { message: "expected to fail, but passed", type: null, stack: null };
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
    skipReason: status === "skipped" ? skip?.description?.trim() || "skipped" : null,
    // Only "flaky" means failed-then-passed: a `test.fail()` test is "expected" with a failed attempt.
    retries: test.status === "flaky" ? failedAttempts.map(toFailure2) : []
  };
}
function walkSuite2(suite, describePath, out) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) out.push(toTestResult2(spec, test, describePath));
  }
  for (const child of suite.suites ?? []) {
    walkSuite2(child, [...describePath, child.title ?? ""], out);
  }
}
function parsePlaywrightJson(json, source) {
  let doc;
  try {
    doc = JSON.parse(json);
  } catch (cause) {
    throw new PlaywrightReportParseError("malformed JSON", { cause, source: source ?? "" });
  }
  const report = doc;
  if (typeof report !== "object" || report === null || typeof report.config !== "object" || !Array.isArray(report.suites)) {
    throw new PlaywrightReportParseError(
      "not a Playwright JSON report (expected top-level `config` and `suites`)",
      { source: source ?? "" }
    );
  }
  const out = [];
  for (const fileSuite of report.suites) walkSuite2(fileSuite, [], out);
  return out;
}
function parsePlaywrightFile(path) {
  let json;
  try {
    json = readFileSync3(path, "utf8");
  } catch (cause) {
    throw new PlaywrightReportParseError(`cannot read report: ${path}`, { cause, source: path });
  }
  if (json.charCodeAt(0) === 65279) json = json.slice(1);
  return parsePlaywrightJson(json, path);
}

// src/llm/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// src/llm/schema.ts
import { z as z2 } from "zod";
var ModelVerdictSchema = z2.object({
  test_key: z2.string().describe("the exact test_key from the input, echoed back"),
  kind: z2.enum(["flake_likely", "real_regression", "infra_failure", "unknown"]).describe("`unknown` when the evidence does not clearly support one of the others"),
  confidence: z2.enum(["low", "medium", "high"]),
  one_line_reason: z2.string().max(200).describe("\u2264 140 chars ideally; shown verbatim in the PR comment"),
  likely_cause: z2.string().describe("1-3 sentences; empty string if kind is unknown"),
  suspect_location: z2.string().nullable().describe('e.g. "src/api/client.ts:42", or null'),
  suggested_next_step: z2.string().describe("one concrete action for the developer")
});
var TriageResponseSchema = z2.object({
  verdicts: z2.array(ModelVerdictSchema)
});
function triageJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "test_key",
            "kind",
            "confidence",
            "one_line_reason",
            "likely_cause",
            "suspect_location",
            "suggested_next_step"
          ],
          properties: {
            test_key: { type: "string" },
            kind: {
              type: "string",
              enum: ["flake_likely", "real_regression", "infra_failure", "unknown"]
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            one_line_reason: { type: "string" },
            likely_cause: { type: "string" },
            suspect_location: { type: ["string", "null"] },
            suggested_next_step: { type: "string" }
          }
        }
      }
    }
  };
}

// src/llm/providers/anthropic.ts
var DEFAULT_MODEL = "claude-opus-5";
var MAX_TOKENS = 16e3;
var RATE_INPUT = 5;
var RATE_OUTPUT = 25;
var RATE_CACHE_READ = 0.5;
var RATE_CACHE_WRITE = 6.25;
function fromAnthropicClient(name, client, model, enabled) {
  return {
    name,
    model,
    enabled,
    async countTokens(system, userPayload) {
      try {
        const r = await client.messages.countTokens({
          model,
          system: [{ type: "text", text: system }],
          messages: [{ role: "user", content: userPayload }]
        });
        return r.input_tokens;
      } catch (cause) {
        throw new LlmError(`${name}: countTokens failed`, { cause });
      }
    },
    async triage(system, userPayload) {
      let response;
      try {
        response = await client.messages.parse({
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userPayload }],
          output_config: { format: zodOutputFormat(TriageResponseSchema) }
        });
      } catch (cause) {
        throw new LlmError(`${name}: request failed`, { cause });
      }
      if (!response.parsed_output) {
        throw new LlmError(`${name}: model returned unparseable output`);
      }
      const verdicts = response.parsed_output.verdicts;
      const u = response.usage ?? {};
      const inputTokens = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      const cachedInputTokens = u.cache_read_input_tokens ?? 0;
      const cacheCreation = u.cache_creation_input_tokens ?? 0;
      const freshInput = Math.max(inputTokens - cachedInputTokens - cacheCreation, 0);
      const usd = freshInput / 1e6 * RATE_INPUT + cachedInputTokens / 1e6 * RATE_CACHE_READ + cacheCreation / 1e6 * RATE_CACHE_WRITE + outputTokens / 1e6 * RATE_OUTPUT;
      return {
        verdicts,
        usage: { inputTokens, outputTokens, cachedInputTokens },
        usd,
        cacheHit: cachedInputTokens > 0,
        model
      };
    }
  };
}
function disabledProvider(name, model) {
  const reason = `${name}: not configured`;
  return {
    name,
    model,
    enabled: false,
    async countTokens() {
      throw new LlmError(reason);
    },
    async triage() {
      throw new LlmError(reason);
    }
  };
}
function createAnthropicProvider(opts) {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? process.env["ANTHROPIC_AUTH_TOKEN"];
  const client = new Anthropic(
    apiKey ? { apiKey, timeout: opts.timeoutMs } : { timeout: opts.timeoutMs }
  );
  return fromAnthropicClient("anthropic", client, model, Boolean(apiKey));
}

// src/llm/providers/cloud.ts
import Anthropic2 from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
function createBedrockProvider(opts) {
  const model = opts.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  const region = opts.awsRegion ?? env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"];
  if (!region) return disabledProvider("bedrock", model);
  try {
    const client = new AnthropicBedrockMantle({ awsRegion: region, timeout: opts.timeoutMs });
    return fromAnthropicClient("bedrock", client, model, true);
  } catch {
    return disabledProvider("bedrock", model);
  }
}
function createVertexProvider(opts) {
  const model = opts.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  const projectId = opts.projectId ?? env["ANTHROPIC_VERTEX_PROJECT_ID"];
  if (!projectId) return disabledProvider("vertex", model);
  const region = opts.region ?? env["CLOUD_ML_REGION"] ?? "global";
  try {
    const client = new AnthropicVertex({ projectId, region, timeout: opts.timeoutMs });
    return fromAnthropicClient("vertex", client, model, true);
  } catch {
    return disabledProvider("vertex", model);
  }
}
function createFoundryProvider(opts) {
  const model = opts.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  const resource = opts.resource ?? env["ANTHROPIC_FOUNDRY_RESOURCE"];
  const apiKey = opts.apiKey ?? env["ANTHROPIC_FOUNDRY_API_KEY"];
  if (!resource || !apiKey) return disabledProvider("foundry", model);
  try {
    const client = new AnthropicFoundry({ resource, apiKey, timeout: opts.timeoutMs });
    return fromAnthropicClient("foundry", client, model, true);
  } catch {
    return disabledProvider("foundry", model);
  }
}
function createCustomProvider(opts) {
  const model = opts.model ?? DEFAULT_MODEL;
  if (!opts.baseUrl) return disabledProvider("custom", model);
  try {
    const client = new Anthropic2({
      baseURL: opts.baseUrl,
      apiKey: opts.apiKey ?? "not-needed",
      timeout: opts.timeoutMs
    });
    return fromAnthropicClient("custom", client, model, true);
  } catch {
    return disabledProvider("custom", model);
  }
}

// src/llm/providers/openai-compatible.ts
var estimateTokens = (s) => Math.ceil(s.length / 4);
function createOpenAiCompatProvider(opts) {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const rateIn = opts.rateInput ?? 0;
  const rateOut = opts.rateOutput ?? 0;
  const keyless = opts.name === "local" || opts.name === "openai-compatible";
  return {
    name: opts.name,
    model: opts.model,
    enabled: keyless || Boolean(opts.apiKey),
    async countTokens(system, userPayload) {
      return estimateTokens(system) + estimateTokens(userPayload);
    },
    async triage(system, userPayload) {
      const controller = new AbortController();
      const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}
          },
          body: JSON.stringify({
            model: opts.model,
            temperature: 0,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userPayload }
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "triage", strict: true, schema: triageJsonSchema() }
            }
          })
        });
      } catch (cause) {
        throw new LlmError(`${opts.name}: request to ${url} failed`, { cause });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new LlmError(
          `${opts.name}: ${res.status} ${res.statusText}${body ? ` \u2014 ${body.slice(0, 300)}` : ""}`
        );
      }
      let json;
      try {
        json = await res.json();
      } catch (cause) {
        throw new LlmError(`${opts.name}: response was not JSON`, { cause });
      }
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new LlmError(`${opts.name}: empty completion`);
      let parsed;
      try {
        parsed = TriageResponseSchema.parse(JSON.parse(content));
      } catch (cause) {
        throw new LlmError(`${opts.name}: model output did not match the triage schema`, {
          cause
        });
      }
      const inputTokens = json.usage?.prompt_tokens ?? estimateTokens(system + userPayload);
      const outputTokens = json.usage?.completion_tokens ?? estimateTokens(content);
      return {
        verdicts: parsed.verdicts,
        usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
        usd: inputTokens / 1e6 * rateIn + outputTokens / 1e6 * rateOut,
        cacheHit: false,
        model: opts.model
      };
    }
  };
}

// src/llm/providers/index.ts
var PRESETS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.6-flash",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    rateInput: 0,
    // free tier / negligible
    rateOutput: 0
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyEnv: ["OPENAI_API_KEY"],
    rateInput: 0.15,
    rateOutput: 0.6
  },
  local: {
    baseUrl: "http://localhost:11434/v1",
    // Ollama default
    model: "qwen2.5",
    keyEnv: [],
    rateInput: 0,
    rateOutput: 0
  }
};
function firstEnv(env, keys) {
  for (const k of keys) {
    const v = env[k];
    if (v) return v;
  }
  return void 0;
}
function resolveProvider(opts = {}) {
  if (opts.disabled) return null;
  const env = opts.env ?? process.env;
  const choice = (opts.provider ?? env["FLAKETRIAGE_LLM_PROVIDER"] ?? "auto").toLowerCase();
  const model = opts.model ?? env["FLAKETRIAGE_LLM_MODEL"];
  const baseUrl = opts.baseUrl ?? env["FLAKETRIAGE_LLM_BASE_URL"];
  const apiKey = opts.apiKey ?? env["FLAKETRIAGE_LLM_API_KEY"];
  const timeoutMs = opts.timeoutMs ?? 12e4;
  if (choice === "none") return null;
  const anthropicKey = apiKey ?? env["ANTHROPIC_API_KEY"] ?? env["ANTHROPIC_AUTH_TOKEN"];
  if (choice === "auto") {
    if (anthropicKey) {
      return createAnthropicProvider({ model: model ?? void 0, apiKey: anthropicKey, timeoutMs });
    }
    if (firstEnv(env, PRESETS.gemini.keyEnv)) {
      return build("gemini", { model, baseUrl, apiKey, timeoutMs, env });
    }
    if (firstEnv(env, PRESETS.openai.keyEnv)) {
      return build("openai", { model, baseUrl, apiKey, timeoutMs, env });
    }
    return null;
  }
  if (choice === "anthropic") {
    return createAnthropicProvider({ model: model ?? void 0, apiKey: anthropicKey, timeoutMs });
  }
  if (choice === "gemini" || choice === "openai" || choice === "local") {
    return build(choice, { model, baseUrl, apiKey, timeoutMs, env });
  }
  if (choice === "openai-compatible") {
    if (!baseUrl) {
      throw new Error("--provider openai-compatible requires --llm-base-url");
    }
    return createOpenAiCompatProvider({
      name: "openai-compatible",
      model: model ?? "local-model",
      baseUrl,
      apiKey,
      timeoutMs
    });
  }
  if (choice === "bedrock") {
    return createBedrockProvider({
      model: model ?? void 0,
      awsRegion: opts.awsRegion,
      timeoutMs,
      env
    });
  }
  if (choice === "vertex") {
    return createVertexProvider({
      model: model ?? void 0,
      projectId: opts.gcpProjectId,
      region: opts.gcpRegion,
      timeoutMs,
      env
    });
  }
  if (choice === "foundry") {
    return createFoundryProvider({
      model: model ?? void 0,
      resource: opts.foundryResource,
      apiKey,
      timeoutMs,
      env
    });
  }
  if (choice === "custom") {
    if (!baseUrl) {
      throw new Error("--provider custom requires --llm-base-url");
    }
    return createCustomProvider({
      model: model ?? void 0,
      baseUrl,
      apiKey,
      timeoutMs
    });
  }
  throw new Error(`unknown --provider "${choice}"`);
}
function build(name, o) {
  const preset = PRESETS[name];
  return createOpenAiCompatProvider({
    name,
    model: o.model ?? preset.model,
    baseUrl: o.baseUrl ?? preset.baseUrl,
    apiKey: o.apiKey ?? firstEnv(o.env, preset.keyEnv),
    timeoutMs: o.timeoutMs,
    rateInput: preset.rateInput,
    rateOutput: preset.rateOutput
  });
}

// src/llm/prompt.ts
var SYSTEM_PROMPT = `You are FlakeTriage's escalation judge. A deterministic classifier has already
handled the clear cases using test history and fingerprinting. You only see the
failures it could not decide \u2014 the ambiguous ones.

For each failure decide one of:
  - flake_likely     the failure is non-deterministic: timing, ordering, shared
                     state, environment, network jitter, a race. The code change
                     is probably not the cause.
  - real_regression  the code change under test plausibly broke this. There is a
                     believable path from a changed file to the observed failure.
  - infra_failure    the environment failed: a dependency service, the container,
                     the runner, DNS, disk, a browser that would not start.
  - unknown          the evidence does not clearly support any of the above.

Rules:
  - "unknown" is a valid, expected, and rewarded answer. It is better to say
    "not enough signal" than to invent a cause. Do not guess.
  - Base the verdict on the evidence in the payload only: the failure message,
    the stack frames, the changed files, and the short history summary. Do not
    assume facts that are not there.
  - real_regression needs a concrete link \u2014 name the changed file or symbol that
    connects to the failure. If you cannot, it is not a confident real_regression.
  - one_line_reason must be a single plain sentence a developer can act on,
    ideally under 140 characters.
  - suspect_location is "path:line" when the stack or diff points at one, else null.
  - likely_cause is an empty string when kind is "unknown".
  - Echo test_key back exactly as given. Return exactly one verdict per input
    failure, in the same order.`;
var DEFAULT_LIMITS = {
  maxFailures: 15,
  maxStackLines: 30,
  maxMessageChars: 2e3,
  maxDiffLines: 400
};
function truncateLines(text, maxLines) {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `\u2026 (${lines.length - maxLines} more lines truncated)`].join(
    "\n"
  );
}
function truncateChars(text, maxChars) {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\u2026 (truncated)`;
}
function buildUserPayload(input, limits = DEFAULT_LIMITS) {
  const { git, attempt, ambiguous } = input;
  const failures = ambiguous.slice(0, limits.maxFailures);
  const parts = [];
  parts.push(
    `## Run context`,
    `commit: ${git.commitSha}`,
    `parent: ${git.parentSha ?? "(none)"}`,
    `branch: ${git.branch ?? "(detached)"}`,
    `attempt: ${attempt}`,
    `changed files (${git.changedFiles.length}):`,
    ...git.changedFiles.slice(0, 100).map((f) => `  - ${f}`),
    "",
    `## ${failures.length} ambiguous failure(s)`
  );
  for (const t of failures) {
    const r = t.result;
    parts.push(
      "",
      `### test_key: ${r.testKey}`,
      `suite: ${r.suite}`,
      `name: ${r.name}`,
      `status: ${r.status}`,
      `file: ${r.file ?? "(unknown)"}`,
      `fingerprint: ${r.fingerprint ?? "(none)"}`,
      `message:`,
      truncateChars(r.failure?.message ?? "(no message)", limits.maxMessageChars),
      `stack:`,
      truncateLines(r.failure?.stack ?? "(no stack)", limits.maxStackLines)
    );
  }
  if (input.diff && input.diff.trim().length > 0) {
    parts.push("", `## commit diff (truncated)`, truncateLines(input.diff, limits.maxDiffLines));
  }
  if (ambiguous.length > failures.length) {
    parts.push(
      "",
      `(${ambiguous.length - failures.length} further ambiguous failure(s) omitted from this batch and reported without a model opinion)`
    );
  }
  return parts.join("\n");
}

// src/pipeline.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname2, isAbsolute, join as join3, resolve } from "node:path";

// src/core/blame.ts
var CONFIDENCE = {
  exact_line: 0.95,
  same_hunk: 0.8,
  same_file: 0.5,
  imported_by: 0.3
};
var DEFAULT_HUNK_RADIUS = 5;
function norm(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
function samePath(a, b) {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
}
function correlate(stack, diff, opts = {}) {
  const radius = opts.hunkRadius ?? DEFAULT_HUNK_RADIUS;
  const links = [];
  const changedFiles = [...new Set(diff.map((h) => h.file))];
  for (const frame of stack) {
    const hunksInFile = diff.filter((h) => samePath(h.file, frame.file));
    if (frame.line !== null && hunksInFile.length > 0) {
      let best = null;
      let bestFile = "";
      for (const h of hunksInFile) {
        if (h.changedLines.includes(frame.line)) {
          best = "exact_line";
          bestFile = h.file;
          break;
        }
        const near = frame.line >= h.newStart - radius && frame.line <= h.newStart + h.newLines + radius;
        if (near && best === null) {
          best = "same_hunk";
          bestFile = h.file;
        }
      }
      if (best) {
        links.push({ frame, changedFile: bestFile, proximity: best, confidence: CONFIDENCE[best] });
        continue;
      }
    }
    const inChangedFile = changedFiles.find((cf) => samePath(cf, frame.file));
    if (inChangedFile) {
      links.push({
        frame,
        changedFile: inChangedFile,
        proximity: "same_file",
        confidence: CONFIDENCE.same_file
      });
      continue;
    }
    if (opts.importsOf) {
      const imports = opts.importsOf(frame.file) ?? [];
      const hit = changedFiles.find((cf) => imports.some((imp) => samePath(imp, cf)));
      if (hit) {
        links.push({
          frame,
          changedFile: hit,
          proximity: "imported_by",
          confidence: CONFIDENCE.imported_by
        });
      }
    }
  }
  return links.sort(
    (a, b) => b.confidence - a.confidence || a.frame.depth - b.frame.depth
  );
}
var VENDOR = /node_modules[\\/]|[\\/](?:site-packages|dist-packages)[\\/]|\b(?:java|javax|jdk|sun|scala|kotlin)\.|jdk\.internal|java\.base\/|\borg\.(?:junit|testng|gradle|apache\.maven\.surefire|hamcrest|mockito)\b|node:internal|internal\/(?:process|modules)\/|<frozen |\/usr\/lib\/python|_pytest[\\/]|\bat new Promise \(<anonymous>\)/;
var FRAME_PATTERNS = [
  // JS / TS:  at fn (path/to/file.ts:12:5)   |   at path/to/file.ts:12:5
  { re: /^\s*at\s+(?:async\s+)?(.+?)\s+\(([^()]+?):(\d+)(?::\d+)?\)\s*$/, symbol: 1, file: 2, line: 3 },
  { re: /^\s*at\s+([^\s()]+?):(\d+)(?::\d+)?\s*$/, symbol: null, file: 1, line: 2 },
  // Java / Kotlin:  at pkg.Class.method(File.java:42)
  { re: /^\s*at\s+([\w$.]+)\(([\w$]+\.\w+):(\d+)\)\s*$/, symbol: 1, file: 2, line: 3 },
  // Python:  File "path/x.py", line 42, in fn
  { re: /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/, file: 1, line: 2, symbol: 3 },
  // pytest short:  path/x.py:42: in fn
  { re: /^\s*([\w./\\-]+\.\w+):(\d+):\s*in\s+(\S+)/, file: 1, line: 2, symbol: 3 },
  // pytest final:  path/x.py:42: SomeError
  { re: /^\s*([\w./\\-]+\.\w+):(\d+):\s*[A-Z]/, file: 1, line: 2, symbol: null },
  // ruby:  path/x.rb:3:in `meth'
  { re: /^\s*([\w./\\-]+\.rb):(\d+):in\s+[`']?([^'"]+)/, file: 1, line: 2, symbol: 3 },
  // go:  path/x_test.go:12
  { re: /(?:^|\s)([\w./\\-]+\.go):(\d+)/, file: 1, line: 2, symbol: null },
  // playwright code-frame header:  at ..\pages\Foo.ts:10
  { re: /^\s*at\s+([.\w/\\-]+\.\w+):(\d+)\s*$/, symbol: null, file: 1, line: 2 }
];
function parseStackFrames(stack, opts = {}) {
  const max = opts.max ?? 12;
  const out = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.replace(/\[[0-9;]*[A-Za-z]/g, "");
    if (VENDOR.test(line)) continue;
    for (const p of FRAME_PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      let file = (m[p.file] ?? "").trim().replace(/\\/g, "/").replace(/^(?:\.\.\/)+/, "");
      file = file.replace(/^[A-Za-z]:\//, "").replace(/^\/?home\/runner\/work\/[^/]+\/[^/]+\//, "").replace(/^\/?(?:github\/workspace|__w\/[^/]+\/[^/]+)\//, "").replace(/^[A-Za-z]:\/a\/[^/]+\/[^/]+\//, "").replace(/^\/?(?:home|Users)\/[^/]+\//, "").replace(/^\//, "");
      if (!file || !/\.\w+$/.test(file)) break;
      const lineNo = p.line ? Number(m[p.line]) : NaN;
      out.push({
        file,
        line: Number.isFinite(lineNo) ? lineNo : null,
        symbol: p.symbol !== null ? m[p.symbol]?.trim() ?? null : null,
        raw: rawLine.trim(),
        depth: out.length
      });
      break;
    }
    if (out.length >= max) break;
  }
  return out;
}
var IMPORT_PATTERNS = [
  /\bimport\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g,
  // ES import ... from "x"
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  // CJS require("x")
  /\bfrom\s+([\w.]+)\s+import\b/g,
  // python: from x import y
  /^\s*import\s+([\w.]+)\s*;?\s*$/gm,
  // python/java: import x  (bare, not `import x from`)
  /\buse\s+([\w\\]+)\s*;/g
  // php: use X\Y;
];
function parseImports(source) {
  const specs = /* @__PURE__ */ new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const s = m[1]?.trim();
      if (s) specs.add(s);
    }
  }
  return [...specs];
}

// src/core/classify.ts
var INFRA_SIGNATURES = [
  { pattern: /\bECONNREFUSED\b|connection refused/i, label: "connection refused" },
  { pattern: /\bECONNRESET\b|socket hang up/i, label: "connection reset / socket hang up" },
  { pattern: /\bETIMEDOUT\b/i, label: "connection timed out" },
  { pattern: /\bEAI_AGAIN\b/i, label: "DNS temporary failure (EAI_AGAIN)" },
  {
    pattern: /net::ERR_(?:CONNECTION_|NETWORK_|ADDRESS_UNREACHABLE|TIMED_OUT|EMPTY_RESPONSE)/i,
    label: "browser network error (net::ERR_\u2026)"
  },
  {
    pattern: /net::ERR_NAME_NOT_RESOLVED|Could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|\bENOTFOUND\b/i,
    label: "DNS resolution failure"
  },
  { pattern: /\bEHOSTUNREACH\b|\bENETUNREACH\b/i, label: "host / network unreachable" },
  {
    pattern: /\b(?:502|503|504)\b[^\n]{0,40}\b(?:from|response|status|gateway|unavailable|timeout)\b|\bBad Gateway\b|\bService Unavailable\b|\bGateway Time-?out\b/i,
    label: "upstream 5xx (gateway / unavailable / timeout)"
  },
  {
    pattern: /\b(?:connection|conn|pool)\s+pool\s+(?:exhausted|timeout|is full)|\bTimedOutError: .*acquiring a connection\b|QueuePool limit .* overflow|too many connections/i,
    label: "connection pool exhausted"
  },
  { pattern: /OOMKilled|\bout of memory\b|java\.lang\.OutOfMemoryError/i, label: "out of memory / OOMKilled" },
  {
    pattern: /\bContainer (?:exited|killed|failed to start)\b|\bpod (?:evicted|OOMKilled)\b/i,
    label: "container exited / killed"
  },
  { pattern: /No space left on device|\bENOSPC\b/i, label: "no space left on device" },
  {
    pattern: /(?:chrome|chromium|firefox|webkit|browser|webdriver|geckodriver|chromedriver)[^\n]{0,60}(?:failed to (?:start|launch)|launch failed|crashed|not reachable)|session not created|unable to (?:connect to|obtain) .{0,40}(?:driver|browser)|Failed to connect to the bus/i,
    label: "browser / WebDriver launch failure"
  },
  {
    pattern: /Runner\.Worker.* exited with code|The runner has received a shutdown signal|The operation was canceled/i,
    label: "CI runner terminated"
  },
  {
    // any socket or host: default, rootless (/run/user/…), DOCKER_HOST=tcp://…, Windows named pipe
    pattern: /Cannot connect to the Docker daemon at \S+|error during connect: .*docker_engine/i,
    label: "Docker daemon unreachable"
  },
  {
    // the registry's `toomanyrequests` error code, not a bare "429 Too Many Requests":
    // that also appears when a test hits the rate limiting of the app under test.
    pattern: /\btoomanyrequests:/i,
    label: "container registry pull rate limit"
  }
];
var RECENT_WINDOW = 30;
var AMBIGUOUS = {
  kind: "ambiguous",
  confidence: "low",
  evidence: ["no deterministic signal (history, fingerprint or blame) \u2014 needs a closer look"],
  source: "history"
};
function shortSha(sha) {
  return sha.slice(0, 7);
}
function unexplainedFlips(timeline) {
  let total = 0;
  let unexplained = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    if (timeline[i].outcome !== timeline[i - 1].outcome) {
      total += 1;
      if (!timeline[i].testFileChanged) unexplained += 1;
    }
  }
  return { total, unexplained, considered: timeline.length };
}
function blameSentence(link) {
  const at = `frame ${link.frame.depth} (${link.frame.file}${link.frame.line !== null ? `:${link.frame.line}` : ""})`;
  switch (link.proximity) {
    case "exact_line":
      return `${at} is on a line this PR changed in ${link.changedFile}`;
    case "same_hunk":
      return `${at} is within 5 lines of a hunk this PR changed in ${link.changedFile}`;
    case "same_file":
      return `${at} is in ${link.changedFile}, which this PR changed`;
    case "imported_by":
      return `${at} is in a file that imports ${link.changedFile}, which this PR changed`;
  }
}
function classify(input, opts = {}) {
  const { current, history } = input;
  const window = opts.window ?? RECENT_WINDOW;
  if (history.passedSameCommitOtherAttempt) {
    return {
      kind: "flake_confirmed",
      confidence: "high",
      source: "history",
      evidence: [
        `passed in another attempt of the same commit ${shortSha(current.commitSha)} (this is attempt ${current.attempt}) \u2014 the code did not change between attempts`
      ]
    };
  }
  const infra = INFRA_SIGNATURES.find((s) => s.pattern.test(current.normalizedText));
  if (infra) {
    return {
      kind: "infra_failure",
      confidence: "high",
      source: "history",
      evidence: [
        `failure looks like an infrastructure problem (${infra.label}), not a code defect`,
        "environmental \u2014 retrying or fixing the environment resolves it, your change did not cause it"
      ]
    };
  }
  if (history.priorRuns >= 1 && !history.everPassed) {
    return {
      kind: "always_failing",
      confidence: "high",
      source: "history",
      evidence: [
        `this test has never passed in ${history.priorRuns} recorded run(s) \u2014 it is already broken or quarantined; not something this PR broke`
      ]
    };
  }
  const flips = unexplainedFlips(history.timeline);
  const evidence4 = [];
  if (flips.unexplained >= 2) {
    const rate = flips.considered > 1 ? flips.total / (flips.considered - 1) : 0;
    evidence4.push(
      `flipped pass\u2194fail ${flips.total} time(s) over the last ${Math.min(
        flips.considered,
        window
      )} run(s) (flip rate ${Math.round(rate * 100)}%), ${flips.unexplained} of those with no change to the test file`
    );
  }
  if (history.fingerprintBranches >= 3) {
    evidence4.push(
      `this exact failure fingerprint (${current.fingerprint}) has appeared on ${history.fingerprintBranches} distinct branches \u2014 a shared flake, not caused by this branch`
    );
  }
  if (evidence4.length > 0) {
    return { kind: "flake_likely", confidence: "medium", source: "history", evidence: evidence4 };
  }
  if (history.parentOutcome === "pass" && current.blameLinks.length > 0) {
    const links = current.blameLinks.slice(0, 5);
    const strong = links.find(
      (l) => l.proximity === "exact_line" || l.proximity === "same_hunk"
    );
    const top = strong ?? links[0];
    return {
      kind: "real_regression",
      confidence: strong ? "high" : "medium",
      source: "history",
      blame: links,
      evidence: [
        `passed on the parent commit ${current.parentSha ? shortSha(current.parentSha) : "(parent)"} and fails here`,
        blameSentence(top)
      ]
    };
  }
  return AMBIGUOUS;
}

// src/core/flakyPass.ts
var MAX_REASON = 160;
function classifyPassedTest(input) {
  const evidence = [];
  if (input.retries.length > 0) {
    const n = input.retries.length;
    const first = input.retries[0];
    const reason = firstLine(first.message ?? first.stack ?? first.type);
    evidence.push(
      `failed ${n === 1 ? "once" : `${n} times`}, then passed on retry in this run (attempt ${input.attempt})${reason ? ` \u2014 first failure: ${reason}` : ""}`
    );
  }
  const failed = input.failedAttemptsOnCommit;
  if (failed.length > 0) {
    evidence.push(
      `failed in attempt${failed.length === 1 ? "" : "s"} ${failed.join(", ")} of the same commit ${input.commitSha.slice(0, 7)} and passed in attempt ${input.attempt} \u2014 the code did not change between attempts`
    );
  }
  if (evidence.length === 0) return null;
  return { kind: "flake_confirmed", confidence: "high", source: "history", evidence };
}
function firstLine(text) {
  if (!text) return null;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}\u2026` : line;
}

// src/pipeline.ts
var SOURCE_EXT = /(?:[\w.@/\\-]+)\.(?:tsx?|jsx?|mjs|cjs|py|rb|java|kt|kts|go|php|cs|scala|swift|rs|c|cc|cpp|h|hpp)\b/gi;
function referencedFiles(...blobs) {
  const out = /* @__PURE__ */ new Set();
  for (const blob of blobs) {
    if (!blob) continue;
    for (const m of blob.matchAll(SOURCE_EXT)) {
      out.add(m[0].replace(/\\/g, "/").replace(/^[a-zA-Z]:\//, ""));
    }
  }
  return [...out];
}
function testFileTouched(changed, candidates) {
  if (candidates.length === 0) return false;
  const changedBases = new Set(
    changed.map((c) => c.replace(/\\/g, "/").split("/").pop().toLowerCase())
  );
  const changedFull = new Set(changed.map((c) => c.replace(/\\/g, "/").toLowerCase()));
  return candidates.some((cand) => {
    const norm2 = cand.replace(/\\/g, "/").toLowerCase();
    return changedFull.has(norm2) || changedBases.has(norm2.split("/").pop());
  });
}
function testFileCandidates(result) {
  const out = [];
  if (result.file) out.push(result.file.replace(/\\/g, "/"));
  const suite = result.suite;
  if (/^[\w]+(\.[\w]+)+$/.test(suite)) {
    const parts = suite.split(".");
    const last = parts[parts.length - 1];
    out.push(`${last}.java`, `${last}.kt`, `${parts.join("/")}.py`, `${last}.py`);
  } else if (/\.\w+$/.test(suite)) {
    out.push(suite.replace(/\\/g, "/"));
  }
  return out;
}
var STRIPPABLE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|rb|php)$/;
function makeImportsResolver(repoRoot) {
  const cache = /* @__PURE__ */ new Map();
  return (file) => {
    const cached = cache.get(file);
    if (cached) return cached;
    let out = [];
    try {
      const abs = resolve(repoRoot, file);
      if (abs.startsWith(resolve(repoRoot))) {
        const src = readFileSync4(abs, "utf8");
        const dir = dirname2(file.replace(/\\/g, "/"));
        out = parseImports(src).flatMap((spec) => resolveSpec(spec, dir)).filter((p) => Boolean(p));
      }
    } catch {
    }
    cache.set(file, out);
    return out;
  };
}
function resolveSpec(spec, fromDir) {
  if (spec.startsWith(".")) {
    const joined = join3(fromDir, spec).replace(/\\/g, "/");
    return [joined, joined.replace(STRIPPABLE_EXT, "")];
  }
  if (/^[\w]+(\.[\w]+)+$/.test(spec) && !isAbsolute(spec)) {
    return [spec.replace(/\./g, "/"), `${spec.replace(/\./g, "/")}.py`];
  }
  return [];
}
var DEFAULT_WINDOW = 30;
function triageRun(results, git, attempt, history, opts = {}) {
  const window = opts.window ?? DEFAULT_WINDOW;
  const analyzed = analyzeResults(results, { repoRoot: git.repoRoot });
  const importsOf = makeImportsResolver(git.repoRoot);
  const passed = analyzed.filter((r) => r.status === "passed").length;
  const skipped = analyzed.filter((r) => r.status === "skipped").length;
  const failures = analyzed.filter(
    (r) => r.status === "failed" || r.status === "error"
  );
  const triaged = failures.map((result) => ({
    result,
    verdict: classifyOne(result, git, attempt, history, window, importsOf)
  }));
  return {
    git,
    attempt,
    total: analyzed.length,
    passed,
    skipped,
    triaged,
    flakes: findFlakyPasses(analyzed, git, attempt, history),
    ambiguousCount: triaged.filter((t) => t.verdict.kind === "ambiguous").length
  };
}
function findFlakyPasses(analyzed, git, attempt, history) {
  const passedByKey = /* @__PURE__ */ new Map();
  for (const result of analyzed) {
    if (result.status !== "passed") continue;
    const rows = passedByKey.get(result.testKey) ?? [];
    rows.push(result);
    passedByKey.set(result.testKey, rows);
  }
  const flakes = [];
  for (const [key, rows] of passedByKey) {
    const retries = rows.flatMap((r) => r.retries);
    const verdict = classifyPassedTest({
      commitSha: git.commitSha,
      attempt,
      retries,
      failedAttemptsOnCommit: history.failedAttemptsOnCommit(git.commitSha, key, attempt)
    });
    if (verdict) flakes.push({ result: { ...rows[0], retries }, verdict });
  }
  return flakes;
}
function applyEscalation(run, outcome) {
  const triaged = run.triaged.map((t) => {
    if (t.verdict.kind !== "ambiguous") return t;
    const mv = outcome.verdicts.get(t.result.testKey);
    if (!mv) return t;
    return { result: t.result, model: mv, verdict: modelToVerdict(mv) };
  });
  return {
    ...run,
    triaged,
    ambiguousCount: triaged.filter((t) => t.verdict.kind === "ambiguous").length,
    escalation: {
      model: outcome.model,
      provider: outcome.provider,
      tokens: outcome.usage.inputTokens,
      usd: outcome.usd,
      escalated: outcome.escalated,
      deferred: outcome.deferred.length,
      cacheHit: outcome.cacheHit,
      ...outcome.error ? { error: outcome.error } : {}
    }
  };
}
function modelToVerdict(mv) {
  const evidence = [mv.one_line_reason, mv.likely_cause].filter((s) => s.trim().length > 0);
  const base = { source: "model", evidence };
  switch (mv.kind) {
    case "real_regression":
      return { ...base, kind: "real_regression", confidence: mv.confidence === "high" ? "high" : "medium" };
    case "infra_failure":
      return { ...base, kind: "infra_failure", confidence: "high" };
    case "flake_likely":
      return { ...base, kind: "flake_likely", confidence: "medium" };
    case "unknown":
    default:
      return {
        kind: "ambiguous",
        confidence: "low",
        source: "model",
        evidence: evidence.length > 0 ? evidence : ["the model could not determine a cause"]
      };
  }
}
function classifyOne(result, git, attempt, history, window, importsOf) {
  const fingerprint = result.fingerprint ?? "";
  const norm2 = result.failure ? normalizeFailure(result.failure, { repoRoot: git.repoRoot }) : { message: "", frames: [], canonical: "" };
  const normalizedText = [norm2.message, ...norm2.frames].join("\n");
  const fileCandidates = testFileCandidates(result);
  const stackFrames = result.failure?.stack ? parseStackFrames(result.failure.stack) : [];
  const blameLinks = git.diffHunks.length > 0 && stackFrames.length > 0 ? correlate(stackFrames, git.diffHunks, { importsOf }) : [];
  const priorTimeline = history.timelineByTestKey(result.testKey);
  const timeline = priorTimeline.slice(-window + 1).map((t) => ({
    outcome: t.status === "passed" ? "pass" : "fail",
    testFileChanged: testFileTouched(t.changedFiles, fileCandidates)
  }));
  timeline.push({
    outcome: "fail",
    testFileChanged: testFileTouched(git.changedFiles, fileCandidates)
  });
  const parentOutcome = git.parentSha ? history.outcomeOnCommit(git.parentSha, result.testKey) : null;
  const spread = fingerprint ? history.fingerprintSpread(fingerprint) : null;
  const fingerprintBranches = Math.max(spread?.distinctBranches ?? 0, git.branch ? 1 : 0);
  const input = {
    test: {
      testKey: result.testKey,
      suite: result.suite,
      name: result.name,
      file: result.file
    },
    current: {
      status: result.status === "error" ? "error" : "failed",
      fingerprint,
      normalizedText,
      commitSha: git.commitSha,
      parentSha: git.parentSha,
      attempt,
      changedFiles: git.changedFiles,
      blameLinks
    },
    history: {
      passedSameCommitOtherAttempt: history.passedInAnotherAttempt(
        git.commitSha,
        result.testKey,
        attempt
      ),
      everPassed: history.everPassed(result.testKey),
      priorRuns: priorTimeline.length,
      parentOutcome,
      timeline,
      fingerprintBranches
    }
  };
  return classify(input, { window });
}

// src/llm/triage.ts
var TOKEN_GUARDRAIL = 1e5;
var EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
async function escalate(ambiguous, git, attempt, provider, opts = {}) {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const guardrail = opts.tokenGuardrail ?? TOKEN_GUARDRAIL;
  const base = {
    verdicts: /* @__PURE__ */ new Map(),
    deferred: [],
    usage: EMPTY_USAGE,
    usd: 0,
    cacheHit: false,
    model: provider.model,
    provider: provider.name,
    escalated: 0
  };
  if (ambiguous.length === 0) return base;
  const ranked = [...ambiguous].sort(
    (a, b) => historyDepth(b) - historyDepth(a)
  );
  const batch = ranked.slice(0, limits.maxFailures);
  const deferred = ranked.slice(limits.maxFailures);
  const framePaths = batch.flatMap(
    (t) => referencedFiles(t.result.failure?.stack, t.result.failure?.message)
  );
  const diff = opts.diff ?? "";
  void framePaths;
  const payload = redact(
    buildUserPayload({ git, attempt, ambiguous: batch, diff }, limits),
    opts.redactPatterns
  );
  let tokenCount;
  try {
    tokenCount = await provider.countTokens(SYSTEM_PROMPT, payload);
  } catch (e) {
    return { ...base, deferred, error: `token count failed: ${errMsg(e)}` };
  }
  if (tokenCount > guardrail) {
    return {
      ...base,
      deferred,
      error: `assembled payload is ~${tokenCount} tokens, over the ${guardrail} guardrail \u2014 not escalating`
    };
  }
  let result;
  try {
    result = await provider.triage(SYSTEM_PROMPT, payload);
  } catch (e) {
    return { ...base, deferred, error: errMsg(e) };
  }
  const byKey = /* @__PURE__ */ new Map();
  for (const v of result.verdicts) byKey.set(v.test_key, v);
  return {
    verdicts: byKey,
    deferred,
    usage: result.usage,
    usd: result.usd,
    cacheHit: result.cacheHit,
    model: result.model,
    provider: provider.name,
    escalated: batch.length
  };
}
function historyDepth(t) {
  return t.verdict.kind === "ambiguous" ? 0 : t.verdict.evidence.length;
}
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/report/shared.ts
var BUCKET_OF = {
  real_regression: "needs_you",
  always_failing: "look_soon",
  ambiguous: "look_soon",
  infra_failure: "safe_to_ignore",
  flake_confirmed: "safe_to_ignore",
  flake_likely: "safe_to_ignore"
};
var BUCKET_META = {
  needs_you: { emoji: "\u{1F534}", title: "Needs you", order: 0 },
  look_soon: { emoji: "\u{1F7E0}", title: "Look when you can", order: 1 },
  safe_to_ignore: { emoji: "\u26AA", title: "Safe to ignore", order: 2 }
};
var VERDICT_LABEL = {
  real_regression: "likely broken by this PR",
  always_failing: "already broken / quarantined \u2014 not this PR",
  ambiguous: "unclear \u2014 not enough signal",
  infra_failure: "infrastructure, not your change",
  flake_confirmed: "confirmed flake",
  flake_likely: "likely flake"
};
var FLAKY_PASS_META = { emoji: "\u26AA", title: "Passed after retry" };
function headline(run) {
  const regressions = run.triaged.filter((t) => t.verdict.kind === "real_regression").length;
  const needsYou = run.triaged.filter(
    (t) => BUCKET_OF[t.verdict.kind] === "needs_you"
  ).length;
  const lookSoon = run.triaged.filter(
    (t) => BUCKET_OF[t.verdict.kind] === "look_soon"
  ).length;
  const emoji = needsYou > 0 ? "\u{1F534}" : lookSoon > 0 ? "\u{1F7E0}" : "\u{1F7E2}";
  return { emoji, regressions, needsYou };
}
var KIND_ORDER = [
  "real_regression",
  "always_failing",
  "ambiguous",
  "infra_failure",
  "flake_confirmed",
  "flake_likely"
];
function groupByAction(run) {
  const byBucket = /* @__PURE__ */ new Map();
  for (const t of run.triaged) {
    const b = BUCKET_OF[t.verdict.kind];
    const list = byBucket.get(b) ?? [];
    list.push(t);
    byBucket.set(b, list);
  }
  const out = [];
  for (const bucket of ["needs_you", "look_soon", "safe_to_ignore"]) {
    const items = byBucket.get(bucket);
    if (!items?.length) continue;
    items.sort(
      (a, b) => KIND_ORDER.indexOf(a.verdict.kind) - KIND_ORDER.indexOf(b.verdict.kind) || confRank(b) - confRank(a)
    );
    out.push({ bucket, items });
  }
  return out;
}
function confRank(t) {
  return t.verdict.confidence === "high" ? 2 : t.verdict.confidence === "medium" ? 1 : 0;
}
function accounting(run) {
  const fromModel = run.triaged.filter((t) => t.verdict.source === "model").length;
  return {
    fromHistory: run.triaged.length - fromModel,
    fromModel,
    usd: run.escalation?.usd ?? 0
  };
}
function testTitle(t) {
  return `${t.result.suite} \u203A ${t.result.name}`;
}

// src/report/json.ts
function renderJsonReport(run) {
  const { emoji, regressions, needsYou } = headline(run);
  const acc = accounting(run);
  return {
    schema: "flaketriage/triage@2",
    commit: run.git.commitSha,
    parent: run.git.parentSha,
    branch: run.git.branch,
    attempt: run.attempt,
    emoji,
    totals: {
      total: run.total,
      passed: run.passed,
      skipped: run.skipped,
      failed: run.triaged.length,
      regressions,
      needsYou,
      ambiguous: run.ambiguousCount,
      flaky: run.flakes.length
    },
    cost: { fromHistory: acc.fromHistory, fromModel: acc.fromModel, usd: acc.usd },
    ...run.escalation ? {
      escalation: {
        model: run.escalation.model,
        escalated: run.escalation.escalated,
        deferred: run.escalation.deferred,
        cacheHit: run.escalation.cacheHit,
        ...run.escalation.error ? { error: run.escalation.error } : {}
      }
    } : {},
    verdicts: run.triaged.map((t) => ({
      testKey: t.result.testKey,
      suite: t.result.suite,
      name: t.result.name,
      status: t.result.status === "error" ? "error" : "failed",
      fingerprint: t.result.fingerprint,
      kind: t.verdict.kind,
      confidence: t.verdict.confidence,
      evidence: t.verdict.evidence,
      source: t.verdict.source,
      action: BUCKET_OF[t.verdict.kind],
      ...t.verdict.blame && t.verdict.blame.length > 0 ? {
        blame: t.verdict.blame.map((b) => ({
          file: b.frame.file,
          line: b.frame.line,
          proximity: b.proximity,
          confidence: b.confidence,
          changedFile: b.changedFile
        }))
      } : {},
      ...t.model ? {
        model: {
          one_line_reason: t.model.one_line_reason,
          likely_cause: t.model.likely_cause,
          suspect_location: t.model.suspect_location,
          suggested_next_step: t.model.suggested_next_step
        }
      } : {}
    })),
    flakes: run.flakes.map((t) => ({
      testKey: t.result.testKey,
      suite: t.result.suite,
      name: t.result.name,
      kind: t.verdict.kind,
      confidence: t.verdict.confidence,
      evidence: t.verdict.evidence,
      retries: t.result.retries.length
    }))
  };
}

// src/report/markdown.ts
var STICKY_MARKER = "<!-- flaketriage -->";
var MAX_ITEMS_PER_GROUP = 8;
function renderMarkdown(run) {
  const { emoji, needsYou } = headline(run);
  const failures = run.triaged.length;
  const flakes = run.flakes.length;
  const lines = [STICKY_MARKER];
  if (failures === 0) {
    lines.push(`### ${emoji} FlakeTriage \u2014 no failures${flakes > 0 ? `, ${flakes} flaky` : ""}`);
    lines.push(...flakySection(run), "", footer(run));
    return lines.join("\n");
  }
  lines.push(
    `### ${emoji} FlakeTriage \u2014 ${failures} failure${failures === 1 ? "" : "s"}, ` + (needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : "none need you")
  );
  for (const group of groupByAction(run)) {
    const meta = BUCKET_META[group.bucket];
    lines.push("", `**${meta.emoji} ${meta.title} \u2014 ${bucketSummary(group)}**`);
    for (const item of group.items.slice(0, MAX_ITEMS_PER_GROUP)) {
      lines.push(...renderItem(item, run.git.changedFiles));
    }
    const hidden = group.items.length - MAX_ITEMS_PER_GROUP;
    if (hidden > 0) lines.push(`- \u2026and ${hidden} more`);
  }
  lines.push(...flakySection(run), "", footer(run));
  return lines.join("\n");
}
function flakySection(run) {
  const n = run.flakes.length;
  if (n === 0) return [];
  const out = ["", `**${FLAKY_PASS_META.emoji} ${FLAKY_PASS_META.title} \u2014 ${n} flake${n === 1 ? "" : "s"}**`];
  for (const item of run.flakes.slice(0, MAX_ITEMS_PER_GROUP)) {
    out.push(`- \`${testTitle(item)}\``);
    for (const sentence of item.verdict.evidence.slice(0, 2)) out.push(`  ${sentence}`);
  }
  const hidden = n - MAX_ITEMS_PER_GROUP;
  if (hidden > 0) out.push(`- \u2026and ${hidden} more`);
  return out;
}
function bucketSummary(group) {
  const n = group.items.length;
  const kinds = group.items.map((t) => t.verdict.kind);
  const uniq = [...new Set(kinds)];
  if (group.bucket === "safe_to_ignore") {
    const flakes = kinds.filter((k) => k === "flake_confirmed" || k === "flake_likely").length;
    const infra = kinds.filter((k) => k === "infra_failure").length;
    const parts = [];
    if (flakes) parts.push(`${flakes} flake${flakes === 1 ? "" : "s"}`);
    if (infra) parts.push(`${infra} infra failure${infra === 1 ? "" : "s"}`);
    return parts.join(", ");
  }
  if (uniq.length === 1) return `${n} ${VERDICT_LABEL[uniq[0]]}`;
  return `${n} item${n === 1 ? "" : "s"}`;
}
function renderItem(item, changedFiles) {
  const tag = item.verdict.source === "model" ? " _(model)_" : "";
  const out = [`- \`${testTitle(item)}\`${tag}`];
  for (const sentence of item.verdict.evidence.slice(0, 2)) {
    out.push(`  ${sentence}`);
  }
  const next = item.model?.suggested_next_step ?? startHint(item, changedFiles);
  if (next) out.push(`  \u2192 ${next}`);
  return out;
}
var SRC_LOC = /([\w./\\-]+\.(?:tsx?|jsx?|mjs|cjs|py|rb|java|kt|go|php|cs|scala|rs)):(\d+)/g;
function startHint(item, changedFiles) {
  if (item.verdict.kind !== "real_regression") return null;
  const link = item.verdict.blame?.[0];
  if (link?.frame.line != null) {
    return `Start at \`${link.frame.file}:${link.frame.line}\``;
  }
  const stack = item.result.failure?.stack;
  if (!stack) return null;
  const changedBases = new Set(
    changedFiles.map((f) => f.replace(/\\/g, "/").split("/").pop().toLowerCase())
  );
  const locs = [...stack.matchAll(SRC_LOC)].map((m) => ({
    file: m[1].replace(/\\/g, "/"),
    line: m[2]
  }));
  const pick = locs.find((l) => changedBases.has(l.file.split("/").pop().toLowerCase())) ?? locs[0];
  return pick ? `Start at \`${pick.file}:${pick.line}\`` : null;
}
function footer(run) {
  const acc = accounting(run);
  const bits = [];
  if (acc.fromHistory > 0) bits.push(`${acc.fromHistory} from history`);
  if (acc.fromModel > 0) bits.push(`${acc.fromModel} from model`);
  if (bits.length === 0) bits.push("0 verdicts");
  const parts = [
    `FlakeTriage \xB7 ${bits.join(", ")} \xB7 $${acc.usd.toFixed(2)}`,
    `commit ${run.git.commitSha.slice(0, 7)}`
  ];
  const first = firstActionable(run.triaged);
  if (first) parts.push(`<code>flaketriage explain "${first.result.name}"</code>`);
  if (run.escalation?.deferred) parts.push(`${run.escalation.deferred} not escalated`);
  if (run.escalation?.error) parts.push(`model skipped: ${run.escalation.error}`);
  return `<sub>${parts.join(" \xB7 ")}</sub>`;
}
function firstActionable(triaged) {
  const order = ["real_regression", "always_failing", "ambiguous"];
  for (const k of order) {
    const hit = triaged.find((t) => t.verdict.kind === k);
    if (hit) return hit;
  }
  return void 0;
}

// src/report/summary.ts
var STACK_LINES = 15;
function renderSummary(run) {
  const { emoji, needsYou } = headline(run);
  const failures = run.triaged.length;
  const acc = accounting(run);
  const lines = [];
  lines.push(`## ${emoji} FlakeTriage`, "");
  lines.push(...runInfoLine(run));
  lines.push("", ...statsTable(run));
  if (failures === 0) {
    lines.push("", "No failures on this run.", ...flakySection2(run));
    return lines.join("\n");
  }
  lines.push(
    "",
    needsYou > 0 ? `**${needsYou} failure${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} you.**` : "**Nothing here needs you** \u2014 see *Safe to ignore* for why."
  );
  for (const group of groupByAction(run)) {
    const meta = BUCKET_META[group.bucket];
    lines.push("", `### ${meta.emoji} ${meta.title} (${group.items.length})`);
    for (const item of group.items) {
      lines.push("", ...renderItem2(item, group.bucket === "needs_you"));
    }
  }
  lines.push(...flakySection2(run), "", ...footer2(run, acc));
  return lines.join("\n");
}
function flakySection2(run) {
  const n = run.flakes.length;
  if (n === 0) return [];
  const lines = [
    "",
    `### ${FLAKY_PASS_META.emoji} ${FLAKY_PASS_META.title} (${n})`,
    "",
    "These tests passed, but only after failing first. They don't fail the build; left alone, they teach everyone to ignore red runs."
  ];
  for (const item of run.flakes) lines.push("", ...renderItem2(item, false));
  return lines;
}
function runInfoLine(run) {
  const bits = [
    `commit \`${run.git.commitSha.slice(0, 7)}\``,
    run.git.branch ? `branch \`${run.git.branch}\`` : null,
    run.git.parentSha ? `parent \`${run.git.parentSha.slice(0, 7)}\`` : null,
    `attempt ${run.attempt}`
  ].filter((s) => s !== null);
  return [bits.join(" \xB7 ")];
}
function statsTable(run) {
  const { needsYou } = headline(run);
  const acc = accounting(run);
  const header = ["Total", "Passed", "Failed", "Skipped", "Needs you", "Cost"];
  const values = [
    String(run.total),
    String(run.passed),
    String(run.triaged.length),
    String(run.skipped),
    String(needsYou),
    `$${acc.usd.toFixed(2)}`
  ];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    `| ${values.join(" | ")} |`
  ];
}
function renderItem2(item, openByDefault) {
  const conf = item.verdict.confidence;
  const src = item.verdict.source === "model" ? " \xB7 model" : " \xB7 history";
  const summary2 = `<code>${escapeHtml(testTitle(item))}</code> \u2014 ${VERDICT_LABEL[item.verdict.kind]} (${conf} confidence${src})`;
  const body = [];
  body.push("**Evidence**");
  for (const e of item.verdict.evidence) body.push(`- ${e}`);
  if (item.model) {
    body.push("", "**Model reasoning**");
    body.push(`- likely cause: ${item.model.likely_cause}`);
    if (item.model.suspect_location) body.push(`- suspect location: \`${item.model.suspect_location}\``);
  }
  if (item.verdict.blame && item.verdict.blame.length > 0) {
    body.push("", "**Blame** (stack frame \u2194 changed file)");
    body.push(...blameTable(item.verdict.blame));
  }
  const next = item.model?.suggested_next_step;
  if (next) body.push("", `**Next step:** ${next}`);
  const failure = item.result.failure;
  if (failure && (failure.message || failure.stack)) {
    body.push("", "**Failure**");
    if (failure.message) body.push("```", truncate(failure.message, STACK_LINES), "```");
    if (failure.stack) body.push("```", truncate(failure.stack, STACK_LINES), "```");
  }
  body.push("", `<sub><code>flaketriage explain "${escapeHtml(item.result.name)}"</code></sub>`);
  return [
    `<details${openByDefault ? " open" : ""}>`,
    `<summary>${summary2}</summary>`,
    "",
    ...body,
    "",
    "</details>"
  ];
}
function blameTable(links) {
  const header = ["Confidence", "Proximity", "Frame", "Changed file"];
  const rows = links.map((l) => [
    l.confidence.toFixed(2),
    l.proximity,
    `\`${l.frame.file}${l.frame.line !== null ? `:${l.frame.line}` : ""}\``,
    `\`${l.changedFile}\``
  ]);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`)
  ];
}
function footer2(run, acc) {
  const bits = [];
  if (acc.fromHistory > 0) bits.push(`${acc.fromHistory} from history`);
  if (acc.fromModel > 0) bits.push(`${acc.fromModel} from model`);
  if (bits.length === 0) bits.push("0 verdicts");
  const parts = [bits.join(", "), `$${acc.usd.toFixed(2)}`];
  if (run.escalation?.model && acc.fromModel > 0) parts.push(run.escalation.model);
  if (run.escalation?.deferred) parts.push(`${run.escalation.deferred} not escalated`);
  const out = ["---", `<sub>FlakeTriage \xB7 ${parts.join(" \xB7 ")}</sub>`];
  if (run.escalation?.error) out.push(`<sub>\u26A0\uFE0F model escalation skipped: ${run.escalation.error}</sub>`);
  return out;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function truncate(s, lines) {
  const l = s.split(/\r?\n/);
  return l.length <= lines ? s : `${l.slice(0, lines).join("\n")}
\u2026 (${l.length - lines} more line(s))`;
}

// src/report/text.ts
function renderText(run, color = false) {
  const bold = (s) => color ? `[1m${s}[22m` : s;
  const dim = (s) => color ? `[2m${s}[22m` : s;
  const { emoji, needsYou } = headline(run);
  const failures = run.triaged.length;
  const out = [];
  out.push(
    bold(
      `${emoji} FlakeTriage \u2014 ${run.passed} passed, ${failures} failed/error, ${run.skipped} skipped`
    )
  );
  out.push(
    dim(
      `   commit ${run.git.commitSha.slice(0, 7)}${run.git.branch ? ` (${run.git.branch})` : ""} \xB7 attempt ${run.attempt}`
    )
  );
  if (failures === 0) {
    out.push(...flakyLines(run, bold, dim), "", footer3(run, dim));
    return out.join("\n");
  }
  if (needsYou > 0) out.push(dim(`   ${needsYou} need${needsYou === 1 ? "s" : ""} you`));
  for (const group of groupByAction(run)) {
    const meta = BUCKET_META[group.bucket];
    out.push("", bold(`${meta.emoji} ${meta.title}`));
    for (const item of group.items) out.push(...renderItem3(item, dim));
  }
  out.push(...flakyLines(run, bold, dim), "", footer3(run, dim));
  return out.join("\n");
}
function flakyLines(run, bold, dim) {
  if (run.flakes.length === 0) return [];
  const out = ["", bold(`${FLAKY_PASS_META.emoji} ${FLAKY_PASS_META.title}`)];
  for (const item of run.flakes) out.push(...renderItem3(item, dim));
  return out;
}
function renderItem3(item, dim) {
  const conf = ` [${item.verdict.confidence}]`;
  const src = item.verdict.source === "model" ? dim(" (model)") : "";
  const label = dim(` \u2014 ${VERDICT_LABEL[item.verdict.kind]}`);
  const out = [`  \u2022 ${testTitle(item)}${dim(conf)}${label}${src}`];
  for (const sentence of item.verdict.evidence) out.push(dim(`      ${sentence}`));
  if (item.model?.suggested_next_step) {
    out.push(dim(`      \u2192 ${item.model.suggested_next_step}`));
  }
  return out;
}
function footer3(run, dim) {
  const acc = accounting(run);
  const bits = [];
  if (acc.fromHistory > 0) bits.push(`${acc.fromHistory} from history`);
  if (acc.fromModel > 0) bits.push(`${acc.fromModel} from model`);
  if (bits.length === 0) bits.push("0 verdicts");
  let line = `   ${bits.join(", ")} \xB7 $${acc.usd.toFixed(2)}`;
  if (run.escalation?.model && acc.fromModel > 0) line += ` \xB7 ${run.escalation.model}`;
  if (run.escalation?.error) line += `
   ! model escalation skipped: ${run.escalation.error}`;
  return dim(line);
}

// src/run.ts
async function runFlakeTriage(opts) {
  const repoPath = resolve2(opts.repoPath);
  const globs = opts.reportGlobs?.length ? opts.reportGlobs : DEFAULT_REPORT_GLOBS;
  const attempt = opts.attempt ?? 1;
  const window = opts.window ?? 30;
  const failOn = opts.failOn ?? "regression";
  const now = opts.now ?? Date.now;
  const printPayload = opts.printPayload ?? false;
  const reportFiles = discoverReports(repoPath, globs);
  if (reportFiles.length === 0) {
    throw new FlakeTriageError(
      "NO_REPORTS",
      `no JUnit reports matched [${globs.join(", ")}] under ${repoPath}`
    );
  }
  const results = [];
  const parseFailures = [];
  for (const file of reportFiles) {
    try {
      const parsed = file.toLowerCase().endsWith(".json") ? parsePlaywrightFile(file) : parseJUnitFile(file);
      results.push(...parsed);
    } catch (e) {
      parseFailures.push({ file, message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (results.length === 0) {
    throw new FlakeTriageError(
      "JUNIT_PARSE",
      `all ${reportFiles.length} report(s) failed to parse`
    );
  }
  const git = await readGitContext(repoPath, {
    commit: opts.commit,
    parent: opts.parent
  });
  const history = History.open(resolve2(opts.db));
  let run;
  try {
    run = triageRun(results, git, attempt, history, { window });
    if (!printPayload) {
      history.recordRun(
        {
          repo: git.repoSlug,
          commitSha: git.commitSha,
          parentSha: git.parentSha,
          branch: git.branch,
          ciRunId: opts.ciRunId ?? null,
          attempt,
          startedAt: now(),
          changedFiles: git.changedFiles
        },
        analyzeResults(results, { repoRoot: git.repoRoot }).map((r) => ({
          suite: r.suite,
          testName: r.name,
          testKey: r.testKey,
          status: r.status,
          durationMs: r.durationMs,
          message: r.failure?.message ?? null,
          stack: r.failure?.stack ?? null,
          fingerprint: r.fingerprint
        }))
      );
    }
  } catch (e) {
    history.close();
    throw e;
  }
  history.close();
  const resolveOpts = {
    provider: opts.llmProvider,
    model: opts.llmModel,
    baseUrl: opts.llmBaseUrl,
    awsRegion: opts.awsRegion,
    gcpProjectId: opts.gcpProjectId,
    gcpRegion: opts.gcpRegion,
    foundryResource: opts.foundryResource,
    disabled: opts.llm === false,
    ...opts.providerEnv ? { env: opts.providerEnv } : {}
  };
  if (printPayload) {
    const provider2 = resolveProvider(resolveOpts);
    const ambiguous = run.triaged.filter((t) => t.verdict.kind === "ambiguous");
    let payloadPreview;
    if (ambiguous.length === 0) {
      payloadPreview = {
        provider: provider2?.name ?? null,
        model: provider2?.model ?? null,
        ambiguousCount: 0,
        system: null,
        user: null
      };
    } else {
      const framePaths = ambiguous.flatMap(
        (t) => referencedFiles(t.result.failure?.stack, t.result.failure?.message)
      );
      const diff = await readCommitDiff(
        git.repoRoot,
        git.commitSha,
        git.parentSha,
        framePaths
      ).catch(() => "");
      const payload = buildUserPayload({ git, attempt, ambiguous, diff }, DEFAULT_LIMITS);
      payloadPreview = {
        provider: provider2?.name ?? null,
        model: provider2?.model ?? null,
        ambiguousCount: ambiguous.length,
        system: redact(SYSTEM_PROMPT, opts.redactPatterns),
        user: redact(payload, opts.redactPatterns)
      };
    }
    return {
      run,
      markdown: renderMarkdown(run),
      summary: renderSummary(run),
      text: renderText(run, false),
      json: renderJsonReport(run),
      exitCode: 0,
      reportFileCount: reportFiles.length,
      parseFailures,
      payloadPreview
    };
  }
  const provider = resolveProvider(resolveOpts);
  if (provider && provider.enabled && run.ambiguousCount > 0) {
    const ambiguous = run.triaged.filter((t) => t.verdict.kind === "ambiguous");
    const framePaths = ambiguous.flatMap(
      (t) => referencedFiles(t.result.failure?.stack, t.result.failure?.message)
    );
    const diff = await readCommitDiff(
      git.repoRoot,
      git.commitSha,
      git.parentSha,
      framePaths
    ).catch(() => "");
    run = applyEscalation(
      run,
      await escalate(ambiguous, git, attempt, provider, {
        diff,
        redactPatterns: opts.redactPatterns
      })
    );
  } else if (provider && !provider.enabled && run.ambiguousCount > 0) {
    run = {
      ...run,
      escalation: {
        model: provider.model,
        provider: provider.name,
        tokens: 0,
        usd: 0,
        escalated: 0,
        deferred: 0,
        cacheHit: false,
        error: `${provider.name}: no API key configured`
      }
    };
  }
  return {
    run,
    markdown: renderMarkdown(run),
    summary: renderSummary(run),
    text: renderText(run, false),
    json: renderJsonReport(run),
    exitCode: exitCodeFor(run, failOn),
    reportFileCount: reportFiles.length,
    parseFailures
  };
}
function exitCodeFor(run, failOn) {
  if (failOn === "never") return 0;
  if (failOn === "any") return run.triaged.length > 0 ? 1 : 0;
  return run.triaged.some((t) => t.verdict.kind === "real_regression") ? 1 : 0;
}

// action/comment.ts
async function upsertStickyComment(api, target, body) {
  const existing = await findMarkedComment(api, target);
  if (existing) {
    const { data: data2 } = await api.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: existing.id,
      body
    });
    return { action: "updated", commentId: data2.id, url: data2.html_url };
  }
  const { data } = await api.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    body
  });
  return { action: "created", commentId: data.id, url: data.html_url };
}
async function findMarkedComment(api, target) {
  for (let page = 1; page <= 20; page += 1) {
    const { data } = await api.listComments({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.issueNumber,
      per_page: 100,
      page
    });
    const hit = data.find((c) => (c.body ?? "").trimStart().startsWith(STICKY_MARKER));
    if (hit) return hit;
    if (data.length < 100) break;
  }
  return null;
}

// action/index.ts
function splitGlobs(raw) {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
function boolInput(name, fallback) {
  const v = core.getInput(name).trim().toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}
function resolveRefs() {
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (pr) {
    return {
      commit: pr.head?.sha,
      parent: pr.base?.sha,
      prNumber: pr.number
    };
  }
  const before = typeof ctx.payload["before"] === "string" ? ctx.payload["before"] : void 0;
  const after = typeof ctx.payload["after"] === "string" ? ctx.payload["after"] : void 0;
  return {
    commit: after && !/^0+$/.test(after) ? after : void 0,
    parent: before && !/^0+$/.test(before) ? before : void 0,
    prNumber: void 0
  };
}
async function main() {
  const reports = splitGlobs(core.getInput("reports"));
  const workingDirectory = core.getInput("working-directory") || process.cwd();
  const db = core.getInput("db-path") || ".flaketriage/history.db";
  const failOn = core.getInput("fail-on") || "regression";
  const attempt = Number(core.getInput("attempt") || process.env["GITHUB_RUN_ATTEMPT"] || "1");
  const cfg = loadConfig(workingDirectory).config;
  const redactPatterns = cfg.redact?.patterns ? compilePatterns(cfg.redact.patterns) : void 0;
  const provider = core.getInput("provider") || cfg.llm?.provider || "auto";
  const llmModel = core.getInput("llm-model") || cfg.llm?.model || void 0;
  const llmBaseUrl = core.getInput("llm-base-url") || cfg.llm?.base_url || void 0;
  const wantComment = core.getBooleanInput("comment");
  const noLlm = boolInput("no-llm", false);
  const anthropicKey = core.getInput("anthropic-api-key");
  const githubToken = core.getInput("github-token");
  if (anthropicKey) process.env["ANTHROPIC_API_KEY"] = anthropicKey;
  const refs = resolveRefs();
  const result = await runFlakeTriage({
    repoPath: workingDirectory,
    reportGlobs: reports,
    db,
    commit: refs.commit,
    parent: refs.parent,
    attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    failOn,
    llm: !noLlm,
    llmProvider: provider,
    llmModel,
    llmBaseUrl,
    redactPatterns,
    ciRunId: process.env["GITHUB_RUN_ID"] ?? null
  });
  const { run, markdown, summary: summary2, json } = result;
  await core.summary.addRaw(summary2).write();
  for (const pf of result.parseFailures) {
    core.warning(
      `skipped unparseable report ${relative2(workingDirectory, pf.file)}: ${pf.message}`
    );
  }
  if (run.escalation?.error) {
    core.warning(`LLM escalation skipped: ${run.escalation.error}`);
  } else if (run.escalation && run.escalation.escalated > 0) {
    core.info(
      `\u2192 ${run.escalation.escalated} failure(s), ${run.escalation.tokens.toLocaleString()} tokens sent to ${run.escalation.provider}/${run.escalation.model}`
    );
  }
  core.setOutput("regressions", String(json.totals.regressions));
  core.setOutput("needs-attention", String(json.totals.needsYou));
  core.setOutput("failed", String(json.totals.failed));
  core.setOutput("flaky", String(json.totals.flaky));
  core.setOutput("cost-usd", json.cost.usd.toFixed(4));
  core.setOutput("report-markdown", markdown);
  core.setOutput("report-summary", summary2);
  core.setOutput("report-json", JSON.stringify(json));
  if (wantComment && refs.prNumber !== void 0) {
    if (!githubToken) {
      core.warning("comment: true but no github-token provided \u2014 skipping the PR comment");
    } else {
      const octokit = github.getOctokit(githubToken);
      const { owner, repo } = github.context.repo;
      try {
        const res = await upsertStickyComment(
          octokit.rest.issues,
          { owner, repo, issueNumber: refs.prNumber },
          markdown
        );
        core.info(`FlakeTriage comment ${res.action}: ${res.url ?? res.commentId}`);
      } catch (e) {
        core.warning(`failed to post the PR comment: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else if (wantComment) {
    core.info("not a pull_request event \u2014 job summary written, no PR comment");
  }
  if (result.exitCode === 1) {
    core.setFailed(
      json.totals.regressions > 0 ? `${json.totals.regressions} real regression(s) \u2014 see the FlakeTriage report` : `${json.totals.failed} failing test(s) with --fail-on ${failOn}`
    );
  }
}
main().catch((e) => {
  if (e instanceof FlakeTriageError) {
    core.setFailed(`flaketriage: ${e.message} [${e.code}]`);
  } else {
    core.setFailed(e instanceof Error ? e.stack ?? e.message : String(e));
  }
});
