import { describe, expect, it } from "vitest";

import type { TriagedResult, TriagedRun } from "../src/pipeline.js";
import { renderJsonReport } from "../src/report/json.js";
import { renderMarkdown } from "../src/report/markdown.js";
import { renderSummary } from "../src/report/summary.js";
import { renderText } from "../src/report/text.js";
import { analyzedResult, gitContext, triagedResult, verdict } from "./helpers/factories.js";

const EVIDENCE =
  "failed once, then passed on retry in this run (attempt 1) — first failure: expected true";

function flake(name: string): TriagedResult {
  return triagedResult(name, verdict("flake_confirmed", { evidence: [EVIDENCE] }), {
    result: analyzedResult(name, {
      status: "passed",
      failure: null,
      fingerprint: null,
      retries: [{ message: "expected true", type: null, stack: null }],
    }),
  });
}

function run(triaged: TriagedResult[], flakes: TriagedResult[]): TriagedRun {
  return {
    git: gitContext(),
    attempt: 1,
    total: 12,
    passed: 10,
    skipped: 0,
    triaged,
    flakes,
    ambiguousCount: 0,
  };
}

describe("reports — passing tests that failed first", () => {
  it("markdown: a green run with flakes says so and lists them", () => {
    const md = renderMarkdown(run([], [flake("checkout")]));
    expect(md).toMatch(/### 🟢 FlakeTriage — no failures, 1 flaky/);
    expect(md).toContain("**⚪ Passed after retry — 1 flake**");
    expect(md).toContain("`acme.Suite › checkout`");
    expect(md).toContain(EVIDENCE);
  });

  it("markdown: a green run without flakes is unchanged", () => {
    const md = renderMarkdown(run([], []));
    expect(md).toMatch(/### 🟢 FlakeTriage — no failures\n/);
    expect(md).not.toMatch(/Passed after retry|flaky/);
  });

  it("markdown: flakes come after the failure groups and don't change the headline emoji", () => {
    const md = renderMarkdown(run([triagedResult("reg", verdict("real_regression"))], [flake("checkout")]));
    expect(md.indexOf("Needs you")).toBeGreaterThan(0);
    expect(md.indexOf("Needs you")).toBeLessThan(md.indexOf("Passed after retry"));
    expect(md).toMatch(/### 🔴 FlakeTriage — 1 failure/);
  });

  it("text and job summary list flaky passes", () => {
    const r = run([], [flake("checkout")]);
    expect(renderText(r)).toMatch(/⚪ Passed after retry[\s\S]*acme\.Suite › checkout/);
    expect(renderSummary(r)).toMatch(/### ⚪ Passed after retry \(1\)[\s\S]*acme\.Suite › checkout/);
  });

  it("json: totals.flaky and flakes[] with the retry count; failed stays 0", () => {
    const json = renderJsonReport(run([], [flake("checkout")]));
    expect(json.totals).toMatchObject({ failed: 0, flaky: 1 });
    expect(json.flakes).toEqual([
      {
        testKey: "key-checkout",
        suite: "acme.Suite",
        name: "checkout",
        kind: "flake_confirmed",
        confidence: "high",
        evidence: [EVIDENCE],
        retries: 1,
      },
    ]);
  });
});
