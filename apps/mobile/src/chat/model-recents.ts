import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The models this phone last picked on one machine, newest first.
 *
 * Per server, because two machines rarely share a provider list and a recent model
 * that the machine on screen cannot run is noise at the top of the picker. Kept on
 * the phone rather than in the machine's settings: it is a habit of this device.
 */
const LIMIT = 6;

function storageKey(serverId: string): string {
  return `fastvibe.modelRecents.v1.${serverId}`;
}

export async function loadModelRecents(serverId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(serverId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export async function rememberModel(serverId: string, key: string): Promise<string[]> {
  const next = [key, ...(await loadModelRecents(serverId)).filter((item) => item !== key)].slice(0, LIMIT);
  await AsyncStorage.setItem(storageKey(serverId), JSON.stringify(next)).catch(() => undefined);
  return next;
}
