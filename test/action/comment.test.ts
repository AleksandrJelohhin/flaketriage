import { describe, expect, it, vi } from "vitest";

import { STICKY_MARKER } from "../../src/report/markdown.js";
import { upsertStickyComment } from "../../action/comment.js";
import type { CommentApi, MinimalIssueComment } from "../../action/comment.js";

function fakeApi(existing: MinimalIssueComment[] = []): CommentApi & {
  created: string[];
  updated: { id: number; body: string }[];
} {
  const created: string[] = [];
  const updated: { id: number; body: string }[] = [];
  let nextId = 1000;
  return {
    created,
    updated,
    listComments: vi.fn(async ({ page }) => ({
      data: page === 1 ? existing : [],
    })),
    createComment: vi.fn(async ({ body }) => {
      created.push(body);
      return { data: { id: ++nextId, html_url: `https://gh/c/${nextId}` } };
    }),
    updateComment: vi.fn(async ({ comment_id, body }) => {
      updated.push({ id: comment_id, body });
      return { data: { id: comment_id, html_url: `https://gh/c/${comment_id}` } };
    }),
  };
}

const target = { owner: "acme", repo: "app", issueNumber: 7 };
const body = `${STICKY_MARKER}\n### 🟢 FlakeTriage — no failures`;

describe("upsertStickyComment", () => {
  it("creates a comment when none carries the marker", async () => {
    const api = fakeApi([
      { id: 1, body: "unrelated review comment" },
      { id: 2, body: "LGTM" },
    ]);
    const res = await upsertStickyComment(api, target, body);
    expect(res.action).toBe("created");
    expect(api.created).toEqual([body]);
    expect(api.updated).toEqual([]);
    expect(res.url).toMatch(/^https:\/\/gh\/c\//);
  });

  it("updates the existing marked comment in place (never a second one)", async () => {
    const api = fakeApi([
      { id: 1, body: "chatter" },
      { id: 42, body: `${STICKY_MARKER}\n### 🔴 FlakeTriage — 1 failure` },
      { id: 43, body: "more chatter" },
    ]);
    const res = await upsertStickyComment(api, target, body);
    expect(res).toMatchObject({ action: "updated", commentId: 42 });
    expect(api.updated).toEqual([{ id: 42, body }]);
    expect(api.created).toEqual([]);
  });

  it("tolerates leading whitespace before the marker", async () => {
    const api = fakeApi([{ id: 9, body: `\n  ${STICKY_MARKER}\nold report` }]);
    const res = await upsertStickyComment(api, target, body);
    expect(res).toMatchObject({ action: "updated", commentId: 9 });
  });

  it("paginates until it finds the marked comment", async () => {
    const page1 = Array.from({ length: 100 }, (_v, i) => ({ id: i + 1, body: "x" }));
    const marked = { id: 555, body: `${STICKY_MARKER}\nreport` };
    const api: CommentApi = {
      listComments: vi.fn(async ({ page }) => ({
        data: page === 1 ? page1 : page === 2 ? [marked] : [],
      })),
      createComment: vi.fn(async () => ({ data: { id: 1 } })),
      updateComment: vi.fn(async ({ comment_id }) => ({ data: { id: comment_id } })),
    };
    const res = await upsertStickyComment(api, target, body);
    expect(res).toMatchObject({ action: "updated", commentId: 555 });
    expect(api.listComments).toHaveBeenCalledTimes(2);
  });
});
