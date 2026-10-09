/**
 * The cloud API, same-origin. In production nginx sends /api to the service; under
 * `next dev` next.config.ts proxies it. Cookies ride along by default for same-origin
 * requests, and the browser adds the Origin header the service checks on writes.
 */

export type Me = {
  id: string;
  login: string;
  avatar_url: string | null;
  email: string | null;
  role: "user" | "admin";
  created_at: string;
};

export type SessionInfo = {
  id: string;
  kind: "web" | "desktop" | "mobile";
  device_name: string | null;
  platform: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  current: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get unauthorized() {
    return this.status === 401;
  }
}

export async function api<T = void>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  } catch (cause) {
    throw new ApiError(0, "network", cause instanceof Error ? cause.message : "network error");
  }
  if (response.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const e = (body as { error?: { code?: string; message?: string; request_id?: string } } | undefined)?.error;
    throw new ApiError(response.status, e?.code ?? "error", e?.message ?? response.statusText, e?.request_id);
  }
  return body as T;
}

export const fetchMe = () => api<Me>("/api/me");

export async function fetchSessions(): Promise<SessionInfo[]> {
  return (await api<{ sessions: SessionInfo[] }>("/api/sessions")).sessions;
}

export const revokeSession = (id: string) => api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
export const signOut = () => api("/api/auth/logout", { method: "POST" });
