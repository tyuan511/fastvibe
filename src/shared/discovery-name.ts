/** DNS-SD instance labels are limited to 63 UTF-8 bytes, including conflict suffixes. */
export const DISCOVERY_NAME_MAX_BYTES = 63;

export function discoveryNameProblem(value: string): "invalidCharacters" | "tooLong" | null {
  const name = value.trim();
  // bonjour-service treats dots as label separators and rewrites them. Reject those
  // and escape/control characters instead of advertising a different name than saved.
  if (/[.\\\x00-\x1f\x7f]/.test(name)) return "invalidCharacters";
  if (new TextEncoder().encode(name).length > DISCOVERY_NAME_MAX_BYTES) return "tooLong";
  return null;
}

/** An empty preference means follow the computer's default name. */
export function discoveryNameSetting(value: unknown): string {
  return typeof value === "string" && !discoveryNameProblem(value) ? value.trim() : "";
}

/** Leave room for a conflict suffix without splitting a Unicode character. */
export function discoveryNameWithSuffix(name: string, suffix = ""): string {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(suffix).length;
  let prefix = "";
  for (const character of name) {
    bytes += encoder.encode(character).length;
    if (bytes > DISCOVERY_NAME_MAX_BYTES) break;
    prefix += character;
  }
  return `${prefix}${suffix}`;
}
