/**
 * The official remote connection, as the settings pane sees it.
 *
 * The phone reaches this desktop through FastVibe's cloud: signaling introduces them (only
 * devices signed in to the same account), and WebRTC connects them directly when it can,
 * relaying through the cloud only when it cannot. Shared by Main, which runs it, and the
 * renderer, which only shows it.
 */

/** How a connected phone is reaching this machine. */
export type OfficialPath =
  /** Still negotiating; not known yet. */
  | "connecting"
  /** Straight to this machine, on the LAN or across NATs. Costs the account nothing. */
  | "direct"
  /** Through FastVibe's relay. Counts against the account's monthly relay allowance. */
  | "relay";

export type OfficialPeer = {
  id: string;
  /** What the phone calls itself. Display only. */
  name: string;
  platform?: string;
  path: OfficialPath;
};

export type OfficialStatus =
  /** The switch is off. */
  | "off"
  /** The switch is on but there is no FastVibe account to connect as. */
  | "signed-out"
  /** Registering, or waiting for the cloud. */
  | "connecting"
  /** Reachable: a phone on this account can find this machine and connect. */
  | "online"
  /** Could not come up; `error` says why and, where it helps, what to do. */
  | "error";

export type OfficialState = {
  enabled: boolean;
  status: OfficialStatus;
  /** This machine's id in the account's device list, once registered. */
  deviceId: string | null;
  /** The name the account's device list shows. */
  deviceName: string;
  error?: string;
  peers: OfficialPeer[];
};
