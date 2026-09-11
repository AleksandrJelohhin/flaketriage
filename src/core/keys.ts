import { createHash } from "node:crypto";

/**
 * Stable identity for a test across runs.
 *
 * Derived from suite + test name ONLY. Callers must pass a suite/name pair that
 * is already free of line numbers, timestamps and parameterised values — see
 * {@link stableSuite}. The result is a full sha256 hex digest.
 */
export function testKey(suite: string, name: string): string {
  return createHash("sha256").update(`${suite}::${name}`, "utf8").digest("hex");
}

/**
 * Canonicalise a suite identifier so the same test yields the same {@link testKey}
 * regardless of the OS the runner executed on.
 *
 * - `\` → `/` (Playwright/Jest on Windows emit `dir\file.spec.ts`)
 * - collapse repeated slashes, strip a single leading `./`
 * - trim surrounding whitespace
 *
 * Intentionally does NOT strip directories or extensions: those are signal and
 * are stable.
 */
export function stableSuite(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "");
}
