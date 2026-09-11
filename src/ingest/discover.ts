/**
 * discover.ts — find JUnit report files under a root by glob.
 *
 * Dependency-free: the only patterns we need are simple (`**​/junit*.xml`,
 * `**​/TEST-*.xml`), so a small `**`/`*`/`?` matcher over a filtered directory
 * walk is enough and avoids pulling in a glob library.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DEFAULT_REPORT_GLOBS = ["**/junit*.xml", "**/TEST-*.xml"];

// Note: `build/` and `dist/` are NOT ignored — Gradle writes reports to
// `build/test-results/`.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  ".flaketriage",
]);

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` → any number of path segments (including none)
        if (glob[i + 2] === "/") {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Return absolute paths of files under `root` whose repo-relative POSIX path
 * matches any pattern. Deterministic (sorted), de-duplicated.
 */
export function discoverReports(
  root: string,
  patterns: string[] = DEFAULT_REPORT_GLOBS,
): string[] {
  const matchers = patterns.map(globToRegExp);
  const found = new Set<string>();

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(entry)) walk(abs);
      } else if (st.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (matchers.some((m) => m.test(rel))) found.add(abs);
      }
    }
  };

  walk(root);
  return [...found].sort();
}
