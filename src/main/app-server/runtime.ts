import { APP_CAPABILITIES, type AppCapability, type AppServerIdentity } from "../../shared/app-protocol.ts";
import { observe } from "../ipc/broadcast.ts";
import { AppServer, type AppCallContext, type AppServerDeps } from "./app-server.ts";

export type AppServerRuntimeCreate = {
  identity: AppServerIdentity;
  channels: () => readonly string[];
  capabilities?: readonly AppCapability[];
  log?: AppServerDeps["log"];
  onSessionsChanged?: AppServerDeps["onSessionsChanged"];
};

export type AppServerRuntimeInit = {
  /**
   * The process call table (desktop: the same gateway windows use; headless: registry
   * dispatch). Captured at init so `create` can run as soon as identity is known, before
   * every handler has been registered.
   */
  dispatch: (method: string, payload: unknown, context: AppCallContext) => Promise<unknown>;
};

let server: AppServer | null = null;
let dispatchFn: AppServerRuntimeInit["dispatch"] | null = null;
let unobserve: (() => void) | null = null;

/**
 * Construct the process-wide AppServer. Dispatch is late-bound: `initAppServer` supplies
 * it, and every call looks it up then, so create can precede handler registration.
 */
export function createAppServer(options: AppServerRuntimeCreate): AppServer {
  if (server) return server;
  server = new AppServer({
    identity: options.identity,
    channels: options.channels,
    capabilities: options.capabilities ?? APP_CAPABILITIES,
    log: options.log,
    onSessionsChanged: options.onSessionsChanged,
    dispatch: (method, payload, context) => {
      if (!dispatchFn) throw new Error("App Server 尚未初始化");
      return dispatchFn(method, payload, context);
    },
  });
  return server;
}

/**
 * Bind dispatch and observe `broadcast` once, including `except` origin metadata.
 *
 * The observer is not a `subscribe()` receiver: it must see events that skip a window,
 * so AppServer can fan them out to everyone else without echoing them back.
 */
export function initAppServer(options: AppServerRuntimeInit): AppServer {
  if (!server) throw new Error("App Server 尚未创建");
  dispatchFn = options.dispatch;
  if (!unobserve) {
    const target = server;
    unobserve = observe(({ channel, payload, except }) => {
      target.publish(channel, payload, except ? { except } : undefined);
    });
  }
  return server;
}

export function getAppServer(): AppServer {
  if (!server) throw new Error("App Server 尚未创建");
  return server;
}

/** Test seam. Production never resets the process instance. */
export function resetAppServerRuntime(): void {
  unobserve?.();
  unobserve = null;
  dispatchFn = null;
  if (server) server.closeAll();
  server = null;
}
