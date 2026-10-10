import { Ipc } from "@shared/ipc";
import type { RemoteServerState } from "@shared/ipc";
import type { OfficialState } from "@shared/official";
import { broadcast, subscribe } from "./ipc/broadcast";
import { dispatch, handle, handlerChannels } from "./ipc/registry";
import { getFastVibePaths } from "./engine/paths";
import { log } from "./engine/logger";
import { readAppSettings, writeAppSettings } from "./engine/app-settings";
import { passwordProblem } from "./server/auth";
import { clearRemoteAccess, isConfigured, listDevices, revokeDevice, setPassword } from "./server/store";
import { lanAddresses, RemoteServer } from "./server/server";
import { MdnsAdvertiser, mdnsInstanceName } from "./server/mdns";
import { defaultDeviceName, deviceNameProblem, deviceNameSetting } from "@shared/device-name";
import { uiText } from "./engine/ui-text";
import { getAppServer } from "./app-server/runtime";
import { setRemoteServing } from "./engine/keep-awake";
import type { AccountService } from "./engine/account";
import { hostname } from "node:os";
import { createNodeDataChannelPeer, shutdownWebRtc } from "./rtc/peer";
import { OfficialConnection } from "./rtc/official";

/**
 * Where remote access meets the desktop app.
 *
 * One switch turns on two ways in. Phones signed in to the same FastVibe account reach
 * this computer through `rtc/official.ts`: signaling introduces two sessions of the
 * account and a WebRTC data channel carries the App Protocol, with no address and no
 * password. And once a password is set, phones on the local network use the listener
 * below, found by mDNS or by scanning the address's QR code. Both end in the same
 * `RemoteServer`, which applies the remote policy and runs the protocol.
 *
 * Everything Electron-shaped lives here — the setting that decides whether it runs, the
 * methods the settings pane calls, the paths — so that `server/` itself stays free of
 * Electron and the headless Agent can use it too.
 *
 * The server is handed the *same* `dispatch` and `subscribe` the windows use. That is
 * the whole point of the table: a method is reachable both ways by construction, and a
 * push written for a window reaches a phone without the push site knowing it exists.
 */

let server: RemoteServer | null = null;
let official: OfficialConnection | null = null;
let mdns: MdnsAdvertiser | null = null;

/** Default port for the LAN listener. */
const DEFAULT_PORT = 7777;

function instance(): RemoteServer {
  return (server ??= new RemoteServer({
    accessFile: getFastVibePaths().remoteAccessFile,
    appServer: getAppServer(),
    channels: () => handlerChannels(),
    dispatch: (method, payload, clientId) =>
      // A remote caller has no window: the handlers that need one are denied by the
      // policy before they get here, and the rest read `ctx.window` as null.
      dispatch(method, payload, { kind: "remote", window: null, origin: clientId }),
    subscribe: (client) => subscribe(client),
    onStatusChange: announceFromServer,
    log: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message, error) => log.error(message, error),
    },
  }));
}

/** The remote server, for the other transports that attach connections to it. */
export function remoteServer(): RemoteServer {
  return instance();
}

function mdnsInstance(): MdnsAdvertiser {
  return (mdns ??= new MdnsAdvertiser({
    log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
  }));
}

/**
 * Keep the mDNS announcement equal to «the LAN listener is up».
 *
 * Derived from the server's own status rather than toggled at each call site, and called
 * from the announce path: the places that start, stop or rebind the listener are many and
 * the next one added would otherwise leave a phone listing a machine that is gone. The
 * record carries one address family — the phone's discovery hands back a single address
 * per service, and a link-local IPv6 one is of no use — so IPv4 wins when this machine
 * has one, even though the listener answers on both.
 */
function syncDiscovery(): void {
  const status = server?.status;
  if (status?.running && status.port !== null) {
    const addresses = lanAddresses();
    mdnsInstance().publish(status.port, mdnsInstanceName(deviceName()), addresses.ipv4 || !addresses.ipv6 ? "ipv4" : "ipv6");
  } else mdns?.unpublish();
}

function readPort(): number {
  const value = readAppSettings(getFastVibePaths()).remotePort;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536
    ? value
    : DEFAULT_PORT;
}

/**
 * Listen on every interface, on IPv4 and IPv6 at once: `::` is dual-stack, so one socket
 * answers both families and a phone is not told which of them to use. A machine with IPv6
 * switched off cannot bind it, and gets IPv4 alone.
 */
async function startListener(port: number): Promise<void> {
  try {
    await instance().start({ port, host: "::" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL" && code !== "EPROTONOSUPPORT") throw error;
    log.warn("IPv6 is not available here; the LAN listener is IPv4 only");
    await instance().start({ port, host: "0.0.0.0" });
  }
}

/** The name chosen in settings; empty follows the computer's own name. */
function readChosenName(): string {
  const settings = readAppSettings(getFastVibePaths());
  // `remoteDiscoveryName` is what this was called while it named the computer on the LAN.
  return deviceNameSetting(settings.remoteDeviceName ?? settings.remoteDiscoveryName);
}

/** The computer's own name, used until one is chosen. */
function computerName(): string {
  return defaultDeviceName(hostname());
}

/** The name the account's device list, the console and the phone show for this computer. */
function deviceName(): string {
  return readChosenName() || computerName();
}

/**
 * Whether remote access is switched on, which is a preference rather than a running
 * thing: it turns on both ways in at once — the password-protected LAN listener when a
 * password is set, and the official connection (phones signed in to this account) when
 * someone is signed in. Either may be unavailable for want of its prerequisite without
 * the switch turning itself off, so the pane can say what is missing.
 */
function readEnabled(): boolean {
  return readAppSettings(getFastVibePaths()).remoteEnabled === true;
}

function writeEnabled(enabled: boolean): void {
  const paths = getFastVibePaths();
  writeAppSettings(paths, { ...readAppSettings(paths), remoteEnabled: enabled });
}

/** The one state the pane draws everything from. */
function state(): RemoteServerState {
  return {
    ...instance().status,
    enabled: readEnabled(),
    lanAddresses: lanAddresses(),
    deviceName: readChosenName(),
    defaultDeviceName: computerName(),
    official: official?.state() ?? OFFICIAL_OFF,
  };
}

const OFFICIAL_OFF: OfficialState = {
  enabled: false,
  status: "off",
  deviceId: null,
  deviceName: "",
  peers: [],
};

/** Push the state to every window, so two settings panes cannot disagree. */
function announce(): RemoteServerState {
  const next = state();
  // Either way in is a reason not to sleep under a phone that is looking for this machine.
  setRemoteServing(next.running, "listener");
  setRemoteServing(next.official.enabled && next.official.status === "online", "official");
  syncDiscovery();
  broadcast(Ipc.remoteState, next);
  return next;
}

/**
 * The `onStatusChange` callback the server and the official connection are handed: a
 * phone attached or dropped, or the official connection changed.
 *
 * A plain function, not `() => announce()` inlined at either construction site: that
 * expression calls `instance()` while `instance()` is still in the middle of building the
 * very object it would return, before `server` has been assigned — the memoized
 * `server ??= new RemoteServer(...)` never completes, and each nested call builds another
 * one. This only ever runs later, from inside their own event handlers.
 */
function announceFromServer(): void {
  if (!server) return;
  announce();
}

/**
 * Bring up whichever ways in the machine is able to offer, for the switch being on.
 *
 * The listener needs a password and the official connection needs a signed-in account;
 * neither failing for want of its prerequisite is an error here — the pane shows what is
 * missing. A listener that cannot bind (the port is taken) is one: that throws.
 */
async function bringUp(): Promise<RemoteServerState> {
  if (isConfigured(getFastVibePaths().remoteAccessFile)) await startListener(readPort());
  official?.setEnabled(true);
  return announce();
}

export function registerRemoteIpc(queueSettingsWrite: (task: () => Promise<void>) => Promise<void>, account: AccountService): void {
  official = new OfficialConnection({
    account: { token: () => account.token(), origin: () => account.origin() },
    attach: (socket, peer) => instance().attachTransport(socket, peer),
    installFile: getFastVibePaths().rtcDeviceFile,
    deviceName,
    platform: process.platform,
    onChange: () => announceFromServer(),
    createPeer: (iceServers) => createNodeDataChannelPeer(iceServers, (message) => log.warn(message)),
    log: { info: (message) => log.info(message), warn: (message) => log.warn(message) },
  });
  // Signing in or out, or a refresh finding the token revoked, decides whether there is
  // anyone to be reachable as.
  account.subscribe(() => official?.accountChanged());

  handle(Ipc.remoteGetState, () => state());

  handle(Ipc.remoteSetPassword, async (payload: { password: string }) => {
    const password = typeof payload?.password === "string" ? payload.password : "";
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    setPassword(getFastVibePaths().remoteAccessFile, password);
    // Every previously issued token stopped working with the old password, so any client
    // still connected is now holding one that no longer resolves. With the switch already
    // on, the password is the last thing the listener was waiting for.
    if (readEnabled() && !instance().status.running) {
      try {
        await startListener(readPort());
      } catch (error) {
        announce();
        throw error;
      }
    }
    return announce();
  });

  /**
   * Remove the password, which is what the listener needs to exist: it stops, and the LAN
   * goes with it. The official connection is not the password's to take down — it
   * authenticates by account — so the switch itself is left as it was.
   */
  handle(Ipc.remoteClearPassword, async () => {
    await instance().stop();
    clearRemoteAccess(getFastVibePaths().remoteAccessFile);
    return announce();
  });

  handle(Ipc.remoteStart, async (payload?: { port?: number }) => {
    const paths = getFastVibePaths();
    if (typeof payload?.port === "number") writeAppSettings(paths, { ...readAppSettings(paths), remotePort: payload.port });
    writeEnabled(true);
    try {
      return await bringUp();
    } catch (error) {
      announce();
      throw error;
    }
  });

  handle(Ipc.remoteSetDeviceName, async (payload?: { name?: unknown }) => {
    if (typeof payload?.name !== "string") throw new Error(uiText("电脑名称无效", "Invalid computer name"));
    const name = payload.name.trim();
    const problem = deviceNameProblem(name);
    if (problem === "invalidCharacters") throw new Error(uiText("名称不能包含控制字符", "Names cannot contain control characters"));
    if (problem === "tooLong") throw new Error(uiText(
      "名称过长，请缩短后重试（最多 64 个字符）", "Name is too long; shorten it and try again (64 characters maximum)",
    ));
    await queueSettingsWrite(async () => {
      const paths = getFastVibePaths();
      const { remoteDiscoveryName: _legacy, ...rest } = readAppSettings(paths) as Record<string, unknown>;
      const settings = { ...rest, remoteDeviceName: name };
      writeAppSettings(paths, settings);
      broadcast(Ipc.settingsChanged, settings);
    });
    // The account's device list and the phones' lists carry the name, so tell the cloud.
    await official?.renamed();
    return announce();
  });

  handle(Ipc.remoteStop, async () => {
    official?.setEnabled(false);
    await instance().stop();
    writeEnabled(false);
    return announce();
  });

  handle(Ipc.remoteListDevices, () => listDevices(getFastVibePaths().remoteAccessFile));

  handle(Ipc.remoteRevokeDevice, (payload: { id: string }) => {
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (!id) throw new Error("设备无效");
    revokeDevice(getFastVibePaths().remoteAccessFile, id);
    // Revoking is something a user does about a device they no longer trust, so the
    // connection it already holds has to go with the token — otherwise the socket that
    // is open right now keeps working until it happens to drop.
    instance().disconnectDevice(id);
    announce();
    return listDevices(getFastVibePaths().remoteAccessFile);
  });

  /** Drop every phone connected through the account, leaving the connection itself up. */
  handle(Ipc.remoteOfficialDisconnect, () => {
    official?.disconnectPeers();
    return announce();
  });
}

/**
 * Bring remote access back if it was on when the app last closed.
 *
 * Reports rather than throws: a port taken by something else must not stop the app from
 * launching, and must not stop the official connection from coming up either.
 */
export async function restoreRemoteServer(): Promise<void> {
  if (readAppSettings(getFastVibePaths()).remoteEnabled !== true) return;
  try {
    await bringUp();
  } catch (error) {
    log.error("remote server failed to start", error);
    official?.setEnabled(true);
    announce();
  }
}

export async function stopRemoteServer(): Promise<void> {
  official?.shutdown();
  shutdownWebRtc();
  mdns?.unpublish();
  if (server) await server.stop();
  setRemoteServing(false, "listener");
  setRemoteServing(false, "official");
}
