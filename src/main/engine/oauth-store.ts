import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * Credential storage for subscription (OAuth) logins, backed by a JSON file inside
 * FastVibe's isolated runtime.
 *
 * API keys deliberately do **not** come here. They go to the engine's in-memory
 * overlay (`ModelRuntime.setRuntimeApiKey`, fed from `agent/.env`), which is what keeps
 * a pasted key out of the SDK's own auth file. An OAuth login is a different animal:
 * its refresh token has to survive a restart or the user would re-authorise in the
 * browser on every launch, so it is the one credential that must be written to disk.
 *
 * The file is read on every operation rather than cached. It holds a handful of
 * entries and is read rarely (a login, a token refresh, an availability pass), so a
 * cache would only buy staleness — and a second writer (a logout, or the migration in
 * Settings) rewriting the file behind the runtime's back would then be invisible.
 */
const FILE_VERSION = 1;

type CredentialsFile = {
  version: number;
  credentials: Record<string, Credential>;
};

export class OAuthCredentialStore implements CredentialStore {
  #file: string;
  /** One promise chain per provider, so a refresh and a logout cannot interleave. */
  #chains = new Map<string, Promise<unknown>>();

  constructor(file: string) {
    this.#file = file;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return readCredentialsFile(this.#file)[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(readCredentialsFile(this.#file)).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  /**
   * Serialized read-modify-write, the only write path. `fn` sees the credential as it
   * is on disk right now because a token refresh must rotate from the current one; a
   * `undefined` return leaves the entry untouched.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const credentials = readCredentialsFile(this.#file);
      const current = credentials[providerId];
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      credentials[providerId] = next;
      writeCredentialsFile(this.#file, credentials);
      return next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const credentials = readCredentialsFile(this.#file);
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      writeCredentialsFile(this.#file, credentials);
    });
  }

  /** Queue behind any in-flight operation on the same provider. */
  #enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(task);
    const tail = queued.catch(() => undefined);
    this.#chains.set(providerId, tail);
    void tail.then(() => {
      if (this.#chains.get(providerId) === tail) this.#chains.delete(providerId);
    });
    return queued;
  }
}

/** Provider ids holding a stored OAuth credential. */
export function readOAuthProviderIds(file: string): Set<string> {
  return new Set(Object.keys(readCredentialsFile(file)));
}

export function hasOAuthCredential(file: string, providerId: string): boolean {
  return providerId in readCredentialsFile(file);
}

/**
 * Drop a provider's stored credential without going through a store instance — used
 * when a provider is deleted, where there is no live runtime to log out of. A corrupt
 * or missing file is simply «no credential».
 */
export function deleteOAuthCredential(file: string, providerId: string): void {
  const credentials = readCredentialsFile(file);
  if (!(providerId in credentials)) return;
  delete credentials[providerId];
  writeCredentialsFile(file, credentials);
}

function readCredentialsFile(file: string): Record<string, Credential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Missing (the normal first-run state) or unreadable: no credentials. A corrupt
    // file is ignored rather than trusted — the worst case is one re-login.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const credentials = (parsed as CredentialsFile).credentials;
  if (typeof credentials !== "object" || credentials === null) return {};
  const out: Record<string, Credential> = {};
  for (const [providerId, credential] of Object.entries(credentials)) {
    if (!providerId || typeof credential !== "object" || credential === null) continue;
    const type = (credential as { type?: unknown }).type;
    if (type !== "oauth" && type !== "api_key") continue;
    out[providerId] = credential as Credential;
  }
  return out;
}

/**
 * Write through a temporary file and rename, so a crash mid-write cannot leave a
 * half-written token behind, and `0o600` keeps the refresh token owner-only.
 */
function writeCredentialsFile(file: string, credentials: Record<string, Credential>): void {
  const payload: CredentialsFile = { version: FILE_VERSION, credentials };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  // `mode` on write only applies when the file is created; a file that already
  // existed keeps its old permissions, and an older build could have made it 0644.
  chmodSync(file, 0o600);
}
