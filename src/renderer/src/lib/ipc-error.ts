import { i18n } from "@/lib/i18n";

/**
 * Electron prefixes every rejected `ipcRenderer.invoke` with the channel name and a
 * nested `Error:` (`Error invoking remote method 'providers:add': Error: 密钥无效`),
 * which is noise in a user-facing message. Strip both and fall back to a generic
 * message for non-Errors.
 */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : (i18n.t("common:errors.generic") as string);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}
