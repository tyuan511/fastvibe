import { app } from "electron";
import { join } from "node:path";
import { Ipc } from "@shared/ipc";
import type {
  RemoteLanAddressFamily,
  RemoteServerState,
  RemoteTunnelTools,
} from "@shared/ipc";
import { broadcast, subscribe } from "./ipc/broadcast";
import { dispatch, handle, handlerChannels } from "./ipc/registry";
import { getFastVibePaths } from "./engine/paths";
import { fileIconsDirectory } from "./engine/file-icons";
import { log } from "./engine/logger";
import { readAppSettings, writeAppSettings } from "./engine/app-settings";
import { passwordProblem } from "./server/auth";
import { clearRemoteAccess, isConfigured, listDevices, revokeDevice, setPassword } from "./server/store";
import { lanAddresses, RemoteServer } from "./server/server";
import { getAppServer } from "./app-server/runtime";
import { readFrpSettings, saveFrpSettings, writeFrpcConfig } from "./server/frp-store";
import { checkFrpDns } from "./server/frp-dns";
import { setRemoteServing } from "./engine/keep-awake";
import { frpProblems, frpPublicUrl, frpView, type FrpSettingsInput, type FrpSettingsView } from "@shared/frp";
import {
  TunnelRunner,
  TUNNEL_OFF,
  isTunnelProvider,
  probeTunnelTools,
  type TunnelOptions,
  type TunnelProvider,
} from "./server/tunnel";

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
let tunnel: TunnelRunner | null = null;

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
    webRoot: app.isPackaged
      ? join(process.resourcesPath, "app.asar", "out", "renderer")
      : join(__dirname, "../renderer"),
    iconRoot: fileIconsDirectory(),
    log: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message, error) => log.error(message, error),
    },
  }));
}

function tunnelInstance(): TunnelRunner {
  return (tunnel ??= new TunnelRunner({
    onChange: announceFromServer,
    log: {
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message, error) => log.error(message, error),
    },
  }));
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
 * The tunnel the user picked, which is a preference rather than a running process.
 *
 * Kept in `settings.json` next to `remotePort` so that a machine which had a tunnel up
 * gets it back at the next launch — the whole point of the feature is that the phone's
 * bookmark keeps working without anybody opening a terminal. Nothing secret is in it,
 * which is why it can live in the file that is handed to every renderer.
 */
function readTunnelChoice(): TunnelProvider | null {
  const value = readAppSettings(getFastVibePaths()).remoteTunnel;
  return isTunnelProvider(value) ? value : null;
}

function writeTunnelChoice(provider: TunnelProvider | null): void {
  const paths = getFastVibePaths();
  writeAppSettings(paths, { ...readAppSettings(paths), remoteTunnel: provider });
}

/** The one state both halves are described by, since the pane draws them as one card. */
function state(): RemoteServerState {
  return {
    ...instance().status,
    lanAccess: readLanAccess(),
    lanAddresses: lanAddresses(),
    lanAddressFamily: effectiveLanAddressFamily(),
    tunnel: tunnelInstance().status,
    tunnelChoice: readTunnelChoice(),
  };
}

/** Push the server's state to every window, so two settings panes cannot disagree. */
function announce(): RemoteServerState {
  const next = state();
  setRemoteServing(next.running);
  broadcast(Ipc.remoteState, next);
  return next;
}

/**
 * The `onStatusChange` callback both the server and the tunnel are handed.
 *
 * A plain function, not `() => announce()` inlined at either construction site: that
 * expression calls `instance()` while `instance()` is still in the middle of building
 * the very object it would return, before `server` has been assigned — the memoized
 * `server ??= new RemoteServer(...)` never completes, and each nested call builds
 * another one. Reading the module-level variables here instead is safe because this
 * only ever runs later, from inside the server's or the tunnel's own event handlers, by
 * which point construction has long finished.
 *
 * The tunnel's half is read with `?.`: the server can report a login before anybody has
 * ever asked for a tunnel, and skipping the broadcast in that case would lose the
 * device list's live refresh over a feature that is not even in use.
 */
function announceFromServer(): void {
  if (!server) return;
  setRemoteServing(server.status.running);
  broadcast(Ipc.remoteState, {
    ...server.status,
    lanAccess: readLanAccess(),
    lanAddresses: lanAddresses(),
    lanAddressFamily: effectiveLanAddressFamily(),
    tunnel: tunnel?.status ?? TUNNEL_OFF,
    tunnelChoice: readTunnelChoice(),
  } satisfies RemoteServerState);
}

/**
 * Bring up the chosen tunnel in front of `port`, if there is one.
 *
 * Not awaited by the caller. A quick tunnel takes five to fifteen seconds to register
 * with an edge, and holding `remote:start` open for that would leave the switch in the
 * settings pane spinning with nothing to read — while the runner announces 启动中… and
 * then either the URL or the reason on its own. `start()` never rejects, so there is
 * nothing here for a caller to catch either.
 */
function launchTunnel(port: number): void {
  const provider = readTunnelChoice();
  if (!provider) return;
  void tunnelInstance().start(provider, port, provider === "frp" ? frpOptions(port) : {});
}

/**
 * Render `frpc.toml` for this start and work out the URL it will be reachable at.
 *
 * Rendered per start rather than per save because the local port is part of it, and the
 * port is only certain once the server is listening. An absent or invalid config returns
 * no options, which the runner turns into 「请先填写 frp 服务器配置」 in the pane rather
 * than a frpc usage dump.
 */
function frpOptions(port: number): TunnelOptions {
  const paths = getFastVibePaths();
  const config = readFrpSettings(paths.frpFile);
  if (!config || frpProblems(config).length > 0) return {};
  const publicUrl = frpPublicUrl(config);
  if (!publicUrl) return {};
  try {
    writeFrpcConfig(paths.frpcConfigFile, config, port);
  } catch (error) {
    log.error("frpc config write failed", error);
    return {};
  }
  return { configFile: paths.frpcConfigFile, publicUrl };
}

export function registerRemoteIpc(): void {
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

  handle(Ipc.remoteClearPassword, async () => {
    await tunnelInstance().stop();
    await instance().stop();
    const paths = getFastVibePaths();
    clearRemoteAccess(paths.remoteAccessFile);
    // Matches what `remote:stop` does: without this, turning access off from the danger
    // zone left `remoteEnabled: true` on disk — harmless at the next launch, since
    // `restoreRemoteServer` refuses to start with no password, but it logged a warning
    // about it every time for a setting the user had already turned off on purpose.
    // The tunnel choice goes with it: 关闭远程访问 turns off the whole feature, and a
    // remembered provider would dial out again the moment a password was set.
    writeAppSettings(paths, { ...readAppSettings(paths), remoteEnabled: false, remoteLanAccess: false, remoteTunnel: null });
    return announce();
  });

  handle(Ipc.remoteStart, async (payload?: { port?: number }) => {
    const port = typeof payload?.port === "number" ? payload.port : readPort();
    const paths = getFastVibePaths();
    if (!isConfigured(paths.remoteAccessFile)) throw new Error("请先设置远程访问密码");
    const status = await instance().start({ port, host: listenHost() });
    writeAppSettings(paths, { ...readAppSettings(paths), remoteEnabled: true, remotePort: status.port ?? port });
    launchTunnel(status.port ?? port);
    return announce();
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
    // Stop the tunnel first because it must never publish a port while the server is
    // between bindings.
    const port = instance().status.port ?? readPort();
    try {
      await tunnelInstance().stop();
      await instance().stop();
      const status = await instance().start({ port, host: listenHost() });
      launchTunnel(status.port ?? port);
      return announce();
    } catch (error) {
      announce();
      throw error;
    }
  });

  handle(Ipc.remoteStop, async () => {
    // The tunnel goes down first. Stopped the other way round it would spend a moment
    // publishing a port with nothing behind it, which a phone reads as a dead site
    // rather than as remote access having been switched off.
    await tunnelInstance().stop();
    await instance().stop();
    const paths = getFastVibePaths();
    // The provider is left alone: this is the switch, not the choice, and flipping it
    // back on should bring back the tunnel the user had.
    writeAppSettings(paths, { ...readAppSettings(paths), remoteEnabled: false });
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

  handle(Ipc.remoteTunnelTools, (): Promise<RemoteTunnelTools> => probeTunnelTools());

  handle(Ipc.remoteFrpGet, (): FrpSettingsView | null => frpView(readFrpSettings(getFastVibePaths().frpFile)));

  handle(Ipc.remoteFrpCheckDns, (payload: { domain?: unknown; serverAddr?: unknown }) => checkFrpDns(payload ?? {}));

  /**
   * Save the frp settings, and put a running frp tunnel onto them.
   *
   * A restart only when frp is the tunnel in use and the server is up: saving the form
   * while cloudflared runs must not take that tunnel down, and with the server off there
   * is nothing to publish yet — `remote:start` renders the new config when it happens.
   */
  handle(Ipc.remoteFrpSet, async (payload: FrpSettingsInput): Promise<FrpSettingsView | null> => {
    if (!payload || typeof payload !== "object") throw new Error("frp 配置无效");
    const saved = saveFrpSettings(getFastVibePaths().frpFile, payload);
    const status = instance().status;
    if (readTunnelChoice() === "frp" && status.running && status.port !== null) {
      await tunnelInstance().stop();
      launchTunnel(status.port);
      announce();
    }
    return frpView(saved);
  });

  /**
   * Pick the tunnel, or none.
   *
   * Always restarts, including when the provider is the one already chosen: that is
   * what the pane's 重试 does after a failure, and a no-op there would be a button that
   * looks like it did nothing. The choice is written before anything is dialled, so a
   * tunnel that fails to start is still the tunnel this machine comes back up with once
   * the missing binary is installed.
   */
  handle(Ipc.remoteTunnelSet, async (payload?: { provider?: unknown }) => {
    const provider = isTunnelProvider(payload?.provider) ? payload.provider : null;
    writeTunnelChoice(provider);
    await tunnelInstance().stop();
    const status = instance().status;
    // Nothing to publish until the server is up. The choice is saved either way, and
    // `remote:start` dials it — so picking a provider before flipping the switch does
    // the expected thing rather than silently nothing.
    if (provider && status.running && status.port !== null) launchTunnel(status.port);
    return announce();
  });
}

/**
 * Bring the server back up if it was running when the app last closed.
 *
 * Never starts without a password, and reports rather than throws: a port taken by
 * something else must not stop the app from launching.
 */
export async function restoreRemoteServer(): Promise<void> {
  const paths = getFastVibePaths();
  const settings = readAppSettings(paths);
  if (settings.remoteEnabled !== true) return;
  if (!isConfigured(paths.remoteAccessFile)) {
    log.warn("remote server was enabled but no password is set; leaving it off");
    return;
  }
  try {
    const status = await instance().start({ port: readPort(), host: listenHost() });
    launchTunnel(status.port ?? readPort());
    announce();
  } catch (error) {
    log.error("remote server failed to start", error);
  }
}

export async function stopRemoteServer(): Promise<void> {
  // Before the server, and unconditionally: the tunnel is a child process, and one left
  // behind by a quit keeps publishing a port that no longer answers.
  if (tunnel) await tunnel.stop();
  if (server) await server.stop();
  setRemoteServing(false);
}
