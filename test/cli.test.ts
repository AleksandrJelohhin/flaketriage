import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram } from "../src/cli.js";
import { TmpRepo, junitXml } from "./helpers/tmprepo.js";

/**
 * These tests spin up throwaway repos meant to behave like a local, non-CI
 * checkout. But `cli.ts`/`git.ts` read real CI hints straight from
 * `process.env` (`GITHUB_RUN_ID` for dedup, `GITHUB_REF_NAME` etc. for the
 * detached-HEAD branch fallback) — and this suite itself runs inside GitHub
 * Actions, so those vars are genuinely set on the *outer* job and would
 * otherwise leak into every scenario's `--commit`/`--repo`. Strip them for
 * the duration of this file so behavior matches a real local run.
 */
const CI_ENV_KEYS = ["GITHUB_RUN_ID", "GITHUB_REF_NAME", "GITHUB_HEAD_REF", "GIT_BRANCH"] as const;
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

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function cli(args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    stdout += String(c);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    stderr += String(c);
    return true;
  });
  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    await buildProgram().parseAsync(args, { from: "user" });
    return { stdout, stderr, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = prevExit;
    out.mockRestore();
    err.mockRestore();
  }
}

const repos: TmpRepo[] = [];
function scenario(): { repo: TmpRepo; db: string } {
  const repo = TmpRepo.create();
  repo.setRemote("https://github.com/acme/widgets.git");
  repos.push(repo);
  return { repo, db: join(repo.dir, ".flaketriage", "history.db") };
}
afterEach(() => {
  while (repos.length) rmSync(repos.pop()!.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("flaketriage run", () => {
  it("triages reports + git context and records the run", async () => {
    const { repo, db } = scenario();
    repo.commit("c1", {
      "reports/junit.xml": junitXml("WidgetTest", { adds: "pass", total: "fail" }),
    });

    const r = await cli(["run", "--repo", repo.dir, "--db", db]);
    expect(r.stdout).toMatch(/FlakeTriage — 1 passed, 1 failed\/error, 0 skipped/);
    expect(r.stdout).toMatch(/commit [0-9a-f]{7} \(main\)/);
  });

  it("exits 2 with a typed code when no reports match", async () => {
    const { repo, db } = scenario();
    repo.commit("c1", { "src/a.ts": "1" });
    const r = await cli(["run", "--repo", repo.dir, "--db", db]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no JUnit reports matched.*\[NO_REPORTS\]/s);
  });

  it("emits the JSON triage report with --format json", async () => {
    const { repo, db } = scenario();
    repo.commit("c1", {
      "reports/junit.xml": junitXml("WidgetTest", { a: "pass", b: "fail" }),
    });
    const r = await cli(["run", "--repo", repo.dir, "--db", db, "--format", "json"]);
    const doc = JSON.parse(r.stdout) as {
      schema: string;
      totals: Record<string, number>;
      verdicts: { name: string; kind: string }[];
    };
    expect(doc.schema).toBe("flaketriage/triage@2");
    expect(doc.totals).toMatchObject({ passed: 1, failed: 1 });
    expect(doc.verdicts[0]!.name).toBe("b");
  });

  it("emits the sticky markdown comment with --format md", async () => {
    const { repo, db } = scenario();
    repo.commit("c1", {
      "reports/junit.xml": junitXml("WidgetTest", { a: "pass", b: "fail" }),
    });
    const r = await cli(["run", "--repo", repo.dir, "--db", db, "--format", "md"]);
    expect(r.stdout.startsWith("<!-- flaketriage -->")).toBe(true);
    expect(r.stdout).toMatch(/### (?:🔴|🟠|🟢) FlakeTriage/u);
  });

  describe("exit codes (--fail-on)", () => {
    async function firstFailingRegression(): Promise<{
      repo: TmpRepo;
      db: string;
    }> {
      const { repo, db } = scenario();
      const src = Array.from({ length: 8 }, (_v, i) => `line ${i}`).join("\n");
      // green baseline …
      repo.commit("c1", {
        "src/calc.ts": src,
        "reports/junit.xml": junitXml("CalcTest", { totals: "pass" }),
      });
      await cli(["run", "--repo", repo.dir, "--db", db]);
      // … then a change on line 4 of src/calc.ts, where the failing frame lands
      repo.commit("c2", {
        "src/calc.ts": src.replace("line 4", "line 4 // regression"),
        "reports/junit.xml": junitXml(
          "CalcTest",
          { totals: "fail" },
          { file: "src/calc.ts", line: 5 },
        ),
      });
      return { repo, db };
    }

    it("default (regression): exit 1 on a real regression", async () => {
      const { repo, db } = await firstFailingRegression();
      const r = await cli(["run", "--repo", repo.dir, "--db", db]);
      expect(r.stdout).toMatch(/likely broken by this PR|Needs you/);
      expect(r.exitCode).toBe(1);
    });

    it("--fail-on never: always exit 0", async () => {
      const { repo, db } = await firstFailingRegression();
      const r = await cli(["run", "--repo", repo.dir, "--db", db, "--fail-on", "never"]);
      expect(r.exitCode).toBe(0);
    });

    it("--fail-on any: exit 1 on any failure, even a confirmed flake", async () => {
      const { repo, db } = scenario();
      repo.commit("c1", { "reports/junit.xml": junitXml("S", { t: "pass" }) });
      const head = repo.git("rev-parse", "HEAD");
      await cli(["run", "--repo", repo.dir, "--db", db, "--commit", head, "--attempt", "1"]);

      repo.write("reports/junit.xml", junitXml("S", { t: "fail" }));
      const flake = await cli([
        "run", "--repo", repo.dir, "--db", db, "--commit", head, "--attempt", "2",
      ]);
      expect(flake.stdout).toMatch(/confirmed flake/);
      expect(flake.exitCode).toBe(0); // default: a flake does not fail the build

      const any = await cli([
        "run", "--repo", repo.dir, "--db", db, "--commit", head, "--attempt", "3",
        "--fail-on", "any",
      ]);
      expect(any.exitCode).toBe(1);
    });

    it("all-green run exits 0", async () => {
      const { repo, db } = scenario();
      repo.commit("c1", { "reports/junit.xml": junitXml("S", { a: "pass", b: "pass" }) });
      const r = await cli(["run", "--repo", repo.dir, "--db", db]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/🟢/);
    });
  });

  describe("LLM escalation", () => {
    /** A commit whose lone failure has no parent record → deterministic verdict is ambiguous. */
    async function ambiguousScenario(): Promise<{ repo: TmpRepo; db: string }> {
      const { repo, db } = scenario();
      repo.commit("c1", {
        "reports/junit.xml": junitXml("Suite", { t: "fail" }),
      });
      return { repo, db };
    }

    it("--no-llm makes no network call and leaves the verdict ambiguous", async () => {
      const { repo, db } = await ambiguousScenario();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const r = await cli(["run", "--repo", repo.dir, "--db", db, "--no-llm", "--fail-on", "never"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.stdout).toMatch(/unclear — not enough signal/);
    });

    it("--provider none also skips escalation", async () => {
      const { repo, db } = await ambiguousScenario();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await cli(["run", "--repo", repo.dir, "--db", db, "--provider", "none", "--fail-on", "never"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("--provider local escalates the ambiguous verdict via one OpenAI-compatible call", async () => {
      const { repo, db } = await ambiguousScenario();
      const key = (
        await import("../src/core/keys.js")
      ).testKey("Suite", "t");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url) =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      verdicts: [
                        {
                          test_key: key,
                          kind: "flake_likely",
                          confidence: "medium",
                          one_line_reason: "timeout with no link to the diff",
                          likely_cause: "slow first-run compile",
                          suspect_location: null,
                          suggested_next_step: "retry the job",
                        },
                      ],
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 800, completion_tokens: 40 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );

      const r = await cli([
        "run", "--repo", repo.dir, "--db", db,
        "--provider", "local", "--fail-on", "never",
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://localhost:11434/v1/chat/completions");
      expect(r.stdout).toMatch(/likely flake/);
      expect(r.stdout).toMatch(/\(model\)/);
      expect(r.stdout).toMatch(/timeout with no link to the diff/);
      expect(r.stdout).toMatch(/→ retry the job/);
    });

    it("a model real_regression fails the build under the default --fail-on", async () => {
      const { repo, db } = await ambiguousScenario();
      const key = (await import("../src/core/keys.js")).testKey("Suite", "t");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdicts: [
                      {
                        test_key: key,
                        kind: "real_regression",
                        confidence: "high",
                        one_line_reason: "the diff changes the exact function in the stack",
                        likely_cause: "new guard clause returns early",
                        suspect_location: "src/x.ts:5",
                        suggested_next_step: "revert the guard",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const r = await cli(["run", "--repo", repo.dir, "--db", db, "--provider", "local"]);
      expect(r.stdout).toMatch(/likely broken by this PR|Needs you/);
      expect(r.exitCode).toBe(1);
    });

    it("a failed model call is reported but does not change the exit code", async () => {
      const { repo, db } = await ambiguousScenario();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("upstream 500", { status: 500 }),
      );
      const r = await cli(["run", "--repo", repo.dir, "--db", db, "--provider", "local"]);
      expect(r.exitCode).toBe(0); // ambiguous, not a regression
      expect(r.stdout).toMatch(/model escalation skipped/);
    });

    it("logs one line stating what was sent to which provider/model", async () => {
      const { repo, db } = await ambiguousScenario();
      const key = (await import("../src/core/keys.js")).testKey("Suite", "t");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    verdicts: [
                      {
                        test_key: key,
                        kind: "flake_likely",
                        confidence: "medium",
                        one_line_reason: "timeout",
                        likely_cause: "slow ci",
                        suspect_location: null,
                        suggested_next_step: "retry",
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 6120, completion_tokens: 40 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const r = await cli([
        "run", "--repo", repo.dir, "--db", db,
        "--provider", "local", "--fail-on", "never",
      ]);
      expect(r.stderr).toMatch(/→ 1 failure\(s\), 6,120 tokens sent to local\//);
    });
  });

  describe("--print-payload", () => {
    /** A commit whose lone failure has no parent record → deterministic verdict is ambiguous. */
    async function ambiguousScenario(): Promise<{ repo: TmpRepo; db: string }> {
      const { repo, db } = scenario();
      repo.commit("c1", {
        "reports/junit.xml": junitXml("Suite", { t: "fail" }),
      });
      return { repo, db };
    }

    it("prints the exact redacted payload, calls the model zero times, and records nothing", async () => {
      const { repo, db } = await ambiguousScenario();
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const r = await cli([
        "run", "--repo", repo.dir, "--db", db,
        "--provider", "local", "--print-payload",
      ]);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.exitCode).toBe(0);

      const doc = JSON.parse(r.stdout) as {
        provider: string | null;
        model: string | null;
        ambiguousCount: number;
        system: string | null;
        user: string | null;
      };
      expect(doc.provider).toBe("local");
      expect(doc.ambiguousCount).toBe(1);
      expect(doc.system).toMatch(/FlakeTriage's escalation judge/);
      expect(doc.user).toMatch(/### test_key:/);

      const { History } = await import("../src/core/history.js");
      const h = History.open(db);
      try {
        expect(h.recentRuns(10)).toHaveLength(0);
      } finally {
        h.close();
      }
    });

    it("redacts a secret embedded in a failure message — no default-pattern match survives", async () => {
      const { repo, db } = scenario();
      repo.write(
        "reports/junit.xml",
        `<?xml version="1.0"?>
<testsuite name="Suite" tests="1">
  <testcase classname="Suite" name="t" time="0.1">
    <failure message="request failed" type="Error">Error: request failed
    at fetch (src/client.ts:10:1)
    curl -H "Authorization: Bearer sk-ant-api03-thisIsASecretToken1234567890" https://internal/api
    aws_access_key_id = AKIAABCDEFGHIJKLMNOP
    password=hunter2000</failure>
  </testcase>
</testsuite>
`,
      );
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", "c1");

      const r = await cli([
        "run", "--repo", repo.dir, "--db", db,
        "--provider", "local", "--print-payload",
      ]);

      const doc = JSON.parse(r.stdout) as { system: string; user: string };
      const combined = `${doc.system}\n${doc.user}`;
      expect(combined).not.toMatch(/Bearer\s+sk-ant/);
      expect(combined).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(combined).not.toMatch(/password=hunter2000/);
      expect(combined).toContain("[REDACTED]");
    });

    it("no ambiguous failures → still exits 0 with an empty preview, no crash", async () => {
      const { repo, db } = scenario();
      repo.commit("c1", {
        "reports/junit.xml": junitXml("Suite", { t: "pass" }),
      });
      const r = await cli([
        "run", "--repo", repo.dir, "--db", db,
        "--provider", "local", "--print-payload",
      ]);
      expect(r.exitCode).toBe(0);
      const doc = JSON.parse(r.stdout) as { ambiguousCount: number; user: string | null };
      expect(doc.ambiguousCount).toBe(0);
      expect(doc.user).toBeNull();
    });
  });
});

describe("flaketriage history / stats", () => {
  async function recordSequence(
    repo: TmpRepo,
    db: string,
    statuses: Record<string, "pass" | "fail">[],
  ): Promise<void> {
    for (let i = 0; i < statuses.length; i += 1) {
      repo.commit(`c${i}`, {
        "reports/junit.xml": junitXml("WidgetTest", statuses[i]!),
      });
      // eslint-disable-next-line no-await-in-loop
      await cli(["run", "--repo", repo.dir, "--db", db]);
    }
  }

  it("history prints a per-test timeline and flip rate", async () => {
    const { repo, db } = scenario();
    await recordSequence(repo, db, [
      { renders: "pass" },
      { renders: "fail" },
      { renders: "pass" },
      { renders: "fail" },
    ]);

    const r = await cli(["history", "renders", "--db", db]);
    expect(r.stdout).toMatch(/WidgetTest › renders/);
    expect(r.stdout).toMatch(/flipped 3\/3 transitions · flip rate 100%/);
    expect((r.stdout.match(/ pass | FAIL /g) ?? []).length).toBe(4);
  });

  it("history reports nothing for an unknown test (exit 0)", async () => {
    const { repo, db } = scenario();
    await recordSequence(repo, db, [{ a: "pass" }]);
    const r = await cli(["history", "does-not-exist", "--db", db]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/no test in history matches/);
  });

  it("stats ranks tests by flip rate and honours --min-runs", async () => {
    const { repo, db } = scenario();
    await recordSequence(repo, db, [
      { flaky: "pass", stable: "pass" },
      { flaky: "fail", stable: "pass" },
      { flaky: "pass", stable: "pass" },
      { flaky: "fail", stable: "fail" },
    ]);

    const json = await cli(["stats", "--db", db, "--min-runs", "3", "--format", "json"]);
    const doc = JSON.parse(json.stdout) as {
      stats: { testName: string; flipRate: number }[];
      flakyCount: number;
      costEstimate: { batches: number; usd: number };
    };
    expect(doc.stats.map((s) => s.testName)).toEqual(["flaky", "stable"]);
    expect(doc.stats[0]!.flipRate).toBeGreaterThan(doc.stats[1]!.flipRate);
    expect(doc.flakyCount).toBe(1); // "flaky" flips, "stable" does not
    expect(doc.costEstimate).toMatchObject({ batches: 1 });
    expect(doc.costEstimate.usd).toBeCloseTo(0.05, 2);

    const text = await cli(["stats", "--db", db, "--min-runs", "3"]);
    expect(text.stdout).toMatch(/1 flaky test in this window/);
    expect(text.stdout).toMatch(/≈ \$0\.05 \(1 batch of ≤15, claude-opus-5 rates\)/);

    const empty = await cli(["stats", "--db", db, "--min-runs", "99"]);
    expect(empty.stdout).toMatch(/no test has ≥ 99 recorded runs/);
  });

  it("records each CLI run (NULL ci_run_id) even for the same commit", async () => {
    const { repo, db } = scenario();
    repo.commit("c1", { "reports/junit.xml": junitXml("S", { t: "fail" }) });
    const head = repo.git("rev-parse", "HEAD");
    await cli(["run", "--repo", repo.dir, "--db", db, "--commit", head, "--fail-on", "never"]);
    await cli(["run", "--repo", repo.dir, "--db", db, "--commit", head, "--fail-on", "never"]);
    const h = (await import("../src/core/history.js")).History.open(db);
    try {
      expect(h.summary().runs).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe("flaketriage backfill (argument validation — no network)", () => {
  it("fails clearly when no token is available", async () => {
    const prevToken = process.env["GITHUB_TOKEN"];
    const prevGh = process.env["GH_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    delete process.env["GH_TOKEN"];
    try {
      const r = await cli(["backfill", "--repo", "acme/widgets", "--db", ":memory:"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/no GitHub token.*\[GITHUB_API\]/s);
    } finally {
      if (prevToken !== undefined) process.env["GITHUB_TOKEN"] = prevToken;
      if (prevGh !== undefined) process.env["GH_TOKEN"] = prevGh;
    }
  });

  it("rejects a --repo that isn't owner/name", async () => {
    const r = await cli(["backfill", "--repo", "not-a-slug", "--token", "t"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/owner\/name/);
  });
});
