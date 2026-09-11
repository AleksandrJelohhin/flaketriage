/**
 * comment.ts — post or update the single sticky FlakeTriage PR comment.
 *
 * The comment is identified by the hidden marker that `renderMarkdown` puts on
 * the first line (`STICKY_MARKER`). One comment per PR, updated in place — never
 * a new comment per push.
 */

import { STICKY_MARKER } from "../src/report/markdown.js";

export interface MinimalIssueComment {
  id: number;
  body?: string | undefined;
}

/** The subset of octokit we use — lets tests pass a fake. */
export interface CommentApi {
  listComments(params: {
    owner: string;
    repo: string;
    issue_number: number;
    per_page: number;
    page: number;
  }): Promise<{ data: MinimalIssueComment[] }>;
  createComment(params: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ data: { id: number; html_url?: string } }>;
  updateComment(params: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }): Promise<{ data: { id: number; html_url?: string } }>;
}

export interface UpsertResult {
  action: "created" | "updated";
  commentId: number;
  url: string | undefined;
}

export async function upsertStickyComment(
  api: CommentApi,
  target: { owner: string; repo: string; issueNumber: number },
  body: string,
): Promise<UpsertResult> {
  const existing = await findMarkedComment(api, target);
  if (existing) {
    const { data } = await api.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: existing.id,
      body,
    });
    return { action: "updated", commentId: data.id, url: data.html_url };
  }
  const { data } = await api.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    body,
  });
  return { action: "created", commentId: data.id, url: data.html_url };
}

async function findMarkedComment(
  api: CommentApi,
  target: { owner: string; repo: string; issueNumber: number },
): Promise<MinimalIssueComment | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data } = await api.listComments({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.issueNumber,
      per_page: 100,
      page,
    });
    const hit = data.find((c) => (c.body ?? "").trimStart().startsWith(STICKY_MARKER));
    if (hit) return hit;
    if (data.length < 100) break;
  }
  return null;
}
