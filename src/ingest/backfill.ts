/**
 * backfill.ts — populate history from GitHub Actions runs already in the cloud.
 *
 * What makes a first-day install useful, so it has to handle real volume: paginated, idempotent (the
 * `idx_runs_dedup` unique index makes a re-run a no-op), resumable, and it never
 * hammers the API (rate-limit handling lives in `github.ts`).
 */

import { analyzeResults } from "../core/analyze.js";
import { History } from "../core/history.js";
import { GithubClient } from "./github.js";
import type { GithubApi, WorkflowRun } from "./github.js";
import { parseJUnitXml } from "./junit.js";
import { unzip } from "./zip.js";

export interface BackfillOptions {
  /** "owner/name" */
  repoSlug: string;
  db: string;
  /** how far back to walk, in days. Default 90. */
  days?: number;
  /** resume: skip runs with id >= this (i.e. continue from an interrupted walk). */
  sinceRunId?: number | undefined;
  /** artifact name glob (no slashes — matches the artifact's own name). Default "*". */
  artifactNameGlob?: string;
  token?: string;
  client?: GithubApi; // injectable for tests
  onProgress?: (event: BackfillProgress) => void;
}

export type BackfillProgress =
  | { type: "page"; page: number; totalRuns: number }
  | { type: "run"; run: WorkflowRun; artifacts: number }
  | { type: "recorded"; run: WorkflowRun; results: number; inserted: boolean }
  | { type: "skipped"; run: WorkflowRun; reason: string }
  | { type: "error"; run: WorkflowRun; message: string };

export interface BackfillSummary {
  runsScanned: number;
  runsMatched: number;
  runsRecorded: number;
  runsAlreadyRecorded: number;
  resultsRecorded: number;
  artifactsDownloaded: number;
  parseFailures: number;
  /** oldest processed run id — pass as `--since` to resume further back. */
  lastRunId: number | null;
  stoppedReason: "window" | "since" | "exhausted";
}

const DEFAULT_DAYS = 90;
const DEFAULT_GLOB = "*";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export async function backfill(opts: BackfillOptions): Promise<BackfillSummary> {
  const days = opts.days ?? DEFAULT_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const nameRe = globToRegExp(opts.artifactNameGlob ?? DEFAULT_GLOB);
  const client = opts.client ?? new GithubClient({ repoSlug: opts.repoSlug, token: opts.token });
  const history = History.open(opts.db);

  const summary: BackfillSummary = {
    runsScanned: 0,
    runsMatched: 0,
    runsRecorded: 0,
    runsAlreadyRecorded: 0,
    resultsRecorded: 0,
    artifactsDownloaded: 0,
    parseFailures: 0,
    lastRunId: null,
    stoppedReason: "exhausted",
  };

  try {
    let page = 1;
    outer: for (;;) {
      const { runs, totalCount } = await client.listWorkflowRunsPage(page);
      opts.onProgress?.({ type: "page", page, totalRuns: totalCount });
      if (runs.length === 0) break;

      for (const run of runs) {
        if (run.createdAt < cutoff) {
          summary.stoppedReason = "window";
          break outer;
        }
        summary.runsScanned += 1;

        if (opts.sinceRunId !== undefined && run.id >= opts.sinceRunId) {
          opts.onProgress?.({ type: "skipped", run, reason: "already processed (--since)" });
          continue;
        }

        summary.lastRunId = summary.lastRunId === null ? run.id : Math.min(summary.lastRunId, run.id);

        if (history.runExists(opts.repoSlug, run.headSha, String(run.id), run.runAttempt)) {
          summary.runsAlreadyRecorded += 1;
          opts.onProgress?.({ type: "recorded", run, results: 0, inserted: false });
          continue;
        }

        let artifacts;
        try {
          artifacts = await client.listArtifacts(run.id);
        } catch (e) {
          opts.onProgress?.({ type: "error", run, message: errMsg(e) });
          continue;
        }
        const matching = artifacts.filter((a) => !a.expired && nameRe.test(a.name));
        opts.onProgress?.({ type: "run", run, artifacts: matching.length });
        if (matching.length === 0) {
          opts.onProgress?.({ type: "skipped", run, reason: "no matching artifact" });
          continue;
        }
        summary.runsMatched += 1;

        const results = [];
        for (const artifact of matching) {
          try {
            const zip = await client.downloadArtifactZip(artifact.id);
            summary.artifactsDownloaded += 1;
            for (const entry of unzip(zip)) {
              if (!entry.name.toLowerCase().endsWith(".xml")) continue;
              try {
                results.push(...parseJUnitXml(entry.data.toString("utf8"), entry.name));
              } catch {
                summary.parseFailures += 1;
              }
            }
          } catch (e) {
            opts.onProgress?.({ type: "error", run, message: errMsg(e) });
          }
        }
        if (results.length === 0) {
          opts.onProgress?.({ type: "skipped", run, reason: "no parseable JUnit XML in artifacts" });
          continue;
        }

        const parentSha = await client.getCommitParent(run.headSha).catch(() => null);
        const analyzed = analyzeResults(results);
        const { inserted } = history.recordRun(
          {
            repo: opts.repoSlug,
            commitSha: run.headSha,
            parentSha,
            branch: run.headBranch,
            ciRunId: String(run.id),
            attempt: run.runAttempt,
            startedAt: run.createdAt,
            changedFiles: [],
          },
          analyzed.map((r) => ({
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
        if (inserted) {
          summary.runsRecorded += 1;
          summary.resultsRecorded += analyzed.length;
        } else {
          summary.runsAlreadyRecorded += 1;
        }
        opts.onProgress?.({ type: "recorded", run, results: analyzed.length, inserted });
      }

      if (runs.length < 50 || summary.runsScanned >= totalCount) break;
      page += 1;
    }
    if (opts.sinceRunId !== undefined && summary.stoppedReason === "exhausted") {
      summary.stoppedReason = "since";
    }
  } finally {
    history.close();
  }

  return summary;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
