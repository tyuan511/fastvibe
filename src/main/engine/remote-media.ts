import { decodeScopedId } from "../../shared/server-scope.ts";

export type RemoteMediaEndpoint = { port: number; token: string };

const FORWARD_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"] as const;

/** The loopback URL main fetches so a remote file streams as bytes, not a base64 frame. */
export function remoteMediaTarget(endpoint: RemoteMediaEndpoint, localPath: string): string {
  const url = new URL(`http://127.0.0.1:${endpoint.port}/api/media`);
  url.searchParams.set("path", localPath);
  return url.toString();
}

/**
 * Proxy one media request to the machine that has the file.
 *
 * The renderer only ever sees `fastvibe-media://`. When that path is a remote ref, main
 * reads it through the SSH forward as an HTTP byte stream and passes the response on,
 * range headers included, so a video can still seek.
 */
export async function fetchRemoteMedia(
  endpoint: RemoteMediaEndpoint | null,
  scopedPath: string,
  method: string,
  rangeHeader: string | null,
): Promise<Response> {
  const decoded = decodeScopedId(scopedPath);
  if (!decoded || !isAbsoluteRemotePath(decoded.localId)) return new Response(null, { status: 400 });
  if (!endpoint) return new Response(null, { status: 404 });
  const headers = new Headers({ authorization: `Bearer ${endpoint.token}` });
  if (rangeHeader) headers.set("range", rangeHeader);
  let upstream: Response;
  try {
    upstream = await fetch(remoteMediaTarget(endpoint, decoded.localId), {
      method,
      headers,
      redirect: "error",
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  const forwarded = new Headers({ "cache-control": "no-store" });
  for (const name of FORWARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: forwarded });
}

function isAbsoluteRemotePath(filePath: string): boolean {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
}
