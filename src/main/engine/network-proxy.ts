import { app, session, webContents, type Session, type WebContents } from "electron";
import { chromiumProxyConfig, isProxyLoopback, proxySettingsOf, proxyUrlFromResolution, type ProxySettings } from "../../shared/proxy.ts";
import { installNodeProxy } from "./node-proxy.ts";

/** One owner for every Chromium session (including the updater's private one) and
 * Node networking. Installed before windows, the engine, or background downloads. */
export async function createNetworkProxy(initial: Record<string, unknown>) {
  const sessions = new Set<Session>();
  let current = proxySettingsOf(initial);
  let barrier: Promise<void> = Promise.resolve();
  let broken: unknown;
  const protectContents = (contents: WebContents) => {
    if (!contents.isDestroyed()) contents.setWebRTCIPHandlingPolicy(
      current.proxyEnabled || broken ? "disable_non_proxied_udp" : "default",
    );
  };
  const contentsCreated = (_event: Electron.Event, contents: WebContents) => protectContents(contents);
  app.on("web-contents-created", contentsCreated);
  const configure = async (target: Session, settings: ProxySettings) => {
    await target.setProxy(chromiumProxyConfig(settings));
    await target.closeAllConnections();
  };
  const register = (target: Session) => {
    if (sessions.has(target)) return;
    sessions.add(target);
    // A setup error must still allow the local settings UI to open, but never
    // leave a session using Chromium's old/default direct connection unnoticed.
    target.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
      callback({ cancel: Boolean(broken) && !isProxyLoopback(details.url) });
    });
  };
  const created = (target: Session) => {
    register(target);
    // setProxy queues its network-context update before a new guest can navigate.
    void configure(target, current).catch((error: unknown) => { broken = error; });
  };
  app.on("session-created", created);
  const defaultSession = session.defaultSession;
  register(defaultSession);
  register(session.fromPartition("persist:fastvibe-browser"));
  register(session.fromPartition("electron-updater", { cache: false }));
  try {
    await app.setProxy(chromiumProxyConfig(current));
    await Promise.all([...sessions].map((target) => configure(target, current)));
  } catch (error) { broken = error; }

  const node = await installNodeProxy(async (url) => {
    await barrier;
    if (broken) throw new Error("Proxy configuration failed");
    // OAuth callbacks, MCP on this machine, and SSH loopback bridges are not egress.
    if (isProxyLoopback(url)) return "";
    return proxyUrlFromResolution(await defaultSession.resolveProxy(url));
  });
  broken ||= node.error;
  for (const contents of webContents.getAllWebContents()) protectContents(contents);
  return {
    get error() { return broken; },
    apply(settings: Record<string, unknown>): Promise<void> {
      const next = proxySettingsOf(settings);
      const task = barrier.then(async () => {
        if (!broken && JSON.stringify(chromiumProxyConfig(next)) === JSON.stringify(chromiumProxyConfig(current))) {
          current = next;
          return;
        }
        const previous = current;
        const change = async (value: ProxySettings) => {
          current = value;
          for (const contents of webContents.getAllWebContents()) protectContents(contents);
          await app.setProxy(chromiumProxyConfig(value));
          await Promise.all([...sessions].map((target) => configure(target, value)));
          await node.reset();
          broken = undefined;
          for (const contents of webContents.getAllWebContents()) protectContents(contents);
        };
        try { await change(next); }
        catch (error) {
          try { await change(previous); }
          catch (rollbackError) { broken = rollbackError; }
          throw error;
        }
      });
      // Failed saves have rolled back; don't poison subsequent network requests.
      barrier = task.catch(() => undefined);
      return task;
    },
    async close() {
      app.off("session-created", created);
      app.off("web-contents-created", contentsCreated);
      await barrier;
      await node.close();
    },
  };
}
