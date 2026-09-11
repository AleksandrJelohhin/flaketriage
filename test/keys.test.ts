import { describe, expect, it } from "vitest";

import { stableSuite, testKey } from "../src/core/keys.js";

describe("testKey", () => {
  it("is a deterministic sha256 hex digest of suite::name", () => {
    const k = testKey("checkout.spec.ts", "applies discount code");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(testKey("checkout.spec.ts", "applies discount code")).toBe(k);
  });

  it("uses the exact `suite::name` construction", async () => {
    const { createHash } = await import("node:crypto");
    expect(testKey("checkout.spec.ts", "applies discount code")).toBe(
      createHash("sha256")
        .update("checkout.spec.ts::applies discount code", "utf8")
        .digest("hex"),
    );
  });

  it("is sensitive to both suite and name", () => {
    const base = testKey("suite", "name");
    expect(testKey("suite2", "name")).not.toBe(base);
    expect(testKey("suite", "name2")).not.toBe(base);
  });
});

describe("stableSuite", () => {
  it("normalises Windows path separators (same test, different runner OS)", () => {
    expect(stableSuite("bacoffice\\backoffice-001.spec.ts")).toBe(
      "bacoffice/backoffice-001.spec.ts",
    );
    expect(testKey(stableSuite("dir\\a.spec.ts"), "t")).toBe(
      testKey(stableSuite("dir/a.spec.ts"), "t"),
    );
  });

  it("collapses repeated slashes and strips a leading ./", () => {
    expect(stableSuite("./src//foo/bar.test.ts")).toBe("src/foo/bar.test.ts");
  });

  it("keeps directories and extensions — they are stable signal", () => {
    expect(stableSuite("packages/core/src/util.test.ts")).toBe(
      "packages/core/src/util.test.ts",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(stableSuite("  a.spec.ts \n")).toBe("a.spec.ts");
  });
});
