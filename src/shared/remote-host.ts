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
  /** SSH password authentication secret, stored only in the 0600 host profile. */
  password?: string;
  knownHostsFile?: string;
  /** The remote FastVibe service port, normally bound to loopback. */
  servicePort?: number;
  /** Port on the local machine used for the SSH forward. */
  localPort?: number;
};

export type RemoteWorkspaceTarget = {
  kind: "remote";
  hostId: string;
  workspaceId: string;
  root: string;
};

export type RemoteHostConnectionState = {
  hostId: string | null;
  status: "disconnected" | "connecting" | "connected" | "error";
  localPort?: number;
  error?: string;
  /** Recent SSH bootstrap/tunnel output shown while the client prepares the Agent. */
  output?: string[];
};
