// SPDX-License-Identifier: MIT
// M11 loopback test protocol, not native GitHub REST or a durable remote service.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type HttpResult = { status: number; body: unknown };
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export interface GithubTestServerState {
  issue: { number: number; state: "open" | "closed"; version: number; mergeCommit?: string };
  branches: Map<string, string>;
  pull: { number: number; state: "open" | "closed" | "merged"; head: string; base: string; merged: boolean; mergeCommit?: string; mergedHead?: string; mergedBase?: string; created: boolean; params?: Record<string, unknown> };
  reviews: Array<Record<string, unknown>>;
  checks: Record<string, "success" | "failure" | "pending">;
}
export interface GithubServerFaultSpec { kind: "drop-after-apply" | "status" | "delay"; status?: number; delayMs?: number }
export interface GithubRequestRecord { method: string; path: string; body?: Record<string, unknown> }

/** Loopback fake protocol, intentionally not advertised as native GitHub REST. */
export class GithubTestServer {
  readonly state: GithubTestServerState = {
    issue: { number: 7, state: "open", version: 1 }, branches: new Map([["main", "b".repeat(40)]]),
    pull: { number: 8, state: "open", head: "a".repeat(40), base: "b".repeat(40), merged: false, created: false },
    reviews: [], checks: { test: "success" },
  };
  readonly requests: GithubRequestRecord[] = [];
  readonly repositoryId: number;
  private readonly server = createServer((req, res) => { void this.handle(req, res); });
  private readonly faults = new Map<string, GithubServerFaultSpec[]>();
  private port?: number;
  constructor(repositoryId = 11) { this.repositoryId = repositoryId; }
  get baseUrl(): string { if (!this.port) throw new Error("M11 server 尚未启动"); return `http://127.0.0.1:${this.port}`; }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => reject(cause); this.server.once("error", error);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", error); this.port = (this.server.address() as AddressInfo).port; resolve(); });
    });
  }
  async close(): Promise<void> { if (!this.port) return; await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve())); this.port = undefined; }
  injectFault(method: string, path: string, spec: GithubServerFaultSpec): void {
    const key = `${method} ${path}`; this.faults.set(key, [...(this.faults.get(key) ?? []), structuredClone(spec)]);
  }
  reopenIssue(): void { this.state.issue.state = "open"; this.state.issue.version++; }
  driftPullHead(sha: string): void { this.state.pull.head = sha; }
  setCheck(name: string, value: "success" | "failure" | "pending"): void { this.state.checks[name] = value; }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET", path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      let text = ""; for await (const chunk of req) text += String(chunk);
      const body = text ? object(JSON.parse(text)) : undefined;
      this.requests.push({ method, path, ...(body ? { body } : {}) });
      const fault = this.faults.get(`${method} ${path}`)?.shift();
      // Status injection is before any mutation; 5xx still requires reconciliation.
      if (fault?.kind === "status") { this.write(res, fault.status ?? 500, { applied: false }); return; }
      const result = this.route(method, path, body, String(req.headers["x-m11-operation"] ?? ""));
      if (fault?.kind === "drop-after-apply") { res.socket?.destroy(); return; }
      if (fault?.kind === "delay") {
        // Headers arrive promptly; delay the body to exercise the full HTTP timeout.
        res.writeHead(result.status, { "content-type": "application/json" }); res.flushHeaders();
        await new Promise(resolve => setTimeout(resolve, fault.delayMs ?? 100));
        if (!res.destroyed) res.end(JSON.stringify(result.body)); return;
      }
      this.write(res, result.status, result.body);
    } catch { if (!res.destroyed) this.write(res, 400, { applied: false }); }
  }
  private route(method: string, path: string, body: Record<string, unknown> | undefined, id: string): HttpResult {
    const repo = this.repositoryId; const fail = (status = 409): HttpResult => ({ status, body: { applied: false } });
    if (method === "GET") {
      const branch = `/repositories/${repo}/git/refs/heads/`;
      if (path.startsWith(branch)) {
        const name = decodeURIComponent(path.slice(branch.length)), sha = this.state.branches.get(name);
        return sha ? { status: 200, body: { ref: `refs/heads/${name}`, object: { sha } } } : fail(404);
      }
      if (path === `/repos/${repo}/pulls`) return { status: 200, body: this.state.pull.created ? [{ number: this.state.pull.number, ...this.state.pull.params }] : [] };
      if (path === `/repos/${repo}/pulls/${this.state.pull.number}/reviews`) return this.state.pull.created ? { status: 200, body: this.state.reviews } : fail(404);
      if (path === `/repos/${repo}/pulls/${this.state.pull.number}`) return this.state.pull.created ? { status: 200, body: this.state.pull } : fail(404);
      if (path === `/repos/${repo}/issues/${this.state.issue.number}`) return { status: 200, body: this.state.issue };
      return fail(404);
    }
    if (!id || !body) return fail(400);
    let result: unknown;
    if (method === "POST" && path === `/repositories/${repo}/git/refs`) {
      const ref = String(body.ref ?? ""), name = ref.replace(/^refs\/heads\//, "");
      if (!name || this.state.branches.has(name)) return fail(422);
      this.state.branches.set(name, String(body.sha)); result = { ref, object: { sha: body.sha } };
    } else if (method === "POST" && path === `/repos/${repo}/pulls`) {
      if (this.state.pull.created) return fail(422);
      this.state.pull.created = true; this.state.pull.params = structuredClone(body); result = { number: this.state.pull.number, ...body };
    } else if (method === "POST" && path === `/repos/${repo}/pulls/${this.state.pull.number}/reviews`) {
      if (!this.state.pull.created || this.state.pull.state !== "open" || body.commit_id !== this.state.pull.head) return fail();
      this.state.reviews.push({ ...body }); result = { ...body };
    } else if (method === "PUT" && path === `/repos/${repo}/pulls/${this.state.pull.number}/merge`) {
      const approved = this.state.reviews.some(review => review.event === "APPROVE" && review.commit_id === this.state.pull.head);
      if (!this.state.pull.created || this.state.pull.state !== "open" || body.sha !== this.state.pull.head || body.base !== this.state.pull.base || !approved || Object.values(this.state.checks).some(value => value !== "success")) return fail();
      this.state.pull.state = "merged"; this.state.pull.merged = true; this.state.pull.mergeCommit = "d".repeat(40); this.state.pull.mergedHead = this.state.pull.head; this.state.pull.mergedBase = this.state.pull.base;
      result = { merged: true, sha: this.state.pull.mergeCommit, mergedHead: this.state.pull.head, mergedBase: this.state.pull.base };
    } else if (method === "PATCH" && path === `/repos/${repo}/issues/${this.state.issue.number}`) {
      if (!this.state.pull.merged || body.mergeCommit !== this.state.pull.mergeCommit || this.state.issue.state !== "open"
        || (body.version !== undefined && body.version !== this.state.issue.version)) return fail();
      this.state.issue.state = "closed"; this.state.issue.version++; this.state.issue.mergeCommit = String(body.mergeCommit); result = { ...this.state.issue };
    } else return fail(404);
    // Echo only: there is deliberately no operation-id cache or idempotency gate.
    return { status: 200, body: { operationId: id, ...object(result) } };
  }
  private write(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed) return; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  }
}
