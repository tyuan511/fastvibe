// SPDX-License-Identifier: MIT
// Native REST contract fixture only: ephemeral IPv4 loopback, fake credentials, no deduplication/CAS.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGED = "c".repeat(40);
export const ROOT = "/repos/acme/widget";
type Row = Record<string, unknown>;
export interface NativeRequest { method: string; path: string; query: Record<string, string>; body?: Row; headers: IncomingMessage["headers"]; actor: string }
export interface NativeFault { kind: "drop-after-apply" | "status"; status?: number; message?: string; headers?: Record<string, string> }
export class GithubNativeServer {
  readonly requests: NativeRequest[] = [];
  readonly branches = new Map<string, string>([["main", BASE], ["fix/one", HEAD]]);
  readonly pulls: Row[] = [];
  readonly reviews: Row[] = [];
  readonly events: Row[] = [];
  readonly checks: Row[] = [{ id: 1, name: "test", head_sha: HEAD, status: "completed", conclusion: "success", app: { id: 99 } }];
  readonly statuses: Row[] = [];
  readonly issue: Row = { number: 7, state: "open", updated_at: "2026-01-01T00:00:00Z" };
  readonly identities = new Map([["fake-writer", { id: 1, login: "agent" }], ["fake-reviewer", { id: 2, login: "reviewer" }]]);
  readonly splitPages = new Set<string>();
  private faults = new Map<string, NativeFault[]>();
  private server = createServer((req, res) => { void this.handle(req, res); });
  private port = 0;
  private nextId = 100;
  get baseUrl(): string { if (!this.port) throw new Error("server not started"); return `http://127.0.0.1:${this.port}`; }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.port = (this.server.address() as AddressInfo).port;
  }
  async close(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server.close(e => e ? reject(e) : resolve())); }
  fault(method: string, path: string, spec: NativeFault): void { const key = `${method} ${path}`; this.faults.set(key, [...(this.faults.get(key) ?? []), spec]); }
  seedPull(): Row {
    const pull: Row = { id: this.nextId++, number: 8, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), title: "Fix", body: "Existing", state: "open", user: { id: 1, login: "agent" },
      head: { ref: "fix/one", sha: HEAD, repo: { id: 11 } }, base: { ref: "main", sha: BASE, repo: { id: 11 } }, merged: false, merge_commit_sha: null, merged_at: null };
    this.pulls.push(pull); return pull;
  }
  seedApproval(commit = HEAD): void { this.reviews.push({ id: this.nextId++, state: "APPROVED", commit_id: commit, body: "Reviewed", user: { id: 2, login: "reviewer" } }); }
  seedMerged(): void { const p = this.pulls[0] ?? this.seedPull(); Object.assign(p, { merged: true, state: "closed", merge_commit_sha: MERGED, merged_at: new Date().toISOString() }); }
  driftHead(value: string): void { (this.pulls[0]!.head as Row).sha = value; this.branches.set("fix/one", value); }
  reopen(): void { this.issue.state = "open"; this.issue.updated_at = new Date().toISOString(); this.events.push({ id: this.nextId++, event: "reopened", actor: { id: 3 }, created_at: new Date().toISOString() }); }
  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); }
  private page(path: string, url: URL, rows: Row[]): { body: unknown; headers?: Record<string, string> } {
    const envelope = (items: Row[]) => path.endsWith("/check-runs") ? { total_count: rows.length, check_runs: items } : items;
    if (!this.splitPages.has(path)) return { body: envelope(rows) };
    if (url.searchParams.get("page") === "2") return { body: envelope(rows) };
    const next = new URL(url.pathname + url.search, this.baseUrl); next.searchParams.set("page", "2");
    return { body: envelope([]), headers: { link: `<${next.href}>; rel="next"` } };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", this.baseUrl), path = url.pathname, method = req.method ?? "GET";
      let text = ""; for await (const chunk of req) text += String(chunk);
      const body = text ? JSON.parse(text) as Row : undefined;
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, ""), principal = this.identities.get(token);
      this.requests.push({ method, path, query: Object.fromEntries(url.searchParams), body, headers: { ...req.headers }, actor: principal?.login ?? "unknown" });
      if (!principal) { this.send(res, 401, { message: "Bad credentials" }); return; }
      const fault = this.faults.get(`${method} ${path}`)?.shift();
      if (fault?.kind === "status") { this.send(res, fault.status ?? 503, { message: fault.message ?? "Service unavailable" }, fault.headers); return; }
      const fail = (status = 404) => ({ status, body: { message: status === 404 ? "Not Found" : "Conflict" } });
      let result: { status: number; body: unknown; headers?: Record<string, string> } = fail();
      const pull = this.pulls.find(p => p.number === 8);
      if (method === "GET") {
        if (path === "/user") result = { status: 200, body: principal };
        else if (path === ROOT) result = { status: 200, body: { id: 11, full_name: "acme/widget" } };
        else if (path.startsWith(`${ROOT}/git/ref/heads/`)) { const name = path.slice(`${ROOT}/git/ref/heads/`.length), sha = this.branches.get(name); result = sha ? { status: 200, body: { ref: `refs/heads/${name}`, object: { type: "commit", sha } } } : fail(); }
        else if (path.startsWith(`${ROOT}/git/commits/`)) { const sha = path.slice(`${ROOT}/git/commits/`.length); result = [HEAD, BASE, MERGED].includes(sha) ? { status: 200, body: { sha } } : fail(); }
        else if (path === `${ROOT}/pulls`) { if (url.searchParams.get("state") !== "all") result = fail(400); else result = { status: 200, ...this.page(path, url, this.pulls.filter(p => (p.head as Row).ref === url.searchParams.get("head")?.split(":").slice(1).join(":") && (p.base as Row).ref === url.searchParams.get("base"))) }; }
        else if (path === `${ROOT}/pulls/8`) result = pull ? { status: 200, body: pull } : fail();
        else if (path === `${ROOT}/pulls/8/reviews`) result = pull ? { status: 200, ...this.page(path, url, this.reviews) } : fail();
        else if (path.endsWith("/check-runs")) result = { status: 200, ...this.page(path, url, this.checks) };
        else if (path.endsWith("/statuses")) result = { status: 200, ...this.page(path, url, this.statuses) };
        else if (path === `${ROOT}/issues/7/events`) result = { status: 200, ...this.page(path, url, this.events) };
        else if (path === `${ROOT}/issues/7`) result = { status: 200, body: this.issue };
      } else if (method === "POST" && path === `${ROOT}/git/refs` && body) {
        const name = String(body.ref).replace(/^refs\/heads\//, "");
        if (this.branches.has(name)) result = fail(422); else { this.branches.set(name, String(body.sha)); result = { status: 201, body: { ref: body.ref, object: { sha: body.sha, type: "commit" } } }; }
      } else if (method === "POST" && path === `${ROOT}/pulls` && body) {
        if (pull) result = fail(422); else { const created = this.seedPull(); Object.assign(created, { title: body.title, body: body.body, user: principal, head: { ref: body.head, sha: this.branches.get(String(body.head)), repo: { id: 11 } }, base: { ref: body.base, sha: this.branches.get(String(body.base)), repo: { id: 11 } } }); result = { status: 201, body: created }; }
      } else if (method === "POST" && path === `${ROOT}/pulls/8/reviews` && body && pull) {
        const state = ({ APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" } as Record<string, string>)[String(body.event)];
        const review = { id: this.nextId++, body: body.body, commit_id: body.commit_id, state, user: principal }; this.reviews.push(review); result = { status: 200, body: review };
      } else if (method === "PUT" && path === `${ROOT}/pulls/8/merge` && pull && body) {
        if (body.sha !== (pull.head as Row).sha || pull.merged) result = fail(409); else { Object.assign(pull, { merged: true, state: "closed", merge_commit_sha: MERGED, merged_at: new Date().toISOString() }); result = { status: 200, body: { merged: true, sha: MERGED, message: "Pull Request successfully merged" } }; }
      } else if (method === "PATCH" && path === `${ROOT}/issues/7` && body) {
        if (Object.keys(body).sort().join(",") !== "state,state_reason" || body.state !== "closed" || body.state_reason !== "completed") result = fail(422);
        else { Object.assign(this.issue, body, { updated_at: new Date().toISOString() }); this.events.push({ id: this.nextId++, event: "closed", actor: principal, created_at: new Date().toISOString() }); result = { status: 200, body: this.issue }; }
      }
      if (fault?.kind === "drop-after-apply") { res.socket?.destroy(); return; }
      this.send(res, result.status, result.body, result.headers);
    } catch { if (!res.destroyed) this.send(res, 500, { message: "Fixture request failed" }); }
  }
}
