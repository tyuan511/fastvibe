import type { OfficialPath } from "../../shared/official.ts";
import { mappedCandidate, parseCandidate, predictedCandidates } from "./candidates.ts";
import { ChannelSocket } from "./channel-socket.ts";
import type { IceServerConfig } from "./ice.ts";
import { isGlobalV6, isPublicV4, maskAddress, type PathPlan } from "./netpath.ts";
import type { PeerChannel, PeerFactory, PeerLike, PeerOptions } from "./peer.ts";
import type { PortMapping } from "./portmap.ts";
import type { RemoteSocket } from "../server/server.ts";
import type { PeerInfo } from "./signaling.ts";

/** The one data channel label the phone opens. Anything else is not ours. */
export const CHANNEL_LABEL = "fastvibe";

const MAX_BUFFERED_SIGNALS = 64;
const MAX_SDP_CHARS = 64 * 1024;
const MAX_FRAME_BYTES = 24 * 1024 * 1024;

/**
 * How long the phone's candidates are held back for this side to find its own public address.
 *
 * They are held at all so a connectivity check cannot be the first packet on a socket a proxy
 * routes by that packet: the check is addressed at the phone's private address, and the STUN
 * request that should have followed it then went the same way and was never answered. The
 * moment this side has a server-reflexive candidate, that request has already gone out, and
 * holding on until gathering *completes* only adds the relay allocation — a round trip to
 * TURN that a phone on the same network never needed. This is the ceiling for a STUN server
 * that does not answer, after which the call goes on with whatever it has.
 */
const GATHER_WAIT_MS = 1500;

/**
 * How many of the router's next ports the phone is told to try, when the router hands them
 * out in order (`predictedCandidates`).
 *
 * The call's socket gets a new port for every destination it sends to, and the phone's
 * public address is one of several: its private addresses are tried first and each takes a
 * port on the way to nowhere, and whatever else behind that router opens a connection in
 * the same moment takes more. Measured with the real library on a network whose router
 * gives out some hundred ports a second, the port toward the phone landed 2 to 5 past the
 * STUN one in seven calls of ten, and within 20 in nine. Each port offered is a pair the
 * phone tries before its relay, so the run is long enough for that and no longer.
 */
const PREDICTED_PORTS = 20;

/**
 * On a router that hands out ports in order, how long the phone's offer is kept back for
 * its public candidate to arrive, and how long after gathering starts the phone's
 * candidates are handed over.
 *
 * What makes a guess land is how little time passes between the two packets whose ports
 * are being related: this side's STUN request, and its first packet to the phone's public
 * address. Applied at once, the offer starts the STUN request a phone's round trip before
 * that address is even known here, and on the network above the gap was 15 to 75 ports.
 * So the offer waits for it — a phone has it within a round trip to its own STUN server —
 * and the candidates then follow the STUN request by just enough to be behind it.
 */
const PAIRING_HOLD_MS = 700;
const PAIRING_GAP_MS = 25;

/**
 * How long a call that would be bound to one interface waits to learn whether the phone has
 * a public IPv6 address, after its offer arrives; and the most it waits for that offer.
 *
 * Binding gets the call past a tunnel, but a bound socket is IPv4 only. Where this computer
 * has IPv6 that the tunnel leaves alone and the phone has it too, that path needs no help
 * and is the better one, so the call is left unbound. The phone's own addresses are the
 * first candidates it sends, right behind the offer.
 */
const V6_PEEK_AFTER_OFFER_MS = 250;
const V6_PEEK_MAX_MS = 1000;

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
  /**
   * How this computer reaches the internet right now (`netpath.ts`): which server to gather
   * with, whether to bind past a tunnel, and what the router does with ports. Null, or
   * absent, is a call set up the plain way.
   */
  loadPlan?: () => Promise<PathPlan | null>;
  /** Asks the router to forward a port to the call's socket (`portmap.ts`). */
  portMap?: {
    /** A free local port to give the call, or null when there is no router to ask. */
    reserve: (localAddress: string) => Promise<number | null>;
    map: (localAddress: string, port: number) => Promise<PortMapping | null>;
  };
  sendSignal: (data: unknown) => boolean;
  /** The data channel is open: hand it to the remote server. */
  attach: (socket: RemoteSocket) => void;
  /** Something the pane shows changed (the path, or that it connected). */
  onChange: () => void;
  /**
   * The phone said which phone it is, in its offer. Called once, when the offer is applied.
   * The id is the phone's own claim, which is as far as an account's own devices are trusted.
   * `successor` is the phone saying this call replaces one of its own that is about to lose
   * its relay credential: the old one is still carrying the session and the phone closes it
   * itself once the new one has taken over.
   */
  onClientId?: (id: string, info: { successor: boolean }) => void;
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
  /** The phone offered to read compressed frames; the answer agrees, which permits sending them. */
  #deflate = false;
  /**
   * The phone's candidates, held until this side has finished finding its own.
   *
   * A candidate handed over at once starts connectivity checks at once, and on a machine
   * whose traffic goes through a proxy that decides a socket's route by its first packet,
   * those checks — addressed to the phone's private addresses — went out before the STUN
   * request did. The socket was then routed directly, the STUN request with it, and across
   * a border that drops UDP it was never answered: the call offered only this computer's
   * private addresses, and a phone off this network could not connect at all. Finishing
   * the gathering first costs one round trip and is right anywhere: the public address is
   * what a phone on another network needs most.
   */
  #held: Array<{ candidate: string; mid: string }> | null = [];
  #gatherTimer: NodeJS.Timeout | null = null;
  /** Set once this side has found its own public address, which is what the hold waits for. */
  #haveReflexive = false;
  #path: OfficialPath = "connecting";
  /** The plan this call was set up with, kept for what is decided later and for the log. */
  #plan: PathPlan | null = null;
  /** The `mid` candidates are sent under: the offer's, which the library's own lines repeat. */
  #mid = "0";
  /** The library's own server-reflexive line, which the lines written here sit beside. */
  #reflexive: string | null = null;
  /**
   * The call's socket is bound to one IPv4 address, so an IPv6 candidate from the phone can
   * only fail to send — and would take one of the few places the library keeps for the
   * phone's addresses.
   */
  #v4Only = false;
  /** The call's ports are being lined up with the phone's public candidate (`PAIRING_HOLD_MS`). */
  #pairing = false;
  #pendingOffer: { sdp: string; deflate: boolean; clientId: unknown; rollover: boolean } | null = null;
  #pairingTimer: NodeJS.Timeout | null = null;
  /** `pending` while the router is being asked: the predicted ports wait for its answer. */
  #forward: "none" | "pending" | "mapped" | "failed" = "none";
  #mapping: PortMapping | null = null;
  #predicted = false;
  /** Told each signal that arrives before there is a peer, while a call waits to see the phone's addresses. */
  #peek: ((data: unknown) => void) | null = null;
  #localKinds = new Map<string, number>();
  #remoteKinds = new Map<string, number>();
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
      // What each end offered is why: a call with only private addresses on one side could
      // never have left the local network.
      this.#deps.log.warn(`rtc ${this.cid}: no data channel after ${this.#deps.connectTimeoutMs} ms; giving up (sent ${kindsText(this.#localKinds)}; phone sent ${kindsText(this.#remoteKinds)})`);
      this.close();
    }, this.#deps.connectTimeoutMs);
    this.#timeout.unref();

    const [listed, plan] = await Promise.all([
      this.#deps.loadIce().catch((error: unknown) => {
        this.#deps.log.warn(`rtc ${this.cid}: could not load ICE servers (${String(error)}); trying without`);
        return [] as IceServerConfig[];
      }),
      this.#deps.loadPlan ? this.#deps.loadPlan().catch(() => null) : Promise.resolve(null),
    ]);
    if (this.#closed) return;
    this.#plan = plan;
    // The library uses one server of however many it is given, picked at random; a plan
    // names the one that answered from here.
    const ice = plan?.stun ? [plan.stun] : listed;

    let bind = plan?.bindAddress ?? null;
    if (plan && bind && plan.nativeV6 && await this.#phoneHasGlobalV6()) {
      bind = null;
      // What the plan measured was the bound path. Unbound, the socket leaves by the
      // tunnel, whose address and port habits are somebody else's.
      this.#plan = { ...plan, publicAddress: null, mapping: "unknown" };
    }
    if (this.#closed) return;
    // A forwarded port has to lead to the socket's own way out: the address it is bound
    // to, or the default route's when that is a real interface.
    const forwardTo = bind ?? (plan && !plan.tunnel ? plan.localAddress : null);
    const port = forwardTo && this.#deps.portMap ? await this.#deps.portMap.reserve(forwardTo).catch(() => null) : null;
    if (this.#closed) return;

    // What this call was given to work with. A phone on mobile data can only be reached
    // through an address the STUN server reports or a relay, so «no servers» here is the
    // whole explanation of a call that gathers nothing but private addresses.
    this.#deps.log.info(`rtc ${this.cid}: call from ${this.peer.name}, ${ice.length} STUN server(s)${planText(this.#plan, bind)}, after ${Date.now() - this.#startedAt} ms`);

    const options: PeerOptions = { ...(bind ? { bindAddress: bind } : {}), ...(port ? { port } : {}) };
    const special = bind !== null || port !== null;
    let pc: PeerLike;
    try {
      pc = special ? this.#deps.createPeer(ice, options) : this.#deps.createPeer(ice);
    } catch (error) {
      if (!special) {
        this.#deps.log.warn(`rtc ${this.cid}: could not create a peer connection: ${String(error)}`);
        this.close();
        return;
      }
      // The address went away, or the port was taken, between the plan and the call. The
      // plain socket is what every call had before there was a plan.
      this.#deps.log.warn(`rtc ${this.cid}: could not open the planned socket (${String(error)}); using the default`);
      try {
        pc = this.#deps.createPeer(listed);
      } catch (again) {
        this.#deps.log.warn(`rtc ${this.cid}: could not create a peer connection: ${String(again)}`);
        this.close();
        return;
      }
      this.#plan = null;
      bind = null;
    }
    this.#pc = pc;
    this.#v4Only = bind !== null;
    if (this.#plan && forwardTo && port) void this.#forwardPort(forwardTo, port);
    // Guessing ports is for a call with no forwarded port coming, on a peer whose
    // candidates can be held (a stand-in without gathering states has nothing to hold).
    this.#pairing = this.#plan?.mapping === "sequential" && port === null && pc.onGatheringStateChange !== undefined;
    pc.onLocalDescription((sdp, type) => {
      if (type === "answer") this.#deps.sendSignal({ type: "answer", sdp, ...(this.#deflate ? { deflate: true } : {}) });
    });
    pc.onLocalCandidate((candidate, mid) => {
      const sent = this.#deps.sendSignal({ type: "candidate", candidate, mid });
      const type = /\btyp (\w+)/.exec(candidate)?.[1] ?? "?";
      this.#localKinds.set(type, (this.#localKinds.get(type) ?? 0) + 1);
      // Host candidates are the common, uninteresting ones; the others decide whether a
      // phone off this network can connect at all.
      if (!sent || type !== "host") this.#deps.log.info(`rtc ${this.cid}: local ${type} candidate ${sent ? "sent" : "NOT sent (signaling is down)"}`);
      // The public address is what the hold is for. A relay candidate comes after it and
      // is a second round trip, so it must not keep a phone on this network waiting.
      if (type === "srflx" && !this.#haveReflexive) {
        this.#haveReflexive = true;
        // IPv4 is the one a router rewrites; an IPv6 line has no ports to predict.
        if (parseCandidate(candidate)?.address.includes(".")) this.#reflexive = candidate;
        // Before the phone's candidates are handed over: once they are, this socket starts
        // taking the router's next ports, and the phone should already be trying them.
        this.#predictPorts();
        this.#releaseCandidates();
      }
    });
    pc.onStateChange((state) => {
      if (state === "failed" || state === "closed") this.close();
    });
    if (pc.onGatheringStateChange) {
      pc.onGatheringStateChange((state) => {
        if (state === "complete") this.#releaseCandidates();
      });
    } else {
      this.#held = null;
    }
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
      this.#peek?.(data);
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
    if (this.#gatherTimer) clearTimeout(this.#gatherTimer);
    if (this.#pairingTimer) clearTimeout(this.#pairingTimer);
    this.#timeout = this.#poll = this.#gatherTimer = this.#pairingTimer = null;
    this.#pendingOffer = null;
    this.#held = null;
    this.#peek = null;
    const mapping = this.#mapping;
    this.#mapping = null;
    if (mapping) void mapping.release();
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
    const message = data as { type?: unknown; sdp?: unknown; candidate?: unknown; mid?: unknown; client_id?: unknown; deflate?: unknown; rollover?: unknown };
    try {
      if (message.type === "offer" && typeof message.sdp === "string" && message.sdp.length <= MAX_SDP_CHARS) {
        const offer = { sdp: message.sdp, deflate: message.deflate === true, clientId: message.client_id, rollover: message.rollover === true };
        if (this.#pairing && this.#held && !this.#pendingOffer && !this.#held.some(({ candidate }) => isPublicReflexive(candidate))) {
          this.#pendingOffer = offer;
          this.#pairingTimer = setTimeout(() => this.#applyPendingOffer(), PAIRING_HOLD_MS);
          this.#pairingTimer.unref();
          return;
        }
        this.#applyOffer(pc, offer);
        if (this.#pairing) this.#releaseSoon();
      } else if (message.type === "candidate" && typeof message.candidate === "string" && message.candidate.length <= 2048) {
        if (!usableRemoteCandidate(message.candidate)) return;
        if (this.#v4Only && parseCandidate(message.candidate)?.address.includes(":")) return;
        const kind = /\btyp (\w+)/.exec(message.candidate)?.[1] ?? "?";
        this.#remoteKinds.set(kind, (this.#remoteKinds.get(kind) ?? 0) + 1);
        const mid = typeof message.mid === "string" ? message.mid : "0";
        if (this.#held) {
          if (this.#held.length < MAX_BUFFERED_SIGNALS) this.#held.push({ candidate: message.candidate, mid });
          if (this.#pendingOffer && isPublicReflexive(message.candidate)) this.#applyPendingOffer();
          return;
        }
        pc.addRemoteCandidate(message.candidate, mid);
      }
    } catch (error) {
      // A bad description or candidate from the far end is that call's problem only.
      this.#deps.log.warn(`rtc ${this.cid}: rejected a signal: ${String(error)}`);
    }
  }

  #applyOffer(pc: PeerLike, offer: { sdp: string; deflate: boolean; clientId: unknown; rollover: boolean }): void {
    // Before the offer is applied: the answer it produces has to carry the agreement.
    this.#deflate = offer.deflate;
    this.#mid = /^a=mid:(\S+)/m.exec(offer.sdp)?.[1] ?? this.#mid;
    pc.setRemoteDescription(offer.sdp, "offer");
    // Applying the offer is what starts this side's gathering.
    if (this.#held && !this.#gatherTimer) {
      this.#gatherTimer = setTimeout(() => this.#releaseCandidates(), GATHER_WAIT_MS);
      this.#gatherTimer.unref();
    }
    const id = offer.clientId;
    if (typeof id === "string" && id.length > 0 && id.length <= 128 && !this.#clientId) {
      this.#clientId = id;
      this.#deps.onClientId?.(id, { successor: offer.rollover });
    }
  }

  /** The phone's public candidate is here, or has been waited for long enough: start gathering. */
  #applyPendingOffer(): void {
    const offer = this.#pendingOffer;
    const pc = this.#pc;
    if (this.#pairingTimer) clearTimeout(this.#pairingTimer);
    this.#pairingTimer = null;
    this.#pendingOffer = null;
    if (!offer || !pc || this.#closed) return;
    try {
      this.#applyOffer(pc, offer);
    } catch (error) {
      this.#deps.log.warn(`rtc ${this.cid}: rejected a signal: ${String(error)}`);
      return;
    }
    this.#releaseSoon();
  }

  /** Hand the phone's candidates over just behind this side's STUN request, not a round trip later. */
  #releaseSoon(): void {
    const timer = setTimeout(() => this.#releaseCandidates(), PAIRING_GAP_MS);
    timer.unref();
  }

  /** Hand the phone's candidates over, now that this side has its public address (or has waited long enough). */
  #releaseCandidates(): void {
    const held = this.#held;
    if (!held) return;
    this.#held = null;
    if (this.#gatherTimer) clearTimeout(this.#gatherTimer);
    this.#gatherTimer = null;
    const pc = this.#pc;
    if (!pc || this.#closed) return;
    for (const { candidate, mid } of held) {
      try {
        pc.addRemoteCandidate(candidate, mid);
      } catch (error) {
        this.#deps.log.warn(`rtc ${this.cid}: rejected a signal: ${String(error)}`);
      }
    }
  }

  /**
   * Whether the phone has offered a public IPv6 address of its own, waiting a moment for
   * its first candidates if they are not here yet.
   */
  #phoneHasGlobalV6(): Promise<boolean> {
    const isOffer = (data: unknown): boolean => (data as { type?: unknown } | null)?.type === "offer";
    const hasV6 = (data: unknown): boolean => {
      const message = data as { type?: unknown; candidate?: unknown } | null;
      if (message?.type !== "candidate" || typeof message.candidate !== "string") return false;
      const parsed = parseCandidate(message.candidate);
      return parsed !== null && parsed.type === "host" && isGlobalV6(parsed.address);
    };
    if (this.#buffered.some(hasV6)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let short: NodeJS.Timeout | null = null;
      const finish = (value: boolean): void => {
        clearTimeout(long);
        if (short) clearTimeout(short);
        this.#peek = null;
        resolve(value);
      };
      const afterOffer = (): void => {
        short ??= setTimeout(() => finish(false), V6_PEEK_AFTER_OFFER_MS);
        short.unref();
      };
      const long = setTimeout(() => finish(false), V6_PEEK_MAX_MS);
      long.unref();
      this.#peek = (data) => {
        if (hasV6(data)) finish(true);
        else if (isOffer(data)) afterOffer();
      };
      if (this.#buffered.some(isOffer)) afterOffer();
    });
  }

  /** Ask the router to forward a port to this call's socket, and tell the phone when it has. */
  async #forwardPort(localAddress: string, port: number): Promise<void> {
    const portMap = this.#deps.portMap;
    if (!portMap) return;
    this.#forward = "pending";
    const mapping = await portMap.map(localAddress, port).catch(() => null);
    if (this.#closed) {
      if (mapping) void mapping.release();
      return;
    }
    // A router whose own address is not the one the internet sees this computer at is
    // behind another NAT, and its forwarded port leads nowhere.
    const known = this.#plan?.publicAddress ?? null;
    if (!mapping || (known !== null && mapping.externalAddress !== known)) {
      if (mapping) void mapping.release();
      this.#forward = "failed";
      this.#predictPorts();
      return;
    }
    this.#mapping = mapping;
    this.#forward = "mapped";
    const sent = this.#deps.sendSignal({ type: "candidate", candidate: mappedCandidate(mapping.externalAddress, mapping.externalPort, this.#reflexive), mid: this.#mid });
    this.#deps.log.info(`rtc ${this.cid}: router forwards a port (${mapping.protocol}) ${sent ? "sent" : "NOT sent (signaling is down)"}`);
  }

  /**
   * Tell the phone the ports the router is about to give this socket, when it hands them
   * out in order. Not when a port is being forwarded: that one takes a packet from
   * anywhere, and the guesses would only be noise beside it.
   */
  #predictPorts(): void {
    if (this.#predicted || this.#closed || !this.#reflexive) return;
    if (this.#plan?.mapping !== "sequential" || this.#forward === "pending" || this.#forward === "mapped") return;
    this.#predicted = true;
    const candidates = predictedCandidates(this.#reflexive, PREDICTED_PORTS);
    if (candidates.length === 0) return;
    // One message for the lot: the service counts messages on this computer's one
    // signaling socket and closes it when they come too fast, and a phone that
    // reconnects a few times in a row would otherwise send a hundred in a second. A
    // phone that does not know this message ignores it and connects as it did before.
    const sent = this.#deps.sendSignal({ type: "candidates", candidates, mid: this.#mid });
    this.#deps.log.info(`rtc ${this.cid}: router hands out ports in order; next ${candidates.length} ${sent ? "offered" : "NOT sent (signaling is down)"}`);
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
      this.#deps.log.info(`rtc ${this.cid}: channel open after ${this.#connectedAt - this.#startedAt} ms${this.#deflate ? ", deflate available" : ""}`);
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
    // Compress only once the relay is confirmed. Until ICE nominates — and on a direct
    // path, which is the usual LAN case — frames go out as they are: deflating them on
    // this thread costs more than the bytes save.
    // `null` until ICE nominates: neither the relay's compression nor the direct path's
    // larger fragments, both of which want a path that has actually been selected.
    this.#socket?.setCompress(path === null ? null : path === "relay");
    const next: OfficialPath = path ?? "connecting";
    if (next === this.#path) return;
    this.#path = next;
    const pair = this.#pc?.selectedPair?.() ?? null;
    const made = pair ? ` (${pair.local} to ${pair.remote}, ${pair.family})` : "";
    this.#deps.log.info(`rtc ${this.cid}: path ${next}${made}${next === "relay" && this.#deflate ? ", compressed" : ""}`);
    this.#deps.onChange();
  }
}

/** A phone's server-reflexive candidate at a public IPv4 address: where a guessed port has to lead. */
function isPublicReflexive(line: string): boolean {
  const parsed = parseCandidate(line);
  return parsed !== null && parsed.type === "srflx" && isPublicV4(parsed.address);
}

/** `host:2 srflx:1` — how many candidates of each kind, for the log. */
function kindsText(kinds: Map<string, number>): string {
  return kinds.size === 0 ? "none" : [...kinds].map(([kind, count]) => `${kind}:${count}`).join(" ");
}

/** What the plan changed about this call, for the log; nothing when there was no plan. */
function planText(plan: PathPlan | null, bind: string | null): string {
  if (!plan) return "";
  const parts: string[] = [];
  if (bind) parts.push(`bound to ${maskAddress(bind)} past a tunnel`);
  else if (plan.tunnel) parts.push("through a tunnel");
  parts.push(`public ${maskAddress(plan.publicAddress)}`, `router ports ${plan.mapping}`);
  return `, ${parts.join(", ")}`;
}
