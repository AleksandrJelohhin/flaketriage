import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FlakeTriageError } from "../src/core/errors.js";
import { runFlakeTriage } from "../src/run.js";
import { STICKY_MARKER } from "../src/report/markdown.js";
import { TmpRepo, junitXml } from "./helpers/tmprepo.js";

const repos: TmpRepo[] = [];
function repo(): { repo: TmpRepo; db: string } {
  const r = TmpRepo.create();
  r.setRemote("https://github.com/acme/app.git");
  repos.push(r);
  return { repo: r, db: join(r.dir, ".flaketriage/history.db") };
}
afterEach(() => {
  while (repos.length) rmSync(repos.pop()!.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("runFlakeTriage", () => {
  it("returns markdown / text / json / exitCode for one recorded run", async () => {
    const { repo: r, db } = repo();
    r.commit("c1", { "reports/junit.xml": junitXml("S", { a: "pass", b: "fail" }) });

    const res = await runFlakeTriage({ repoPath: r.dir, db, providerEnv: {} });
    expect(res.markdown.startsWith(STICKY_MARKER)).toBe(true);
    expect(res.json.schema).toBe("flaketriage/triage@2");
    expect(res.json.totals).toMatchObject({ passed: 1, failed: 1 });
    expect(res.text).toMatch(/FlakeTriage — 1 passed/);
    expect(res.reportFileCount).toBe(1);
  });

  it("records exactly one run (not two, despite md+json+text all being produced)", async () => {
    const { repo: r, db } = repo();
    r.commit("c1", { "reports/junit.xml": junitXml("S", { a: "fail" }) });
    await runFlakeTriage({ repoPath: r.dir, db, providerEnv: {} });

    const { History } = await import("../src/core/history.js");
    const h = History.open(db);
    try {
      expect(h.summary().runs).toBe(1);
    } finally {
      h.close();
    }
  });

  it("real_regression: green on parent, and a failing frame lands on a line this PR changed", async () => {
    const { repo: r, db } = repo();
    const src10 = Array.from({ length: 10 }, (_v, i) => `line ${i + 1}`).join("\n");
    const c1 = r.commit("c1", {
      "src/calc.ts": src10,
      "reports/junit.xml": junitXml("CalcTest", { totals: "pass" }),
    });
    await runFlakeTriage({ repoPath: r.dir, db, commit: c1, providerEnv: {} });

    const c2 = r.commit("c2", {
      "src/calc.ts": src10.replace("line 5", "line 5 // BUG"),
      "reports/junit.xml": junitXml(
        "CalcTest",
        { totals: "fail" },
        { file: "src/calc.ts", line: 5 },
      ),
    });

    const res = await runFlakeTriage({
      repoPath: r.dir,
      db,
      commit: c2,
      parent: c1,
      providerEnv: {},
    });
    expect(res.json.verdicts[0]!.kind).toBe("real_regression");
    expect(res.json.verdicts[0]!.blame?.[0]).toMatchObject({ proximity: "exact_line" });
    expect(res.exitCode).toBe(1);
  });

  it("--fail-on never keeps exitCode 0 on a regression", async () => {
    const { repo: r, db } = repo();
    const src = Array.from({ length: 6 }, (_v, i) => `L${i}`).join("\n");
    const c1 = r.commit("c1", {
      "src/x.ts": src,
      "reports/junit.xml": junitXml("XTest", { t: "pass" }),
    });
    await runFlakeTriage({ repoPath: r.dir, db, commit: c1, providerEnv: {} });
    const c2 = r.commit("c2", {
      "src/x.ts": src.replace("L3", "L3 boom"),
      "reports/junit.xml": junitXml("XTest", { t: "fail" }, { file: "src/x.ts", line: 4 }),
    });
    const res = await runFlakeTriage({
      repoPath: r.dir,
      db,
      commit: c2,
      parent: c1,
      failOn: "never",
      providerEnv: {},
    });
    expect(res.exitCode).toBe(0);
  });

  it("throws a typed error when no reports match", async () => {
    const { repo: r, db } = repo();
    r.commit("c1", { "src/a.ts": "1" });
    await expect(runFlakeTriage({ repoPath: r.dir, db, providerEnv: {} })).rejects.toBeInstanceOf(
      FlakeTriageError,
    );
  });

  it("escalates ambiguous verdicts through the resolved provider", async () => {
    const { repo: r, db } = repo();
    r.commit("c1", { "reports/junit.xml": junitXml("S", { t: "fail" }) });
    const key = (await import("../src/core/keys.js")).testKey("S", "t");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
                      one_line_reason: "no diff link",
                      likely_cause: "timing",
                      suspect_location: null,
                      suggested_next_step: "retry",
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

    const res = await runFlakeTriage({
      repoPath: r.dir,
      db,
      llmProvider: "local",
      providerEnv: {},
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.json.verdicts[0]).toMatchObject({ kind: "flake_likely", source: "model" });
    expect(res.json.escalation).toMatchObject({ escalated: 1 });
  });
});
