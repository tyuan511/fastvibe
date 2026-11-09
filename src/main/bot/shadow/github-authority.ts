// SPDX-License-Identifier: MIT
// M11 preparation: host-issued profiles bind test operations to durable domain authority.
import type { Mandate } from "../core/model.ts";
import type { Policy } from "../core/ports.ts";
import type { ShadowEngine, WorkerToken } from "./engine.ts";
import type { GithubAuthorization as OperationAuth, GithubOperationKind } from "./github-operation.ts";
import type { ShadowSourceRegistry } from "./source-registry.ts";
import type { Operation, ShadowStore } from "./store.ts";

interface Profile {
  token: WorkerToken;
  authorization:
    OperationAuth;
  mandate: Mandate;
  sourceRevision: number;
  policyVersion: string;
}
const profileKey = (auth: OperationAuth) => JSON.stringify(["github:m11:authority", auth.source, auth.instance, auth.ticketId, auth.generation, auth.assignmentId, auth.bindingClaim]);
const sameToken = (a: WorkerToken | undefined, b: WorkerToken): boolean => !!a && a.ticketId === b.ticketId
  && a.assignmentId === b.assignmentId && a.generation === b.generation && a.claimToken === b.claimToken;
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Trusted deployment host calls grant; neither a Worker nor arbitrary request metadata creates this profile. */
export class GithubOperationAuthority {
  constructor(privateStore: ShadowStore, privateRegistry: ShadowSourceRegistry, privateEngine: ShadowEngine, privatePolicy: () => Policy) {
    this.store = privateStore; this.registry = privateRegistry; this.engine = privateEngine; this.policy = privatePolicy;
  }
  private readonly store: ShadowStore;
  private readonly registry: ShadowSourceRegistry;
  private readonly engine: ShadowEngine;
  private readonly policy: () => Policy;

  grant(token: WorkerToken, source: string, instance: string, repositoryId: string, allowed: readonly GithubOperationKind[], options: { settleIssue?: boolean } = {}): OperationAuth {
    return this.store.atomic(() => {
      const ticket = this.store.tickets.get(token.ticketId);
      const config = this.registry.instance(source); const policy = this.policy();
      if (!ticket || ticket.ended || !sameToken(this.engine.currentBinding(ticket.id), token)) throw new Error("GitHub 执行授权需要当前开放 Ticket binding");
      const origin = this.store.triggers.get(ticket.origin.triggerId);
      if (!config?.enabled || config.status !== "enabled" || !this.registry.kind(source) || origin?.source !== source || origin.meta.instance !== instance
        || String(origin.meta.repositoryId) !== repositoryId
        || String((config.config.repository as Record<string, unknown> | undefined)?.id) !== repositoryId) throw new Error("GitHub 执行授权来源或仓库不匹配");
      const decision = this.store.decisions.get(ticket.decisionId);
      if (decision?.kind !== "accept" || decision.ticketId !== ticket.id || stable(decision.mandate) !== stable(ticket.mandate)) throw new Error("GitHub 执行授权缺少真实 Decision/Mandate");
      if (policy.paused || !policy.revalidate(ticket.mandate)) throw new Error("GitHub 执行授权 Policy 无效");
      if (!allowed.length || (allowed.includes("issue-close") && !options.settleIssue)) throw new Error("Issue 收束必须使用独立 continuation");
      const authorization: OperationAuth = { source, instance, repositoryId, ticketId: ticket.id, mandateId: ticket.decisionId,
        generation: token.generation, assignmentId: token.assignmentId, bindingClaim: token.claimToken, allowed: [...new Set(allowed)].sort() };
      const key = profileKey(authorization);
      const existing = this.store.cursors.get<Profile>(source, instance, key);
      const profile: Profile = { token: structuredClone(token), authorization, mandate: ticket.mandate, sourceRevision: config.revision, policyVersion: policy.version };
      if (existing) {
        if (stable(existing.value) !== stable(profile)) throw new Error("GitHub 执行授权 profile 不可扩大或替换");
      } else if (!this.store.cursors.save(source, instance, key, profile, 0)) throw new Error("GitHub 执行授权 profile CAS 冲突");
      return structuredClone(authorization);
    });
  }

  /** Call immediately before each write, including after credential resolution or HTTP preflight. Reads may continue after Stop. */
  authorize(operation: Operation): void {
    this.store.atomic(() => {
      const payload = operation.payload as { kind?: GithubOperationKind; authorization?: OperationAuth } | undefined;
      const auth = payload?.authorization;
      if (payload?.kind === "issue-close") throw new Error("Issue 收束必须使用独立 continuation");
      if (!auth || auth.source !== operation.source || auth.instance !== operation.instance) throw new Error("GitHub operation 缺少宿主授权");
      const profile = this.store.cursors.get<Profile>(operation.source, operation.instance,
        profileKey(auth))?.value;
      if (!profile || stable(profile.authorization) !== stable(auth) || !payload?.kind || !profile.authorization.allowed.includes(payload.kind)) throw new Error("GitHub operation 与宿主授权不匹配");
      const ticket = this.store.tickets.get(auth.ticketId); const policy = this.policy(); const source = this.registry.instance(operation.source);
      if (!ticket || ticket.ended || ticket.decisionId !== auth.mandateId || stable(ticket.mandate) !== stable(profile.mandate)
        || !sameToken(this.engine.currentBinding(ticket.id), profile.token)) throw new Error("GitHub operation Ticket、Stop 或 binding 已失效");
      if (!source?.enabled || source.status !== "enabled" || !this.registry.kind(operation.source) || source.revision !== profile.sourceRevision
        || String((source.config.repository as Record<string, unknown> | undefined)?.id) !== auth.repositoryId) throw new Error("GitHub operation Source revision 已失效");
      if (policy.paused || policy.version !== profile.policyVersion || !policy.revalidate(ticket.mandate)) throw new Error("GitHub operation Policy 已失效");
    });
  }
}
