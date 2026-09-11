import { createHash } from "node:crypto";

import { normalizeFailure } from "./normalize.js";
import type { NormalizeInput, NormalizeOptions } from "./normalize.js";

/**
 * fingerprint.ts — normalised failure  →  short stable id.
 *
 * `fingerprint = sha256(normalizedMessage + "|" + normalizedTopFrames)` truncated
 * to the first 16 hex chars.
 *
 * Two failures with the same fingerprint are treated as "the same failure". That
 * grouping is what lets the report say "this exact failure appeared 14 times
 * across 9 unrelated branches".
 */

export const FINGERPRINT_LENGTH = 16;

/** Hash an already-built canonical string (`message + "|" + frames`). */
export function fingerprintCanonical(canonical: string): string {
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

/** Normalise a raw failure and return its fingerprint. */
export function fingerprintFailure(
  input: NormalizeInput,
  opts?: NormalizeOptions,
): string {
  return fingerprintCanonical(normalizeFailure(input, opts).canonical);
}
