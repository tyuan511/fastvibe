import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { RemoteHostProfile } from "@shared/remote-host";
import { readSshConfig } from "./ssh-config.ts";

type StoredHosts = { version: 1; hosts: RemoteHostProfile[] };

export type SshHostSnapshot = {
  saved: RemoteHostProfile[];
  discovered: RemoteHostProfile[];
};

export function readSshHosts(file: string): SshHostSnapshot {
  const saved = readSaved(file);
  const discovered = readSshConfig();
  return { saved, discovered };
}

export function saveSshHost(file: string, profile: RemoteHostProfile): SshHostSnapshot {
  const next = normalize(profile);
  if (!next.id || !next.label || !next.host) throw new Error("SSH 主机配置无效");
  const saved = readSaved(file).filter((item) => item.id !== next.id);
  saved.push(next);
  writeSaved(file, saved);
  return { saved, discovered: readSshConfig() };
}

export function removeSshHost(file: string, id: string): SshHostSnapshot {
  const saved = readSaved(file).filter((item) => item.id !== id);
  writeSaved(file, saved);
  return { saved, discovered: readSshConfig() };
}

function readSaved(file: string): RemoteHostProfile[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredHosts>;
    if (parsed.version !== 1 || !Array.isArray(parsed.hosts)) return [];
    return parsed.hosts.map(normalize).filter((item) => item.id && item.label && item.host);
  } catch {
    return [];
  }
}

function writeSaved(file: string, hosts: RemoteHostProfile[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${file.split(/[\\/]/).pop()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function normalize(value: RemoteHostProfile): RemoteHostProfile {
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
    ...(validPort(value?.servicePort) ? { servicePort: value.servicePort } : {}),
    ...(validPort(value?.localPort) ? { localPort: value.localPort } : {}),
  };
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}
