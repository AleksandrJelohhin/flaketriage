/**
 * index.ts — the GitHub Action wrapper.
 *
 * Thin: read inputs → run the same core (`runFlakeTriage`) → post/update the
 * sticky PR comment → set outputs → exit. The SQLite history is persisted
 * between runs by `actions/cache` steps in action.yml (see the README note about
 * this being a lossy mechanism).
 */

import { relative } from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import { loadConfig } from "../src/config.js";
import { FlakeTriageError } from "../src/core/errors.js";
import { compilePatterns } from "../src/llm/payload.js";
import { runFlakeTriage } from "../src/run.js";
import type { FailOn } from "../src/run.js";
import { upsertStickyComment } from "./comment.js";

function splitGlobs(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** getBooleanInput throws on an empty optional input; this tolerates it. */
function boolInput(name: string, fallback: boolean): boolean {
  const v = core.getInput(name).trim().toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

interface Refs {
  commit: string | undefined;
  parent: string | undefined;
  prNumber: number | undefined;
}

/** Resolve the commit/parent to triage and the PR number from the event payload. */
function resolveRefs(): Refs {
  const ctx = github.context;
  const pr = ctx.payload.pull_request as
    | { number: number; head?: { sha?: string }; base?: { sha?: string } }
    | undefined;
  if (pr) {
    return {
      commit: pr.head?.sha,
      parent: pr.base?.sha,
      prNumber: pr.number,
    };
  }
  // push (or other): before/after when present
  const before = typeof ctx.payload["before"] === "string" ? ctx.payload["before"] : undefined;
  const after = typeof ctx.payload["after"] === "string" ? ctx.payload["after"] : undefined;
  return {
    commit: after && !/^0+$/.test(after) ? after : undefined,
    parent: before && !/^0+$/.test(before) ? before : undefined,
    prNumber: undefined,
  };
}

async function main(): Promise<void> {
  const reports = splitGlobs(core.getInput("reports"));
  const workingDirectory = core.getInput("working-directory") || process.cwd();
  const db = core.getInput("db-path") || ".flaketriage/history.db";
  const failOn = (core.getInput("fail-on") || "regression") as FailOn;
  const attempt = Number(core.getInput("attempt") || process.env["GITHUB_RUN_ATTEMPT"] || "1");
  const cfg = loadConfig(workingDirectory).config;
  const redactPatterns = cfg.redact?.patterns ? compilePatterns(cfg.redact.patterns) : undefined;
  const provider = core.getInput("provider") || cfg.llm?.provider || "auto";
  const llmModel = core.getInput("llm-model") || cfg.llm?.model || undefined;
  const llmBaseUrl = core.getInput("llm-base-url") || cfg.llm?.base_url || undefined;
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
    ciRunId: process.env["GITHUB_RUN_ID"] ?? null,
  });

  const { run, markdown, summary, json } = result;

  // ── job summary (always) — the fuller drill-down report; the sticky PR
  // comment below stays compact, so the job summary is where "explain this
  // verdict" evidence, blame tables and raw failures actually live.
  await core.summary.addRaw(summary).write();

  for (const pf of result.parseFailures) {
    core.warning(
      `skipped unparseable report ${relative(workingDirectory, pf.file)}: ${pf.message}`,
    );
  }
  if (run.escalation?.error) {
    core.warning(`LLM escalation skipped: ${run.escalation.error}`);
  } else if (run.escalation && run.escalation.escalated > 0) {
    core.info(
      `→ ${run.escalation.escalated} failure(s), ${run.escalation.tokens.toLocaleString()} ` +
        `tokens sent to ${run.escalation.provider}/${run.escalation.model}`,
    );
  }

  // ── outputs ─────────────────────────────────────────────────────────────────
  core.setOutput("regressions", String(json.totals.regressions));
  core.setOutput("needs-attention", String(json.totals.needsYou));
  core.setOutput("failed", String(json.totals.failed));
  core.setOutput("flaky", String(json.totals.flaky));
  core.setOutput("cost-usd", json.cost.usd.toFixed(4));
  core.setOutput("report-markdown", markdown);
  core.setOutput("report-summary", summary);
  core.setOutput("report-json", JSON.stringify(json));

  // ── sticky PR comment ───────────────────────────────────────────────────────
  if (wantComment && refs.prNumber !== undefined) {
    if (!githubToken) {
      core.warning("comment: true but no github-token provided — skipping the PR comment");
    } else {
      const octokit = github.getOctokit(githubToken);
      const { owner, repo } = github.context.repo;
      try {
        const res = await upsertStickyComment(
          octokit.rest.issues,
          { owner, repo, issueNumber: refs.prNumber },
          markdown,
        );
        core.info(`FlakeTriage comment ${res.action}: ${res.url ?? res.commentId}`);
      } catch (e) {
        core.warning(`failed to post the PR comment: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else if (wantComment) {
    core.info("not a pull_request event — job summary written, no PR comment");
  }

  // ── exit status ─────────────────────────────────────────────────────────────
  if (result.exitCode === 1) {
    core.setFailed(
      json.totals.regressions > 0
        ? `${json.totals.regressions} real regression(s) — see the FlakeTriage report`
        : `${json.totals.failed} failing test(s) with --fail-on ${failOn}`,
    );
  }
}

main().catch((e: unknown) => {
  if (e instanceof FlakeTriageError) {
    core.setFailed(`flaketriage: ${e.message} [${e.code}]`);
  } else {
    core.setFailed(e instanceof Error ? e.stack ?? e.message : String(e));
  }
});
