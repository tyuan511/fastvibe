import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { normalizePublicUrl, type RemoteHostProfile } from "../../shared/remote-host.ts";
import { readSshConfig } from "./ssh-config.ts";

type StoredHosts = { version: 1; hosts: StoredProfile[] };

/** On disk a password is either sealed by the OS keychain or, where there is none, plain. */
type StoredProfile = RemoteHostProfile & { passwordSealed?: string };

/**
 * Seals a secret with the platform keychain (Electron `safeStorage`). Absent, or unable
 * to encrypt (a Linux session with no secret service), the password stays in the 0600
 * file as before rather than being lost.
 *
 * Every method is asynchronous: Electron 46 removes the synchronous `safeStorage` calls.
 * `reseal` is the keychain saying the stored form is out of date (its key rotated) and
 * should be written again.
 */
export type SecretBox = {
  available(): Promise<boolean>;
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<{ plain: string; reseal: boolean }>;
};

export type SshHostSnapshot = {
  saved: RemoteHostProfile[];
  discovered: RemoteHostProfile[];
};

export async function readSshHosts(file: string, secrets?: SecretBox): Promise<SshHostSnapshot> {
  const { hosts: saved, stale } = await readSaved(file, secrets);
  // Profiles written before sealing existed carry a plain password; seal them as soon as
  // the keychain can, instead of waiting for the user to happen to edit one. A sealed one
  // the keychain calls out of date is written again for the same reason.
  if ((stale || hasPlainPassword(file)) && await secrets?.available()) await writeSaved(file, saved, secrets);
  const discovered = readSshConfig();
  return { saved, discovered };
}

/**
 * Save one profile.
 *
 * The renderer never holds a saved password (`hasPassword` stands in for it), so a
 * password-auth profile arriving without one keeps the password already on file.
 */
export async function saveSshHost(file: string, profile: RemoteHostProfile, secrets?: SecretBox): Promise<SshHostSnapshot> {
  const next = normalize(profile);
  if (!next.id || !next.label || !next.host) throw new Error("SSH 主机配置无效");
  const current = (await readSaved(file, secrets)).hosts;
  const previous = current.find((item) => item.id === next.id);
  if (next.authMethod === "password" && !next.password) {
    if (previous?.password) next.password = previous.password;
    else if (previous?.passwordSealed) next.passwordSealed = previous.passwordSealed;
  }
  if (next.authMethod !== "password") delete next.password;
  const saved = current.filter((item) => item.id !== next.id);
  saved.push(next);
  await writeSaved(file, saved, secrets);
  return { saved, discovered: readSshConfig() };
}

export async function removeSshHost(file: string, id: string, secrets?: SecretBox): Promise<SshHostSnapshot> {
  const saved = (await readSaved(file, secrets)).hosts.filter((item) => item.id !== id);
  await writeSaved(file, saved, secrets);
  return { saved, discovered: readSshConfig() };
}

/** The same snapshot with every secret replaced by `hasPassword`, for a renderer. */
export function redactSshHosts(snapshot: SshHostSnapshot): SshHostSnapshot {
  const redact = (host: StoredProfile): RemoteHostProfile => {
    const { password, passwordSealed, ...rest } = host;
    return password || passwordSealed ? { ...rest, hasPassword: true } : rest;
  };
  return { saved: snapshot.saved.map(redact), discovered: snapshot.discovered.map(redact) };
}

async function readSaved(file: string, secrets?: SecretBox): Promise<{ hosts: StoredProfile[]; stale: boolean }> {
  let items: StoredProfile[];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredHosts>;
    if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return { hosts: [], stale: false };
    items = parsed.hosts;
  } catch {
    return { hosts: [], stale: false };
  }
  const opened = await Promise.all(items.map((item) => unseal(item, secrets)));
  return {
    hosts: opened.map((entry) => normalize(entry.profile)).filter((item) => item.id && item.label && item.host),
    stale: opened.some((entry) => entry.stale),
  };
}

/**
 * Open a sealed password. One that cannot be opened right now (no keychain this session)
 * stays sealed rather than being dropped, so the next write does not erase it.
 */
async function unseal(item: StoredProfile, secrets?: SecretBox): Promise<{ profile: StoredProfile; stale: boolean }> {
  const { passwordSealed, ...rest } = item ?? ({} as StoredProfile);
  if (typeof passwordSealed !== "string" || !passwordSealed) return { profile: rest, stale: false };
  if (!secrets || !await secrets.available()) return { profile: { ...rest, passwordSealed }, stale: false };
  try {
    const { plain, reseal } = await secrets.open(passwordSealed);
    return { profile: { ...rest, password: plain }, stale: reseal };
  } catch {
    // Sealed by another user account or a reset keychain: unrecoverable, so ask again.
    return { profile: rest, stale: false };
  }
}

function hasPlainPassword(file: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredHosts>;
    return Array.isArray(parsed.hosts) && parsed.hosts.some((item) => typeof item?.password === "string" && item.password !== "");
  } catch {
    return false;
  }
}

async function writeSaved(file: string, hosts: StoredProfile[], secrets?: SecretBox): Promise<void> {
  const sealing = secrets && await secrets.available() ? secrets : undefined;
  const stored: StoredProfile[] = await Promise.all(hosts.map(async (host) => {
    const { password, hasPassword: _hasPassword, ...rest } = host;
    if (!password) return rest;
    return sealing ? { ...rest, passwordSealed: await sealing.seal(password) } : { ...rest, password };
  }));
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${file.split(/[\\/]/).pop()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, hosts: stored }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function normalize(value: StoredProfile): StoredProfile {
  return {
    id: typeof value?.id === "string" ? value.id.trim() : "",
    label: typeof value?.label === "string" ? value.label.trim() : "",
    host: typeof value?.host === "string" ? value.host.trim() : "",
    ...(typeof value?.hostName === "string" && value.hostName.trim() ? { hostName: value.hostName.trim() } : {}),
    source: value?.source === "config" ? "config" : "manual",
    ...(typeof value?.user === "string" && value.user.trim() ? { user: value.user.trim() } : {}),
    ...(validPort(value?.port) ? { port: value.port } : {}),
    ...(typeof value?.identityFile === "string" && value.identityFile.trim() ? { identityFile: value.identityFile.trim() } : {}),
    authMethod: value?.authMethod === "password" || value?.authMethod === "identity-file" ? value.authMethod : "default-key",
    ...(typeof value?.knownHostsFile === "string" && value.knownHostsFile.trim() ? { knownHostsFile: value.knownHostsFile.trim() } : {}),
    ...(typeof value?.password === "string" && value.password ? { password: value.password } : {}),
    ...(typeof value?.passwordSealed === "string" && value.passwordSealed && !value.password ? { passwordSealed: value.passwordSealed } : {}),
    // 7777 was the old fixed Agent port, and the settings pane wrote it into every profile
    // it edited without ever showing the field. It is not a choice anyone made, and keeping
    // it would pin the Agent to the one port the random default exists to avoid.
    ...(validPort(value?.servicePort) && value.servicePort !== 7777 ? { servicePort: value.servicePort } : {}),
    ...(validPort(value?.localPort) ? { localPort: value.localPort } : {}),
    ...(validPort(value?.phoneAccess?.port)
      ? {
          phoneAccess: {
            port: value.phoneAccess.port,
            ...(normalizePublicUrl(value.phoneAccess.publicUrl) ? { publicUrl: normalizePublicUrl(value.phoneAccess.publicUrl)! } : {}),
          },
        }
      : {}),
  };
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}
