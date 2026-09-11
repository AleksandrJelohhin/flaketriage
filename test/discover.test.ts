import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discoverReports, DEFAULT_REPORT_GLOBS } from "../src/ingest/discover.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ft-discover-"));
  const files = [
    "junit.xml",
    "reports/junit-results.xml",
    "target/surefire-reports/TEST-com.acme.FooTest.xml",
    "packages/web/build/test-results/test/TEST-Bar.xml",
    "coverage/report.xml", // not a report name
    "node_modules/pkg/junit.xml", // ignored dir
    ".venv/lib/junit.xml", // ignored dir
    "src/app.ts",
  ];
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("discoverReports", () => {
  it("matches the default globs (incl. Gradle build dirs) and skips vendored dirs", () => {
    const found = discoverReports(root, DEFAULT_REPORT_GLOBS).map((p) =>
      p.slice(root.length + 1).replace(/\\/g, "/"),
    );
    expect(found).toEqual([
      "junit.xml",
      "packages/web/build/test-results/test/TEST-Bar.xml",
      "reports/junit-results.xml",
      "target/surefire-reports/TEST-com.acme.FooTest.xml",
    ]);
  });

  it("honours an explicit pattern", () => {
    const found = discoverReports(root, ["reports/*.xml"]).map((p) =>
      p.slice(root.length + 1).replace(/\\/g, "/"),
    );
    expect(found).toEqual(["reports/junit-results.xml"]);
  });

  it("returns [] when nothing matches", () => {
    expect(discoverReports(root, ["**/*.tap"])).toEqual([]);
  });

  it("? matches exactly one non-slash char", () => {
    expect(discoverReports(root, ["junit.xm?"]).length).toBe(1);
    expect(discoverReports(root, ["junit.x?"]).length).toBe(0);
  });
});
