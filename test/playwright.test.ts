import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PlaywrightReportParseError } from "../src/core/errors.js";
import { History } from "../src/core/history.js";
import type { GitContext } from "../src/ingest/git.js";
import { parseJUnitFile } from "../src/ingest/junit.js";
import type { TestResult } from "../src/ingest/junit.js";
import { parsePlaywrightFile, parsePlaywrightJson } from "../src/ingest/playwright.js";
import { triageRun } from "../src/pipeline.js";
import { runFlakeTriage } from "../src/run.js";
import { TmpRepo } from "./helpers/tmprepo.js";

/**
 * Fixtures are real Playwright 1.63 output: each JSON report and JUnit report
 * pair comes from ONE run (retries: 1), with local paths replaced by C:\ft-fixture.
 * The suite has a stable test, two flaky tests (fail on attempt 1 only), an
 * always-failing test, a skipped test, nested describes and a nested file.
 */
const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const json = parsePlaywrightFile(join(FIX, "playwright-retries.json"));
const junit = parseJUnitFile(join(FIX, "playwright-retries.junit.xml"));

function one(results: TestResult[], name: string): TestResult {
  const hit = results.find((r) => r.name === name);
  if (!hit) throw new Error(`no result named ${name}`);
  return hit;
}

const pairs = (rs: TestResult[]) => rs.map((r) => `${r.testKey} ${r.status}`).sort();

describe("parsePlaywrightJson", () => {
  it("maps expected, flaky, unexpected and skipped tests", () => {
    expect(json).toHaveLength(6);
    expect(one(json, "cart › adds an item")).toMatchObject({ status: "passed", retries: [], failure: null });
    expect(one(json, "empty cart shows a hint").status).toBe("passed");
    expect(one(json, "gift wrapping")).toMatchObject({ status: "skipped", skipReason: "skipped" });

    const flaky = one(json, "cart › applies discount code");
    expect(flaky.status).toBe("passed");
    expect(flaky.retries).toHaveLength(1);
    expect(flaky.retries[0]!.message).toBe("simulated flake on the first attempt");

    const nested = one(json, "suggestions appear");
    expect(nested).toMatchObject({ suite: "nested/search.spec.ts", status: "passed" });
    expect(nested.retries).toHaveLength(1);

    const failing = one(json, "cart › checkout › rejects an expired card");
    expect(failing.status).toBe("failed");
    expect(failing.retries).toEqual([]);
    expect(failing.failure?.stack).toContain('Received: "declined"');
  });

  it("produces the same test keys and statuses as Playwright's JUnit report from the same run", () => {
    expect(pairs(json)).toEqual(pairs(junit));
  });

  it("matches the JUnit failure message and summed durations", () => {
    const name = "cart › checkout › rejects an expired card";
    expect(one(json, name).failure?.message).toBe(one(junit, name).failure?.message);
    for (const r of junit.filter((x) => x.status !== "skipped")) {
      expect(one(json, r.name).durationMs, r.name).toBe(r.durationMs);
    }
  });

  it("is the format where flakes are visible: JUnit shows the same tests as clean passes", () => {
    expect(one(junit, "cart › applies discount code")).toMatchObject({ status: "passed", retries: [] });
    expect(json.filter((r) => r.retries.length > 0).map((r) => r.name).sort()).toEqual([
      "cart › applies discount code",
      "suggestions appear",
    ]);
  });

  it("several projects: one result per project with the same key, exactly like JUnit", () => {
    const projectsJson = parsePlaywrightFile(join(FIX, "playwright-projects.json"));
    const projectsJunit = parseJUnitFile(join(FIX, "playwright-projects.junit.xml"));
    expect(projectsJson).toHaveLength(12);
    expect(pairs(projectsJson)).toEqual(pairs(projectsJunit));
  });

  it("strips ANSI colour codes from failure text", () => {
    const texts = json.flatMap((r) => [r.failure, ...r.retries]).flatMap((f) => [f?.message, f?.stack]);
    expect(texts.some((t) => t && /\u001b\[/.test(t))).toBe(false);
  });

  it("a timed-out last attempt is an error", () => {
    const doc = {
      config: {},
      suites: [
        {
          title: "slow.spec.ts",
          file: "slow.spec.ts",
          specs: [
            {
              title: "loads the dashboard",
              file: "slow.spec.ts",
              tests: [
                {
                  status: "unexpected",
                  results: [
                    { status: "timedOut", duration: 30000, error: { message: "Test timeout of 30000ms exceeded." } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [r] = parsePlaywrightJson(JSON.stringify(doc));
    expect(r).toMatchObject({ status: "error", durationMs: 30000 });
    expect(r!.failure?.message).toBe("Test timeout of 30000ms exceeded.");
  });

  it("a test.fail() test that failed as expected is a clean pass, not a flake", () => {
    const doc = {
      config: {},
      suites: [
        {
          title: "known.spec.ts",
          file: "known.spec.ts",
          specs: [
            {
              title: "known bug",
              file: "known.spec.ts",
              tests: [
                {
                  expectedStatus: "failed",
                  status: "expected",
                  annotations: [{ type: "fail" }],
                  results: [{ status: "failed", duration: 5, error: { message: "Error: boom" } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const [r] = parsePlaywrightJson(JSON.stringify(doc));
    expect(r).toMatchObject({ status: "passed", retries: [], failure: null });
  });

  it("rejects malformed JSON and JSON that is not a Playwright report", () => {
    expect(() => parsePlaywrightJson("{ nope", "x.json")).toThrow(PlaywrightReportParseError);
    expect(() => parsePlaywrightJson("{ nope")).toThrow(/malformed JSON/);
    expect(() => parsePlaywrightJson(JSON.stringify({ stats: {} }))).toThrow(/not a Playwright JSON report/);
  });
});

describe("Playwright flakes end to end", () => {
  const git: GitContext = {
    repoRoot: "/repo",
    repoSlug: "acme/app",
    commitSha: "c8commit000",
    parentSha: null,
    branch: "main",
    changedFiles: [],
    diffHunks: [],
  };

  it("triageRun: flaky Playwright tests become flakes, the always-failing one is triaged", () => {
    const h = History.open(":memory:");
    try {
      const run = triageRun(json, git, 1, h);
      expect(run.triaged.map((t) => t.result.name)).toEqual(["cart › checkout › rejects an expired card"]);
      expect(run.flakes.map((t) => t.result.name).sort()).toEqual(["cart › applies discount code", "suggestions appear"]);
      expect(run.flakes[0]!.verdict.evidence[0]).toMatch(
        /^failed once, then passed on retry in this run \(attempt 1\) — first failure: simulated flake on the first attempt$/,
      );
    } finally {
      h.close();
    }
  });

  const repos: TmpRepo[] = [];
  afterEach(() => {
    while (repos.length) rmSync(repos.pop()!.dir, { recursive: true, force: true });
  });

  it("runFlakeTriage reads a Playwright JSON report from --reports", async () => {
    const r = TmpRepo.create();
    r.setRemote("https://github.com/acme/app.git");
    repos.push(r);
    r.commit("c1", {
      "test-results/playwright-report.json": JSON.stringify(
        JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(FIX, "playwright-retries.json"), "utf8"))),
      ),
    });

    const res = await runFlakeTriage({
      repoPath: r.dir,
      reportGlobs: ["**/playwright-report.json"],
      db: join(r.dir, ".flaketriage/history.db"),
      providerEnv: {},
    });
    expect(res.json.totals).toMatchObject({ total: 6, passed: 4, failed: 1, skipped: 1, flaky: 2 });
    expect(res.markdown).toMatch(/Passed after retry — 2 flakes/);
  });
});
