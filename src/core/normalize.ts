/**
 * normalize.ts — raw failure message + stack  →  stable canonical form.
 *
 * This is one of the three files that ARE the product. It is a pure,
 * deterministic function: no I/O, no clock, no randomness.
 *
 * The goal: two failures that are "the same failure" seen through different
 * runs — different timestamps, ports, temp dirs, object hashes, absolute paths,
 * shifted line numbers, vendor stack frames — must collapse to an identical
 * canonical string, while genuinely different failures must not.
 *
 * Ordering of the replacement passes matters (see the passes below).
 */

export interface NormalizeInput {
  /** The `message`/`type` attribute text of the <failure>/<error>, if any. */
  message?: string | null | undefined;
  /** The body text of the <failure>/<error> element (the stack / assertion dump). */
  stack?: string | null | undefined;
}

export interface NormalizeOptions {
  /**
   * Absolute path of the repo checkout. When provided, occurrences are stripped
   * so `/home/ci/proj/src/a.ts` and `D:\build\proj\src\a.ts` both become
   * `src/a.ts`. Compared case-insensitively; both `/` and `\` forms are matched.
   */
  repoRoot?: string | undefined;
  /** Max non-vendor stack frames kept in the fingerprint. */
  maxFrames?: number | undefined;
}

export interface NormalizedFailure {
  /** Canonical one-or-few-line message, volatile tokens replaced. */
  message: string;
  /** Up to `maxFrames` normalised, non-vendor frames, most-recent-call first. */
  frames: string[];
  /**
   * The exact string that gets hashed into a fingerprint:
   * `message + "|" + frames.join("\n")`.
   */
  canonical: string;
}

const DEFAULT_MAX_FRAMES = 5;

// ── token patterns ────────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// Box-drawing / rule runs Playwright and others print around banners.
const RULE_RUN = /[\u2500-\u257F\u2580-\u259F\u2014\u2015=_*.\u00b7\u2022\u2013]{4,}/g;
const ISO_TIME =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const EPOCH_MS = /\b\d{13}\b/g;
const UUID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const WIN_TEMP =
  /[A-Za-z]:\\(?:Users\\[^\\/\r\n]+\\AppData\\Local\\Temp|Windows\\Temp|Temp)\\[^\s"'()\]]*/gi;
const NIX_TEMP = /(?:\/private)?\/(?:tmp|var\/folders\/[^\s"':]+|var\/tmp)\/[^\s"':()\]]*/g;
// Known CI checkout roots — strip the root, keep the repo-relative tail.
const CI_ROOTS = [
  /\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g, // GitHub Actions (linux/mac)
  /[A-Za-z]:\\a\\[^\\/\s]+\\[^\\/\s]+\\/g, // GitHub Actions (windows: D:\a\repo\repo\)
  /\/github\/workspace\//g,
  /\/builds\/[^/\s]+\/[^/\s]+\//g, // GitLab CI
  /\/__w\/[^/\s]+\/[^/\s]+\//g, // GitHub Actions container
];
// Absolute paths: keep only the basename — the checkout location is volatile,
// the filename is signal. `C:\a\b\Foo.spec.js` -> `Foo.spec.js`.
const WIN_ABS = /[A-Za-z]:\\(?:[^\s"'()\]:*?<>|\\]+\\)+([^\s"'()\]:*?<>|\\]+)/g;
const NIX_ABS =
  /(?<![\w.])\/(?:usr|opt|home|Users|root|app|workspace|srv|private|mnt)\/(?:[^\s"':()\]/]+\/)+([^\s"':()\]/]+)/g;
const HEX_0X = /\b0x[0-9a-fA-F]{4,}\b/g;
// bare hex blob: >=7 chars, has a letter AND a digit (skips pure decimals & words)
const HEX_BARE = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,}\b/gi;
// `:1234` only where it is genuinely a network port: after `//host`, `localhost`,
// an IPv4/IPv6 literal. NOT after a bare `file.ext` (that's a line number).
const HOSTPORT =
  /(\/\/[a-z0-9._-]+|(?<![\w.])localhost|(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):\d{2,5}\b/gi;
// URL credentials: `http://user:pass@host` → `http://<CRED>@host`
const URL_CRED = /(\/\/)[^/\s:@]+:[^/\s:@]+@/g;

// A stack frame we should discard entirely (vendor / runtime noise).
const VENDOR_FRAME =
  /node_modules[\\/]|[\\/](?:site-packages|dist-packages)[\\/]|\bat (?:java|javax|jdk|sun|com\.sun|scala|kotlin)\.|\b(?:org\.junit|org\.testng|org\.gradle|org\.apache\.maven\.surefire|jdk\.internal|java\.base\/|org\.hamcrest|org\.mockito)|internal\/(?:process|modules)\/|node:internal|\bat new Promise \(<anonymous>\)|\bat Promise\.|\bReflectionMethod\b|<frozen |\/usr\/lib\/python|_pytest[\\/]/;

// ── scalar-token normalisation ────────────────────────────────────────────────

function replaceTokens(text: string, opts: NormalizeOptions): string {
  let s = text.replace(ANSI, "");

  if (opts.repoRoot) {
    for (const variant of repoRootVariants(opts.repoRoot)) {
      s = s.split(variant).join("");
    }
  }

  s = s.replace(ISO_TIME, "<TIME>").replace(EPOCH_MS, "<TIME>");
  s = s.replace(UUID, "<UUID>");
  s = s.replace(WIN_TEMP, "<TMP>").replace(NIX_TEMP, "<TMP>");
  for (const re of CI_ROOTS) s = s.replace(re, "");
  s = s.replace(WIN_ABS, "$1").replace(NIX_ABS, "$1");
  s = s.replace(HEX_0X, "<HEX>").replace(HEX_BARE, "<HEX>");
  s = s.replace(URL_CRED, "$1<CRED>@");
  s = s.replace(HOSTPORT, (_m, host: string) => `${host}:<PORT>`);
  // perf-metric durations (k6, gotestsum, load tests) — volatile, not signal
  s = s.replace(/\b\d+m\d+(?:\.\d+)?s\b/g, "<DUR>"); // go "3m2s"
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms)\b/g, "<DUR>");
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:secs?|seconds?)\b/g, "<DUR>");
  s = s.replace(/\bp\(\d{1,3}(?:\.\d+)?\)/g, "p(<N>)");
  s = s.replace(RULE_RUN, " ");

  return s;
}

function repoRootVariants(root: string): string[] {
  const trimmed = root.replace(/[\\/]+$/, "");
  const fwd = trimmed.replace(/\\/g, "/");
  const back = trimmed.replace(/\//g, "\\");
  const set = new Set<string>();
  for (const base of [fwd, back]) {
    set.add(base + "/");
    set.add(base + "\\");
  }
  return [...set];
}

function squishLine(line: string): string {
  return line.replace(/[ \t\u00a0]+/g, " ").trim();
}

// ── message normalisation ─────────────────────────────────────────────────────

/**
 * Reduce a failure message to its stable core.
 *
 * pytest dumps the whole assertion rewrite into `message`; we keep the lines
 * that carry the actual error (`E   AssertionError: ...`) and drop the source
 * echo. For everything else we keep the first meaningful lines.
 */
export function normalizeMessage(raw: string, opts: NormalizeOptions = {}): string {
  const replaced = replaceTokens(raw, opts);
  const lines = replaced
    .split(/\r?\n/)
    .map(squishLine)
    .filter((l) => l.length > 0);

  if (lines.length === 0) return "";

  // pytest / unittest style: prefer the `E   ...` error lines when present.
  const eLines = lines
    .filter((l) => /^E\s+\S/.test(l))
    .map((l) => l.replace(/^E\s+/, ""));
  const picked = eLines.length > 0 ? eLines : lines;

  // Drop a leading Playwright banner line: "[chromium] › file › title"
  const cleaned = picked.filter(
    (l) => !/^\[[^\]]+\]\s*›/.test(l) && !/^›/.test(l),
  );
  const finalLines = (cleaned.length > 0 ? cleaned : picked).slice(0, 4);

  return finalLines.join("\n").trim();
}

// ── stack-frame normalisation ────────────────────────────────────────────────

const DRIVE = "(?:[A-Za-z]:[\\\\/])?"; // optional leading Windows drive
const FRAME_MATCHERS: RegExp[] = [
  /^\s*at\s+\S/, // JS / Java / .NET / Kotlin
  /^\s*File\s+".+",\s+line\s+\d+/, // Python "File "x", line N"
  new RegExp(`^\\s*${DRIVE}[\\w./\\\\-]+\\.[A-Za-z]{1,5}:\\d+:(?:\\s|$)`), // "x.py:12: in fn" / "x.py:15: AssertionError"
  new RegExp(`^\\s*#?\\s*${DRIVE}[\\w./\\\\-]+\\.rb:\\d+:in\\s+`), // ruby "x.rb:3:in `m'"
  new RegExp(`^\\s*${DRIVE}[\\w./\\\\-]+\\.php:\\d+$`), // phpunit "x.php:42"
  new RegExp(`^\\s*${DRIVE}[\\w./\\\\-]+_test\\.go:\\d+`), // go "x_test.go:12"
];

function looksLikeFrame(line: string): boolean {
  return FRAME_MATCHERS.some((re) => re.test(line));
}

/** Strip `:line[:col]`, OS path separators and trailing arrow markers from one frame. */
export function normalizeFrame(rawFrame: string, opts: NormalizeOptions = {}): string {
  let f = squishLine(replaceTokens(rawFrame, opts));

  // "File "x", line 5, in fn"  ->  "at fn (x)"
  f = f.replace(
    /^File\s+"(.+?)",\s+line\s+\d+(?:,\s+in\s+(\S+))?.*$/,
    (_m, file: string, fn?: string) => (fn ? `at ${fn} (${file})` : `at ${file}`),
  );
  // pytest "path.py:12: in fn"        -> "at fn (path.py)"
  f = f.replace(/^#?\s*([\w./\\-]+\.\w+):\d+:\s*in\s+(\S+).*$/, "at $2 ($1)");
  // pytest "path.py:15: SomeError"    -> "at path.py (SomeError)"
  f = f.replace(/^([\w./\\-]+\.\w+):\d+:\s*([A-Za-z][\w.]*Error|[A-Za-z][\w.]*Exception)\b.*$/, "at $1 ($2)");
  // pytest bare "path.py:15:"         -> "at path.py"
  f = f.replace(/^([\w./\\-]+\.\w+):\d+:?\s*$/, "at $1");
  // ruby "x.rb:3:in `meth'"           -> "at meth (x.rb)"
  f = f.replace(/^#?\s*([\w./\\-]+\.rb):\d+:in\s+[`']?([^'"]+?)['"]?$/, "at $2 ($1)");

  // drop surviving :line:col — after a file extension, or after a placeholder
  f = f.replace(/(\.[A-Za-z]{1,6}|<PATH>|<TMP>)(?::\d+){1,2}\b/g, "$1");
  // normalise OS path separators inside the frame for cross-OS stability
  f = f.replace(/\\(?=[\w.])/g, "/").replace(/(^|\()\.\.?\//g, "$1");
  // trailing Playwright "› title" / box-rule junk (only a dash *run*, not a lone ">")
  f = f.replace(/\s+›.*$/, "").replace(/\s*[-—]{2,}>?\s*$/, "");
  return squishLine(f);
}

/**
 * Pull the first `maxFrames` non-vendor frames out of a stack dump, normalised.
 */
export function extractFrames(
  stack: string,
  opts: NormalizeOptions = {},
): string[] {
  const max = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const out: string[] = [];
  for (const rawLine of stack.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    if (!looksLikeFrame(line)) continue;
    if (VENDOR_FRAME.test(line)) continue;
    const norm = normalizeFrame(line, opts);
    if (norm.length === 0) continue;
    if (out.length > 0 && out[out.length - 1] === norm) continue; // dedupe repeats
    out.push(norm);
    if (out.length >= max) break;
  }
  return out;
}

// ── top-level entry point ────────────────────────────────────────────────────

/**
 * A "weak" message carries no error information — it is just a source location
 * or test title. Playwright's `<failure message>` is `file:line:col  test title`,
 * which differs for every test even when the underlying failure is identical
 * (e.g. the dev server is down). In that case the real error lives in the body.
 */
function isWeakMessage(m: string): boolean {
  if (m.length === 0) return true;
  const first = m.split(/\r?\n/, 1)[0]!.trim();
  return (
    /^[\w.\-/\\]+\.[a-z0-9]+:\d+(?::\d+)?\s/i.test(first) || // "spec.ts:29:3 title"
    /^[\w.\-/\\]+\.[a-z0-9]+:\d+(?::\d+)?$/i.test(first) // bare "spec.ts:29:3"
  );
}

/** First body line that reads like an actual error, skipping frames/echoes/banners. */
function firstErrorLine(body: string): string {
  const lines = body.split(/\r?\n/).map((l) => l.replace(ANSI, ""));
  const candidates = lines.filter(
    (l) =>
      l.trim().length > 0 &&
      !looksLikeFrame(l) &&
      !/^\s*[|>]/.test(l) && // pytest/jest code-echo gutter
      !/^\s*\d+\s*[|]/.test(l) && // numbered code frame
      !/^\[[^\]]+\]\s*›/.test(l) &&
      !/^\s*›/.test(l) &&
      !/^[\s\-—_=~.·•*]+$/.test(l), // rule / separator line
  );
  const strong = candidates.find((l) =>
    /(?:^|\b)(?:[A-Z]\w*(?:Error|Exception)|assert|expect\(|expected |unexpected |timeout|timed out|net::|ECONN|ETIMEDOUT|not found|failed)\b/i.test(
      l,
    ),
  );
  return (strong ?? candidates[0] ?? "").trim();
}

export function normalizeFailure(
  input: NormalizeInput,
  opts: NormalizeOptions = {},
): NormalizedFailure {
  const rawMessage = (input.message ?? "").trim();
  const rawStack = (input.stack ?? "").trim();

  // Pick the most informative message source:
  //  - a real `message` attribute wins
  //  - otherwise (empty or a bare source-location) fall back to the body's first
  //    error-looking line, then the body's non-frame lines
  let messageSource: string;
  if (rawMessage.length > 0 && !isWeakMessage(rawMessage)) {
    messageSource = rawMessage;
  } else if (rawStack.length > 0) {
    messageSource =
      firstErrorLine(rawStack) ||
      rawStack
        .split(/\r?\n/)
        .filter((l) => !looksLikeFrame(l))
        .join("\n");
  } else {
    messageSource = rawMessage;
  }

  const message = normalizeMessage(messageSource, opts);
  const frames = extractFrames(rawStack.length > 0 ? rawStack : rawMessage, opts);
  const canonical = `${message}|${frames.join("\n")}`;

  return { message, frames, canonical };
}
