/** Format a host and port for display or an HTTP URL. */
export function formatRemoteAddress(host: string, port: number, forUrl = false): string {
  if (!host.includes(":")) return `${host}:${port}`;
  const encodedHost = forUrl ? host.replaceAll("%", "%25") : host;
  return `[${encodedHost}]:${port}`;
}
