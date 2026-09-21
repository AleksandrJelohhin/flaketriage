import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeResults } from "../src/core/analyze.js";
import { History } from "../src/core/history.js";
import type { RunMeta } from "../src/core/history.js";
import { testKey } from "../src/core/keys.js";
import type { GitContext } from "../src/ingest/git.js";
import { parseJUnitXml } from "../src/ingest/junit.js";
import { triageRun } from "../src/pipeline.js";
import { runFlakeTriage } from "../src/run.js";
import { TmpRepo, junitXml } from "./helpers/tmprepo.js";

/**
 * Flakes hiding in PASSING tests: a failed attempt recorded in the same report
 * (Surefire <flakyFailure>), or a failing CI attempt of the same commit.
 */

const SUREFIRE_FLAKY = `<testsuite name="acme.Suite" tests="2">
  <testcase classname="acme.Suite" name="flaky" time="0.2">
    <flakyFailure message="expected true" type="java.lang.AssertionError">java.lang.AssertionError: expected true
    at acme.Suite.flaky(Suite.java:12)</flakyFailure>
  </testcase>
  <testcase classname="acme.Suite" name="stable" time="0.1"/>
</testsuite>`;

const FAIL = `<testsuite name="acme.Suite"><testcase classname="acme.Suite" name="t"><failure message="boom">boom</failure></testcase></testsuite>`;
const PASS = `<testsuite name="acme.Suite"><testcase classname="acme.Suite" name="t"/></testsuite>`;
const T_KEY = testKey("acme.Suite", "t");
const SHA = "c8commit000";

const git = (over: Partial<GitContext> = {}): GitContext => ({
  repoRoot: "/repo",
  repoSlug: "acme/app",
  commitSha: SHA,
  parentSha: "c7parent",
  branch: "main",
  changedFiles: [],
  diffHunks: [],
  ...over,
});

let h: History;
beforeEach(() => (h = History.open(":memory:")));
afterEach(() => h.close());

/** Record a run the way the CLI does (analyze → recordRun). */
function record(over: Partial<RunMeta>, xml: string): void {
  const meta: RunMeta = {
    repo: "acme/app",
    commitSha: SHA,
    parentSha: null,
    branch: "main",
    ciRunId: null,
    attempt: 1,
    startedAt: 1_000,
    changedFiles: [],
    ...over,
  };
  h.recordRun(
    meta,
    analyzeResults(parseJUnitXml(xml)).map((r) => ({
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

describe("History.failedAttemptsOnCommit", () => {
  it("lists the other attempts of the same commit in which the test failed", () => {
    record({ attempt: 1 }, FAIL);
    record({ attempt: 2 }, PASS);
    record({ attempt: 3 }, FAIL);
    expect(h.failedAttemptsOnCommit(SHA, T_KEY, 2)).toEqual([1, 3]);
    expect(h.failedAttemptsOnCommit(SHA, T_KEY, 3)).toEqual([1]); // itself excluded
    expect(h.failedAttemptsOnCommit("other", T_KEY, 2)).toEqual([]);
  });
});

describe("triageRun — flakes on passing tests", () => {
  it("a passed test with in-run retries is a flake, not a failure", () => {
    const run = triageRun(parseJUnitXml(SUREFIRE_FLAKY), git(), 1, h);
    expect(run.triaged).toEqual([]);
    expect(run.passed).toBe(2);
    expect(run.flakes).toHaveLength(1);
    expect(run.flakes[0]!.result.name).toBe("flaky");
    expect(run.flakes[0]!.verdict).toMatchObject({ kind: "flake_confirmed", confidence: "high" });
    expect(run.flakes[0]!.verdict.evidence[0]).toMatch(
      /^failed once, then passed on retry in this run \(attempt 1\) — first failure: expected true$/,
    );
  });

  it("a green re-run of a failed attempt is a flake", () => {
    record({ attempt: 1 }, FAIL);
    const run = triageRun(parseJUnitXml(PASS), git(), 2, h);
    expect(run.flakes).toHaveLength(1);
    expect(run.flakes[0]!.verdict.evidence).toEqual([
      expect.stringMatching(/^failed in attempt 1 of the same commit c8commi and passed in attempt 2/),
    ]);
  });

  it("stable passes, and failures on a different commit, are not flakes", () => {
    record({ attempt: 1, commitSha: "older" }, FAIL);
    expect(triageRun(parseJUnitXml(PASS), git(), 1, h).flakes).toEqual([]);
  });

  it("reports a test once when several rows share its key, combining their retries", () => {
    const twoProjects = `<testsuites>
      <testsuite name="chromium"><testcase classname="acme.Suite" name="t"><flakyFailure message="a">a</flakyFailure></testcase></testsuite>
      <testsuite name="firefox"><testcase classname="acme.Suite" name="t"><flakyFailure message="b">b</flakyFailure></testcase></testsuite>
    </testsuites>`;
    const run = triageRun(parseJUnitXml(twoProjects), git(), 1, h);
    expect(run.flakes).toHaveLength(1);
    expect(run.flakes[0]!.result.retries).toHaveLength(2);
    expect(run.flakes[0]!.verdict.evidence[0]).toMatch(/^failed 2 times, then passed on retry/);
  });
});

describe("runFlakeTriage — flakes end to end", () => {
  const repos: TmpRepo[] = [];
  afterEach(() => {
    while (repos.length) rmSync(repos.pop()!.dir, { recursive: true, force: true });
  });
  function repo(): { r: TmpRepo; db: string } {
    const r = TmpRepo.create();
    r.setRemote("https://github.com/acme/app.git");
    repos.push(r);
    return { r, db: join(r.dir, ".flaketriage/history.db") };
  }

  it("in-run retry: reported in every format, exit code unchanged even with --fail-on any", async () => {
    const { r, db } = repo();
    r.commit("c1", { "reports/junit.xml": SUREFIRE_FLAKY });

    const res = await runFlakeTriage({ repoPath: r.dir, db, failOn: "any", providerEnv: {} });
    expect(res.json.totals).toMatchObject({ passed: 2, failed: 0, flaky: 1 });
    expect(res.json.flakes).toEqual([
      expect.objectContaining({ name: "flaky", kind: "flake_confirmed", retries: 1 }),
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.markdown).toMatch(/FlakeTriage — no failures, 1 flaky/);
    expect(res.text).toMatch(/Passed after retry/);
    expect(res.summary).toMatch(/Passed after retry \(1\)/);
  });

  it("CI re-run: attempt 2 of the same commit passes after attempt 1 failed", async () => {
    const { r, db } = repo();
    const sha = r.commit("c1", { "reports/junit.xml": junitXml("S", { t: "fail" }) });

    const first = await runFlakeTriage({ repoPath: r.dir, db, commit: sha, attempt: 1, providerEnv: {} });
    expect(first.json.totals).toMatchObject({ failed: 1, flaky: 0 });

    // same commit, new CI attempt: only the report changes
    r.write("reports/junit.xml", junitXml("S", { t: "pass" }));
    const second = await runFlakeTriage({ repoPath: r.dir, db, commit: sha, attempt: 2, providerEnv: {} });
    expect(second.json.totals).toMatchObject({ failed: 0, flaky: 1 });
    expect(second.json.flakes[0]!.evidence[0]).toMatch(/^failed in attempt 1 of the same commit/);
    expect(second.json.flakes[0]!.retries).toBe(0);
  });
});
