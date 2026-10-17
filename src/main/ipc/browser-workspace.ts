import { app, dialog, session, shell, webContents, type DownloadItem, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile, access } from "node:fs/promises";
import { Ipc } from "@shared/ipc";
import { browserShortcut, type BrowserClearData, type BrowserDownload, type BrowserDownloadAction } from "../../shared/browser-workspace";
import { BrowserLibraryStore } from "../engine/browser-library";
import { uiText } from "../engine/ui-text";
import { handle, type CallerContext } from "./registry";
import { broadcast } from "./broadcast";

export function registerBrowserWorkspaceIpc(): void {
  const partition = session.fromPartition("persist:fastvibe-browser");
  const store = new BrowserLibraryStore(join(app.getPath("userData"), "browser-library.json"));
  const ready = store.load().catch((error) => console.warn("browser library load failed", error));
  const live = new Map<string, DownloadItem>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = (): void => {
    // Download callbacks can arrive many times per second. Persist and notify together.
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void store.save().catch((error) => console.warn("browser library save failed", error));
      broadcast(Ipc.browserLibraryChanged, null);
    }, 250);
  };
  const guestFor = (id: number, ctx: CallerContext): WebContents => {
    const guest = webContents.fromId(id);
    if (!ctx.window || !guest || guest.isDestroyed() || guest.getType() !== "webview" ||
        guest.session !== partition || guest.hostWebContents !== ctx.window.webContents) {
      throw new Error(uiText("浏览器页面已关闭", "Browser page is no longer available"));
    }
    return guest;
  };

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview" || contents.session !== partition) return;
    const record = (): void => {
      void ready.then(() => {
        if (contents.isDestroyed()) return;
        store.visit({ url: contents.getURL(), title: contents.getTitle(), visitedAt: Date.now() });
        changed();
      });
    };
    contents.on("did-navigate", record);
    contents.on("did-navigate-in-page", (_event, _url, mainFrame) => { if (mainFrame) record(); });
    contents.on("page-title-updated", () => {
      void ready.then(() => {
        if (contents.isDestroyed()) return;
        const item = store.data.history.find((item) => item.url === contents.getURL());
        if (item) { item.title = contents.getTitle().slice(0, 512); changed(); }
      });
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const command = browserShortcut(input, process.platform === "darwin");
      const host = contents.hostWebContents;
      if (!command || !host || host.isDestroyed()) return;
      // Escape remains available to page widgets as well as closing browser chrome.
      if (command !== "escape") event.preventDefault();
      broadcast(Ipc.browserShortcut, { guestId: contents.id, command, at: Date.now() }, { only: `window:${host.id}` });
    });
  });

  partition.on("will-download", (_event, item) => {
    const id = randomUUID();
    const record: BrowserDownload = {
      id, name: item.getFilename(), url: item.getURL(), path: "", received: 0,
      total: item.getTotalBytes(), startedAt: Date.now(), state: "progressing", paused: false, canResume: false,
    };
    live.set(id, item);
    const update = (state?: BrowserDownload["state"]): void => {
      Object.assign(record, {
        path: item.getSavePath(), received: item.getReceivedBytes(), total: item.getTotalBytes(),
        state: state ?? item.getState(), paused: item.isPaused(), canResume: item.canResume(),
      });
      changed();
    };
    item.on("updated", () => update());
    item.once("done", (_event, state) => {
      update(state);
      record.canResume = false;
      live.delete(id);
    });
    void ready.then(() => {
      // Keep every active transfer even when the completed record limit is reached.
      store.data.downloads = [record, ...store.data.downloads].filter((row, index) => live.has(row.id) || index < 100);
      changed();
    });
    // Leaving savePath unset preserves Electron's native destination picker.
  });

  handle(Ipc.browserLibrary, async () => { await ready; return store.data; });
  handle(Ipc.browserClearData, async (options?: BrowserClearData) => {
    await ready;
    const chosen = options ?? { cookies: true, cache: true };
    if (chosen.cookies) await partition.clearStorageData();
    if (chosen.cache) await partition.clearCache();
    if (chosen.history) store.data.history = [];
    if (chosen.downloads) store.data.downloads = store.data.downloads.filter((item) => live.has(item.id));
    await store.save();
    broadcast(Ipc.browserLibraryChanged, null);
  });
  handle(Ipc.browserDownloadAction, async (payload: { id: string; action: BrowserDownloadAction }) => {
    await ready;
    const row = store.data.downloads.find((item) => item.id === payload.id);
    if (!row) throw new Error(uiText("下载记录已不存在", "Download no longer exists"));
    if (payload.action === "reveal") {
      if (!row.path || row.state !== "completed") throw new Error(uiText("文件尚未下载完成", "Download is not complete"));
      await access(row.path);
      shell.showItemInFolder(row.path);
      return;
    }
    const item = live.get(payload.id);
    if (!item) throw new Error(uiText("下载已结束", "Download has ended"));
    switch (payload.action) {
      case "cancel": item.cancel(); break;
      case "pause": item.pause(); row.paused = true; break;
      case "resume":
        if (!item.canResume() && !item.isPaused()) throw new Error(uiText("此下载无法继续", "This download cannot be resumed"));
        item.resume(); row.paused = false; break;
      default: throw new Error("Unknown download action");
    }
    changed();
  });
  handle(Ipc.browserCapture, async (payload: { guestId: number }, ctx) => {
    const guest = guestFor(payload.guestId, ctx);
    const picture = await guest.capturePage();
    if (picture.isEmpty()) throw new Error(uiText("页面截图为空", "The page capture is empty"));
    const result = await dialog.showSaveDialog(ctx.window!, {
      defaultPath: join(app.getPath("downloads"), `FastVibe-${Date.now()}.png`),
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, picture.toPNG());
    return result.filePath;
  });
  handle(Ipc.browserPrint, (payload: { guestId: number }, ctx) => {
    const guest = guestFor(payload.guestId, ctx);
    return new Promise<void>((resolve, reject) => guest.print({ printBackground: true }, (success, reason) => {
      if (success || /cancel/i.test(reason)) resolve();
      else reject(new Error(reason || uiText("打印失败", "Print failed")));
    }));
  });
}
