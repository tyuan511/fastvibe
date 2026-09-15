/**
 * Electron prefixes every rejected `ipcRenderer.invoke` with the channel name, which
 * is noise in a user-facing message ("Error invoking remote method 'providers:add':
 * Error: 密钥无效"). Strip it and fall back to a generic message for non-Errors.
 */
export function cleanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "操作失败，请重试";
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "");
}
