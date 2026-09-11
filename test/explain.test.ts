import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FlakeTriageError } from "../src/core/errors.js";
import { explainTest } from "../src/explain.js";
import { renderExplain } from "../src/report/explain.js";
import { runFlakeTriage } from "../src/run.js";
import { TmpRepo, junitXml } from "./helpers/tmprepo.js";

const repos: TmpRepo[] = [];
function repo(): { repo: TmpRepo; db: string } {
  const r = TmpRepo.create();
  r.setRemote("https://github.com/acme/shop.git");
  repos.push(r);
  return { repo: r, db: join(r.dir, ".flaketriage/history.db") };
}
afterEach(() => {
  while (repos.length) rmSync(repos.pop()!.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// real git + two triage runs per test; generous under full-suite parallelism
const T = 30_000;

/** Record a green baseline then a regression that changes line 5 of src/calc.ts. */
async function regressionHistory(): Promise<{ repo: TmpRepo; db: string }> {
  const { repo: r, db } = repo();
  const src = Array.from({ length: 10 }, (_v, i) => `L${i + 1}`).join("\n");
  const c1 = r.commit("c1", {
    "src/calc.ts": src,
    "reports/junit.xml": junitXml("CalcTest", { totals: "pass" }),
  });
  await runFlakeTriage({ repoPath: r.dir, db, commit: c1, providerEnv: {} });
  const c2 = r.commit("c2", {
    "src/calc.ts": src.replace("L5", "L5 // BUG"),
    "reports/junit.xml": junitXml("CalcTest", { totals: "fail" }, { file: "src/calc.ts", line: 5 }),
  });
  await runFlakeTriage({ repoPath: r.dir, db, commit: c2, parent: c1, providerEnv: {} });
  return { repo: r, db };
}

describe("explainTest", () => {
  it("re-derives the verdict and lays out every input", async () => {
    const { repo: r, db } = await regressionHistory();
    const rep = await explainTest("totals", { repoPath: r.dir, db });

    expect(rep.suite).toBe("CalcTest");
    expect(rep.verdict).toMatchObject({ kind: "real_regression", confidence: "high" });

    // timeline: pass on c1, fail on c2
    expect(rep.timeline.map((t) => t.status)).toEqual(["passed", "failed"]);

    // fingerprint spread
    expect(rep.fingerprint?.occurrences).toBe(1);

    // blame — live diff, exact-line hit
    expect(rep.blameFromLiveDiff).toBe(true);
    expect(rep.blame[0]).toMatchObject({
      proximity: "exact_line",
      changedFile: "src/calc.ts",
    });
    expect(rep.blame[0]!.frame.line).toBe(5);

    // history facts the classifier used
    expect(rep.history).toMatchObject({
      everPassed: true,
      parentOutcome: "pass",
      passedSameCommitOtherAttempt: false,
      priorRuns: 1,
    });

    expect(rep.latest.stack).toContain("src/calc.ts:5");
  }, T);

  it("renders a text report a skeptic can read", async () => {
    const { repo: r, db } = await regressionHistory();
    const txt = renderExplain(await explainTest("totals", { repoPath: r.dir, db }));
    expect(txt).toMatch(/VERDICT: real_regression/);
    expect(txt).toMatch(/RUN TIMELINE {2}\(2 recorded\)/);
    expect(txt).toMatch(/FINGERPRINT/);
    expect(txt).toMatch(/\[0\.95\] exact_line/);
    expect(txt).toMatch(/FAILURE \(as recorded\)/);
  }, T);

  it("falls back to the stored file list when there is no live diff", async () => {
    const { repo: r, db } = await regressionHistory();
    // point --repo at a directory that is a repo but does not have c2's diff reachable
    const other = TmpRepo.create();
    repos.push(other);
    other.commit("unrelated");
    const rep = await explainTest("totals", { repoPath: other.dir, db });
    expect(rep.blameFromLiveDiff).toBe(false);
    // still gets a same_file link from the stored changed_files list
    expect(rep.blame.map((b) => b.proximity)).toContain("same_file");
  }, T);

  it("throws a typed error for an unknown test", async () => {
    const { repo: r, db } = repo();
    r.commit("c1", { "reports/junit.xml": junitXml("S", { t: "fail" }) });
    await runFlakeTriage({ repoPath: r.dir, db, providerEnv: {} });
    await expect(explainTest("nope", { repoPath: r.dir, db })).rejects.toBeInstanceOf(
      FlakeTriageError,
    );
  }, T);
});
