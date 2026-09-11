import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { JUnitParseError } from "../src/core/errors.js";
import { parseJUnitFile, parseJUnitXml } from "../src/ingest/junit.js";
import type { TestResult } from "../src/ingest/junit.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const one = (rs: TestResult[], name: string): TestResult => {
  const r = rs.find((x) => x.name === name);
  if (!r) throw new Error(`no test named ${name}`);
  return r;
};

describe("parseJUnitXml — real reports, one per runner", () => {
  it("pytest: failure / error / skipped / passed are classified", () => {
    const rs = parseJUnitFile(join(FIX, "pytest.junit.xml"));
    const tally = rs.reduce<Record<string, number>>((a, r) => {
      a[r.status] = (a[r.status] ?? 0) + 1;
      return a;
    }, {});
    expect(tally).toMatchObject({ passed: 7, failed: 3, error: 2, skipped: 6 });

    const fail = one(rs, "test_fail");
    expect(fail.suite).toBe("tests.example.test_example");
    expect(fail.status).toBe("failed");
    expect(fail.failure?.stack).toContain("assert 0");
    expect(fail.testKey).toMatch(/^[0-9a-f]{64}$/);

    const err = one(rs, "test_error");
    expect(err.status).toBe("error");
    expect(err.failure?.message).toBe('failed on setup with "assert 0"');
  });

  it("Maven Surefire: 808-case Pulsar report, one real failure, TestNG stack kept", () => {
    const rs = parseJUnitFile(join(FIX, "surefire.junit.xml"));
    expect(rs.length).toBeGreaterThan(700);
    const failed = rs.filter((r) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.suite).toBe("org.apache.pulsar.AddMissingPatchVersionTest");
    expect(failed[0]!.name).toBe("testVersionStrings");
    expect(failed[0]!.failure?.message).toBe("expected [1.2.1] but found [1.2.0]");
    expect(failed[0]!.failure?.stack).toContain("AddMissingPatchVersionTest.java:29");
  });

  it("Playwright: <error> (timeout) vs <failure>, file attribute, classname suite", () => {
    const rs = parseJUnitFile(join(FIX, "playwright.junit.xml"));
    const timeout = one(rs, "open admin");
    expect(timeout.status).toBe("error");
    expect(timeout.suite).toBe("admin.spec.js");
    expect(timeout.failure?.message).toMatch(/Test timeout of 60000ms exceeded/);
  });

  it("Jest: nested <testsuites>, describe-path classname, message from body", () => {
    const rs = parseJUnitFile(join(FIX, "jest.junit.xml"));
    expect(rs).toHaveLength(6);
    const failing = one(rs, "Failing test");
    expect(failing.suite).toBe("Test 1 › Test 1.1");
    expect(failing.status).toBe("failed");
    // no message attribute — the body carries "Error: expect(received).toBeTruthy()"
    expect(failing.failure?.message).toBeNull();
    expect(failing.failure?.stack).toContain("toBeTruthy");
    expect(one(rs, "Skipped test").status).toBe("skipped");
  });
});

describe("parseJUnitXml — structural edge cases (from the corpus)", () => {
  it("decodes XML entities in test names and messages", () => {
    const rs = parseJUnitFile(join(FIX, "xml-entities.junit.xml"));
    expect(rs.map((r) => r.name)).toContain("Test with & in the test name");
    const amp = one(rs, "Test with & in the test name");
    expect(amp.status).toBe("error");
    expect(amp.failure?.message).toBe("A message with &");
    expect(amp.failure?.stack).toBe("Content with &");
  });

  it("Surefire <flakyFailure> ⇒ passed, evidence captured in retries[]", () => {
    const rs = parseJUnitFile(join(FIX, "surefire-flaky.junit.xml"));
    expect(rs).toHaveLength(1);
    const tc = rs[0]!;
    expect(tc.status).toBe("passed");
    expect(tc.failure).toBeNull();
    expect(tc.retries).toHaveLength(1);
    expect(tc.retries[0]!.type).toBe("java.lang.AssertionError");
    expect(tc.retries[0]!.stack).toContain("Expected: <false>");
    // nested <stackTrace> / <system-err> scaffolding is stripped
    expect(tc.retries[0]!.stack).not.toContain("<stackTrace>");
    expect(tc.retries[0]!.stack).not.toContain("Some error output here");
  });

  it("accepts a bare <testsuite> root and a <testsuites> wrapper alike", () => {
    const bare = parseJUnitXml(
      `<testsuite name="s"><testcase name="t"><failure message="x">y</failure></testcase></testsuite>`,
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]!.status).toBe("failed");

    const wrapped = parseJUnitXml(
      `<testsuites><testsuite name="s"><testcase name="t"/></testsuite></testsuites>`,
    );
    expect(wrapped[0]!.status).toBe("passed");
  });

  it("walks nested <testsuite> elements", () => {
    const rs = parseJUnitXml(
      `<testsuites><testsuite name="outer">
         <testsuite name="inner">
           <testcase classname="pkg.Inner" name="a"><failure>boom</failure></testcase>
         </testsuite>
       </testsuite></testsuites>`,
    );
    expect(rs).toHaveLength(1);
    expect(rs[0]!.suite).toBe("pkg.Inner");
    expect(rs[0]!.status).toBe("failed");
  });

  it("parses a <failure> body containing unescaped '<' (stopNode safety)", () => {
    const rs = parseJUnitXml(
      `<testsuite name="s"><testcase name="t"><failure message="m">self = &lt;obj&gt; and <raw> angle brackets</failure></testcase></testsuite>`,
    );
    expect(rs[0]!.status).toBe("failed");
    expect(rs[0]!.failure?.stack).toContain("angle brackets");
  });

  it("time attribute → durationMs", () => {
    const rs = parseJUnitXml(
      `<testsuite name="s"><testcase name="t" time="1.234"/></testsuite>`,
    );
    expect(rs[0]!.durationMs).toBe(1234);
  });
});

describe("parseJUnitXml — error handling", () => {
  it("throws JUnitParseError on an empty document", () => {
    expect(() => parseJUnitXml("   ")).toThrow(JUnitParseError);
  });

  it("throws JUnitParseError on non-JUnit XML", () => {
    expect(() => parseJUnitXml("<rss><channel/></rss>")).toThrow(
      /not a JUnit XML report/,
    );
  });

  it("throws JUnitParseError on malformed XML (git merge markers in the corpus)", () => {
    const bad = `<testsuites>\n<<<<<<< HEAD\n<testsuite/>\n>>>>>>> branch\n</testsuites>`;
    expect(() => parseJUnitXml(bad)).toThrow(JUnitParseError);
  });

  it("carries a machine-readable code and the source label", () => {
    try {
      parseJUnitXml("nonsense", "report.xml");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(JUnitParseError);
      expect((e as JUnitParseError).code).toBe("JUNIT_PARSE");
      expect((e as JUnitParseError).source).toBe("report.xml");
    }
  });
});
