import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createToken, hashPassword, tokenMatches, verifyPassword } from "./auth.ts";

/**
 * On-disk credentials for the remote server.
 *
 * Its own file, not a corner of `settings.json`: that one is read wholesale by every
 * renderer and re-broadcast on every write, so a password hash living there would be
 * handed to every window and, once clients can connect, to them as well. Nothing here is
 * reachable through the call table.
 *
 * The file is written 0600. That is not much against someone who already has the
 * account, but it does keep the hash out of a backup that copies world-readable files,
 * and it costs one syscall.
 */

export type RemoteDevice = {
  id: string;
  /** SHA-256 of the token. The token itself is shown once, at creation, and never kept. */
  hash: string;
  /** What the user calls this client. Free text, shown in the settings pane. */
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
};

export type RemoteAccess = {
  version: 1;
  /** scrypt hash of the password, or null when remote access has never been set up. */
  password: string | null;
  devices: RemoteDevice[];
};

const EMPTY: RemoteAccess = { version: 1, password: null, devices: [] };

/**
 * Read the credentials, treating anything unreadable as "not configured".
 *
 * Failing closed matters here: a corrupt file must leave the server refusing every
 * login, never falling back to a state where some other check is the only one left.
 */
export function readRemoteAccess(file: string): RemoteAccess {
  if (!existsSync(file)) return { ...EMPTY, devices: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY, devices: [] };
    const record = parsed as Partial<RemoteAccess>;
    const password = typeof record.password === "string" && record.password ? record.password : null;
    const devices = Array.isArray(record.devices)
      ? record.devices.filter(isDevice)
      : [];
    return { version: 1, password, devices };
  } catch {
    return { ...EMPTY, devices: [] };
  }
}

function isDevice(value: unknown): value is RemoteDevice {
  if (typeof value !== "object" || value === null) return false;
  const device = value as Partial<RemoteDevice>;
  return (
    typeof device.id === "string" &&
    typeof device.hash === "string" &&
    device.hash.length > 0 &&
    typeof device.label === "string" &&
    typeof device.createdAt === "number"
  );
}

export function writeRemoteAccess(file: string, record: RemoteAccess): void {
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // `mode` on writeFileSync only applies when the file is created; an existing file
  // keeps whatever it had, so tighten it explicitly on every write.
  try {
    chmodSync(file, 0o600);
  } catch {
    // A filesystem without POSIX modes (a Windows share) is not a reason to fail the write.
  }
}

/** Set or replace the password. Every existing device is revoked with it. */
export function setPassword(file: string, password: string): void {
  // Changing the password is what a user does when they think someone else has it, so
  // the tokens it previously issued must stop working — otherwise the new password
  // protects nothing that was already taken.
  writeRemoteAccess(file, { version: 1, password: hashPassword(password), devices: [] });
}

export function clearRemoteAccess(file: string): void {
  writeRemoteAccess(file, { version: 1, password: null, devices: [] });
}

export function isConfigured(file: string): boolean {
  return readRemoteAccess(file).password !== null;
}

/**
 * Check a password and, if it is right, issue a device token.
 *
 * Returns the token exactly once — only its hash is stored, so a client that loses it
 * has to log in again rather than ask for it back.
 */
export function login(file: string, password: string, label: string): { token: string; device: RemoteDevice } | null {
  const record = readRemoteAccess(file);
  if (!record.password || !verifyPassword(password, record.password)) return null;
  const { token, hash } = createToken();
  const device: RemoteDevice = {
    id: randomUUID(),
    hash,
    label: label.slice(0, 80) || "未命名设备",
    createdAt: Date.now(),
    lastSeenAt: null,
  };
  writeRemoteAccess(file, { ...record, devices: [...record.devices, device] });
  return { token, device };
}

/**
 * Resolve a presented token to the device it belongs to, or null.
 *
 * Every stored device is compared against, rather than stopping at the first match, so
 * the work does not depend on which device presented the token.
 */
export function authenticate(file: string, token: string): RemoteDevice | null {
  const record = readRemoteAccess(file);
  let found: RemoteDevice | null = null;
  for (const device of record.devices) {
    if (tokenMatches(token, device.hash)) found = device;
  }
  return found;
}

/** Record that a device just connected. Best-effort: a failed write must not deny access. */
export function touchDevice(file: string, id: string): void {
  try {
    const record = readRemoteAccess(file);
    const devices = record.devices.map((device) =>
      device.id === id ? { ...device, lastSeenAt: Date.now() } : device,
    );
    writeRemoteAccess(file, { ...record, devices });
  } catch {
    // ignore
  }
}

/** Revoke one device. A phone that is lost is one entry to delete. */
export function revokeDevice(file: string, id: string): RemoteDevice[] {
  const record = readRemoteAccess(file);
  const devices = record.devices.filter((device) => device.id !== id);
  writeRemoteAccess(file, { ...record, devices });
  return devices;
}

/** The devices, without their hashes — this is what the settings pane is allowed to see. */
export function listDevices(file: string): Array<Omit<RemoteDevice, "hash">> {
  return readRemoteAccess(file).devices.map(({ hash: _hash, ...rest }) => rest);
}
