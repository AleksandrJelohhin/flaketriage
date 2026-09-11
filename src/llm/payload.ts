/**
 * payload.ts — the Data Boundary: secrets never leave
 * this machine in an LLM request.
 *
 * `redact()` is applied to the *exact* payload handed to the model in
 * `llm/triage.ts`, and to the identical payload `--print-payload` prints — the
 * preview shows precisely what left, not a separate approximation of it. Pure:
 * no I/O, no network, no clock.
 */

const REDACTED = "[REDACTED]";

/**
 * Patterns for the secret shapes most likely to appear in a stack trace, log
 * line, or env dump that ends up inside a failure message: bearer tokens,
 * password/secret assignments, AWS access keys, PEM private key blocks, and
 * the common vendor API-key prefixes (Anthropic, OpenAI, GitHub, Google, Slack).
 */
export const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-_.=]+/gi,
  /(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{30,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

/**
 * Redact every match of every default pattern, plus any `extraPatterns` (e.g.
 * from `.flaketriage.yml`'s `redact.patterns`), in `text`.
 */
export function redact(text: string, extraPatterns: RegExp[] = []): string {
  let out = text;
  for (const pattern of [...DEFAULT_REDACT_PATTERNS, ...extraPatterns]) {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    out = out.replace(global, REDACTED);
  }
  return out;
}

/** Compile `.flaketriage.yml`'s `redact.patterns` (regex source strings) once. */
export function compilePatterns(sources: string[]): RegExp[] {
  return sources.map((source) => new RegExp(source, "gi"));
}
