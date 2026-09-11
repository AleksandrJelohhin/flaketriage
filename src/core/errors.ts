/**
 * Typed errors for the pure core + ingest layers.
 *
 * Convention: `core/` throws these; only the CLI boundary catches and
 * formats them. Never swallow them deeper in the pipeline.
 */

export type FlakeTriageErrorCode =
  | "JUNIT_PARSE"
  | "JUNIT_EMPTY"
  | "CONFIG_INVALID"
  | "HISTORY_IO"
  | "GIT_CONTEXT"
  | "NO_REPORTS"
  | "LLM_FAILURE"
  | "GITHUB_API";

export class FlakeTriageError extends Error {
  readonly code: FlakeTriageErrorCode;

  constructor(code: FlakeTriageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Raised when a JUnit report cannot be parsed as XML or is not a JUnit document. */
export class JUnitParseError extends FlakeTriageError {
  /** Path or label of the offending report, when known. */
  readonly source: string | undefined;

  constructor(message: string, options?: { cause?: unknown; source?: string }) {
    super("JUNIT_PARSE", message, options);
    this.source = options?.source;
  }
}

/** Raised when git metadata for a run cannot be resolved. */
export class GitContextError extends FlakeTriageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("GIT_CONTEXT", message, options);
  }
}

/** Raised when the history store cannot be opened or written. */
export class HistoryError extends FlakeTriageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("HISTORY_IO", message, options);
  }
}

/** Raised when the LLM escalation layer fails (network, auth, unparseable output, guardrail). */
export class LlmError extends FlakeTriageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("LLM_FAILURE", message, options);
  }
}
