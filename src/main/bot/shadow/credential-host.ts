// SPDX-License-Identifier: MIT
// M7 credential boundary: references persist in Shadow, secret material stays in the host resolver.
import type { CredentialReference, ShadowSourceRegistry } from "./source-registry.ts";

export interface CredentialResolver {
  resolve(reference: CredentialReference, purpose: string): Promise<unknown>;
}
export interface CredentialBindingView { source: string; ref: CredentialReference; revision: number }

/**
 * A deliberately narrow host-only credential facade. It has no getter for the
 * secret and its public views contain only references. Real keychain/remote
 * stores can implement CredentialResolver in a later production milestone.
 */
export class ShadowCredentialHost {
  private readonly resolvers = new Map<string, CredentialResolver>();
  private readonly registry: ShadowSourceRegistry;
  constructor(registry: ShadowSourceRegistry) { this.registry = registry; }
  register(ref: CredentialReference, resolver: CredentialResolver): () => void {
    if (this.resolvers.has(ref.id)) throw new Error(`凭据 resolver 已注册: ${ref.id}`);
    this.resolvers.set(ref.id, resolver);
    return () => { if (this.resolvers.get(ref.id) === resolver) this.resolvers.delete(ref.id); };
  }
  bind(source: string, ref: CredentialReference, expectedRevision?: number): CredentialBindingView {
    return this.registry.bindCredential(source, ref, expectedRevision);
  }
  bindings(): CredentialBindingView[] { return this.registry.credentialBindings(); }
  async withSourceCredential<T>(source: string, purpose: string, use: (secret: unknown) => Promise<T>): Promise<T> {
    const binding = this.registry.credentialBinding(source);
    if (!binding) throw new Error(`Source 没有凭据引用: ${source}`);
    const resolver = this.resolvers.get(binding.ref.id);
    if (!resolver) throw new Error(`凭据 resolver 不可用: ${binding.ref.id}`);
    const secret = await resolver.resolve(binding.ref, purpose);
    if (secret === undefined || secret === null) throw new Error("凭据 resolver 返回空值");
    return use(secret);
  }
  hasResolver(id: string): boolean { return this.resolvers.has(id); }
}
