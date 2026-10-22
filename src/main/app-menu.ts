import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { Ipc, type MenuAction } from "@shared/ipc";
import {
  MENU_COMMAND_IDS,
  chordToAccelerator,
  sanitizeMenuBindings,
  type MenuBindings,
  type MenuCommandId,
} from "@shared/menu-commands";
import { uiText } from "./engine/ui-text";
import { log } from "./engine/logger";

/**
 * The macOS menu bar.
 *
 * Before this existed FastVibe showed Electron's *default* menu on a Mac: a generic
 * File/Edit/View/Window/Help with 重新加载 and 开发者工具 in it, and — the reason this file
 * exists — no way to reach 设置, because the default app menu has no Preferences item and
 * no ⌘, hint. A Mac user reads the menu bar to find out what an app can do; an app that
 * puts nothing there is an app with no settings.
 *
 * Only macOS gets a menu. On Windows and Linux the app draws its own title bar spanning
 * the window (`components/layout/title-bar.tsx`), and a native menu bar would sit on top of
 * that row — so those platforms keep exactly what they had, and the renderer's own
 * dispatcher (设置 → 快捷键) stays the only key handler there.
 *
 * Labels are Main's (native chrome, like the notification text and the open dialog), and
 * the *keys* come from the window: the renderer sends its effective bindings, this module
 * registers them and answers with the commands it took. A registered accelerator is
 * consumed before the page sees the keypress, so the page must not handle those too —
 * `nativeMenuOwns` is how it knows which to skip.
 */

/** Where a menu item asking for the window's help is delivered. */
const WEBSITE_URL = "https://fastvibe.dev";

/** The window set lives in index.ts, which owns window creation. */
let windowSet: () => Iterable<BrowserWindow> = () => [];

let installed = false;
/** Whether the last build actually landed. A menu that failed to build must not claim keys. */
let menuUp = false;
let bindings: MenuBindings = {};

export function installApplicationMenu(windows: () => Iterable<BrowserWindow>): void {
  windowSet = windows;
  if (installed || process.platform !== "darwin") return;
  installed = true;
  rebuild();
}

/**
 * Adopt the window's bindings and report the commands whose keys the menu now owns.
 *
 * Empty when no native menu was installed (Windows, Linux, the browser preview harness):
 * the caller keeps handling every chord itself, which is what it did before.
 */
export function syncMenuBindings(payload: unknown): MenuCommandId[] {
  bindings = sanitizeMenuBindings(payload);
  if (installed) rebuild();
  return ownedCommands();
}

/** Rebuild after a 界面语言 change: the labels are read at build time. */
export function refreshApplicationMenu(): void {
  if (installed) rebuild();
}

function ownedCommands(): MenuCommandId[] {
  if (!installed || !menuUp) return [];
  return MENU_COMMAND_IDS.filter((id) => chordToAccelerator(bindings[id]) !== null);
}

function rebuild(): void {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
    menuUp = true;
  } catch (error) {
    // Losing the menu must not take the window with it. Say so by handing every key back:
    // the renderer's dispatcher answers all of them again, and the app stays usable —
    // just without the bar.
    menuUp = false;
    log.error(`application menu build failed: ${String(error)}`);
  }
}

/** One command row: the label is ours, the key is whatever the window says it is. */
function command(id: MenuCommandId, label: string): MenuItemConstructorOptions {
  const accelerator = chordToAccelerator(bindings[id]);
  return {
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => sendCommand(id),
  };
}

function sendCommand(id: MenuCommandId): void {
  const target = focusedWindow();
  if (!target) return;
  target.webContents.send(Ipc.menuAction, { id } satisfies MenuAction);
}

/** The window the menu belongs to: the one the user is looking at, or the first alive. */
function focusedWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  for (const window of windowSet()) {
    if (!window.isDestroyed()) return window;
  }
  return null;
}

function template(): MenuItemConstructorOptions[] {
  const appName = app.name || "FastVibe";
  const dev = !app.isPackaged;
  return [
    {
      // The app menu. macOS draws the bundle name here whatever this label says, but the
      // items are the app's own: 关于 and 设置… are what a person looks for first.
      label: appName,
      submenu: [
        command("about", uiText(`关于 ${appName}`, `About ${appName}`)),
        { type: "separator" },
        command("settings", uiText("设置…", "Settings…")),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: uiText("隐藏 FastVibe", "Hide FastVibe") },
        { role: "hideOthers", label: uiText("隐藏其他", "Hide Others") },
        { role: "unhide", label: uiText("显示全部", "Show All") },
        { type: "separator" },
        { role: "quit", label: uiText("退出 FastVibe", "Quit FastVibe") },
      ],
    },
    {
      label: uiText("文件", "File"),
      submenu: [
        command("newChat", uiText("新对话", "New Chat")),
        command("openFolder", uiText("打开文件夹…", "Open Folder…")),
        { type: "separator" },
        { role: "close", label: uiText("关闭窗口", "Close Window") },
      ],
    },
    // The standard Edit menu, including the two macOS appends nobody writes by hand
    // (Start Dictation, Emoji & Symbols) that `editMenu` brings with it.
    { role: "editMenu", label: uiText("编辑", "Edit") },
    {
      label: uiText("视图", "View"),
      submenu: [
        command("commandPalette", uiText("命令面板", "Command Palette")),
        command("focusComposer", uiText("聚焦输入框", "Focus Composer")),
        { type: "separator" },
        command("toggleSidebar", uiText("切换侧边栏", "Toggle Sidebar")),
        command("toggleSidePane", uiText("切换侧边面板", "Toggle Side Pane")),
        { type: "separator" },
        command("prevChat", uiText("上一个对话", "Previous Chat")),
        command("nextChat", uiText("下一个对话", "Next Chat")),
        { type: "separator" },
        // A reload throws away the renderer while a run is streaming into it, so it stays
        // where the console does: available while developing, not one click from a menu.
        // 全屏 is the exception to spelling a label here: Electron swaps 进入/退出 by itself.
        ...(dev
          ? [
              { role: "reload" as const, label: uiText("重新加载", "Reload") },
              { role: "forceReload" as const, label: uiText("强制重新加载", "Force Reload") },
              { role: "toggleDevTools" as const, label: uiText("切换开发者工具", "Toggle Developer Tools") },
              { type: "separator" as const },
            ]
          : []),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu", label: uiText("窗口", "Window") },
    {
      role: "help",
      label: uiText("帮助", "Help"),
      submenu: [
        command("shortcutSettings", uiText("快捷键…", "Keyboard Shortcuts…")),
        {
          label: uiText("FastVibe 官网", "FastVibe Website"),
          click: () => {
            void shell.openExternal(WEBSITE_URL).catch((error: unknown) => log.warn(`menu link failed: ${String(error)}`));
          },
        },
      ],
    },
  ];
}
