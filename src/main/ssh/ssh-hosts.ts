import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { RemoteHostProfile } from "@shared/remote-host";
import { readSshConfig } from "./ssh-config.ts";

type StoredHosts = { version: 1; hosts: StoredProfile[] };

/** On disk a password is either sealed by the OS keychain or, where there is none, plain. */
type StoredProfile = RemoteHostProfile & { passwordSealed?: string };

/**
 * Seals a secret with the platform keychain (Electron `safeStorage`). Absent, or unable
 * to encrypt (a Linux session with no secret service), the password stays in the 0600
 * file as before rather than being lost.
 */
export type SecretBox = {
  available(): boolean;
  seal(plain: string): string;
  open(sealed: string): string;
};

export type SshHostSnapshot = {
  saved: RemoteHostProfile[];
  discovered: RemoteHostProfile[];
};

export function readSshHosts(file: string, secrets?: SecretBox): SshHostSnapshot {
  const saved = readSaved(file, secrets);
  // Profiles written before sealing existed carry a plain password; seal them as soon as
  // the keychain can, instead of waiting for the user to happen to edit one.
  if (secrets?.available() && hasPlainPassword(file)) writeSaved(file, saved, secrets);
  const discovered = readSshConfig();
  return { saved, discovered };
}

/**
 * Save one profile.
 *
 * The renderer never holds a saved password (`hasPassword` stands in for it), so a
 * password-auth profile arriving without one keeps the password already on file.
 */
export function saveSshHost(file: string, profile: RemoteHostProfile, secrets?: SecretBox): SshHostSnapshot {
  const next = normalize(profile);
  if (!next.id || !next.label || !next.host) throw new Error("SSH 主机配置无效");
  const current = readSaved(file, secrets);
  const previous = current.find((item) => item.id === next.id);
  if (next.authMethod === "password" && !next.password) {
    if (previous?.password) next.password = previous.password;
    else if (previous?.passwordSealed) next.passwordSealed = previous.passwordSealed;
  }
  if (next.authMethod !== "password") delete next.password;
  const saved = current.filter((item) => item.id !== next.id);
  saved.push(next);
  writeSaved(file, saved, secrets);
  return { saved, discovered: readSshConfig() };
}

export function removeSshHost(file: string, id: string, secrets?: SecretBox): SshHostSnapshot {
  const saved = readSaved(file, secrets).filter((item) => item.id !== id);
  writeSaved(file, saved, secrets);
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

function readSaved(file: string, secrets?: SecretBox): StoredProfile[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredHosts>;
    if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.map((item) => normalize(unseal(item, secrets))).filter((item) => item.id && item.label && item.host);
  } catch {
    return [];
  }
}

/**
 * Open a sealed password. One that cannot be opened right now (no keychain this session)
 * stays sealed rather than being dropped, so the next write does not erase it.
 */
function unseal(item: StoredProfile, secrets?: SecretBox): StoredProfile {
  const { passwordSealed, ...rest } = item ?? ({} as StoredProfile);
  if (typeof passwordSealed !== "string" || !passwordSealed) return rest;
  if (!secrets?.available()) return { ...rest, passwordSealed };
  try {
    return { ...rest, password: secrets.open(passwordSealed) };
  } catch {
    // Sealed by another user account or a reset keychain: unrecoverable, so ask again.
    return rest;
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

function writeSaved(file: string, hosts: StoredProfile[], secrets?: SecretBox): void {
  const sealing = secrets?.available() ? secrets : undefined;
  const stored: StoredProfile[] = hosts.map((host) => {
    const { password, hasPassword: _hasPassword, ...rest } = host;
    if (!password) return rest;
    return sealing ? { ...rest, passwordSealed: sealing.seal(password) } : { ...rest, password };
  });
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
  };
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}
