/**
 * github.ts — a minimal GitHub REST client for `backfill`.
 *
 * Plain `fetch`, no SDK. Honours `x-ratelimit-remaining` / `x-ratelimit-reset`
 * and `retry-after` so a 90-day backfill on a busy repo never hammers the API.
 */

import { FlakeTriageError } from "../core/errors.js";

export interface WorkflowRun {
  id: number;
  runAttempt: number;
  headSha: string;
  headBranch: string | null;
  event: string;
  conclusion: string | null;
  /** epoch ms. */
  createdAt: number;
}

export interface ArtifactMeta {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
}

export interface GithubClientOptions {
  repoSlug: string; // "owner/name"
  token?: string | undefined;
  baseUrl?: string;
  /** injectable for tests. */
  fetchImpl?: typeof fetch;
  /** sleep hook — injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = "https://api.github.com";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export class GithubApiError extends FlakeTriageError {
  readonly status: number;
  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super("GITHUB_API", message, options);
    this.status = status;
  }
}

export interface RunsPage {
  runs: WorkflowRun[];
  totalCount: number;
}

/** The subset of GithubClient that `backfill` depends on — lets tests inject a fake. */
export interface GithubApi {
  listWorkflowRunsPage(page: number, perPage?: number): Promise<RunsPage>;
  listArtifacts(runId: number): Promise<ArtifactMeta[]>;
  downloadArtifactZip(artifactId: number): Promise<Buffer>;
  getCommitParent(sha: string): Promise<string | null>;
}

export class GithubClient implements GithubApi {
  private readonly repoSlug: string;
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(opts: GithubClientOptions) {
    this.repoSlug = opts.repoSlug;
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private async request(path: string, opts: { binary?: boolean } = {}): Promise<{
    status: number;
    json?: unknown;
    buffer?: Buffer;
    headers: Headers;
  }> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      });

      if (res.status === 403 || res.status === 429) {
        const wait = retryDelayMs(res.headers);
        if (attempt < this.maxRetries && wait !== null) {
          attempt += 1;
          await this.sleep(wait);
          continue;
        }
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new GithubApiError(
          `GitHub API ${res.status} for ${path}${body ? `: ${body.slice(0, 300)}` : ""}`,
          res.status,
        );
      }

      // proactively back off when we are almost out of quota
      const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
      if (remaining <= 1) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
        const wait = reset - Date.now();
        if (wait > 0) await this.sleep(wait);
      }

      if (opts.binary) {
        return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      }
      return { status: res.status, json: await res.json(), headers: res.headers };
    }
  }

  /** One page of workflow runs, newest first. */
  async listWorkflowRunsPage(page: number, perPage = 50): Promise<RunsPage> {
    const { json } = await this.request(
      `/repos/${this.repoSlug}/actions/runs?per_page=${perPage}&page=${page}`,
    );
    const doc = json as { total_count: number; workflow_runs: RawRun[] };
    return {
      totalCount: doc.total_count,
      runs: doc.workflow_runs.map(toWorkflowRun),
    };
  }

  async listArtifacts(runId: number): Promise<ArtifactMeta[]> {
    const { json } = await this.request(
      `/repos/${this.repoSlug}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    const doc = json as { artifacts: RawArtifact[] };
    return doc.artifacts.map((a) => ({
      id: a.id,
      name: a.name,
      sizeBytes: a.size_in_bytes,
      expired: a.expired,
    }));
  }

  async downloadArtifactZip(artifactId: number): Promise<Buffer> {
    const { buffer } = await this.request(
      `/repos/${this.repoSlug}/actions/artifacts/${artifactId}/zip`,
      { binary: true },
    );
    return buffer!;
  }

  private parentCache = new Map<string, string | null>();

  /** First parent SHA of a commit, or null for a root commit. Cached. */
  async getCommitParent(sha: string): Promise<string | null> {
    const cached = this.parentCache.get(sha);
    if (cached !== undefined) return cached;
    const { json } = await this.request(`/repos/${this.repoSlug}/commits/${sha}`);
    const doc = json as { parents?: { sha: string }[] };
    const parent = doc.parents?.[0]?.sha ?? null;
    this.parentCache.set(sha, parent);
    return parent;
  }
}

function retryDelayMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) return Number(retryAfter) * 1000;
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const wait = Number(reset) * 1000 - Date.now();
    return wait > 0 ? wait : 1000;
  }
  return null;
}

interface RawRun {
  id: number;
  run_attempt?: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  conclusion: string | null;
  created_at: string;
}
interface RawArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

function toWorkflowRun(r: RawRun): WorkflowRun {
  return {
    id: r.id,
    runAttempt: r.run_attempt ?? 1,
    headSha: r.head_sha,
    headBranch: r.head_branch,
    event: r.event,
    conclusion: r.conclusion,
    createdAt: Date.parse(r.created_at),
  };
}
