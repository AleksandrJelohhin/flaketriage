import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintFailure } from "../src/core/fingerprint.js";
import { parseJUnitXml } from "../src/ingest/junit.js";
import type { TestResult } from "../src/ingest/junit.js";

/**
 * Sweep over the whole real-report corpus (test/fixtures/real, 300+ files from
 * 200+ public repos). This proves the parser survives
 * real-world messiness and prove fingerprints collapse *correctly* — not too much,
 * not too little.
 */

const REAL = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "real");

// Files that are intentionally corrupt (git merge markers / truncated upload).
const KNOWN_UNPARSEABLE = new Set([
  "phpunit/PRJG5_gmi__reports_phpunit.xml",
  "surefire-java/mikepenz_action-junit-report__test_results_corrupt-junit_e2e-tests_corrupt_target_sf-reports_TEST-test.CorruptTest.xml",
]);

// Deliberate edge cases: a <failure> element with an empty message AND empty
// body (the Marathon Android runner emits these). Kept to exercise the parser,
// not representative of a report with a triageable failure.
const KNOWN_EMPTY_FAILURE = new Set([
  "other/mikepenz_action-junit-report__test_results_marathon_tests_com.mikepenz.DummyTest3test_01.xml",
]);

interface Loaded {
  rel: string;
  xml: string;
}

function loadCorpus(): Loaded[] {
  const out: Loaded[] = [];
  for (const fw of readdirSync(REAL)) {
    const dir = join(REAL, fw);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".xml")) continue;
      out.push({ rel: `${fw}/${f}`, xml: readFileSync(join(dir, f), "utf8") });
    }
  }
  return out;
}

const corpus = loadCorpus();

interface Parsed {
  rel: string;
  results: TestResult[];
}

const parsed: Parsed[] = [];
const parseErrors: string[] = [];
for (const { rel, xml } of corpus) {
  try {
    parsed.push({ rel, results: parseJUnitXml(xml, rel) });
  } catch {
    parseErrors.push(rel);
  }
}

/** Every framework FlakeTriage claims to support has real fixtures. */
const REQUIRED_FRAMEWORKS = [
  "playwright",
  "jest",
  "vitest",
  "pytest",
  "surefire-java", // maven-surefire + testng share this JUnit shape …
  "testng",
  "gradle",
  "go",
  "phpunit",
  "k6",
];

describe("corpus: framework coverage", () => {
  const dirs = new Set(
    readdirSync(REAL).filter((e) => statSync(join(REAL, e)).isDirectory()),
  );

  it.each(REQUIRED_FRAMEWORKS)("has real %s fixtures", (fw) => {
    expect(dirs.has(fw), `missing test/fixtures/real/${fw}/`).toBe(true);
    const xmls = readdirSync(join(REAL, fw)).filter((f) => f.endsWith(".xml"));
    expect(xmls.length).toBeGreaterThan(0);
  });

  it("every fixture parses to a non-empty TestResult[] with a failure that carries a message", () => {
    const offenders: string[] = [];
    for (const p of parsed) {
      if (KNOWN_UNPARSEABLE.has(p.rel)) continue;
      if (p.results.length === 0) {
        offenders.push(`${p.rel}: 0 results`);
        continue;
      }
      if (KNOWN_EMPTY_FAILURE.has(p.rel)) continue;
      // A real failure with a message OR — for the deliberate rerun/flaky edge
      // cases — a retry attempt carrying one.
      const hasEvidence = p.results.some((r) => {
        const isFail = r.status === "failed" || r.status === "error";
        const msg = (r.failure?.message ?? r.failure?.stack ?? "").trim();
        const retryMsg = r.retries.some(
          (x) => (x.message ?? x.stack ?? "").trim().length > 0,
        );
        return (isFail && msg.length > 0) || retryMsg;
      });
      if (!hasEvidence) offenders.push(`${p.rel}: no failure/retry carries a message`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("corpus: parse robustness", () => {
  it("has a substantial corpus checked in", () => {
    expect(corpus.length).toBeGreaterThan(300);
  });

  it("parses every report except the known-corrupt handful", () => {
    const unexpected = parseErrors.filter((r) => !KNOWN_UNPARSEABLE.has(r));
    expect(unexpected).toEqual([]);
  });

  it("the known-corrupt files do throw (negative fixtures still exercised)", () => {
    for (const rel of KNOWN_UNPARSEABLE) {
      const f = corpus.find((c) => c.rel === rel);
      if (!f) continue; // corpus may be trimmed later
      expect(() => parseJUnitXml(f.xml, rel)).toThrow();
    }
  });

  it(">= 99% of reports parse", () => {
    expect(parsed.length / corpus.length).toBeGreaterThan(0.99);
  });

  it("never emits an empty test name or suite", () => {
    for (const p of parsed) {
      for (const r of p.results) {
        expect(r.name.length, p.rel).toBeGreaterThan(0);
        expect(r.suite.length, p.rel).toBeGreaterThan(0);
      }
    }
  });

  it("testKey is always a full sha256 and free of normalisation placeholders", () => {
    for (const p of parsed) {
      for (const r of p.results) {
        expect(r.testKey).toMatch(/^[0-9a-f]{64}$/);
        expect(r.suite).not.toMatch(/<(TIME|UUID|HEX|PATH|TMP|PORT)>/);
      }
    }
  });
});

describe("corpus: fingerprint collapse behaviour", () => {
  const fingerprints: string[] = [];
  const byFp = new Map<string, Set<string>>(); // fp -> set of testKeys
  for (const p of parsed) {
    for (const r of p.results) {
      if ((r.status === "failed" || r.status === "error") && r.failure) {
        const fp = fingerprintFailure(r.failure);
        fingerprints.push(fp);
        if (!byFp.has(fp)) byFp.set(fp, new Set());
        byFp.get(fp)!.add(`${p.rel}::${r.testKey}`);
      }
    }
  }

  it("produced a meaningful number of failure fingerprints", () => {
    expect(fingerprints.length).toBeGreaterThan(1000);
  });

  it("every fingerprint is 16 hex chars", () => {
    for (const fp of fingerprints) expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does NOT over-collapse: many distinct fingerprints exist", () => {
    const distinct = new Set(fingerprints).size;
    // hundreds of genuinely different failures across 200+ repos
    expect(distinct).toBeGreaterThan(200);
  });

  it("does NOT under-collapse: the biggest group gathers many occurrences", () => {
    const biggest = Math.max(
      ...[...byFp.values()].map((s) => s.size),
    );
    // the headline capability: "this exact failure appeared N times"
    expect(biggest).toBeGreaterThanOrEqual(10);
  });

  it("collapses the 20 superficially-different failures in one Playwright report", () => {
    const pw = parsed.find((p) =>
      p.rel.includes("Aceyuan361_Insight-AITest"),
    );
    expect(pw, "expected the Insight-AITest playwright fixture in the corpus").toBeTruthy();
    const fps = new Set(
      pw!.results
        .filter((r) => r.failure && (r.status === "failed" || r.status === "error"))
        .map((r) => fingerprintFailure(r.failure!)),
    );
    expect(pw!.results.filter((r) => r.status === "failed").length).toBeGreaterThanOrEqual(15);
    expect(fps.size).toBe(1);
  });
});
