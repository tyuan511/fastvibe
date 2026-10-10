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

/** The real thing: libdatachannel through `node-datachannel`. */
export function createNodeDataChannelPeer(iceServers: IceServerConfig[], log?: (message: string) => void): PeerLike {
  if (!loggerStarted) {
    loggerStarted = true;
    // Warnings and worse only; the library is chatty about every ICE step below that.
    nodeDataChannel.initLogger("Warning", (level, message) => log?.(`webrtc ${level}: ${message}`));
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
