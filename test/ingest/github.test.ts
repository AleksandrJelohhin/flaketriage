import { describe, expect, it, vi } from "vitest";

import { GithubApiError, GithubClient } from "../../src/ingest/github.js";

function json(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("GithubClient", () => {
  it("lists workflow runs and maps snake_case → camelCase", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        total_count: 1,
        workflow_runs: [
          {
            id: 1,
            run_attempt: 2,
            head_sha: "abc",
            head_branch: "main",
            event: "push",
            conclusion: "failure",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const client = new GithubClient({ repoSlug: "acme/app", token: "t", fetchImpl });
    const page = await client.listWorkflowRunsPage(1);
    expect(page.totalCount).toBe(1);
    expect(page.runs[0]).toMatchObject({
      id: 1,
      runAttempt: 2,
      headSha: "abc",
      headBranch: "main",
      event: "push",
      conclusion: "failure",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/repos/acme/app/actions/runs?"),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer t" }) }),
    );
  });

  it("lists artifacts", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ artifacts: [{ id: 9, name: "junit-report", size_in_bytes: 100, expired: false }] }),
    );
    const client = new GithubClient({ repoSlug: "acme/app", fetchImpl });
    expect(await client.listArtifacts(1)).toEqual([
      { id: 9, name: "junit-report", sizeBytes: 100, expired: false },
    ]);
  });

  it("downloads an artifact zip as a Buffer", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const client = new GithubClient({ repoSlug: "acme/app", fetchImpl });
    const buf = await client.downloadArtifactZip(9);
    expect(Buffer.compare(buf, Buffer.from([1, 2, 3]))).toBe(0);
  });

  it("resolves and caches a commit's first parent", async () => {
    const fetchImpl = vi.fn(async () => json({ parents: [{ sha: "p1" }, { sha: "p2" }] }));
    const client = new GithubClient({ repoSlug: "acme/app", fetchImpl });
    expect(await client.getCommitParent("abc")).toBe("p1");
    expect(await client.getCommitParent("abc")).toBe("p1");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached
  });

  it("returns null parent for a root commit", async () => {
    const fetchImpl = vi.fn(async () => json({ parents: [] }));
    const client = new GithubClient({ repoSlug: "acme/app", fetchImpl });
    expect(await client.getCommitParent("root")).toBeNull();
  });

  it("throws a typed GithubApiError on a non-retryable failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const client = new GithubClient({ repoSlug: "acme/app", fetchImpl });
    await expect(client.listArtifacts(1)).rejects.toBeInstanceOf(GithubApiError);
  });

  it("retries after a 403 rate-limit response using retry-after, then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response("rate limited", { status: 403, headers: { "retry-after": "2" } });
      }
      return json({ artifacts: [] });
    });
    const sleeps: number[] = [];
    const client = new GithubClient({
      repoSlug: "acme/app",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const artifacts = await client.listArtifacts(1);
    expect(artifacts).toEqual([]);
    expect(call).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("proactively backs off when x-ratelimit-remaining hits 0/1 on a success response", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 5;
    const fetchImpl = vi.fn(async () =>
      json(
        { artifacts: [] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) } },
      ),
    );
    const sleeps: number[] = [];
    const client = new GithubClient({
      repoSlug: "acme/app",
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await client.listArtifacts(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("gives up after maxRetries and throws", async () => {
    const fetchImpl = vi.fn(async () => new Response("still limited", { status: 429, headers: { "retry-after": "0.01" } }));
    const client = new GithubClient({
      repoSlug: "acme/app",
      fetchImpl,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(client.listArtifacts(1)).rejects.toBeInstanceOf(GithubApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
