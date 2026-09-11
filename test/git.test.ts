import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitContextError } from "../src/core/errors.js";
import { readGitContext } from "../src/ingest/git.js";
import { TmpRepo } from "./helpers/tmprepo.js";

const repos: TmpRepo[] = [];
function newRepo(): TmpRepo {
  const r = TmpRepo.create();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) rmSync(repos.pop()!.dir, { recursive: true, force: true });
});

/**
 * `readGitContext`'s detached-HEAD branch fallback reads real CI hints
 * (`GITHUB_HEAD_REF`, `GITHUB_REF_NAME`, `GIT_BRANCH`) straight from
 * `process.env`. This suite itself runs inside GitHub Actions, so those are
 * genuinely set on the *outer* job — strip them so the throwaway repos here
 * behave like a real local, non-CI checkout.
 */
const CI_ENV_KEYS = ["GITHUB_HEAD_REF", "GITHUB_REF_NAME", "GIT_BRANCH"] as const;
let savedCiEnv: Partial<Record<(typeof CI_ENV_KEYS)[number], string>>;

beforeEach(() => {
  savedCiEnv = {};
  for (const k of CI_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) savedCiEnv[k] = v;
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of CI_ENV_KEYS) {
    const v = savedCiEnv[k];
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
});

describe("readGitContext", () => {
  it("resolves commit, parent, branch and changed files across two commits", async () => {
    const repo = newRepo();
    const c1 = repo.commit("init", { "src/a.ts": "1", "README.md": "r" });
    const c2 = repo.commit("change a", { "src/a.ts": "2", "src/b.ts": "new" });

    const ctx = await readGitContext(repo.dir);
    expect(ctx.commitSha).toBe(c2);
    expect(ctx.parentSha).toBe(c1);
    expect(ctx.branch).toBe("main");
    expect(ctx.changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("derives repoSlug from the origin remote, falls back to the dir name", async () => {
    const withRemote = newRepo();
    withRemote.commit("init");
    withRemote.setRemote("git@github.com:acme/widgets.git");
    expect((await readGitContext(withRemote.dir)).repoSlug).toBe("acme/widgets");

    const noRemote = newRepo();
    noRemote.commit("init");
    expect((await readGitContext(noRemote.dir)).repoSlug).toBe(
      noRemote.dir.split(/[\\/]/).pop(),
    );
  });

  it("returns parentSha null and all files for a root commit", async () => {
    const repo = newRepo();
    repo.commit("root", { "src/a.ts": "1", "src/b.ts": "2" });
    const ctx = await readGitContext(repo.dir);
    expect(ctx.parentSha).toBeNull();
    expect(ctx.changedFiles.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("honours --commit / --parent overrides", async () => {
    const repo = newRepo();
    const c1 = repo.commit("c1", { "x.ts": "1" });
    const c2 = repo.commit("c2", { "x.ts": "2" });
    const c3 = repo.commit("c3", { "y.ts": "3" });
    const ctx = await readGitContext(repo.dir, { commit: c2, parent: c1 });
    expect(ctx.commitSha).toBe(c2);
    expect(ctx.parentSha).toBe(c1);
    expect(ctx.changedFiles).toEqual(["x.ts"]);
    expect(c3).toBeTruthy();
  });

  it("reports a detached HEAD as no branch (absent CI env)", async () => {
    const repo = newRepo();
    const c1 = repo.commit("c1");
    repo.commit("c2");
    repo.git("checkout", "-q", c1);
    const ctx = await readGitContext(repo.dir);
    expect(ctx.branch).toBeNull();
  });

  it("throws GitContextError outside a repository", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "ft-norepo-"));
    try {
      await expect(readGitContext(notARepo)).rejects.toBeInstanceOf(GitContextError);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
