import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway git repo for integration tests. */
export class TmpRepo {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static create(): TmpRepo {
    const dir = mkdtempSync(join(tmpdir(), "ft-repo-"));
    const repo = new TmpRepo(dir);
    repo.git("init", "-q", "-b", "main");
    repo.git("config", "user.email", "t@example.com");
    repo.git("config", "user.name", "Test");
    repo.git("config", "commit.gpgsign", "false");
    repo.git("config", "core.autocrlf", "false");
    repo.git("config", "core.safecrlf", "false");
    return repo;
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8" }).trim();
  }

  write(rel: string, content: string): void {
    mkdirSync(join(this.dir, rel, ".."), { recursive: true });
    writeFileSync(join(this.dir, rel), content);
  }

  /** write files, `git add -A`, commit, return the new SHA. */
  commit(message: string, files: Record<string, string> = {}): string {
    for (const [rel, content] of Object.entries(files)) this.write(rel, content);
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  setRemote(url: string): void {
    this.git("remote", "add", "origin", url);
  }
}

/** A minimal JUnit report for a single-suite set of {name: status} cases. */
export function junitXml(
  suite: string,
  cases: Record<string, "pass" | "fail" | "error" | "skip">,
  /** where the failing frame points — for blame-correlation tests. */
  frame: { file: string; line: number } = { file: `src/${suite}.js`, line: 42 },
): string {
  const body = Object.entries(cases)
    .map(([name, st]) => {
      const open = `<testcase classname="${suite}" name="${name}" time="0.1">`;
      if (st === "pass") return `${open}</testcase>`;
      if (st === "skip") return `${open}<skipped/></testcase>`;
      const tag = st === "error" ? "error" : "failure";
      return `${open}<${tag} message="${name} went ${st}" type="AssertionError">AssertionError: ${name} went ${st}
    at Object.check (${frame.file}:${frame.line}:10)</${tag}></testcase>`;
    })
    .join("\n  ");
  return `<?xml version="1.0"?>\n<testsuite name="${suite}" tests="${
    Object.keys(cases).length
  }">\n  ${body}\n</testsuite>\n`;
}
