import nodeDataChannel from "node-datachannel";
import type { DataChannelLike } from "./channel-socket.ts";
import type { IceServerConfig } from "./ice.ts";

/**
 * The slice of a WebRTC peer connection the responder uses, so the responder can be
 * tested against a fake and the native library is loaded in exactly one place.
 */
export interface PeerChannel extends DataChannelLike {
  getLabel(): string;
  onOpen(callback: () => void): void;
}

export interface PeerLike {
  onLocalDescription(callback: (sdp: string, type: string) => void): void;
  onLocalCandidate(callback: (candidate: string, mid: string) => void): void;
  onStateChange(callback: (state: string) => void): void;
  /** `new`, `in-progress`, then `complete` once every local candidate has been found. */
  onGatheringStateChange?(callback: (state: string) => void): void;
  onDataChannel(callback: (channel: PeerChannel) => void): void;
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void;
  addRemoteCandidate(candidate: string, mid: string): void;
  /** Which kind of path was chosen, once one has been: `relay` if either end is a relay. */
  selectedPath(): "direct" | "relay" | null;
  close(): void;
}

export type PeerFactory = (iceServers: IceServerConfig[]) => PeerLike;

let loggerStarted = false;

/**
 * How long SCTP waits before acknowledging data it has nothing else to send with.
 *
 * libdatachannel already lowers usrsctp's 200ms to 20ms. On a direct path a round trip is
 * about a millisecond, so 20ms is the whole of a small frame's delay and far more than the
 * HTTP listener spends on the same byte. 5ms keeps the acknowledgement off the round trip
 * without acknowledging every fragment on its own.
 */
const SACK_DELAY_MS = 5;

/**
 * How many MTUs the first burst may send before an acknowledgement comes back.
 *
 * The library's 10 (RFC 6928) is right for the open internet and slow for a LAN: a snapshot
 * is several times that, so it trickles out over the first few round trips. 64 is about
 * 80KB, one direct-path fragment plus room for the next, and still small enough that a
 * relayed path — which shares this setting, since usrsctp keeps one for the process — does
 * not open by flooding the relay.
 */
const INITIAL_CONGESTION_WINDOW_MTU = 64;

/** Apply once. The library keeps one set of SCTP settings for the whole process. */
function tuneSctp(): void {
  nodeDataChannel.setSctpSettings({
    delayedSackTime: SACK_DELAY_MS,
    initialCongestionWindow: INITIAL_CONGESTION_WINDOW_MTU,
  });
}

/** The real thing: libdatachannel through `node-datachannel`. */
export function createNodeDataChannelPeer(iceServers: IceServerConfig[], log?: (message: string) => void): PeerLike {
  if (!loggerStarted) {
    loggerStarted = true;
    // Warnings and worse only; the library is chatty about every ICE step below that.
    nodeDataChannel.initLogger("Warning", (level, message) => log?.(`webrtc ${level}: ${message}`));
    // Before any peer exists: a setting applied after usrsctp has started is ignored.
    tuneSctp();
  }
  const pc = new nodeDataChannel.PeerConnection("fastvibe-desktop", { iceServers });
  return {
    onLocalDescription: (cb) => pc.onLocalDescription(cb),
    onLocalCandidate: (cb) => pc.onLocalCandidate(cb),
    onStateChange: (cb) => pc.onStateChange(cb),
    onGatheringStateChange: (cb) => pc.onGatheringStateChange(cb),
    onDataChannel: (cb) => pc.onDataChannel((channel) => cb(channel as unknown as PeerChannel)),
    setRemoteDescription: (sdp, type) => pc.setRemoteDescription(sdp, type),
    addRemoteCandidate: (candidate, mid) => pc.addRemoteCandidate(candidate, mid),
    selectedPath() {
      const pair = pc.getSelectedCandidatePair();
      if (!pair) return null;
      const kinds = [pair.local.type, pair.remote.type].map((type) => type.toLowerCase());
      return kinds.includes("relay") ? "relay" : "direct";
    },
    close: () => pc.close(),
  };
}

/** Release the native library's threads; call once, as the app quits. */
export function shutdownWebRtc(): void {
  if (!loggerStarted) return;
  try {
    nodeDataChannel.cleanup();
  } catch {
    // quitting anyway
  }
}
