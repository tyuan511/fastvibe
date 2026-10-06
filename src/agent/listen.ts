/**
 * Where the headless Agent listens.
 *
 * Loopback by default, because the desktop reaches it through an SSH forward and nothing
 * else should. A phone cannot make that hop, so a host that has been set up for one starts
 * the Agent with `--host=0.0.0.0` — and only that, not an arbitrary interface: the two
 * values are the two states the bootstrap and the preflight know how to compare, and an
 * address nobody planned for would be a state they cannot tell apart from the other.
 *
 * Listening beyond loopback is refused by the server itself unless a password is set
 * (`RemoteServer.start`), so a bad value here can fail to start but not expose anything.
 */
export type AgentListen = {
  host: "127.0.0.1" | "0.0.0.0";
  /** Reachable from other machines. Recorded in the state file as `public`. */
  exposed: boolean;
};

export function resolveListenHost(value: string | undefined): AgentListen {
  const text = (value ?? "").trim();
  if (!text || text === "127.0.0.1" || text === "localhost") return { host: "127.0.0.1", exposed: false };
  if (text === "0.0.0.0") return { host: "0.0.0.0", exposed: true };
  throw new Error(`Agent 监听地址无效：${text}（只支持 127.0.0.1 或 0.0.0.0）`);
}
