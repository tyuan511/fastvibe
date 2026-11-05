import type { Trigger } from "../../src/main/bot/core/model.ts";

// Test-only, fictional GitHub responses. No live repository or credentials.
const issue = { id: 101, number: 7, title: "Fix existing typo", body: "Please fix the typo.", state: "open", updated_at: "2026-11-04T10:00:00Z" };
const comment = { id: 201, body: "Keep the current behavior.", updated_at: "2026-11-04T10:01:00Z", user: { login: "alice", type: "User" } };

/** Raw transport scenarios for later Source adapter tests; M0 only replays the normalized events below. */
export const githubResponses = {
  pages: [
    { status: 200, headers: { etag: '"fixture-page-1"', link: '<https://api.example.invalid/issues?page=2>; rel="next"' }, body: [issue] },
    { status: 200, headers: { etag: '"fixture-page-2"' }, body: [comment] },
  ],
  retry: [{ status: 503, body: { message: "Temporarily unavailable" } }, { status: 200, body: [comment] }],
  notModified: { status: 304, headers: { etag: '"fixture-page-1"' }, body: null },
  inaccessible: { status: 404, body: { message: "Not Found" } },
  deleted: { status: 410, body: { message: "Gone" } },
  rateLimited: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793786400" }, body: { message: "API rate limit exceeded" } },
} as const;

function event(id: string, text: string, at: string, human = true): Trigger {
  return {
    id, source: "github-fixture", threads: [{ source: "github-fixture", id: "repo-11/7" }],
    actor: { source: "github-fixture", id: human ? "alice" : "" }, human,
    at, text, meta: { repositoryId: 11, number: 7 },
  };
}
const opened = event("issue-101:v1", issue.body, issue.updated_at);
const posted = event("comment-201:v1", comment.body, comment.updated_at);
const edited = event("comment-201:v2", "Keep the current behavior and existing API.", "2026-11-04T10:02:00Z");
const ci = event("check-301:v1", "Required check failed at head abc123.", "2026-11-04T10:03:00Z", false);

// The restart replays page overlap; newer versions remain distinct immutable Triggers.
export const githubReplay: readonly Trigger[] = [opened, posted, opened, edited, posted, ci];
export const replayResults = ["stored", "stored", "duplicate", "stored", "duplicate", "stored"] as const;
