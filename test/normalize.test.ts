import { describe, expect, it } from "vitest";

import {
  extractFrames,
  normalizeFailure,
  normalizeFrame,
  normalizeMessage,
} from "../src/core/normalize.js";

/**
 * normalize.ts is one of the three files that ARE the product.
 * These tests were written before the rest of the pipeline.
 *
 * Two axes are checked:
 *  1. each scalar-token rule replaces what it should and nothing it shouldn't
 *  2. superficially-different real failures collapse; genuinely-different ones don't
 */

describe("normalizeMessage — scalar token rules", () => {
  it("ISO timestamps and epoch-ms → <TIME>", () => {
    expect(normalizeMessage("failed at 2024-06-09T16:05:50.779Z retry")).toBe(
      "failed at <TIME> retry",
    );
    expect(normalizeMessage("timestamp=2023-12-19 18:56:43.325550 done")).toBe(
      "timestamp=<TIME> done",
    );
    expect(normalizeMessage("deadline 1719331200000 exceeded")).toBe(
      "deadline <TIME> exceeded",
    );
  });

  it("UUIDs → <UUID>", () => {
    expect(
      normalizeMessage("run 01234567-0011-0011-0011-001122334455 not found"),
    ).toBe("run <UUID> not found");
  });

  it("hex ≥ 6 chars / 0x… / object hashes → <HEX>", () => {
    expect(normalizeMessage("pointer 0x1f4a9c00 is null")).toBe(
      "pointer <HEX> is null",
    );
    expect(normalizeMessage("Object@1a2b3c4d differs")).toBe("Object@<HEX> differs");
    expect(normalizeMessage("commit deadbeefcafe123 rejected")).toBe(
      "commit <HEX> rejected",
    );
  });

  it("does NOT eat plain decimal numbers — expected/received is signal", () => {
    expect(normalizeMessage("expected [1.2.1] but found [1.2.0]")).toBe(
      "expected [1.2.1] but found [1.2.0]",
    );
    expect(normalizeMessage("expect(received).toBe(42) // got 41")).toBe(
      "expect(received).toBe(42) // got 41",
    );
    expect(normalizeMessage("WRONG COVERAGE: 41 > 26")).toBe("WRONG COVERAGE: 41 > 26");
  });

  it("host:port → host:<PORT>, but file.ext:line is left alone", () => {
    expect(
      normalizeMessage("net::ERR_CONNECTION_REFUSED at http://localhost:5173/"),
    ).toBe("net::ERR_CONNECTION_REFUSED at http://localhost:<PORT>/");
    expect(normalizeMessage("dial 127.0.0.1:54321: connection refused")).toBe(
      "dial 127.0.0.1:<PORT>: connection refused",
    );
    // a source location must not be treated as a port
    expect(normalizeMessage("REQUIRE failed at utility.cpp:12")).toContain(
      "utility.cpp:12",
    );
  });

  it("perf-metric durations → <DUR> (k6 / gotestsum), percentiles → p(<N>)", () => {
    expect(
      normalizeMessage("✗ http_req_duration: avg=43.9ms p(95)=49.62ms max=313.12ms"),
    ).toBe("✗ http_req_duration: avg=<DUR> p(<N>)=<DUR> max=<DUR>");
    expect(normalizeMessage("--- FAIL: TestSlow (3m2s)")).toBe("--- FAIL: TestSlow (<DUR>)");
    // an expected/received number that happens to be a plain integer is untouched
    expect(normalizeMessage("expected 500 but got 42")).toBe("expected 500 but got 42");
  });

  it("temp dirs → <TMP>", () => {
    expect(
      normalizeMessage("wrote /tmp/pytest-of-runner/pytest-0/test0/out.txt ok"),
    ).toBe("wrote <TMP> ok");
    expect(
      normalizeMessage(
        "cache at C:\\Users\\runneradmin\\AppData\\Local\\Temp\\xunit\\a.db",
      ),
    ).toBe("cache at <TMP>");
  });

  it("URL credentials → <CRED>", () => {
    expect(
      normalizeMessage("GET http://elastic:changeme@localhost:9200/_all failed"),
    ).toBe("GET http://<CRED>@localhost:<PORT>/_all failed");
  });

  it("strips ANSI colour codes and box-drawing rules", () => {
    expect(normalizeMessage("\u001b[31mError:\u001b[39m boom")).toBe("Error: boom");
    expect(
      normalizeMessage("open admin ─────────────────────────── failed"),
    ).toBe("open admin failed");
  });

  it("repoRoot, when supplied, is stripped from both / and \\ forms", () => {
    const opts = { repoRoot: "/home/ci/work/proj" };
    expect(
      normalizeMessage("at /home/ci/work/proj/src/api/client.ts boom", opts),
    ).toBe("at src/api/client.ts boom");
  });

  it("pytest: keeps the `E   …` error lines, drops the source echo", () => {
    const raw = [
      "def test_fail():",
      ">       assert 0",
      "E       assert 0",
      "",
      "tests/example/test_example.py:15: AssertionError",
    ].join("\n");
    expect(normalizeMessage(raw)).toBe("assert 0");
  });
});

describe("normalizeFrame", () => {
  it("drops :line:col from a JS frame and normalises separators", () => {
    expect(
      normalizeFrame("    at PIMPage.verifyEmployeeAdded (D:\\a\\proj\\pages\\PIMPage.js:28:33)"),
    ).toBe("at PIMPage.verifyEmployeeAdded (PIMPage.js)");
  });

  it("keeps the fully-qualified name for a Java frame, drops the line", () => {
    expect(
      normalizeFrame(
        "\tat org.apache.pulsar.AddMissingPatchVersionTest.testVersionStrings(AddMissingPatchVersionTest.java:29)",
      ),
    ).toBe(
      "at org.apache.pulsar.AddMissingPatchVersionTest.testVersionStrings(AddMissingPatchVersionTest.java)",
    );
  });

  it("rewrites a pytest `path:line: in fn` frame", () => {
    expect(normalizeFrame("test_spark.py:836: in do_test_rsh_events")).toBe(
      "at do_test_rsh_events (test_spark.py)",
    );
  });

  it("rewrites a Python `File \"x\", line N, in fn` frame", () => {
    expect(
      normalizeFrame('  File "/usr/lib/app/foo.py", line 42, in handler'),
    ).toBe("at handler (foo.py)");
  });
});

describe("extractFrames", () => {
  const stack = [
    "Error: boom",
    "    at doThing (src/thing.ts:10:5)",
    "    at Object.<anonymous> (src/thing.test.ts:3:1)",
    "    at node_modules/vitest/dist/runner.js:99:1",
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    "    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
  ].join("\n");

  it("keeps only non-vendor frames", () => {
    expect(extractFrames(stack)).toEqual([
      "at doThing (src/thing.ts)",
      "at Object.<anonymous> (src/thing.test.ts)",
    ]);
  });

  it("keeps at most the first 5 non-vendor frames", () => {
    const deep = Array.from(
      { length: 12 },
      (_v, i) => `    at fn${i} (src/f${i}.ts:${i}:1)`,
    ).join("\n");
    expect(extractFrames(deep)).toHaveLength(5);
    expect(extractFrames(deep, { maxFrames: 3 })).toHaveLength(3);
  });
});

describe("collapse: superficially-different failures → one fingerprint's input", () => {
  it("same Playwright failure at different line:col / test title collapses", () => {
    const a = normalizeFailure({
      message: "report-panel.spec.ts:29:3 应该显示报告面板标题",
      stack:
        "  [chromium] › report-panel.spec.ts:29:3 › 布局 › 标题 ───\n\n    Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/\n\n       at ..\\..\\pages\\MainWindow.ts:24\n        at MainWindow.goto (C:\\Users\\x\\pages\\MainWindow.ts:24:17)",
    });
    const b = normalizeFailure({
      message: "report-panel.spec.ts:41:3 应该显示所有筛选控件",
      stack:
        "  [chromium] › report-panel.spec.ts:41:3 › 布局 › 控件 ───\n\n    Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5173/\n\n       at ..\\..\\pages\\MainWindow.ts:24\n        at MainWindow.goto (C:\\Users\\x\\pages\\MainWindow.ts:24:17)",
    });
    expect(a.canonical).toBe(b.canonical);
    expect(a.message).toBe(
      "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:<PORT>/",
    );
  });

  it("same Java assertion from two different CI runs (timestamps, temp paths) collapses", () => {
    const mk = (ts: string, tmp: string) =>
      normalizeFailure({
        message: "expected [1.2.1] but found [1.2.0]",
        stack: `java.lang.AssertionError: expected [1.2.1] but found [1.2.0]\n\tat ${tmp}/AddMissingPatchVersionTest.java:29)\n\tat X.run(${ts})`,
      });
    expect(mk("2024-01-01T00:00:00Z", "/tmp/build-aaa/src").canonical).toBe(
      mk("2025-09-10T12:00:00Z", "/tmp/build-zzz/src").canonical,
    );
  });
});

describe("no false collapse: genuinely-different failures stay distinct", () => {
  it("different assertion values do not collapse", () => {
    expect(normalizeFailure({ message: "expected [1.2.1] but found [1.2.0]" }).canonical).not.toBe(
      normalizeFailure({ message: "expected [2.0.0] but found [1.9.9]" }).canonical,
    );
  });

  it("a timeout and an assertion in the same test do not collapse", () => {
    const timeout = normalizeFailure({
      message: 'Test timeout of 60000ms exceeded while setting up "adminPage".',
    });
    const assertion = normalizeFailure({
      message: "expect(page).toHaveURL(expected) failed",
    });
    expect(timeout.canonical).not.toBe(assertion.canonical);
  });
});
