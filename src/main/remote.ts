import { app } from "electron";
import { join } from "node:path";
import { Ipc } from "@shared/ipc";
import { broadcast, subscribe } from "./ipc/broadcast";
import { dispatch, handle, handlerChannels } from "./ipc/registry";
import { getFastVibePaths } from "./engine/paths";
import { log } from "./engine/logger";
import { readAppSettings, writeAppSettings } from "./engine/app-settings";
import { passwordProblem } from "./server/auth";
import { clearRemoteAccess, isConfigured, listDevices, revokeDevice, setPassword } from "./server/store";
import { RemoteServer, type RemoteServerStatus } from "./server/server";

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

/** Default port. Loopback only, so a tunnel is what publishes it. */
const DEFAULT_PORT = 7777;

function instance(): RemoteServer {
  return (server ??= new RemoteServer({
    accessFile: getFastVibePaths().remoteAccessFile,
    channels: () => handlerChannels(),
    dispatch: (method, payload, clientId) =>
      // A remote caller has no window: the handlers that need one are denied by the
      // policy before they get here, and the rest read `ctx.window` as null.
      dispatch(method, payload, { kind: "remote", window: null, origin: clientId }),
    subscribe: (client) => subscribe(client),
    webRoot: app.isPackaged
      ? join(process.resourcesPath, "app.asar", "out", "renderer")
      : join(__dirname, "../renderer"),
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

/** Push the server's state to every window, so two settings panes cannot disagree. */
function announce(status: RemoteServerStatus): RemoteServerStatus {
  broadcast(Ipc.remoteState, status);
  return status;
}

export function registerRemoteIpc(): void {
  handle(Ipc.remoteGetState, () => instance().status);

  handle(Ipc.remoteSetPassword, (payload: { password: string }) => {
    const password = typeof payload?.password === "string" ? payload.password : "";
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    setPassword(getFastVibePaths().remoteAccessFile, password);
    // Every previously issued token stopped working with the old password, so any
    // client still connected is now holding one that no longer resolves.
    return announce(instance().status);
  });

  handle(Ipc.remoteClearPassword, async () => {
    await instance().stop();
    clearRemoteAccess(getFastVibePaths().remoteAccessFile);
    return announce(instance().status);
  });

  handle(Ipc.remoteStart, async (payload?: { port?: number }) => {
    const port = typeof payload?.port === "number" ? payload.port : readPort();
    const paths = getFastVibePaths();
    if (!isConfigured(paths.remoteAccessFile)) throw new Error("请先设置远程访问密码");
    const status = await instance().start({ port });
    writeAppSettings(paths, { ...readAppSettings(paths), remoteEnabled: true, remotePort: status.port ?? port });
    return announce(status);
  });

  handle(Ipc.remoteStop, async () => {
    const status = await instance().stop();
    const paths = getFastVibePaths();
    writeAppSettings(paths, { ...readAppSettings(paths), remoteEnabled: false });
    return announce(status);
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
    announce(instance().status);
    return listDevices(getFastVibePaths().remoteAccessFile);
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
    announce(await instance().start({ port: readPort() }));
  } catch (error) {
    log.error("remote server failed to start", error);
  }
}

export async function stopRemoteServer(): Promise<void> {
  if (server) await server.stop();
}
