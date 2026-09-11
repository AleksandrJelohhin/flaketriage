/**
 * blame.ts — correlate a failing stack trace with the files this PR changed.
 *
 * This is the differentiator: the thing that lets FlakeTriage say
 * "frame 2 points at a line you changed in this PR" instead of guessing. It is
 * one of the four files that ARE the product.
 *
 * Pure: no I/O, no clock. `correlate` takes stack frames and diff hunks that the
 * caller has already gathered. `imported_by` needs to read source files to parse
 * their imports — that read happens in the caller, which passes the result in
 * via {@link CorrelateOptions.importsOf}. {@link parseImports} (pure, takes text)
 * does the parsing.
 */

export interface StackFrame {
  /** repo-relative-ish source path (vendor frames already excluded). */
  file: string;
  /** 1-based line in `file`, or null when the runner didn't give one. */
  line: number | null;
  /** function / method name, when the runner included it. */
  symbol: string | null;
  /** the original stack line, for `explain`. */
  raw: string;
  /** 0-based position in the (non-vendor) stack; frame 0 is the failure site. */
  depth: number;
}

export interface DiffHunk {
  /** repo-relative new-file path. */
  file: string;
  /** first line of the hunk in the new file (1-based). */
  newStart: number;
  /** number of lines the hunk spans in the new file. */
  newLines: number;
  /** new-file line numbers that were added or modified in this hunk. */
  changedLines: readonly number[];
}

export type Proximity = "exact_line" | "same_hunk" | "same_file" | "imported_by";

export interface BlameLink {
  frame: StackFrame;
  /** the changed file this frame is linked to. */
  changedFile: string;
  proximity: Proximity;
  /** 0..1 — see the proximity → confidence table in the module doc. */
  confidence: number;
}

export interface CorrelateOptions {
  /**
   * `file → the repo-relative files it statically imports` (one level only).
   * The caller resolves `parseImports` output to real paths. Omit to skip the
   * `imported_by` rule.
   */
  importsOf?: (file: string) => string[];
  /** how close to a hunk still counts as `same_hunk`. Default 5 lines. */
  hunkRadius?: number;
}

const CONFIDENCE: Record<Proximity, number> = {
  exact_line: 0.95,
  same_hunk: 0.8,
  same_file: 0.5,
  imported_by: 0.3,
};

const DEFAULT_HUNK_RADIUS = 5;

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** True when two repo-relative paths refer to the same file (suffix match both ways). */
function samePath(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
}

/**
 * Correlate stack frames with diff hunks, strongest link first. An empty result
 * is valid and common — do not read a regression into a test that simply broke.
 */
export function correlate(
  stack: StackFrame[],
  diff: DiffHunk[],
  opts: CorrelateOptions = {},
): BlameLink[] {
  const radius = opts.hunkRadius ?? DEFAULT_HUNK_RADIUS;
  const links: BlameLink[] = [];
  const changedFiles = [...new Set(diff.map((h) => h.file))];

  for (const frame of stack) {
    const hunksInFile = diff.filter((h) => samePath(h.file, frame.file));

    // exact_line / same_hunk — need a line number
    if (frame.line !== null && hunksInFile.length > 0) {
      let best: Proximity | null = null;
      let bestFile = "";
      for (const h of hunksInFile) {
        if (h.changedLines.includes(frame.line)) {
          best = "exact_line";
          bestFile = h.file;
          break;
        }
        const near =
          frame.line >= h.newStart - radius &&
          frame.line <= h.newStart + h.newLines + radius;
        if (near && best === null) {
          best = "same_hunk";
          bestFile = h.file;
        }
      }
      if (best) {
        links.push({ frame, changedFile: bestFile, proximity: best, confidence: CONFIDENCE[best] });
        continue;
      }
    }

    // same_file — frame is in a changed file, just not near a hunk
    const inChangedFile = changedFiles.find((cf) => samePath(cf, frame.file));
    if (inChangedFile) {
      links.push({
        frame,
        changedFile: inChangedFile,
        proximity: "same_file",
        confidence: CONFIDENCE.same_file,
      });
      continue;
    }

    // imported_by — frame's file imports a changed file (one level)
    if (opts.importsOf) {
      const imports = opts.importsOf(frame.file) ?? [];
      const hit = changedFiles.find((cf) => imports.some((imp) => samePath(imp, cf)));
      if (hit) {
        links.push({
          frame,
          changedFile: hit,
          proximity: "imported_by",
          confidence: CONFIDENCE.imported_by,
        });
      }
    }
  }

  return links.sort(
    (a, b) => b.confidence - a.confidence || a.frame.depth - b.frame.depth,
  );
}

// ── stack frame parsing ──────────────────────────────────────────────────────

const VENDOR =
  /node_modules[\\/]|[\\/](?:site-packages|dist-packages)[\\/]|\b(?:java|javax|jdk|sun|scala|kotlin)\.|jdk\.internal|java\.base\/|\borg\.(?:junit|testng|gradle|apache\.maven\.surefire|hamcrest|mockito)\b|node:internal|internal\/(?:process|modules)\/|<frozen |\/usr\/lib\/python|_pytest[\\/]|\bat new Promise \(<anonymous>\)/;

const FRAME_PATTERNS: { re: RegExp; file: number; line: number; symbol: number | null }[] = [
  // JS / TS:  at fn (path/to/file.ts:12:5)   |   at path/to/file.ts:12:5
  { re: /^\s*at\s+(?:async\s+)?(.+?)\s+\(([^()]+?):(\d+)(?::\d+)?\)\s*$/, symbol: 1, file: 2, line: 3 },
  { re: /^\s*at\s+([^\s()]+?):(\d+)(?::\d+)?\s*$/, symbol: null, file: 1, line: 2 },
  // Java / Kotlin:  at pkg.Class.method(File.java:42)
  { re: /^\s*at\s+([\w$.]+)\(([\w$]+\.\w+):(\d+)\)\s*$/, symbol: 1, file: 2, line: 3 },
  // Python:  File "path/x.py", line 42, in fn
  { re: /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/, file: 1, line: 2, symbol: 3 },
  // pytest short:  path/x.py:42: in fn
  { re: /^\s*([\w./\\-]+\.\w+):(\d+):\s*in\s+(\S+)/, file: 1, line: 2, symbol: 3 },
  // pytest final:  path/x.py:42: SomeError
  { re: /^\s*([\w./\\-]+\.\w+):(\d+):\s*[A-Z]/, file: 1, line: 2, symbol: null },
  // ruby:  path/x.rb:3:in `meth'
  { re: /^\s*([\w./\\-]+\.rb):(\d+):in\s+[`']?([^'"]+)/, file: 1, line: 2, symbol: 3 },
  // go:  path/x_test.go:12
  { re: /(?:^|\s)([\w./\\-]+\.go):(\d+)/, file: 1, line: 2, symbol: null },
  // playwright code-frame header:  at ..\pages\Foo.ts:10
  { re: /^\s*at\s+([.\w/\\-]+\.\w+):(\d+)\s*$/, symbol: null, file: 1, line: 2 },
];

/**
 * Extract source frames (with line numbers) from a raw stack trace, most-recent
 * call first, vendor frames dropped. Unlike the fingerprint frames in
 * `normalize.ts`, these KEEP line numbers — blame needs them.
 */
export function parseStackFrames(stack: string, opts: { max?: number } = {}): StackFrame[] {
  const max = opts.max ?? 12;
  const out: StackFrame[] = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.replace(/\[[0-9;]*[A-Za-z]/g, "");
    if (VENDOR.test(line)) continue;
    for (const p of FRAME_PATTERNS) {
      const m = line.match(p.re);
      if (!m) continue;
      let file = (m[p.file] ?? "").trim().replace(/\\/g, "/").replace(/^(?:\.\.\/)+/, "");
      // strip common absolute prefixes; `samePath` does suffix matching for the rest
      file = file
        .replace(/^[A-Za-z]:\//, "")
        .replace(/^\/?home\/runner\/work\/[^/]+\/[^/]+\//, "") // GH Actions (linux/mac)
        .replace(/^\/?(?:github\/workspace|__w\/[^/]+\/[^/]+)\//, "") // GH Actions (container)
        .replace(/^[A-Za-z]:\/a\/[^/]+\/[^/]+\//, "") // GH Actions (windows)
        .replace(/^\/?(?:home|Users)\/[^/]+\//, "") // user home dir
        .replace(/^\//, "");
      if (!file || !/\.\w+$/.test(file)) break;
      const lineNo = p.line ? Number(m[p.line]) : NaN;
      out.push({
        file,
        line: Number.isFinite(lineNo) ? lineNo : null,
        symbol: p.symbol !== null ? (m[p.symbol]?.trim() ?? null) : null,
        raw: rawLine.trim(),
        depth: out.length,
      });
      break;
    }
    if (out.length >= max) break;
  }
  return out;
}

// ── import parsing (pure; caller resolves paths + reads files) ────────────────

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:[\w*{},\s]+\s+from\s+)?["']([^"']+)["']/g, // ES import ... from "x"
  /\brequire\(\s*["']([^"']+)["']\s*\)/g, // CJS require("x")
  /\bfrom\s+([\w.]+)\s+import\b/g, // python: from x import y
  /^\s*import\s+([\w.]+)\s*;?\s*$/gm, // python/java: import x  (bare, not `import x from`)
  /\buse\s+([\w\\]+)\s*;/g, // php: use X\Y;
];

/**
 * Best-effort list of module specifiers a source file imports. Returns the raw
 * specifiers (`./foo`, `../pricing/discount`, `app.models.user`, `pkg/sub`) —
 * the caller resolves them against the repo.
 */
export function parseImports(source: string): string[] {
  const specs = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const s = m[1]?.trim();
      if (s) specs.add(s);
    }
  }
  return [...specs];
}
