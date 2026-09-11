import { describe, expect, it } from "vitest";

import {
  correlate,
  parseImports,
  parseStackFrames,
} from "../src/core/blame.js";
import type { DiffHunk, StackFrame } from "../src/core/blame.js";

/**
 * blame.ts — the differentiator. Pure, so tests just assemble frames
 * and hunks.
 */

const frame = (over: Partial<StackFrame>): StackFrame => ({
  file: "src/pricing/discount.ts",
  line: 88,
  symbol: "apply",
  raw: "at apply (src/pricing/discount.ts:88:10)",
  depth: 0,
  ...over,
});

const hunk = (over: Partial<DiffHunk>): DiffHunk => ({
  file: "src/pricing/discount.ts",
  newStart: 85,
  newLines: 6,
  changedLines: [86, 87, 88],
  ...over,
});

describe("correlate — proximity levels", () => {
  it("exact_line: a failing frame on a changed line → 0.95", () => {
    const [link] = correlate([frame({ line: 88 })], [hunk({})]);
    expect(link).toMatchObject({ proximity: "exact_line", confidence: 0.95 });
    expect(link!.changedFile).toBe("src/pricing/discount.ts");
  });

  it("same_hunk: a frame within 5 lines of a changed hunk → 0.8", () => {
    const [link] = correlate([frame({ line: 93 })], [hunk({ changedLines: [86, 87, 88] })]);
    expect(link).toMatchObject({ proximity: "same_hunk", confidence: 0.8 });
  });

  it("same_file: a frame in a changed file but far from any hunk → 0.5", () => {
    const [link] = correlate([frame({ line: 400 })], [hunk({})]);
    expect(link).toMatchObject({ proximity: "same_file", confidence: 0.5 });
  });

  it("imported_by: a frame whose file imports a changed file → 0.3", () => {
    const links = correlate(
      [frame({ file: "src/checkout/cart.ts", line: 12 })],
      [hunk({})],
      { importsOf: (f) => (f === "src/checkout/cart.ts" ? ["src/pricing/discount.ts"] : []) },
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ proximity: "imported_by", confidence: 0.3 });
  });

  it("returns an empty array when nothing links — a valid, common answer", () => {
    expect(
      correlate([frame({ file: "src/unrelated.ts", line: 3 })], [hunk({})]),
    ).toEqual([]);
  });

  it("sorts strongest link first", () => {
    const links = correlate(
      [
        frame({ file: "src/pricing/discount.ts", line: 500, depth: 0 }), // same_file
        frame({ file: "src/pricing/discount.ts", line: 88, depth: 1 }), // exact_line
      ],
      [hunk({})],
    );
    expect(links.map((l) => l.proximity)).toEqual(["exact_line", "same_file"]);
  });

  it("exact_line wins over same_hunk within the same frame", () => {
    const [link] = correlate(
      [frame({ line: 88 })],
      [hunk({ newStart: 85, newLines: 10, changedLines: [88] })],
    );
    expect(link!.proximity).toBe("exact_line");
  });

  it("a frame with no line number can still match same_file / imported_by", () => {
    const [link] = correlate([frame({ line: null })], [hunk({})]);
    expect(link!.proximity).toBe("same_file");
  });

  it("matches paths by suffix (repo-relative vs deeper path)", () => {
    const [link] = correlate(
      [frame({ file: "pricing/discount.ts", line: 88 })],
      [hunk({ file: "packages/api/src/pricing/discount.ts" })],
    );
    expect(link?.proximity).toBe("exact_line");
  });
});

describe("parseStackFrames", () => {
  it("extracts JS frames with file + line + symbol, most-recent first", () => {
    const stack = [
      "Error: boom",
      "    at Object.apply (src/pricing/discount.ts:88:10)",
      "    at Cart.total (src/checkout/cart.ts:12:5)",
      "    at node_modules/vitest/dist/runner.js:99:1",
    ].join("\n");
    const frames = parseStackFrames(stack);
    expect(frames).toEqual([
      { file: "src/pricing/discount.ts", line: 88, symbol: "Object.apply", raw: "at Object.apply (src/pricing/discount.ts:88:10)", depth: 0 },
      { file: "src/checkout/cart.ts", line: 12, symbol: "Cart.total", raw: "at Cart.total (src/checkout/cart.ts:12:5)", depth: 1 },
    ]);
  });

  it("extracts a Java frame", () => {
    const frames = parseStackFrames(
      "\tat org.acme.PricingTest.testTotal(PricingTest.java:29)",
    );
    expect(frames[0]).toMatchObject({ file: "PricingTest.java", line: 29, symbol: "org.acme.PricingTest.testTotal" });
  });

  it("extracts pytest frames (both styles)", () => {
    const stack = [
      'File "/home/runner/work/shop/shop/src/pricing.py", line 42, in apply',
      "src/pricing.py:15: in test_discount",
      "src/pricing.py:15: AssertionError",
    ].join("\n");
    const frames = parseStackFrames(stack);
    expect(frames[0]).toMatchObject({ file: "src/pricing.py", line: 42, symbol: "apply" });
    expect(frames[1]).toMatchObject({ file: "src/pricing.py", line: 15, symbol: "test_discount" });
  });

  it("drops vendor frames (node_modules, site-packages, JDK, junit)", () => {
    const stack = [
      "    at real (src/x.ts:1:1)",
      "    at fake (src/y/node_modules/pkg/z.js:2:2)",
      "    at org.junit.runners.ParentRunner.run(ParentRunner.java:363)",
    ].join("\n");
    expect(parseStackFrames(stack).map((f) => f.file)).toEqual(["src/x.ts"]);
  });

  it("strips ANSI and absolute-path prefixes (drive + home dir)", () => {
    const stack = "\u001b[31m    at fn (C:/Users/x/proj/src/a.ts:5:1)\u001b[39m";
    expect(parseStackFrames(stack)[0]).toMatchObject({ file: "proj/src/a.ts", line: 5 });
  });
});

describe("parseImports", () => {
  it("finds ES imports and requires", () => {
    const src = [
      `import { apply } from "../pricing/discount";`,
      `import defaultThing from './util.js';`,
      `const x = require("./legacy");`,
    ].join("\n");
    expect(parseImports(src).sort()).toEqual(
      ["../pricing/discount", "./legacy", "./util.js"].sort(),
    );
  });

  it("finds python and php imports", () => {
    expect(parseImports("from app.pricing import discount\nimport app.util")).toContain(
      "app.pricing",
    );
    expect(parseImports("<?php\nuse App\\Pricing\\Discount;")).toContain("App\\Pricing\\Discount");
  });
});
