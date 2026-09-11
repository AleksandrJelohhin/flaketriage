/**
 * junit.ts — JUnit / xUnit XML  →  TestResult[]
 *
 * Handles the shapes seen across the real-report corpus (test/fixtures/real):
 *  - root `<testsuites>` wrapper OR a bare `<testsuite>` root
 *  - arbitrarily nested `<testsuite>` elements
 *  - `<testcase>` with `<failure>` / `<error>` / `<skipped>` (attr message + body)
 *  - Surefire rerun markers `<flakyFailure>` / `<rerunFailure>` / `<flakyError>` /
 *    `<rerunError>` — captured as `retries`, not as the primary status
 *  - messy bodies: unescaped `<`, CDATA, ANSI, box-drawing, XML entities
 *
 * Pure w.r.t. I/O: {@link parseJUnitXml} takes a string. {@link parseJUnitFile}
 * is the thin fs wrapper for the CLI/tests.
 */

import { readFileSync } from "node:fs";

import { XMLParser } from "fast-xml-parser";

import { JUnitParseError } from "../core/errors.js";
import { stableSuite, testKey } from "../core/keys.js";

export type TestStatus = "passed" | "failed" | "error" | "skipped";

export interface Failure {
  /** `message` attribute (or `type` when message is absent). */
  message: string | null;
  /** `type` attribute, e.g. `java.lang.AssertionError`, `AssertionError`. */
  type: string | null;
  /** Element body text: the stack / assertion dump, entity-decoded, CDATA-unwrapped. */
  stack: string | null;
}

export interface TestResult {
  /** Stable suite id: `classname` when present, else the nearest `<testsuite name>`. */
  suite: string;
  /** Test name / title as reported. */
  name: string;
  /** `sha256(suite + "::" + name)` — stable across runs. */
  testKey: string;
  status: TestStatus;
  durationMs: number | null;
  /** `<testcase file="...">` when present (Playwright, pytest, some Gradle). */
  file: string | null;
  /** Primary failure/error. `null` when passed or skipped. */
  failure: Failure | null;
  /** Reason text from `<skipped>`. `null` unless status is `skipped`. */
  skipReason: string | null;
  /**
   * Failures from earlier attempts of the SAME run (Surefire `<flakyFailure>` /
   * `<rerunFailure>` …). Non-empty here is a strong in-run flake signal that the
   * classifier consumes. Does not affect `status`.
   */
  retries: Failure[];
}

export interface ParsedReport {
  results: TestResult[];
  /** Suite-level `<system-out>` / `<properties>` are ignored for now. */
}

const FAILURE_TAGS = ["failure", "error"] as const;
const RETRY_TAGS = [
  "flakyFailure",
  "flakyError",
  "rerunFailure",
  "rerunError",
] as const;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false, // preserve stack-trace indentation
  parseAttributeValue: false,
  parseTagValue: false,
  cdataPropName: "#cdata",
  // Treat failure/error bodies as opaque text so unescaped `<` in a stack trace
  // cannot break the parse.
  stopNodes: [
    "*.failure",
    "*.error",
    "*.flakyFailure",
    "*.flakyError",
    "*.rerunFailure",
    "*.rerunError",
    "*.system-out",
    "*.system-err",
  ],
  isArray: (name) =>
    ["testsuite", "testcase", "failure", "error", ...RETRY_TAGS].includes(name),
});

// ── xml value helpers ────────────────────────────────────────────────────────

type XmlNode = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function attr(node: XmlNode | undefined, key: string): string | null {
  if (!node) return null;
  const v = node[`@_${key}`];
  if (v === undefined || v === null) return null;
  return String(v);
}

const XML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#10;": "\n",
  "&#13;": "\r",
  "&#9;": "\t",
  "&amp;": "&", // must be last
};

function decodeEntities(s: string): string {
  let out = s.replace(/&#(\d+);/g, (_m, d: string) =>
    String.fromCodePoint(Number(d)),
  );
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) =>
    String.fromCodePoint(parseInt(h, 16)),
  );
  for (const [ent, ch] of Object.entries(XML_ENTITIES)) {
    out = out.split(ent).join(ch);
  }
  return out;
}

/** Extract text from a stopNode value (string) or a mixed node with #text/#cdata. */
function bodyText(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  let text: string;
  if (typeof raw === "string") {
    text = decodeEntities(raw);
  } else if (typeof raw === "object") {
    const node = raw as XmlNode;
    const parts: string[] = [];
    if (typeof node["#text"] === "string") parts.push(decodeEntities(node["#text"]));
    if (typeof node["#cdata"] === "string") parts.push(node["#cdata"] as string);
    for (const c of asArray(node["#cdata"])) {
      if (typeof c === "string" && !parts.includes(c)) parts.push(c);
    }
    text = parts.join("\n");
  } else {
    text = String(raw);
  }
  // Some runners (Maven Surefire) put the trace in a nested <stackTrace> child
  // and tack on <system-out>/<system-err>; since we read the element as raw text
  // those tags come through literally. Strip that scaffolding.
  text = text
    .replace(/<\/?stackTrace>/gi, "")
    .replace(/<system-(?:out|err)>[\s\S]*?<\/system-(?:out|err)>/gi, "")
    .replace(/<system-(?:out|err)\s*\/>/gi, "");
  // unwrap any CDATA sections that survived the stopNode read
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  text = text.replace(/^\s*<!\[CDATA\[/i, "").replace(/\]\]>\s*$/i, "");
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimeToMs(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw.trim().replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

// ── failure extraction ───────────────────────────────────────────────────────

function toFailure(node: unknown): Failure {
  const obj = (typeof node === "object" && node !== null ? node : {}) as XmlNode;
  const message = attr(obj, "message");
  const type = attr(obj, "type");
  const stack = bodyText(node);
  return {
    message: message ?? (stack ? null : type),
    type,
    stack,
  };
}

function collectFailures(testcase: XmlNode, tags: readonly string[]): Failure[] {
  const out: Failure[] = [];
  for (const tag of tags) {
    for (const n of asArray(testcase[tag])) {
      const f = toFailure(n);
      if (f.message || f.stack || f.type) out.push(f);
    }
  }
  return out;
}

// ── suite walk ───────────────────────────────────────────────────────────────

interface WalkCtx {
  results: TestResult[];
}

function walkSuite(suite: XmlNode, inheritedName: string | null, ctx: WalkCtx): void {
  const suiteName = attr(suite, "name") ?? inheritedName;

  for (const tc of asArray(suite["testcase"])) {
    if (typeof tc !== "object" || tc === null) continue;
    ctx.results.push(toTestResult(tc as XmlNode, suiteName));
  }

  // nested <testsuite> (EnricoMi testsuite-in-testsuite, Gradle aggregates)
  for (const child of asArray(suite["testsuite"])) {
    if (typeof child === "object" && child !== null) {
      walkSuite(child as XmlNode, suiteName, ctx);
    }
  }
}

function toTestResult(tc: XmlNode, suiteName: string | null): TestResult {
  const name = (attr(tc, "name") ?? "").trim() || "<unnamed>";
  const classname = attr(tc, "classname")?.trim() || null;
  const suite = stableSuite(classname || suiteName || "<unknown-suite>");

  const failures = collectFailures(tc, FAILURE_TAGS);
  const retries = collectFailures(tc, RETRY_TAGS);
  const skipped = "skipped" in tc;

  let status: TestStatus;
  let failure: Failure | null = null;
  let skipReason: string | null = null;

  const hasError = asArray(tc["error"]).length > 0;
  const hasFailure = asArray(tc["failure"]).length > 0;

  if (hasError) {
    status = "error";
    failure = failures.find((f) => f.type !== null || f.stack !== null) ?? failures[0] ?? null;
  } else if (hasFailure) {
    status = "failed";
    failure = failures[0] ?? null;
  } else if (skipped) {
    status = "skipped";
    skipReason =
      bodyText(tc["skipped"]) ??
      attr(tc["skipped"] as XmlNode | undefined, "message") ??
      "skipped";
  } else {
    status = "passed";
  }

  // A testcase carrying only rerun/flaky markers passed on retry.
  if (status === "passed" && retries.length > 0) {
    // keep status "passed" — retries array carries the flake evidence
  }

  return {
    suite,
    name,
    testKey: testKey(suite, name),
    status,
    durationMs: parseTimeToMs(attr(tc, "time")),
    file: attr(tc, "file"),
    failure,
    skipReason,
    retries,
  };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Parse one JUnit XML document. `source` is used only for error messages.
 * Throws {@link JUnitParseError} on malformed XML or a non-JUnit document.
 */
export function parseJUnitXml(xml: string, source?: string): TestResult[] {
  if (xml.trim().length === 0) {
    throw new JUnitParseError("empty report", { source: source ?? "" });
  }

  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (cause) {
    throw new JUnitParseError("malformed XML", { cause, source: source ?? "" });
  }

  const root = doc as XmlNode;
  const suites: XmlNode[] = [];

  for (const s of asArray(root["testsuites"])) {
    if (typeof s === "object" && s !== null) {
      const wrapper = s as XmlNode;
      for (const inner of asArray(wrapper["testsuite"])) {
        if (typeof inner === "object" && inner !== null) suites.push(inner as XmlNode);
      }
      // <testsuites> with direct <testcase> children (rare, but seen)
      if (asArray(wrapper["testcase"]).length > 0) suites.push(wrapper);
    }
  }
  for (const s of asArray(root["testsuite"])) {
    if (typeof s === "object" && s !== null) suites.push(s as XmlNode);
  }

  if (suites.length === 0) {
    throw new JUnitParseError(
      "no <testsuite> found — not a JUnit XML report",
      { source: source ?? "" },
    );
  }

  const ctx: WalkCtx = { results: [] };
  for (const suite of suites) walkSuite(suite, null, ctx);
  return ctx.results;
}

/** Read + parse a JUnit XML file from disk (UTF-8). */
export function parseJUnitFile(path: string): TestResult[] {
  let xml: string;
  try {
    xml = readFileSync(path, "utf8");
  } catch (cause) {
    throw new JUnitParseError(`cannot read report: ${path}`, { cause, source: path });
  }
  // strip a UTF-8 BOM if present
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  return parseJUnitXml(xml, path);
}
