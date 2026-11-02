import type { IrohRelayUsage } from "./iroh-relay";

export type IrohPeerPath = "connecting" | "direct" | "relay";
export type IrohRemoteStatus = "off" | "signed-out" | "connecting" | "online" | "error";

export type IrohPeer = {
  id: string;
  label: string;
  path: IrohPeerPath;
};

export type IrohRemoteState = {
  enabled: boolean;
  status: IrohRemoteStatus;
  endpointId: string | null;
  error?: string;
  peers: IrohPeer[];
  usage?: IrohRelayUsage;
};
