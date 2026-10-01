/**
 * Why an SSH login failed, when OpenSSH said so plainly enough to act on.
 *
 * - `host-key-unknown`: strict checking met a host this machine has never seen. The fix is
 *   to show its fingerprint and let the user trust it (`ssh:host-key-scan` / `-trust`).
 * - `host-key-changed`: the host presents a different key than the one on file. Never
 *   offered for trust from the GUI — that is exactly what a man in the middle looks like.
 * - `auth-failed`: the key or password was refused. Retrying the same credential is
 *   pointless, so a connect stops at the first one rather than trying every step.
 */
export type SshErrorCode = "host-key-unknown" | "host-key-changed" | "auth-failed";

/** A saved SSH destination. Secrets stay in the platform SSH agent/config. */
export type RemoteHostProfile = {
  id: string;
  label: string;
  /** SSH config alias or hostname passed to OpenSSH. */
  host: string;
  /** Resolved HostName, for display and diagnostics only. */
  hostName?: string;
  /** Whether this entry came from ~/.ssh/config or was created in FastVibe. */
  source?: "config" | "manual";
  user?: string;
  port?: number;
  /** SSH authentication mode. The default uses OpenSSH's normal key/agent lookup. */
  authMethod?: "default-key" | "identity-file" | "password";
  identityFile?: string;
  /**
   * SSH password authentication secret. Main only: it is encrypted at rest with the OS
   * keychain where available, and never sent to a renderer (`hasPassword` is).
   */
  password?: string;
  /** A password is saved for this host. Set on the copies the renderer receives. */
  hasPassword?: boolean;
  knownHostsFile?: string;
  /** The remote FastVibe service port, normally bound to loopback. */
  servicePort?: number;
  /** Port on the local machine used for the SSH forward. */
  localPort?: number;
  /**
   * Set when a phone may connect to this host's resident Agent directly, without SSH.
   * Its presence is the switch: the Agent then listens beyond loopback on `port` and
   * asks for a password. The password itself is never kept here — only its hash, on the
   * host.
   */
  phoneAccess?: PhoneAccess;
};

export type PhoneAccess = {
  /** The Agent's fixed port. Separate from `servicePort`, which treats 7777 as unset. */
  port: number;
  /**
   * What the phone should connect to, when that is not `http://<host>:<port>` — typically
   * an `https://` address in front of the Agent, which an iPhone needs for anything that
   * is not on the local network.
   */
  publicUrl?: string;
};

/**
 * A `publicUrl` the phone can use, or null: an `http(s)` origin and nothing else.
 *
 * The phone adds a machine by origin, so a path would be silently dropped and the user
 * would be looking at a code that opens a different address than the one they typed.
 */
export function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The address a phone scans to connect to this host, or null when phone access is off.
 *
 * `hostName` (the resolved name or IP) is preferred over `host`, which may be a ssh_config
 * alias that only this machine's OpenSSH understands.
 */
export function phoneAccessAddress(host: Pick<RemoteHostProfile, "host" | "hostName" | "phoneAccess">): string | null {
  const access = host.phoneAccess;
  if (!access) return null;
  const publicUrl = normalizePublicUrl(access.publicUrl);
  if (publicUrl) return publicUrl;
  const name = (host.hostName ?? host.host).trim();
  if (!name) return null;
  const bracketed = name.includes(":") && !name.startsWith("[") ? `[${name}]` : name;
  return `http://${bracketed}:${access.port}`;
}

export type RemoteWorkspaceTarget = {
  kind: "remote";
  hostId: string;
  workspaceId: string;
  root: string;
};

/**
 * The outcome of a one-shot SSH reachability check (主机列表里的「测试」).
 *
 * The check stops at the login: no Agent deploy, no forwarding. A host whose FastVibe
 * Agent is absent is still a host this machine can reach, and reporting that as a
 * failure would answer a question nobody asked.
 */
export type RemoteHostTestResult = {
  ok: boolean;
  /** What was reached, for the toast: `root@45.144.137.241:6598`. */
  target: string;
  /** Why it failed, when it did — OpenSSH's own last line where there is one. */
  error?: string;
  errorCode?: SshErrorCode;
  /** What the login found of FastVibe on the host, when it got that far. */
  agent?: RemoteAgentStatus;
};

export type RemoteAgentStatus = {
  /** Readable independent runtime release linked as `~/.fastvibe-agent/current`, if any. */
  installed?: string;
  /** Runtime release of the Agent listening on the service port, if one is. */
  running?: string;
};

/** One host key the user is asked to trust, as OpenSSH itself received it. */
export type SshHostKeyScan = {
  hostId: string;
  /** `SHA256:…` fingerprints, one per key, with their type (`ED25519`). */
  keys: Array<{ type: string; fingerprint: string }>;
  /** Where trusting writes: the first `UserKnownHostsFile` OpenSSH uses for this host. */
  knownHostsFile: string;
};

export type RemoteHostConnectionActivity =
  | "connecting"
  | "checking"
  | "agent-download"
  | "node-download"
  | "agent-fetch"
  | "agent-upload"
  | "starting-agent"
  | "forwarding";

export type RemoteHostConnectionState = {
  hostId: string | null;
  /** App Server identity; unlike hostId this is stable across transports. */
  serverInstanceId?: string | null;
  status: "disconnected" | "connecting" | "connected" | "error";
  /** The concrete SSH step, so project rows can explain a long reconnect/deploy. */
  activity?: RemoteHostConnectionActivity;
  localPort?: number;
  error?: string;
  errorCode?: SshErrorCode;
  /** The remote user's home directory, where browsing for a project starts. */
  home?: string;
  /** Recent SSH bootstrap/tunnel output shown while the client prepares the Agent. */
  output?: string[];
  /** The long transfer running right now, if any; cleared as soon as the next step logs. */
  progress?: RemoteTransferProgress;
};

/**
 * One download or upload of a connect, for a progress bar.
 *
 * - `agent-download` / `node-download`: the remote host fetching the Agent runtime or
 *   Node.js (official source first, mirror on failure).
 * - `agent-fetch`: this desktop downloading the runtime, when the host could not.
 * - `agent-upload`: this desktop pushing the runtime to the host over SSH.
 */
export type RemoteTransferProgress = {
  phase: "agent-download" | "node-download" | "agent-fetch" | "agent-upload";
  /** Bytes so far. */
  done: number;
  /** Bytes in all, when the server (or the local archive) said. */
  total?: number;
  /** Recent speed in bytes per second. */
  rate?: number;
};
