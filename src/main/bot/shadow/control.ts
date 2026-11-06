// SPDX-License-Identifier: MIT
// M7 read-only Shadow control surface; mutations are deliberately test-mode only.
import type { Settings } from "../core/policy.ts";
import { ShadowCredentialHost } from "./credential-host.ts";
import { ShadowPolicyHost } from "./policy-host.ts";
import { ShadowSourceRegistry, type ShadowSourceInstance, type ShadowSourceHealth } from "./source-registry.ts";

export interface ShadowSourceView extends Omit<ShadowSourceInstance, "config"> {
  installed: boolean; configKeys: string[]; health?: ShadowSourceHealth;
}
export interface ShadowControlSnapshot {
  sources: ShadowSourceView[];
  policy: { revision: number; version: string; paused: boolean; ruleIds: string[]; sourceIds: string[] };
  credentialRefs: { source: string; id: string; kind: string; label?: string; revision: number }[];
}
export class ShadowControl {
  private readonly registry: ShadowSourceRegistry;
  private readonly policy: ShadowPolicyHost;
  private readonly credentials: ShadowCredentialHost;
  private readonly testMode: boolean;
  constructor(registry: ShadowSourceRegistry, policy: ShadowPolicyHost, credentials: ShadowCredentialHost, testMode = false) {
    this.registry = registry; this.policy = policy; this.credentials = credentials; this.testMode = testMode;
  }
  read(): ShadowControlSnapshot {
    const sources = this.registry.instances().map(source => ({ id: source.id, kind: source.kind, enabled: source.enabled, status: source.status, revision: source.revision,
      installed: !!this.registry.kind(source.kind), configKeys: Object.keys(source.config).sort(), health: this.registry.health(source.id) }));
    const policy = this.policy.read();
    return { sources, policy: { revision: policy.revision, version: policy.version, paused: policy.settings.paused,
      ruleIds: policy.settings.policy.rules.map(rule => rule.id), sourceIds: Object.keys(policy.settings.policy.sources).sort() },
      credentialRefs: this.credentials.bindings().map(binding => ({ source: binding.source, id: binding.ref.id, kind: binding.ref.kind, ...(binding.ref.label ? { label: binding.ref.label } : {}), revision: binding.revision })) };
  }
  setTestSource(id: string, input: { enabled: boolean; config: unknown }, expectedRevision?: number): ShadowSourceInstance {
    if (!this.testMode) throw new Error("Shadow control mutations are test-only");
    return this.registry.configure(id, input, expectedRevision);
  }
  setTestPolicy(settings: Settings, expectedRevision: number) {
    if (!this.testMode) throw new Error("Shadow control mutations are test-only");
    return this.policy.save(settings, expectedRevision);
  }
}
