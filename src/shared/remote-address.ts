/** Format a host and port for display or an HTTP URL. */
export function formatRemoteAddress(host: string, port: number, forUrl = false): string {
  if (!host.includes(":")) return `${host}:${port}`;
  const encodedHost = forUrl ? host.replaceAll("%", "%25") : host;
  return `[${encodedHost}]:${port}`;
}

/** A normal, browser-openable URL with an optional name for the phone's add form. */
export function remoteQrValue(address: string, name?: string): string {
  const label = name?.trim();
  if (!label) return address;
  // Do not round-trip the authority through URL: it rejects encoded IPv6 zone IDs.
  const hash = address.indexOf("#");
  const base = hash < 0 ? address : address.slice(0, hash);
  const fragment = hash < 0 ? "" : address.slice(hash);
  const query = base.indexOf("?");
  const params = new URLSearchParams(query < 0 ? "" : base.slice(query + 1));
  params.set("name", label);
  return `${query < 0 ? base : base.slice(0, query)}?${params}${fragment}`;
}
