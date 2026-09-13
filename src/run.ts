/**
 * run.ts — the `flaketriage run` pipeline as one reusable function.
 *
 * Both the CLI (`cmdRun`) and the GitHub Action call this. It performs exactly
 * one recorded run: discover → parse → git → classify (against pre-run history)
 * → record → escalate ambiguous verdicts → render.
 *
 * `printPayload: true` is a different, side-effect-free mode (Data Boundary,
 * spec): it classifies (read-only — no `recordRun`) and builds the exact,
 * redacted payload that would be sent, but never calls `provider.triage()` /
 * `countTokens()` — a checkable function, not a promise that nothing leaked.
 */

import { resolve } from "node:path";

import { analyzeResults } from "./core/analyze.js";
import { FlakeTriageError } from "./core/errors.js";
import { History } from "./core/history.js";
import { discoverReports, DEFAULT_REPORT_GLOBS } from "./ingest/discover.js";
import { readCommitDiff, readGitContext } from "./ingest/git.js";
import { parseJUnitFile } from "./ingest/junit.js";
import type { TestResult } from "./ingest/junit.js";
import { parsePlaywrightFile } from "./ingest/playwright.js";
import { resolveProvider } from "./llm/providers/index.js";
import type { ResolveOptions } from "./llm/providers/index.js";
import { redact } from "./llm/payload.js";
import { buildUserPayload, DEFAULT_LIMITS, SYSTEM_PROMPT } from "./llm/prompt.js";
import { escalate } from "./llm/triage.js";
import { applyEscalation, referencedFiles, triageRun } from "./pipeline.js";
import type { TriagedRun } from "./pipeline.js";
import { renderJsonReport } from "./report/json.js";
import type { JsonReport } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderSummary } from "./report/summary.js";
import { renderText } from "./report/text.js";

export type FailOn = "regression" | "any" | "never";

export interface RunFlakeTriageOptions {
  repoPath: string;
  reportGlobs?: string[];
  db: string;
  commit?: string | undefined;
  parent?: string | undefined;
  attempt?: number;
  window?: number;
  failOn?: FailOn;
  /** false ⇒ `--no-llm`. */
  llm?: boolean;
  llmProvider?: string | undefined;
  llmModel?: string | undefined;
  llmBaseUrl?: string | undefined;
  awsRegion?: string | undefined;
  gcpProjectId?: string | undefined;
  gcpRegion?: string | undefined;
  foundryResource?: string | undefined;
  /** extra secret patterns from `.flaketriage.yml`'s `redact.patterns`. */
  redactPatterns?: RegExp[] | undefined;
  /** `--print-payload`: preview the redacted outbound request, call nothing. */
  printPayload?: boolean | undefined;
  /** overrides for provider resolution (mainly for tests). */
  providerEnv?: NodeJS.ProcessEnv;
  ciRunId?: string | null;
  now?: () => number;
}

/** What `--print-payload` shows — the exact bytes that would leave the machine. */
export interface PayloadPreview {
  provider: string | null;
  model: string | null;
  ambiguousCount: number;
  system: string | null;
  user: string | null;
}

export interface RunFlakeTriageResult {
  run: TriagedRun;
  markdown: string;
  /** the fuller, drill-down report meant for a GitHub Actions job summary. */
  summary: string;
  text: string;
  json: JsonReport;
  exitCode: number;
  reportFileCount: number;
  parseFailures: { file: string; message: string }[];
  /** set only when `printPayload` was requested. */
  payloadPreview?: PayloadPreview;
}

export async function runFlakeTriage(
  opts: RunFlakeTriageOptions,
): Promise<RunFlakeTriageResult> {
  const repoPath = resolve(opts.repoPath);
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
      `no JUnit reports matched [${globs.join(", ")}] under ${repoPath}`,
    );
  }

  const results: TestResult[] = [];
  const parseFailures: { file: string; message: string }[] = [];
  for (const file of reportFiles) {
    try {
      // Playwright's JSON report keeps retry attempts that its JUnit output hides.
      const parsed = file.toLowerCase().endsWith(".json") ? parsePlaywrightFile(file) : parseJUnitFile(file);
      results.push(...parsed);
    } catch (e) {
      parseFailures.push({ file, message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (results.length === 0) {
    throw new FlakeTriageError(
      "JUNIT_PARSE",
      `all ${reportFiles.length} report(s) failed to parse`,
    );
  }

  const git = await readGitContext(repoPath, {
    commit: opts.commit,
    parent: opts.parent,
  });

  const history = History.open(resolve(opts.db));
  let run: TriagedRun;
  try {
    run = triageRun(results, git, attempt, history, { window });
    // --print-payload is a read-only preview: never persist a run for it.
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
          changedFiles: git.changedFiles,
        },
        analyzeResults(results, { repoRoot: git.repoRoot }).map((r) => ({
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
  } catch (e) {
    history.close();
    throw e;
  }
  history.close();

  const resolveOpts: ResolveOptions = {
    provider: opts.llmProvider,
    model: opts.llmModel,
    baseUrl: opts.llmBaseUrl,
    awsRegion: opts.awsRegion,
    gcpProjectId: opts.gcpProjectId,
    gcpRegion: opts.gcpRegion,
    foundryResource: opts.foundryResource,
    disabled: opts.llm === false,
    ...(opts.providerEnv ? { env: opts.providerEnv } : {}),
  };

  if (printPayload) {
    // Construction only — no network call, so this stays zero-socket.
    const provider = resolveProvider(resolveOpts);
    const ambiguous = run.triaged.filter((t) => t.verdict.kind === "ambiguous");

    let payloadPreview: PayloadPreview;
    if (ambiguous.length === 0) {
      payloadPreview = {
        provider: provider?.name ?? null,
        model: provider?.model ?? null,
        ambiguousCount: 0,
        system: null,
        user: null,
      };
    } else {
      const framePaths = ambiguous.flatMap((t) =>
        referencedFiles(t.result.failure?.stack, t.result.failure?.message),
      );
      const diff = await readCommitDiff(
        git.repoRoot,
        git.commitSha,
        git.parentSha,
        framePaths,
      ).catch(() => "");
      const payload = buildUserPayload({ git, attempt, ambiguous, diff }, DEFAULT_LIMITS);
      payloadPreview = {
        provider: provider?.name ?? null,
        model: provider?.model ?? null,
        ambiguousCount: ambiguous.length,
        system: redact(SYSTEM_PROMPT, opts.redactPatterns),
        user: redact(payload, opts.redactPatterns),
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
      payloadPreview,
    };
  }

  // ── LLM escalation for ambiguous verdicts ────────────────────────────────────
  const provider = resolveProvider(resolveOpts);

  if (provider && provider.enabled && run.ambiguousCount > 0) {
    const ambiguous = run.triaged.filter((t) => t.verdict.kind === "ambiguous");
    const framePaths = ambiguous.flatMap((t) =>
      referencedFiles(t.result.failure?.stack, t.result.failure?.message),
    );
    const diff = await readCommitDiff(
      git.repoRoot,
      git.commitSha,
      git.parentSha,
      framePaths,
    ).catch(() => "");
    run = applyEscalation(
      run,
      await escalate(ambiguous, git, attempt, provider, {
        diff,
        redactPatterns: opts.redactPatterns,
      }),
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
        error: `${provider.name}: no API key configured`,
      },
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
    parseFailures,
  };
}

export function exitCodeFor(run: TriagedRun, failOn: FailOn): number {
  if (failOn === "never") return 0;
  if (failOn === "any") return run.triaged.length > 0 ? 1 : 0;
  return run.triaged.some((t) => t.verdict.kind === "real_regression") ? 1 : 0;
}
