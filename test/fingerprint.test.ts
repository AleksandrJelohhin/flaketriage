import { describe, expect, it } from "vitest";

import {
  FINGERPRINT_LENGTH,
  fingerprintCanonical,
  fingerprintFailure,
} from "../src/core/fingerprint.js";

describe("fingerprint", () => {
  it("is 16 lowercase hex chars", () => {
    const fp = fingerprintFailure({ message: "boom" });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toHaveLength(FINGERPRINT_LENGTH);
  });

  it("is deterministic", () => {
    const input = { message: "expected [1] but found [2]", stack: "at X.y (A.java:9)" };
    expect(fingerprintFailure(input)).toBe(fingerprintFailure(input));
  });

  it("matches sha256(message + '|' + frames).slice(0,16)", async () => {
    const { createHash } = await import("node:crypto");
    const { normalizeFailure } = await import("../src/core/normalize.js");
    const input = { message: "boom", stack: "at doThing (src/thing.ts:10:5)" };
    const canonical = normalizeFailure(input).canonical;
    const expected = createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(fingerprintFailure(input)).toBe(expected);
    expect(fingerprintCanonical(canonical)).toBe(expected);
  });

  it("collapses two superficially-different renderings of the same failure", () => {
    const run1 = {
      message: "AssertionError: Found errors\nassert 1 == 0",
      stack: "/home/runner/work/proj/proj/test/test_copyright.py:23: in test_copyright",
    };
    const run2 = {
      message: "AssertionError: Found errors\nassert 1 == 0",
      stack: "D:\\a\\proj\\proj\\test\\test_copyright.py:23: in test_copyright",
    };
    expect(fingerprintFailure(run1)).toBe(fingerprintFailure(run2));
  });

  it("keeps genuinely different failures apart", () => {
    expect(fingerprintFailure({ message: "assert 1 == 0" })).not.toBe(
      fingerprintFailure({ message: "assert 2 == 3" }),
    );
  });
});
