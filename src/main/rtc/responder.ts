import type { OfficialPath } from "../../shared/official.ts";
import { ChannelSocket } from "./channel-socket.ts";
import type { IceServerConfig } from "./ice.ts";
import type { PeerChannel, PeerFactory, PeerLike } from "./peer.ts";
import type { RemoteSocket } from "../server/server.ts";
import type { PeerInfo } from "./signaling.ts";

/** The one data channel label the phone opens. Anything else is not ours. */
export const CHANNEL_LABEL = "fastvibe";

const MAX_BUFFERED_SIGNALS = 64;
const MAX_SDP_CHARS = 64 * 1024;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;

/**
 * Whether a phone's candidate can pair with anything here. libjuice keeps only ten remote
 * candidates per call and refuses the rest — including the phone's own address as its checks
 * reveal it — so a call that fills the list with TCP twins and link-local addresses never
 * connects while the phone's STUN requests are visibly arriving.
 */
export function usableRemoteCandidate(line: string): boolean {
  const fields = line.trim().replace(/^a=/, "").split(/\s+/);
  if (fields.length < 5) return false;
  if (fields[2]?.toLowerCase() !== "udp") return false;
  const address = fields[4]?.toLowerCase() ?? "";
  if (address.startsWith("fe80:") || address.startsWith("127.") || address === "::1") return false;
  return true;
}

export type ResponderDeps = {
  cid: string;
  peer: PeerInfo;
  createPeer: PeerFactory;
  /** Fresh STUN/TURN servers for this call. Failing is survivable: LAN still works without. */
  loadIce: () => Promise<IceServerConfig[]>;
  sendSignal: (data: unknown) => boolean;
  /** The data channel is open: hand it to the remote server. */
  attach: (socket: RemoteSocket) => void;
  /** Something the pane shows changed (the path, or that it connected). */
  onChange: () => void;
  /**
   * The phone said which phone it is, in its offer. Called once, when the offer is applied.
   * The id is the phone's own claim, which is as far as an account's own devices are trusted.
   */
  onClientId?: (id: string) => void;
  /** This call is over, whichever way. Called once. */
  onEnd: () => void;
  /** How long a call may take to open its channel before it is abandoned. */
  connectTimeoutMs: number;
  pathPollMs: number;
  log: { info(message: string): void; warn(message: string): void };
};

/**
 * One phone's connection attempt, from this desktop's side: it answers.
 *
 * The phone offers (it opens the data channel), this side applies the offer, sends the
 * answer, and both trickle candidates over the signaling. When the channel opens it is
 * wrapped as a socket and handed to the remote server — from then on signaling plays no
 * part, which is why a `hangup` after that point is ignored: the phone sends one to free
 * its slot, not to end the connection.
 */
export class Responder {
  readonly cid: string;
  readonly peer: PeerInfo;
  #deps: ResponderDeps;
  #pc: PeerLike | null = null;
  #socket: ChannelSocket | null = null;
  #buffered: unknown[] = [];
  #closed = false;
  #connected = false;
  #connectedAt = 0;
  #startedAt = Date.now();
  #clientId: string | null = null;
  /** The phone offered to read compressed frames; the answer agrees and the socket then sends them. */
  #deflate = false;
  #path: OfficialPath = "connecting";
  #timeout: NodeJS.Timeout | null = null;
  #poll: NodeJS.Timeout | null = null;

  constructor(deps: ResponderDeps) {
    this.#deps = deps;
    this.cid = deps.cid;
    this.peer = deps.peer;
  }

  get path(): OfficialPath {
    return this.#path;
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** The phone's stable id from its offer, or null for a phone that does not send one. */
  get clientId(): string | null {
    return this.#clientId;
  }

  /** When the data channel opened (ms since the epoch); 0 until then. */
  get connectedAt(): number {
    return this.#connectedAt;
  }

  async start(): Promise<void> {
    this.#timeout = setTimeout(() => {
      this.#deps.log.warn(`rtc ${this.cid}: no data channel after ${this.#deps.connectTimeoutMs} ms; giving up`);
      this.close();
    }, this.#deps.connectTimeoutMs);
    this.#timeout.unref();

    let ice: IceServerConfig[] = [];
    try {
      ice = await this.#deps.loadIce();
    } catch (error) {
      this.#deps.log.warn(`rtc ${this.cid}: could not load ICE servers (${String(error)}); trying without`);
    }
    if (this.#closed) return;
    // What this call was given to work with. A phone on mobile data can only be reached
    // through an address the STUN server reports or a relay, so «no servers» here is the
    // whole explanation of a call that gathers nothing but private addresses.
    this.#deps.log.info(`rtc ${this.cid}: call from ${this.peer.name}, ${ice.length} STUN server(s), after ${Date.now() - this.#startedAt} ms`);

    let pc: PeerLike;
    try {
      pc = this.#deps.createPeer(ice);
    } catch (error) {
      this.#deps.log.warn(`rtc ${this.cid}: could not create a peer connection: ${String(error)}`);
      this.close();
      return;
    }
    this.#pc = pc;
    pc.onLocalDescription((sdp, type) => {
      if (type === "answer") this.#deps.sendSignal({ type: "answer", sdp, ...(this.#deflate ? { deflate: true } : {}) });
    });
    pc.onLocalCandidate((candidate, mid) => {
      const sent = this.#deps.sendSignal({ type: "candidate", candidate, mid });
      const type = /\btyp (\w+)/.exec(candidate)?.[1] ?? "?";
      // Host candidates are the common, uninteresting ones; the others decide whether a
      // phone off this network can connect at all.
      if (!sent || type !== "host") this.#deps.log.info(`rtc ${this.cid}: local ${type} candidate ${sent ? "sent" : "NOT sent (signaling is down)"}`);
    });
    pc.onStateChange((state) => {
      if (state === "failed" || state === "closed") this.close();
    });
    pc.onDataChannel((channel) => this.#onChannel(channel));

    const waiting = this.#buffered;
    this.#buffered = [];
    for (const data of waiting) this.#apply(data);
  }

  /** A signal from the phone. */
  signal(data: unknown): void {
    if (this.#closed) return;
    if (!this.#pc) {
      // The ICE servers are still being fetched. Order matters (offer, then candidates),
      // so hold them all and replay in sequence.
      if (this.#buffered.length < MAX_BUFFERED_SIGNALS) this.#buffered.push(data);
      return;
    }
    this.#apply(data);
  }

  /** The phone hung up on signaling. Once the channel is up that only frees its slot. */
  remoteHangup(): void {
    if (!this.#connected) this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timeout) clearTimeout(this.#timeout);
    if (this.#poll) clearInterval(this.#poll);
    this.#timeout = this.#poll = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "closing");
    try {
      this.#pc?.close();
    } catch {
      // already gone
    }
    this.#pc = null;
    this.#deps.onEnd();
  }

  #apply(data: unknown): void {
    const pc = this.#pc;
    if (!pc || typeof data !== "object" || data === null) return;
    const message = data as { type?: unknown; sdp?: unknown; candidate?: unknown; mid?: unknown; client_id?: unknown; deflate?: unknown };
    try {
      if (message.type === "offer" && typeof message.sdp === "string" && message.sdp.length <= MAX_SDP_CHARS) {
        // Before the offer is applied: the answer it produces has to carry the agreement.
        this.#deflate = message.deflate === true;
        pc.setRemoteDescription(message.sdp, "offer");
        const id = message.client_id;
        if (typeof id === "string" && id.length > 0 && id.length <= 128 && !this.#clientId) {
          this.#clientId = id;
          this.#deps.onClientId?.(id);
        }
      } else if (message.type === "candidate" && typeof message.candidate === "string" && message.candidate.length <= 2048) {
        if (!usableRemoteCandidate(message.candidate)) return;
        pc.addRemoteCandidate(message.candidate, typeof message.mid === "string" ? message.mid : "0");
      }
    } catch (error) {
      // A bad description or candidate from the far end is that call's problem only.
      this.#deps.log.warn(`rtc ${this.cid}: rejected a signal: ${String(error)}`);
    }
  }

  #onChannel(channel: PeerChannel): void {
    if (this.#closed) {
      channel.close();
      return;
    }
    // One channel, with the label we expect. The phone is the same account but the peer
    // is still a program we did not write; do not let it open whatever it likes.
    if (channel.getLabel() !== CHANNEL_LABEL || this.#socket) {
      channel.close();
      return;
    }
    const attach = (): void => {
      if (this.#closed || this.#socket) return;
      const socket = new ChannelSocket(channel, { maxFrameBytes: MAX_FRAME_BYTES, compress: this.#deflate });
      this.#socket = socket;
      this.#connected = true;
      this.#connectedAt = Date.now();
      this.#deps.log.info(`rtc ${this.cid}: channel open after ${this.#connectedAt - this.#startedAt} ms${this.#deflate ? ", compressed" : ""}`);
      if (this.#timeout) clearTimeout(this.#timeout);
      this.#timeout = null;
      socket.once("close", () => this.close());
      this.#refreshPath();
      this.#poll = setInterval(() => this.#refreshPath(), this.#deps.pathPollMs);
      this.#poll.unref();
      this.#deps.attach(socket);
      this.#deps.onChange();
    };
    if (channel.isOpen()) attach();
    else channel.onOpen(attach);
  }

  #refreshPath(): void {
    const path = this.#pc?.selectedPath() ?? null;
    const next: OfficialPath = path ?? "connecting";
    if (next === this.#path) return;
    this.#path = next;
    this.#deps.onChange();
  }
}
