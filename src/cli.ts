#!/usr/bin/env node
/**
 * cli.ts — commander entrypoint.
 *
 *   flaketriage run                  triage a commit's reports + record the run
 *   flaketriage explain <test>       the full evidence behind one verdict
 *   flaketriage history <test>       the pass/fail timeline for one test
 *   flaketriage stats                the flakiest tests by flip rate
 *   flaketriage backfill             populate history from GitHub Actions runs
 */

import { resolve } from "node:path";
import { argv, env } from "node:process";
import { pathToFileURL } from "node:url";

import { Command, InvalidArgumentError, Option } from "commander";

import { loadConfig } from "./config.js";
import { FlakeTriageError } from "./core/errors.js";
import { computeFlakyStats } from "./core/flakiness.js";
import { History } from "./core/history.js";
import { explainTest } from "./explain.js";
import { backfill } from "./ingest/backfill.js";
import type { BackfillProgress } from "./ingest/backfill.js";
import { estimateEscalationCost, MAX_FAILURES_PER_BATCH } from "./llm/cost.js";
import { compilePatterns } from "./llm/payload.js";
import { runFlakeTriage } from "./run.js";
import type { FailOn } from "./run.js";
import { renderExplain } from "./report/explain.js";
import { renderText } from "./report/text.js";

const DEFAULT_DB = ".flaketriage/history.db";

function parseIntArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return n;
}

function splitList(value: string, prev: string[] = []): string[] {
  return [...prev, ...value.split(",").map((s) => s.trim()).filter(Boolean)];
}

// ── output helpers ───────────────────────────────────────────────────────────

const isTty = process.stdout.isTTY === true;
const dim = (s: string) => (isTty ? `[2m${s}[22m` : s);
const bold = (s: string) => (isTty ? `[1m${s}[22m` : s);

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "—";
}

function fmtDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "FAIL";
    case "error":
      return "ERR ";
    case "skipped":
      return "skip";
    default:
      return status;
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

type RunFormat = "text" | "md" | "summary" | "json";

interface RunOptions {
  reports: string[];
  repo: string;
  db: string;
  commit?: string;
  parent?: string;
  attempt: number;
  format: RunFormat;
  llm: boolean;
  provider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  failOn: FailOn;
  window: number;
  printPayload?: boolean;
}

async function cmdRun(opts: RunOptions): Promise<number> {
  const cfg = loadConfig(resolve(opts.repo)).config;
  const redactPatterns = cfg.redact?.patterns
    ? compilePatterns(cfg.redact.patterns)
    : undefined;

  const result = await runFlakeTriage({
    repoPath: opts.repo,
    reportGlobs: opts.reports,
    db: opts.db,
    commit: opts.commit,
    parent: opts.parent,
    attempt: opts.attempt,
    window: opts.window,
    failOn: opts.failOn,
    llm: opts.llm,
    llmProvider: opts.provider ?? cfg.llm?.provider ?? "auto",
    llmModel: opts.llmModel ?? cfg.llm?.model,
    llmBaseUrl: opts.llmBaseUrl ?? cfg.llm?.base_url,
    redactPatterns,
    printPayload: opts.printPayload,
    ciRunId: env["GITHUB_RUN_ID"] ?? null,
  });

  if (opts.printPayload) {
    process.stdout.write(JSON.stringify(result.payloadPreview, null, 2) + "\n");
    return result.exitCode;
  }

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(result.json, null, 2) + "\n");
  } else if (opts.format === "md") {
    process.stdout.write(result.markdown + "\n");
  } else if (opts.format === "summary") {
    process.stdout.write(result.summary + "\n");
  } else {
    process.stdout.write(renderText(result.run, isTty) + "\n");
    for (const pf of result.parseFailures) {
      process.stderr.write(dim(`   ! skipped unparseable ${pf.file}: ${pf.message}\n`));
    }
  }

  const esc = result.run.escalation;
  if (esc && esc.escalated > 0 && !esc.error) {
    process.stderr.write(
      dim(
        `→ ${esc.escalated} failure(s), ${esc.tokens.toLocaleString()} tokens sent to ` +
          `${esc.provider}/${esc.model}\n`,
      ),
    );
  }

  return result.exitCode;
}

// ── explain <test> ───────────────────────────────────────────────────────────

interface ExplainOptions {
  repo: string;
  db: string;
  format: "text" | "json";
  window: number;
}

async function cmdExplain(query: string, opts: ExplainOptions): Promise<number> {
  const report = await explainTest(query, {
    repoPath: resolve(opts.repo),
    db: resolve(opts.db),
    window: opts.window,
  });
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderExplain(report, isTty) + "\n");
  }
  return 0;
}

// ── history <test> ───────────────────────────────────────────────────────────

interface HistoryOptions {
  db: string;
  format: "text" | "json";
  limit: number;
}

function cmdHistory(query: string, opts: HistoryOptions): number {
  const history = History.open(resolve(opts.db));
  try {
    const matches = history.findTests(query).slice(0, 5);
    if (matches.length === 0) {
      process.stderr.write(`no test in history matches "${query}"\n`);
      return 0;
    }

    const payload = matches.map((m) => {
      const timeline = history.timelineByTestKey(m.testKey).slice(-opts.limit);
      const outcomes = timeline
        .map((t) => t.status)
        .filter((s) => s !== "skipped");
      let flips = 0;
      for (let i = 1; i < outcomes.length; i += 1) {
        const a = outcomes[i - 1] === "passed" ? "p" : "f";
        const b = outcomes[i] === "passed" ? "p" : "f";
        if (a !== b) flips += 1;
      }
      return { test: m, timeline, flips, considered: outcomes.length };
    });

    if (opts.format === "json") {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return 0;
    }

    for (const { test, timeline, flips, considered } of payload) {
      process.stdout.write(
        `\n${bold(`${test.suite} › ${test.testName}`)}\n` +
          dim(`  test_key ${test.testKey.slice(0, 16)}… · ${timeline.length} run(s)`) +
          "\n",
      );
      for (const t of timeline) {
        process.stdout.write(
          `  ${fmtDate(t.startedAt)}  ${shortSha(t.commitSha)}  ` +
            `${(t.branch ?? "—").padEnd(16).slice(0, 16)}  a${t.attempt}  ` +
            `${statusGlyph(t.status)}  ${t.fingerprint ? t.fingerprint.slice(0, 12) : "—".padEnd(12)}\n`,
        );
      }
      const rate = considered > 1 ? flips / (considered - 1) : 0;
      process.stdout.write(
        dim(`  flipped ${flips}/${Math.max(considered - 1, 0)} transitions · flip rate ${pct(rate)}\n`),
      );
    }
    return 0;
  } finally {
    history.close();
  }
}

// ── stats ────────────────────────────────────────────────────────────────────

interface StatsOptions {
  db: string;
  format: "text" | "json";
  limit: number;
  minRuns: number;
  window: number;
  llmModel?: string;
}

function cmdStats(opts: StatsOptions): number {
  const history = History.open(resolve(opts.db));
  try {
    const rows = history.rowsForFlakiness(opts.window);
    const allStats = computeFlakyStats(rows, { minRuns: opts.minRuns });
    const stats = allStats.slice(0, opts.limit);

    // cost estimate: what one LLM triage of the flaky backlog would cost.
    // "flaky" here means ≥2 flips — matching the classifier's flake_likely rule;
    // a single pass→fail transition is a break, not a flake.
    const flakyCount = allStats.filter((s) => s.flips >= 2).length;
    const cost = estimateEscalationCost(flakyCount, { model: opts.llmModel });

    if (opts.format === "json") {
      process.stdout.write(
        JSON.stringify({ stats, flakyCount, costEstimate: cost }, null, 2) + "\n",
      );
      return 0;
    }

    if (stats.length === 0) {
      process.stdout.write(
        `no test has ≥ ${opts.minRuns} recorded runs yet — record more runs with \`flaketriage run\`\n`,
      );
      return 0;
    }

    process.stdout.write(
      bold(`Flakiest tests`) +
        dim(` (last ${opts.window} runs, ≥ ${opts.minRuns} runs each)\n`),
    );
    stats.forEach((s, i) => {
      process.stdout.write(
        `${String(i + 1).padStart(2)}. ${pct(s.flipRate).padStart(4)}  ` +
          `${String(`${s.flips}/${s.runs}`).padStart(6)}  ` +
          `${s.distinctFingerprints > 1 ? `${s.distinctFingerprints}fp ` : "    "}` +
          `${s.suite} › ${s.testName}  ${dim(`(last: ${statusGlyph(s.lastStatus).trim()})`)}\n`,
      );
    });
    process.stdout.write(
      dim(
        `\n${flakyCount} flaky test${flakyCount === 1 ? "" : "s"} in this window. ` +
          `Triaging a run where all of them fail with the model ` +
          `≈ $${cost.usd.toFixed(2)} ` +
          `(${cost.batches} batch${cost.batches === 1 ? "" : "es"} of ≤${MAX_FAILURES_PER_BATCH}, ` +
          `${opts.llmModel ?? "claude-opus-5"} rates). Deterministic verdicts are free.\n`,
      ),
    );
    return 0;
  } finally {
    history.close();
  }
}

// ── backfill ─────────────────────────────────────────────────────────────────

interface BackfillOptions {
  repo: string; // owner/name — a GitHub slug, not a local path
  db: string;
  days: number;
  since?: number;
  artifactName: string;
  token?: string;
}

async function cmdBackfill(opts: BackfillOptions): Promise<number> {
  const token = opts.token ?? env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
  if (!token) {
    throw new FlakeTriageError(
      "GITHUB_API",
      "no GitHub token — pass --token, or set GITHUB_TOKEN / GH_TOKEN " +
        "(e.g. --token $(gh auth token))",
    );
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
    throw new FlakeTriageError("GITHUB_API", `--repo must be "owner/name", got "${opts.repo}"`);
  }

  process.stdout.write(
    `${bold(`backfilling ${opts.repo}`)} — last ${opts.days} day(s), ` +
      `artifacts matching "${opts.artifactName}"${opts.since ? `, resuming before run #${opts.since}` : ""}\n`,
  );

  let lastLine = "";
  const summary = await backfill({
    repoSlug: opts.repo,
    db: resolve(opts.db),
    days: opts.days,
    sinceRunId: opts.since,
    artifactNameGlob: opts.artifactName,
    token,
    onProgress: (evt: BackfillProgress) => {
      const line = progressLine(evt);
      if (!line) return;
      // overwrite the previous progress line when stdout is a TTY
      if (isTty) process.stdout.write(`\r${" ".repeat(lastLine.length)}\r`);
      process.stdout.write(isTty ? line : `${line}\n`);
      lastLine = line;
    },
  });
  if (isTty && lastLine) process.stdout.write("\n");

  process.stdout.write(
    `\n${bold("done")} — scanned ${summary.runsScanned} run(s), ` +
      `${summary.runsMatched} had matching artifacts, ` +
      `${summary.runsRecorded} recorded (${summary.resultsRecorded} results), ` +
      `${summary.runsAlreadyRecorded} already recorded, ` +
      `${summary.artifactsDownloaded} artifact(s) downloaded, ` +
      `${summary.parseFailures} unparseable report(s)\n` +
      dim(
        `stopped: ${summary.stoppedReason}` +
          (summary.lastRunId
            ? ` · resume with --since ${summary.lastRunId} to continue further back\n`
            : "\n"),
      ),
  );
  return 0;
}

function progressLine(evt: BackfillProgress): string | null {
  switch (evt.type) {
    case "page":
      return dim(`  page ${evt.page} (${evt.totalRuns} total run(s))`);
    case "recorded":
      return `  run #${evt.run.id} (${shortSha(evt.run.headSha)}) → ${
        evt.inserted ? `recorded, ${evt.results} result(s)` : "already recorded"
      }`;
    case "skipped":
      return dim(`  run #${evt.run.id} (${shortSha(evt.run.headSha)}) → skipped: ${evt.reason}`);
    case "error":
      return dim(`  run #${evt.run.id} → ! ${evt.message}`);
    case "run":
      return null; // superseded by "recorded"/"skipped"
    default:
      return null;
  }
}

// ── wiring ───────────────────────────────────────────────────────────────────

/**
 * Run a command body, translating a typed {@link FlakeTriageError} into
 * `exitCode 2` + a one-line stderr message. Anything else re-throws.
 */
async function guard(fn: () => number | Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (e) {
    if (e instanceof FlakeTriageError) {
      process.stderr.write(`flaketriage: ${e.message} [${e.code}]\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("flaketriage")
    .description("Classify CI test failures as flake vs real regression")
    .showHelpAfterError();

  program
    .command("run")
    .description("triage the JUnit reports for a commit and record the run")
    .option(
      "--reports <glob>",
      "report glob (repeatable / comma-separated)",
      splitList,
      [],
    )
    .option("--repo <path>", "path to the git repo", process.cwd())
    .option("--db <path>", "history database path", DEFAULT_DB)
    .option("--commit <sha>", "commit SHA (default: HEAD)")
    .option("--parent <sha>", "parent SHA (default: <commit>^)")
    .option("--attempt <n>", "CI attempt / retry number", parseIntArg, 1)
    .option("--window <n>", "recent runs considered for flake detection", parseIntArg, 30)
    .addOption(
      new Option("--format <fmt>", "output format")
        .choices(["text", "md", "summary", "json"])
        .default("text"),
    )
    .option("--no-llm", "never call the LLM — ambiguous verdicts stay ambiguous")
    .addOption(
      new Option("--provider <name>", "LLM provider for ambiguous cases (default: auto)").choices([
        "auto",
        "anthropic",
        "bedrock",
        "vertex",
        "foundry",
        "custom",
        "gemini",
        "openai",
        "local",
        "openai-compatible",
        "none",
      ]),
    )
    .option("--llm-model <id>", "override the provider's default model")
    .option("--llm-base-url <url>", "base URL for a local / custom OpenAI-compatible server")
    .option(
      "--print-payload",
      "print the exact (redacted) request that would be sent, call nothing, exit",
    )
    .addOption(
      new Option("--fail-on <level>", "which verdicts turn the build red")
        .choices(["regression", "any", "never"])
        .default("regression"),
    )
    .action((opts: RunOptions) => guard(() => cmdRun(opts)));

  program
    .command("explain")
    .argument("<test>", "test name, suite::name substring, or test_key prefix")
    .description("show the full, human-verifiable evidence for one test's verdict")
    .option("--repo <path>", "path to the git repo (for a live diff)", process.cwd())
    .option("--db <path>", "history database path", DEFAULT_DB)
    .addOption(
      new Option("--format <fmt>", "output format").choices(["text", "json"]).default("text"),
    )
    .option("--window <n>", "recent-run window", parseIntArg, 30)
    .action((test: string, opts: ExplainOptions) => guard(() => cmdExplain(test, opts)));

  program
    .command("history")
    .argument("<test>", "test name, suite::name substring, or test_key prefix")
    .description("print the pass/fail timeline for one test")
    .option("--db <path>", "history database path", DEFAULT_DB)
    .addOption(
      new Option("--format <fmt>", "output format").choices(["text", "json"]).default("text"),
    )
    .option("--limit <n>", "max runs to show", parseIntArg, 40)
    .action((test: string, opts: HistoryOptions) => guard(() => cmdHistory(test, opts)));

  program
    .command("stats")
    .description("top flakiest tests by flip rate")
    .option("--db <path>", "history database path", DEFAULT_DB)
    .addOption(
      new Option("--format <fmt>", "output format").choices(["text", "json"]).default("text"),
    )
    .option("--limit <n>", "how many to show", parseIntArg, 10)
    .option("--min-runs <n>", "ignore tests with fewer runs", parseIntArg, 3)
    .option("--window <n>", "consider only the last N runs", parseIntArg, 200)
    .option("--llm-model <id>", "model to price the cost estimate against", "claude-opus-5")
    .action((opts: StatsOptions) => guard(() => cmdStats(opts)));

  program
    .command("backfill")
    .description("populate history from a repo's past GitHub Actions runs")
    .requiredOption("--repo <owner/name>", "GitHub repo slug (not a local path)")
    .option("--db <path>", "history database path", DEFAULT_DB)
    .option("--days <n>", "how far back to walk", parseIntArg, 90)
    .option("--since <run-id>", "resume: continue before this run id", parseIntArg)
    .option(
      "--artifact-name <glob>",
      "only download artifacts whose name matches (e.g. '*junit*')",
      "*",
    )
    .option("--token <token>", "GitHub token (default: $GITHUB_TOKEN / $GH_TOKEN)")
    .action((opts: BackfillOptions) => guard(() => cmdBackfill(opts)));

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof FlakeTriageError) {
      process.stderr.write(`flaketriage: ${e.message} [${e.code}]\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
}

// run when invoked as a binary, not when imported by tests
const invokedDirectly =
  argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly || env["FLAKETRIAGE_CLI"] === "1") {
  void main();
}
