// SPDX-License-Identifier: MIT
// M7 isolated Policy host; it persists only authorization settings, never renderer settings or secrets.
import { policyEffects, policyVersion, type Settings, settingsPolicy } from "../core/policy.ts";
import type { PolicyEffect, Ticket } from "../core/model.ts";
import type { SourceScope } from "../core/ports.ts";
import type { ShadowStore } from "./store.ts";

export interface PolicySnapshot { revision: number; version: string; settings: Settings }
const KEY = "shadow:m7:policy";
const copy = <T>(value: T): T => structuredClone(value);
const forbidden = /(?:^|_)(?:token|secret|password|privatekey|authorization|accesskey)(?:$|_)/i;
function assertPolicySafe(value: unknown, path = "policy"): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertPolicySafe(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.test(name) && name !== "credentialRef") throw new Error(`Policy 不能持久化凭据字段: ${path}.${name}`);
    assertPolicySafe(item, `${path}.${name}`);
  }
}
const sourceId = /^[a-z][a-z0-9-]{0,63}$/;
const ruleId = /^[a-zA-Z0-9_-]{1,80}$/;
function validate(settings: Settings): Settings {
  assertPolicySafe(settings);
  if (!settings || typeof settings !== "object" || typeof settings.paused !== "boolean") throw new Error("Shadow Policy paused 无效");
  if (!settings.policy || !Array.isArray(settings.policy.rules) || !settings.policy.sources) throw new Error("Shadow Policy 结构无效");
  const ids = new Set<string>();
  for (const rule of settings.policy.rules) {
    if (!ruleId.test(rule.id) || ids.has(rule.id) || typeof rule.name !== "string" || typeof rule.instruction !== "string" || typeof rule.enabled !== "boolean") throw new Error("Shadow Policy rule 无效");
    ids.add(rule.id);
  }
  if (!settings.eval || !["off", "observe", "auto"].includes(settings.eval.mode) || !Number.isSafeInteger(settings.eval.timeoutSeconds) || settings.eval.timeoutSeconds <= 0) throw new Error("Shadow Eval 配置无效");
  for (const id of Object.keys(settings.policy.sources)) if (!sourceId.test(id)) throw new Error(`非法 Policy Source ID: ${id}`);
  return copy(settings);
}

export class ShadowPolicyHost {
  private readonly store: ShadowStore;
  private readonly initial: Settings;
  constructor(store: ShadowStore, initial: Settings) { this.store = store; this.initial = initial; }
  read(): PolicySnapshot {
    const saved = this.store.get<PolicySnapshot>(KEY);
    if (saved) return copy(saved);
    const settings = validate(this.initial); return { revision: 0, version: policyVersion(settings), settings };
  }
  save(settings: Settings, expectedRevision: number): PolicySnapshot {
    const nextSettings = validate(settings);
    return this.store.atomic(() => {
      const current = this.read();
      if (current.revision !== expectedRevision) throw new Error("Shadow Policy revision 冲突");
      const next: PolicySnapshot = { revision: current.revision + 1, version: policyVersion(nextSettings), settings: nextSettings };
      this.store.set(KEY, next); return copy(next);
    });
  }
  policy(scope: SourceScope): ReturnType<typeof settingsPolicy> { const current = this.read(); return settingsPolicy(current.settings, scope); }
  effects(tickets: readonly Ticket[], previous: Settings, next: Settings, scope: (settings: Settings) => SourceScope): Map<string, PolicyEffect> {
    return policyEffects(tickets, validate(previous), validate(next), scope);
  }
}
