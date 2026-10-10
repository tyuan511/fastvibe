/**
 * The name this computer goes by on the FastVibe account: what the console's device list
 * and the phone's list of computers show. The cloud keeps at most 64 characters.
 */
export const DEVICE_NAME_MAX_LENGTH = 64;

export function deviceNameProblem(value: string): "invalidCharacters" | "tooLong" | null {
  const name = value.trim();
  if (/[\x00-\x1f\x7f]/.test(name)) return "invalidCharacters";
  if ([...name].length > DEVICE_NAME_MAX_LENGTH) return "tooLong";
  return null;
}

/** An empty preference means follow the computer's own name. */
export function deviceNameSetting(value: unknown): string {
  return typeof value === "string" && !deviceNameProblem(value) ? value.trim() : "";
}

/** The computer's own name (`Yuans-MacBook-Pro.local` → `Yuans-MacBook-Pro`), used until one is chosen. */
export function defaultDeviceName(hostName: string): string {
  return hostName.trim().replace(/\.local\.?$/i, "") || "FastVibe";
}
