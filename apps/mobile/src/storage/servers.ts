import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { AddressKind } from "../protocol/address";

const LIST_KEY = "fastvibe.servers.v1";

export type SavedServer = {
  id: string;
  alias: string;
  origin: string;
  host: string;
  kind: AddressKind;
  createdAt: number;
  lastConnectedAt?: number;
};

export async function loadServers(): Promise<SavedServer[]> {
  const raw = await AsyncStorage.getItem(LIST_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isServer).sort((a, b) => (b.lastConnectedAt ?? b.createdAt) - (a.lastConnectedAt ?? a.createdAt));
  } catch {
    return [];
  }
}

export async function saveServers(servers: SavedServer[]): Promise<void> {
  await AsyncStorage.setItem(LIST_KEY, JSON.stringify(servers));
}

/** Same origin updates the existing row, so a tunnel and its LAN address stay two devices. */
export async function upsertServer(server: SavedServer): Promise<SavedServer> {
  const servers = await loadServers();
  const existing = servers.find((item) => item.origin === server.origin);
  const saved: SavedServer = existing
    ? { ...server, id: existing.id, createdAt: existing.createdAt }
    : server;
  const next = existing ? servers.map((item) => (item.id === existing.id ? saved : item)) : [saved, ...servers];
  await saveServers(next);
  return saved;
}

export async function patchServer(id: string, patch: Partial<SavedServer>): Promise<SavedServer[]> {
  const servers = await loadServers();
  await saveServers(servers.map((item) => (item.id === id ? { ...item, ...patch, id: item.id } : item)));
  return loadServers();
}

export async function removeServer(id: string): Promise<SavedServer[]> {
  const servers = await loadServers();
  await saveServers(servers.filter((item) => item.id !== id));
  await deleteToken(id);
  return loadServers();
}

export function tokenKey(id: string): string {
  return `fv.token.${id}`;
}

export async function readToken(id: string): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(id));
}

export async function writeToken(id: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(id), token);
}

export async function deleteToken(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(id)).catch(() => undefined);
}

function isServer(value: unknown): value is SavedServer {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.alias === "string" &&
    typeof record.origin === "string" &&
    typeof record.host === "string" &&
    (record.kind === "lan" || record.kind === "public" || record.kind === "loopback") &&
    typeof record.createdAt === "number"
  );
}
