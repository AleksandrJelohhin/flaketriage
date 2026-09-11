/**
 * git.ts — resolve the git metadata a run is recorded against.
 *
 * commit SHA, parent SHA, branch, the files changed between them, and the diff
 * hunks (file + changed line numbers) the blame correlator needs.
 */

import { basename } from "node:path";

import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";

import type { DiffHunk } from "../core/blame.js";
import { GitContextError } from "../core/errors.js";

export type { DiffHunk } from "../core/blame.js";

export interface GitContext {
  /** Absolute path to the working-tree root. */
  repoRoot: string;
  /** `owner/name` parsed from the origin remote, else the repo directory name. */
  repoSlug: string;
  commitSha: string;
  /** `null` for a root commit or when explicitly unset. */
  parentSha: string | null;
  /** `null` in detached HEAD with no CI branch hint. */
  branch: string | null;
  /** Repo-relative POSIX paths changed between `parentSha` and `commitSha`. */
  changedFiles: string[];
  /** Per-hunk changed-line detail for blame correlation. */
  diffHunks: DiffHunk[];
}

export interface GitOverrides {
  /** Explicit commit SHA (CLI `--commit`); defaults to HEAD. */
  commit?: string | undefined;
  /** Explicit parent SHA (CLI `--parent`); defaults to `<commit>^`. */
  parent?: string | undefined;
}

function parseSlug(remoteUrl: string | undefined): string | null {
  if (!remoteUrl) return null;
  // git@host:owner/repo.git | https://host/owner/repo(.git) | ssh://git@host/owner/repo
  const m = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1]! : null;
}

async function tryRevparse(
  git: SimpleGit,
  ...args: string[]
): Promise<string | null> {
  try {
    const out = (await git.revparse(args)).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function readGitContext(
  repoPath: string,
  overrides: GitOverrides = {},
): Promise<GitContext> {
  const git = simpleGit(repoPath);

  let isRepo = false;
  try {
    isRepo = await git.checkIsRepo();
  } catch (cause) {
    throw new GitContextError(`not a git repository: ${repoPath}`, { cause });
  }
  if (!isRepo) throw new GitContextError(`not a git repository: ${repoPath}`);

  const repoRoot = (await git.revparse(["--show-toplevel"])).trim();

  const commitSha =
    (overrides.commit ? await tryRevparse(git, overrides.commit) : null) ??
    (await tryRevparse(git, "HEAD"));
  if (!commitSha) {
    throw new GitContextError(
      overrides.commit
        ? `cannot resolve --commit ${overrides.commit}`
        : "cannot resolve HEAD (empty repository?)",
    );
  }

  const parentSha = overrides.parent
    ? await tryRevparse(git, overrides.parent)
    : await tryRevparse(git, `${commitSha}^`);

  let branch: string | null = await tryRevparse(git, "--abbrev-ref", "HEAD");
  if (branch === "HEAD" || branch === null) {
    // detached HEAD (typical in CI) — fall back to CI-provided branch names
    branch =
      process.env["GITHUB_HEAD_REF"] ||
      process.env["GITHUB_REF_NAME"] ||
      process.env["GIT_BRANCH"] ||
      null;
  }

  let slug: string | null = null;
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
    diffHunks,
  };
}

const DIFF_HEADER = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff --unified=0` between parent and commit into per-hunk changed
 * lines. `--unified=0` means each hunk IS the changed span, so `changedLines`
 * is just the range of `+` lines in that hunk.
 */
export async function readDiffHunks(
  repoPath: string,
  commitSha: string,
  parentSha: string | null,
  paths: string[] = [],
): Promise<DiffHunk[]> {
  const git = simpleGit(repoPath);
  const range = parentSha ? [parentSha, commitSha] : [`${commitSha}^!`];
  let raw: string;
  try {
    raw = await git.raw([
      "diff",
      "--no-color",
      "--no-renames",
      "--unified=0",
      "--diff-filter=d", // ignore deletions — no new-file lines to blame
      ...range,
      ...(paths.length ? ["--", ...paths] : []),
    ]);
  } catch {
    return [];
  }

  const hunks: DiffHunk[] = [];
  let file: string | null = null;
  let cursor = 0;
  let current: DiffHunk | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const fh = line.match(DIFF_HEADER);
    if (fh) {
      file = fh[1]!;
      current = null;
      continue;
    }
    const hh = line.match(HUNK_HEADER);
    if (hh && file) {
      const newStart = Number(hh[1]);
      const newLines = hh[2] === undefined ? 1 : Number(hh[2]);
      current = { file, newStart, newLines, changedLines: [] };
      // an added-but-empty hunk (newLines 0) still records its position
      hunks.push(current);
      cursor = newStart;
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      (current.changedLines as number[]).push(cursor);
      cursor += 1;
    }
  }
  return hunks;
}

async function resolveChangedFiles(
  git: SimpleGit,
  commitSha: string,
  parentSha: string | null,
): Promise<string[]> {
  try {
    if (parentSha) {
      const out = await git.raw([
        "diff",
        "--name-only",
        "--no-renames",
        `${parentSha}`,
        `${commitSha}`,
      ]);
      return splitPaths(out);
    }
    const out = await git.raw([
      "show",
      "--name-only",
      "--no-renames",
      "--pretty=format:",
      commitSha,
    ]);
    return splitPaths(out);
  } catch {
    return [];
  }
}

function splitPaths(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Unified diff between parent and commit, optionally restricted to (and ordered
 * to prioritise) a set of paths — used to keep the LLM payload's diff focused on
 * files that appear in failing stack frames.
 */
export async function readCommitDiff(
  repoPath: string,
  commitSha: string,
  parentSha: string | null,
  prioritisePaths: string[] = [],
): Promise<string> {
  const git = simpleGit(repoPath);
  const range = parentSha ? [parentSha, commitSha] : [`${commitSha}^!`];

  const priority = [...new Set(prioritisePaths.map((p) => p.replace(/\\/g, "/")))];
  try {
    if (priority.length > 0) {
      const focused = await git
        .raw(["diff", "--no-color", "--unified=3", ...range, "--", ...priority])
        .catch(() => "");
      const rest = await git
        .raw(["diff", "--no-color", "--unified=3", ...range])
        .catch(() => "");
      return focused.trim().length > 0 ? `${focused}\n${rest}` : rest;
    }
    return await git.raw(["diff", "--no-color", "--unified=3", ...range]);
  } catch {
    return "";
  }
}
