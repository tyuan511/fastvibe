import { Ipc } from "@shared/ipc";
import { createFastVibeApi, type ApiTransport } from "@shared/api";
import { ALL_SCOPES } from "@shared/app-protocol";
import { AppClient, type MessageTransport } from "@shared/app-client";
import { planResume } from "@shared/app-resume";

/**
 * The web client's half of `window.fastvibe`.
 *
 * The desktop preload reaches Main over Electron IPC; this reaches the same Main over a
 * WebSocket, and both build the bridge from the same factory (`@shared/api`) so neither
 * can quietly grow a method the other lacks. Everything specific to *being remote* lives
 * here: the password gate, the token, the reconnect.
 *
 * It owns the boot because the renderer reads the bridge as it loads — `stores/settings`
 * takes the settings snapshot synchronously at module scope — so the app cannot be
 * imported until a connection exists and that snapshot has been fetched. That is why
 * `remote.html` loads only this file.
 */

/**
 * The device token, kept per origin.
 *
 * `localStorage` rather than a cookie, because the same token is what a future native
 * client would send; the trade-off is that a script running on this page could read it,
 * which is why the page loads nothing it did not build.
 */
const TOKEN_KEY = "fastvibe.remote.token";

const AUTH_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 15_000;
const MAX_PENDING_PUSHES = 256;

let appClient: AppClient | null = null;
/** Bumped on every new socket so a retired one cannot restart reconnect or land hello. */
let connectionGeneration = 0;
let reconnecting: Promise<void> | null = null;
let reconnectStopped = false;
/** After the first successful boot connect; onStatus on that path must not start reconnect. */
let live = false;
const listeners = new Map<string, Set<(payload: unknown) => void>>();
/** Pushes that arrived before any React subscriber. Dropping them was a silent stall. */
const pendingPushes: Array<{ channel: string; payload: unknown }> = [];

/* ------------------------------------------------------------------ the gate */

const gate = document.getElementById("fastvibe-gate")!;
const gateTitle = document.getElementById("gate-title")!;
const gateHint = document.getElementById("gate-hint")!;
const gateSpinner = document.getElementById("gate-spinner")!;
const gateForm = document.getElementById("gate-form") as HTMLFormElement;
const gatePassword = document.getElementById("gate-password") as HTMLInputElement;
const gateSubmit = document.getElementById("gate-submit") as HTMLButtonElement;
const gateError = document.getElementById("gate-error")!;

function showGate(title: string, hint: string, options?: { form?: boolean; spinner?: boolean }): void {
  gate.hidden = false;
  gate.removeAttribute("data-dismissed");
  gateTitle.textContent = title;
  gateHint.textContent = hint;
  gateForm.hidden = options?.form !== true;
  gateSpinner.hidden = options?.spinner !== true;
  if (options?.form) gatePassword.focus();
}

function hideGate(): void {
  gate.setAttribute("data-dismissed", "");
  // Left in the DOM rather than removed: a dropped socket brings it straight back.
  window.setTimeout(() => {
    if (gate.hasAttribute("data-dismissed")) gate.hidden = true;
  }, 240);
}

function showError(message: string | null): void {
  gateError.textContent = message ?? "";
  gateError.hidden = !message;
}

/* ------------------------------------------------------------------ transport */

function dispatchPush(channel: string, payload: unknown): void {
  const bucket = listeners.get(channel);
  if (!bucket || bucket.size === 0) {
    if (pendingPushes.length >= MAX_PENDING_PUSHES) pendingPushes.shift();
    pendingPushes.push({ channel, payload });
    return;
  }
  // Copied before iterating: a listener that detaches itself while being called would
  // otherwise mutate the set mid-iteration. One throwing subscriber must not stall the rest.
  for (const listener of [...bucket]) {
    try {
      listener(payload);
    } catch {
      // A UI reducer bug is not a protocol gap.
    }
  }
}

function flushPending(channel: string, listener: (payload: unknown) => void): void {
  if (pendingPushes.length === 0) return;
  const rest: Array<{ channel: string; payload: unknown }> = [];
  for (const item of pendingPushes) {
    if (item.channel === channel) listener(item.payload);
    else rest.push(item);
  }
  pendingPushes.length = 0;
  pendingPushes.push(...rest);
}

function isCanonicalFrame(message: unknown): boolean {
  return typeof message === "object" && message !== null && typeof (message as { kind?: unknown }).kind === "string";
}

function websocketTransport(ws: WebSocket): MessageTransport {
  return {
    send: (message) => {
      ws.send(JSON.stringify(message));
    },
    onMessage: (listener) => {
      const handler = (event: MessageEvent): void => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        // Outer auth and leftover legacy `{push}` frames are not App Protocol.
        if (!isCanonicalFrame(message)) return;
        listener(message);
      };
      ws.addEventListener("message", handler);
      return () => ws.removeEventListener("message", handler);
    },
    onClose: (listener) => {
      const handler = (): void => listener("远程连接已断开");
      ws.addEventListener("close", handler);
      return () => ws.removeEventListener("close", handler);
    },
    close: () => {
      ws.close();
    },
  };
}

function bindClient(client: AppClient, generation: number): void {
  client.onPush((channel, payload) => {
    if (generation !== connectionGeneration) return;
    dispatchPush(channel, payload);
  });
  client.onResync(() => {
    if (generation !== connectionGeneration) return;
    // A gap the journal cannot fill: the transcript on screen would look complete and
    // would not be. Reload (and the boot snapshot) is the honest resume.
    window.location.reload();
  });
  client.onStatus((status) => {
    if (generation !== connectionGeneration) return;
    if (appClient !== client) return;
    if (!live || reconnectStopped) return;
    if (status.state !== "error" && status.state !== "closed") return;
    appClient = null;
    void scheduleReconnect();
  });
}

/**
 * Open a socket, authenticate it, then handshake the App Protocol.
 *
 * Resolves only once welcome has landed, so a caller can treat a resolved promise as
 * "this connection can carry calls". A refused token rejects with `UNAUTHORIZED`.
 * Auth and hello each have a deadline; an obsolete generation is closed, not retried.
 */
function connect(token: string, generation: number, options?: { subscribe?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const next = new WebSocket(url.toString());
    let settled = false;
    let authTimer: number | null = window.setTimeout(() => {
      fail(new Error("远程连接鉴权超时"));
    }, AUTH_TIMEOUT_MS);

    const clearAuthTimer = (): void => {
      if (authTimer === null) return;
      window.clearTimeout(authTimer);
      authTimer = null;
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearAuthTimer();
      try {
        next.close();
      } catch {
        // already gone
      }
      reject(error);
    };

    const obsolete = (): boolean => generation !== connectionGeneration || reconnectStopped;

    next.addEventListener("open", () => {
      if (settled || obsolete()) {
        fail(new Error("远程连接已过期"));
        return;
      }
      next.send(JSON.stringify({ type: "auth", token }));
    });

    next.addEventListener("message", (event) => {
      if (settled) return;
      if (obsolete()) {
        fail(new Error("远程连接已过期"));
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type !== "auth") return;
      if (message.ok !== true) {
        fail(new Error("UNAUTHORIZED"));
        return;
      }
      clearAuthTimer();
      const client = new AppClient(websocketTransport(next), {
        client: { kind: "browser", version: "web" },
        handshakeTimeoutMs: HELLO_TIMEOUT_MS,
      });
      bindClient(client, generation);
      void client.connect().then(() => {
        if (settled || obsolete()) {
          client.close();
          fail(new Error("远程连接已过期"));
          return;
        }
        settled = true;
        appClient = client;
        if (options?.subscribe !== false) {
          // Live-only. Replay of `*` cannot name scopes that first moved while we
          // were gone; boot re-reads snapshots instead of a partial journal.
          client.subscribe([ALL_SCOPES]);
        }
        resolve();
      }).catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });

    next.addEventListener("close", () => {
      fail(new Error("连接被关闭"));
    });

    next.addEventListener("error", () => {
      fail(new Error("无法连接到服务器"));
    });
  });
}

function scheduleReconnect(): Promise<void> {
  if (reconnectStopped) return Promise.resolve();
  if (reconnecting) return reconnecting;
  reconnecting = runReconnect().finally(() => {
    reconnecting = null;
  });
  return reconnecting;
}

function showLoginGate(title: string, hint: string, error?: string): void {
  reconnectStopped = true;
  connectionGeneration += 1;
  showGate(title, hint, { form: true });
  if (error) showError(error);
  armPasswordForm(() => {
    window.location.reload();
  });
}

/**
 * Come back after a dropped socket.
 *
 * Wildcard resume cannot guarantee scope coverage, and a numeric seq without its
 * epoch would be applied to the new welcome epoch. After a successful probe we
 * always reload and re-read snapshots — never pretend a replay was complete.
 * Single-flight: a second onStatus cannot start another loop. An obsolete socket
 * or an intentional logout does not resurrect retries.
 */
async function runReconnect(): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    showLoginGate("连接已断开", "请重新登录");
    return;
  }
  showGate("连接已断开", "正在重新连接…", { spinner: true });
  for (let attempt = 0; ; attempt += 1) {
    if (reconnectStopped) return;
    await new Promise((settle) => window.setTimeout(settle, Math.min(10_000, 500 * 2 ** attempt)));
    if (reconnectStopped) return;
    const generation = ++connectionGeneration;
    try {
      await connect(token, generation, { subscribe: false });
      if (generation !== connectionGeneration || reconnectStopped) return;
      const plan = planResume({
        welcomeEpoch: appClient?.epoch ?? "",
        cursors: appClient?.eventCursors() ?? {},
        wildcard: true,
      });
      // `*` → rebootstrap. Reload snapshots rather than apply a partial journal;
      // never pretend a replay was complete (named-scope replay is not offered here).
      if (plan.kind === "rebootstrap" || plan.kind === "replay") {
        window.location.reload();
      }
      return;
    } catch (error) {
      if (generation !== connectionGeneration || reconnectStopped) return;
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        localStorage.removeItem(TOKEN_KEY);
        showLoginGate("需要重新登录", "这台设备的访问权限已被撤销或密码已更改");
        return;
      }
      // Anything else is the server being unreachable: keep waiting, the phone may
      // simply have changed networks.
    }
  }
}

/** Channels answered here instead of being sent, because the answer is local. */
function localAnswer(channel: string): unknown | undefined {
  switch (channel) {
    // A browser tab has no window for Main to act on, and the policy refuses these
    // anyway. Answering with a no-op keeps a title bar drawn for a Windows or Linux
    // host from turning every click into a visible error.
    case Ipc.windowMinimize:
    case Ipc.windowToggleMaximize:
    case Ipc.windowClose:
      return null;
    case Ipc.windowIsMaximized:
      return false;
    default:
      return undefined;
  }
}

const transport: ApiTransport = {
  invoke: (channel, payload) => {
    const local = localAnswer(channel);
    if (local !== undefined) return Promise.resolve(local === null ? undefined : local);
    const live = appClient;
    if (!live) return Promise.reject(new Error("与服务器的连接已断开"));
    return live.call(channel, payload);
  },
  /**
   * Sent as an ordinary call whose reply is dropped.
   *
   * The wire has no one-way frame — the server answers every call it is given — so
   * "fire and forget" is a call nobody awaits. The rejection is swallowed because these
   * are logs and browser-bridge replies: losing one while the socket is down must not
   * surface as an error the user has to read.
   */
  send: (channel, payload) => {
    void transport.invoke(channel, payload).catch(() => undefined);
  },
  subscribe: (channel, listener) => {
    const boxed = listener as (payload: unknown) => void;
    const bucket = listeners.get(channel) ?? new Set();
    bucket.add(boxed);
    listeners.set(channel, bucket);
    flushPending(channel, boxed);
    return () => {
      bucket.delete(boxed);
      if (bucket.size === 0) listeners.delete(channel);
    };
  },
  // Both filled from the handshake below, before the app is imported.
  settingsInitial: {},
  platform: "darwin",
  // Fixed, and the reason it exists: `platform` describes the machine at the other end
  // of the socket, which is exactly the wrong thing to lay a browser out for.
  remote: true,
};

/* ------------------------------------------------------------------ boot */

async function login(password: string): Promise<string> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, label: deviceLabel() }),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) {
    throw new Error(body.error ?? "登录失败");
  }
  return body.token;
}

/** A name for this client in 设置 → 远程访问 → 已登录设备, so devices are tellable apart. */
function deviceLabel(): string {
  const agent = navigator.userAgent;
  const platform = /iphone|ipad|ipod/i.test(agent)
    ? "iOS"
    : /android/i.test(agent)
      ? "Android"
      : /mac/i.test(agent)
        ? "Mac"
        : /windows/i.test(agent)
          ? "Windows"
          : "浏览器";
  const browser = /edg\//i.test(agent)
    ? "Edge"
    : /chrome\//i.test(agent)
      ? "Chrome"
      : /safari\//i.test(agent)
        ? "Safari"
        : /firefox\//i.test(agent)
          ? "Firefox"
          : "Web";
  return `${platform} · ${browser}`;
}

/** Ask for the password until one is accepted, and remember the token it buys. */
function armPasswordForm(onToken: (token: string) => void): void {
  gateForm.onsubmit = (event) => {
    event.preventDefault();
    const password = gatePassword.value;
    if (!password) return;
    gateSubmit.disabled = true;
    showError(null);
    void login(password)
      .then((token) => {
        localStorage.setItem(TOKEN_KEY, token);
        gatePassword.value = "";
        reconnectStopped = false;
        onToken(token);
      })
      .catch((error: unknown) => {
        showError(error instanceof Error ? error.message : "登录失败");
      })
      .finally(() => {
        gateSubmit.disabled = false;
      });
  };
}

function askForPassword(): Promise<string> {
  return new Promise((resolve) => {
    armPasswordForm(resolve);
  });
}

async function boot(): Promise<void> {
  showGate("正在连接…", "FastVibe 远程访问", { spinner: true });

  let configured = false;
  try {
    const hello = (await (await fetch("/api/hello")).json()) as { configured?: boolean };
    configured = hello.configured === true;
  } catch {
    showGate("无法连接", "服务器没有响应，请确认它仍在运行", {});
    return;
  }
  if (!configured) {
    // The server refuses to listen without a password, so this only happens if it was
    // cleared between the page loading and this call.
    showGate("尚未启用", "请先在这台电脑的 设置 → 远程访问 中设置密码", {});
    return;
  }

  let token = localStorage.getItem(TOKEN_KEY);
  for (;;) {
    if (!token) {
      showGate("请输入访问密码", "首次连接需要验证身份", { form: true });
      token = await askForPassword();
    }
    showGate("正在连接…", "FastVibe 远程访问", { spinner: true });
    const generation = ++connectionGeneration;
    try {
      await connect(token, generation);
      live = true;
      break;
    } catch (error) {
      const unauthorized = error instanceof Error && error.message === "UNAUTHORIZED";
      localStorage.removeItem(TOKEN_KEY);
      token = null;
      showGate("请输入访问密码", "首次连接需要验证身份", { form: true });
      showError(unauthorized ? "这台设备的访问权限已失效，请重新输入密码" : "连接失败，请重试");
    }
  }

  // The two values no call can express once the app has started: the renderer reads both
  // synchronously while it loads, so they have to be in hand before it is imported.
  const [settings, info] = await Promise.all([
    transport.invoke(Ipc.settingsGet).catch(() => ({})),
    transport.invoke(Ipc.appGetInfo).catch(() => ({ platform: "darwin" })),
  ]);
  transport.settingsInitial = (settings ?? {}) as Record<string, unknown>;
  transport.platform = typeof info?.platform === "string" ? info.platform : "darwin";

  window.fastvibe = createFastVibeApi(transport);

  await import("@/main");
  hideGate();
}

void boot();
