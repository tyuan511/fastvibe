import { Ipc } from "@shared/ipc";
import type { RemoteLanAddressFamily, RemoteServerState } from "@shared/ipc";
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
import { discoveryNameProblem, discoveryNameSetting } from "@shared/discovery-name";
import { uiText } from "./engine/ui-text";
import { getAppServer } from "./app-server/runtime";
import { setRemoteServing } from "./engine/keep-awake";
import type { AccountService } from "./engine/account";
import { hostname } from "node:os";
import { createNodeDataChannelPeer, shutdownWebRtc } from "./rtc/peer";
import { OfficialConnection } from "./rtc/official";

/**
 * Where the remote server meets the desktop app.
 *
 * Everything Electron-shaped lives here — the settings that decide whether it runs, the
 * methods the settings pane calls, the paths — so that `server/` itself stays free of
 * Electron and could run without a GUI later.
 *
 * The server is handed the *same* `dispatch` and `subscribe` the windows use. That is
 * the whole point of the table: a method is reachable both ways by construction, and a
 * push written for a window reaches a phone without the push site knowing it exists.
 */

let server: RemoteServer | null = null;
let official: OfficialConnection | null = null;
let mdns: MdnsAdvertiser | null = null;

/** Default port for the local or LAN listener. */
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
 * Keep the mDNS announcement equal to «the server is listening beyond this machine».
 *
 * Derived from the server's own status rather than toggled at each call site, and called
 * from both announce paths: the places that start, stop or rebind the listener are many
 * and the next one added would otherwise leave a phone listing a machine that is gone.
 * Loopback-only is never announced — nothing off this machine could connect to it.
 */
function syncDiscovery(): void {
  const status = server?.status;
  if (status?.running && status.port !== null && readLanAccess()) {
    // Use the running listener, not a preference written just before a rebind.
    mdnsInstance().publish(status.port, readDiscoveryName(), status.host.includes(":") ? "ipv6" : "ipv4");
  } else mdns?.unpublish();
}

function readDiscoveryName(): string {
  return discoveryNameSetting(readAppSettings(getFastVibePaths()).remoteDiscoveryName);
}

function readPort(): number {
  const value = readAppSettings(getFastVibePaths()).remotePort;
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65_536
    ? value
    : DEFAULT_PORT;
}

function readLanAccess(): boolean {
  return readAppSettings(getFastVibePaths()).remoteLanAccess === true;
}

function readLanAddressFamily(): RemoteLanAddressFamily {
  const value = readAppSettings(getFastVibePaths()).remoteLanAddressFamily;
  return value === "ipv6" ? "ipv6" : "ipv4";
}

function effectiveLanAddressFamily(): RemoteLanAddressFamily {
  const addresses = lanAddresses();
  const requested = readLanAddressFamily();
  if (requested === "ipv6" && addresses.ipv6) return "ipv6";
  if (addresses.ipv4) return "ipv4";
  if (addresses.ipv6) return "ipv6";
  return requested;
}

function listenHost(): string {
  if (!readLanAccess()) return "127.0.0.1";
  return effectiveLanAddressFamily() === "ipv6" ? "::" : "0.0.0.0";
}

/**
 * Whether remote access is switched on, which is a preference rather than a running
 * thing: it turns on both ways in at once — the password-protected listener (LAN) when a
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

/** The one state the pane draws everything from: the listener, and the official connection. */
function state(): RemoteServerState {
  return {
    ...instance().status,
    enabled: readEnabled(),
    lanAccess: readLanAccess(),
    lanAddresses: lanAddresses(),
    lanAddressFamily: effectiveLanAddressFamily(),
    discoveryName: readDiscoveryName(),
    defaultDiscoveryName: mdnsInstanceName(),
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
 * The `onStatusChange` callback the server and the official connection are handed.
 *
 * A plain function, not `() => announce()` inlined at either construction site: that
 * expression calls `instance()` while `instance()` is still in the middle of building
 * the very object it would return, before `server` has been assigned — the memoized
 * `server ??= new RemoteServer(...)` never completes, and each nested call builds
 * another one. Reading the module-level variables here instead is safe because this
 * only ever runs later, from inside their own event handlers, by which point
 * construction has long finished.
 */
function announceFromServer(): void {
  if (!server) return;
  announce();
}

/** The name the account's device list shows for this machine. */
function deviceName(): string {
  return hostname().replace(/\.local$/i, "") || "FastVibe";
}

/**
 * Bring up whichever ways in the machine is able to offer, for the switch being on.
 *
 * The listener needs a password and the official connection needs a signed-in account;
 * neither failing for want of its prerequisite is an error here — the pane shows what is
 * missing. A listener that cannot bind (the port is taken) is one: that throws.
 */
async function bringUp(): Promise<RemoteServerState> {
  const paths = getFastVibePaths();
  if (isConfigured(paths.remoteAccessFile)) {
    await instance().start({ port: readPort(), host: listenHost() });
  }
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

  handle(Ipc.remoteSetPassword, (payload: { password: string }) => {
    const password = typeof payload?.password === "string" ? payload.password : "";
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    setPassword(getFastVibePaths().remoteAccessFile, password);
    // Every previously issued token stopped working with the old password, so any
    // client still connected is now holding one that no longer resolves.
    return announce();
  });

  /**
   * Remove the password, which is what the listener needs to exist: it stops, and LAN
   * access goes with it. The official connection is not the password's to take down —
   * it authenticates by account — so the switch itself is left as it was.
   */
  handle(Ipc.remoteClearPassword, async () => {
    await instance().stop();
    const paths = getFastVibePaths();
    clearRemoteAccess(paths.remoteAccessFile);
    writeAppSettings(paths, { ...readAppSettings(paths), remoteLanAccess: false });
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

  handle(Ipc.remoteSetLanAccess, async (payload?: { enabled?: unknown; family?: unknown }) => {
    const enabled = payload?.enabled === true;
    const previousEnabled = readLanAccess();
    const previousFamily = effectiveLanAddressFamily();
    const requestedFamily: RemoteLanAddressFamily = payload?.family === "ipv6" ? "ipv6" : payload?.family === "ipv4" ? "ipv4" : readLanAddressFamily();
    const paths = getFastVibePaths();
    writeAppSettings(paths, { ...readAppSettings(paths), remoteLanAccess: enabled, remoteLanAddressFamily: requestedFamily });
    if (!instance().status.running) return announce();
    if (enabled === previousEnabled && effectiveLanAddressFamily() === previousFamily) return announce();

    // Rebind the listener so the switch or address-family choice takes effect immediately.
    const port = instance().status.port ?? readPort();
    try {
      await instance().stop();
      await instance().start({ port, host: listenHost() });
      return announce();
    } catch (error) {
      announce();
      throw error;
    }
  });

  handle(Ipc.remoteSetDiscoveryName, async (payload?: { name?: unknown }) => {
    if (typeof payload?.name !== "string") throw new Error(uiText("主机名称无效", "Invalid computer name"));
    const name = payload.name.trim();
    const problem = discoveryNameProblem(name);
    if (problem === "invalidCharacters") throw new Error(uiText(
      "名称不能包含句点、反斜杠或控制字符", "Names cannot contain dots, backslashes or control characters",
    ));
    if (problem === "tooLong") throw new Error(uiText(
      "名称过长，请缩短后重试（最多 63 字节）", "Name is too long; shorten it and try again (63 bytes maximum)",
    ));
    await queueSettingsWrite(async () => {
      const paths = getFastVibePaths();
      const settings = { ...readAppSettings(paths), remoteDiscoveryName: name };
      writeAppSettings(paths, settings);
      broadcast(Ipc.settingsChanged, settings);
      // Replace only the discovery record; existing HTTP/WebSocket sessions stay live.
      announce();
    });
    return state();
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
  const paths = getFastVibePaths();
  if (readAppSettings(paths).remoteEnabled !== true) return;
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
