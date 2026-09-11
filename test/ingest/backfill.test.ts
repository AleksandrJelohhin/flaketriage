import { describe, expect, it } from "vitest";

import { History } from "../../src/core/history.js";
import { backfill } from "../../src/ingest/backfill.js";
import type { GithubApi, RunsPage, WorkflowRun } from "../../src/ingest/github.js";

/** Build a real (STORE-method) zip in-memory, matching the on-disk format `unzip` reads. */
function buildZip(files: { name: string; content: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localHeaderOffset = offset;
    localParts.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(central, nameBuf);
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    runAttempt: 1,
    headSha: "sha1",
    headBranch: "main",
    event: "push",
    conclusion: "failure",
    createdAt: Date.now(),
    ...over,
  };
}

const junitPass = `<testsuite name="S"><testcase classname="S" name="a"/></testsuite>`;
const junitFail = `<testsuite name="S"><testcase classname="S" name="a"><failure message="boom">boom</failure></testcase></testsuite>`;

/** A fake GithubApi over an in-memory fixture: one page of runs + per-run artifacts/zips. */
class FakeGithub implements GithubApi {
  calls = { listArtifacts: 0, downloadZip: 0, listRuns: 0 };
  constructor(
    private runs: WorkflowRun[],
    private artifactsByRun: Map<number, { id: number; name: string; expired: boolean }[]>,
    private zipsByArtifact: Map<number, Buffer>,
    private parents: Map<string, string | null> = new Map(),
  ) {}

  async listWorkflowRunsPage(page: number): Promise<RunsPage> {
    this.calls.listRuns += 1;
    if (page > 1) return { runs: [], totalCount: this.runs.length };
    return { runs: this.runs, totalCount: this.runs.length };
  }
  async listArtifacts(runId: number) {
    this.calls.listArtifacts += 1;
    return (this.artifactsByRun.get(runId) ?? []).map((a) => ({ ...a, sizeBytes: 100 }));
  }
  async downloadArtifactZip(artifactId: number): Promise<Buffer> {
    this.calls.downloadZip += 1;
    return this.zipsByArtifact.get(artifactId) ?? Buffer.alloc(0);
  }
  async getCommitParent(sha: string): Promise<string | null> {
    return this.parents.get(sha) ?? null;
  }
}

describe("backfill", () => {
  it("records one run per matching artifact set, idempotently on re-run", async () => {
    const r1 = run({ id: 100, headSha: "sha100" });
    const client = new FakeGithub(
      [r1],
      new Map([[100, [{ id: 1, name: "junit-report", expired: false }]]]),
      new Map([[1, buildZip([{ name: "junit.xml", content: junitFail }])]]),
    );
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const db = join(mkdtempSync(join(tmpdir(), "ft-backfill-")), "h.db");

    const first = await backfill({ repoSlug: "acme/app", db, client });
    expect(first).toMatchObject({
      runsScanned: 1,
      runsMatched: 1,
      runsRecorded: 1,
      runsAlreadyRecorded: 0,
      resultsRecorded: 1,
      artifactsDownloaded: 1,
    });

    const second = await backfill({ repoSlug: "acme/app", db, client });
    expect(second).toMatchObject({ runsRecorded: 0, runsAlreadyRecorded: 1, artifactsDownloaded: 0 });
    expect(client.calls.downloadZip).toBe(1); // never re-downloaded on the idempotent pass
  });

  it("filters artifacts by --artifact-name glob", async () => {
    const client = new FakeGithub(
      [run({ id: 1 })],
      new Map([
        [
          1,
          [
            { id: 10, name: "coverage-report", expired: false },
            { id: 11, name: "junit-results", expired: false },
          ],
        ],
      ]),
      new Map([[11, buildZip([{ name: "r.xml", content: junitPass }])]]),
    );
    const summary = await backfill({
      repoSlug: "acme/app",
      db: ":memory:",
      client,
      artifactNameGlob: "junit*",
    });
    expect(summary.artifactsDownloaded).toBe(1);
    expect(client.calls.downloadZip).toBe(1);
  });

  it("skips expired artifacts", async () => {
    const client = new FakeGithub(
      [run({ id: 1 })],
      new Map([[1, [{ id: 10, name: "junit", expired: true }]]]),
      new Map(),
    );
    const summary = await backfill({ repoSlug: "acme/app", db: ":memory:", client });
    expect(summary.runsMatched).toBe(0);
    expect(client.calls.downloadZip).toBe(0);
  });

  it("stops at the --days window and reports lastRunId for --since resumption", async () => {
    const now = Date.now();
    const recent = run({ id: 2, createdAt: now, headSha: "recent" });
    const old = run({ id: 1, createdAt: now - 40 * 86400_000, headSha: "old" });
    const client = new FakeGithub(
      [recent, old],
      new Map([[2, [{ id: 5, name: "junit", expired: false }]]]),
      new Map([[5, buildZip([{ name: "r.xml", content: junitPass }])]]),
    );
    const summary = await backfill({ repoSlug: "acme/app", db: ":memory:", client, days: 7 });
    expect(summary.runsScanned).toBe(1); // stopped before `old`
    expect(summary.stoppedReason).toBe("window");
    expect(summary.lastRunId).toBe(2);
  });

  it("--since <run-id> skips runs at or after that id (resume)", async () => {
    const client = new FakeGithub(
      [run({ id: 5 }), run({ id: 3 })],
      new Map([[3, [{ id: 1, name: "junit", expired: false }]]]),
      new Map([[1, buildZip([{ name: "r.xml", content: junitPass }])]]),
    );
    const summary = await backfill({ repoSlug: "acme/app", db: ":memory:", client, sinceRunId: 5 });
    expect(summary.runsMatched).toBe(1); // run 5 skipped, run 3 processed
    expect(client.calls.downloadZip).toBe(1);
  });

  it("counts unparseable XML without failing the whole run", async () => {
    const client = new FakeGithub(
      [run({ id: 1 })],
      new Map([[1, [{ id: 1, name: "junit", expired: false }]]]),
      new Map([
        [
          1,
          buildZip([
            { name: "good.xml", content: junitPass },
            { name: "bad.xml", content: "<not-xml" },
          ]),
        ],
      ]),
    );
    const summary = await backfill({ repoSlug: "acme/app", db: ":memory:", client });
    expect(summary.parseFailures).toBe(1);
    expect(summary.runsRecorded).toBe(1); // the good.xml still got recorded
  });

  it("emits progress events", async () => {
    const client = new FakeGithub(
      [run({ id: 1 })],
      new Map([[1, [{ id: 1, name: "junit", expired: false }]]]),
      new Map([[1, buildZip([{ name: "r.xml", content: junitPass }])]]),
    );
    const events: string[] = [];
    await backfill({
      repoSlug: "acme/app",
      db: ":memory:",
      client,
      onProgress: (e) => events.push(e.type),
    });
    expect(events).toContain("page");
    expect(events).toContain("recorded");
  });
});

describe("backfill + History integration (file-backed db, verifies parent + real read)", () => {
  it("a recorded run is queryable through History", async () => {
    const client = new FakeGithub(
      [run({ id: 42, headSha: "child42" })],
      new Map([[42, [{ id: 7, name: "junit", expired: false }]]]),
      new Map([[7, buildZip([{ name: "r.xml", content: junitFail }])]]),
      new Map([["child42", "parent42"]]),
    );
    // backfill opens + closes its own handle; use a real temp file so we can re-open
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ft-backfill-"));
    const dbPath = join(dir, "h.db");

    await backfill({ repoSlug: "acme/app", db: dbPath, client });

    const h = History.open(dbPath);
    try {
      const matches = h.findTests("a");
      expect(matches).toHaveLength(1);
      const tl = h.timelineByTestKey(matches[0]!.testKey);
      expect(tl).toHaveLength(1);
      expect(tl[0]).toMatchObject({ commitSha: "child42", parentSha: "parent42", status: "failed" });
    } finally {
      h.close();
    }
  });
});
