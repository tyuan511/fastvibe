import { Ipc } from "@shared/ipc";
import { createFastVibeApi, type ApiTransport } from "@shared/api";

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

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let socket: WebSocket | null = null;
let nextCallId = 1;
const pending = new Map<number, Pending>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();

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
  if (!bucket) return;
  // Copied before iterating: a listener that detaches itself while being called would
  // otherwise mutate the set mid-iteration.
  for (const listener of [...bucket]) listener(payload);
}

function failPending(reason: string): void {
  for (const [, entry] of pending) entry.reject(new Error(reason));
  pending.clear();
}

/**
 * Open a socket and authenticate it.
 *
 * Resolves only once the server has accepted the token, so a caller can treat a
 * resolved promise as "this connection can carry calls". A refused token rejects with
 * `UNAUTHORIZED`, which is the signal to forget it and ask for the password again.
 */
function connect(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const next = new WebSocket(url.toString());
    let settled = false;

    next.addEventListener("open", () => {
      next.send(JSON.stringify({ type: "auth", token }));
    });

    next.addEventListener("message", (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (message.type === "auth") {
        if (settled) return;
        settled = true;
        if (message.ok === true) {
          socket = next;
          resolve();
        } else {
          next.close();
          reject(new Error("UNAUTHORIZED"));
        }
        return;
      }

      if (typeof message.push === "string") {
        dispatchPush(message.push, message.payload);
        return;
      }

      if (typeof message.id === "number") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok === true) entry.resolve(message.result);
        else entry.reject(new Error(typeof message.error === "string" ? message.error : "请求失败"));
      }
    });

    next.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("连接被关闭"));
        return;
      }
      if (socket === next) {
        socket = null;
        failPending("连接已断开");
        void reconnect();
      }
    });

    next.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(new Error("无法连接到服务器"));
    });
  });
}

/**
 * Come back after a dropped socket, then reload.
 *
 * Reloading rather than resuming is deliberate for now. Everything the app has on screen
 * was folded from an event stream, and the events that arrived while the socket was gone
 * are not replayed — so keeping the page would leave a transcript that looks complete and
 * is not, which is worse than the cost of starting over. Main already serves what a
 * precise resume needs (`engine:get-snapshot`, and a `seq` on every event); wiring the
 * renderer to re-snapshot in place is the better answer once it reads them.
 */
async function reconnect(): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    showGate("连接已断开", "请重新登录", { form: true });
    return;
  }
  showGate("连接已断开", "正在重新连接…", { spinner: true });
  for (let attempt = 0; ; attempt += 1) {
    await new Promise((settle) => window.setTimeout(settle, Math.min(10_000, 500 * 2 ** attempt)));
    try {
      await connect(token);
      window.location.reload();
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        localStorage.removeItem(TOKEN_KEY);
        showGate("需要重新登录", "这台设备的访问权限已被撤销或密码已更改", { form: true });
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
    const live = socket;
    if (!live || live.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("与服务器的连接已断开"));
    }
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pending.set(id, { resolve, reject });
      live.send(JSON.stringify({ id, method: channel, payload }));
    });
  },
  /**
   * Sent as an ordinary call whose reply is dropped.
   *
   * The wire has no one-way frame — the server answers every `id` it is given, and
   * refuses a frame without one — so "fire and forget" is a call nobody awaits. The
   * rejection is swallowed because these are logs and browser-bridge replies: losing one
   * while the socket is down must not surface as an error the user has to read.
   */
  send: (channel, payload) => {
    void transport.invoke(channel, payload).catch(() => undefined);
  },
  subscribe: (channel, listener) => {
    const bucket = listeners.get(channel) ?? new Set();
    bucket.add(listener as (payload: unknown) => void);
    listeners.set(channel, bucket);
    return () => {
      bucket.delete(listener as (payload: unknown) => void);
      if (bucket.size === 0) listeners.delete(channel);
    };
  },
  // Both filled from the handshake below, before the app is imported.
  settingsInitial: {},
  platform: "darwin",
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
function askForPassword(): Promise<string> {
  return new Promise((resolve) => {
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
          resolve(token);
        })
        .catch((error: unknown) => {
          showError(error instanceof Error ? error.message : "登录失败");
        })
        .finally(() => {
          gateSubmit.disabled = false;
        });
    };
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
    try {
      await connect(token);
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
