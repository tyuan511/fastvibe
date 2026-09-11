import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Ipc } from "@shared/ipc";
import { readFilePreview } from "./omp/file-preview";
import { loadModelsDev } from "./omp/models-dev";
import { getFastVibePaths } from "./omp/paths";
import { OmpProcessManager } from "./omp/process-manager";
import type { ProviderModel } from "@shared/types";

app.setName("FastVibe");

const omp = new OmpProcessManager();
let mainWindow: BrowserWindow | null = null;

function resolveAppIcon(): string {
  const name = process.platform === "darwin" ? "icon.icns" : "icon.png";
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, "../../resources", name);
}

function applyAppIcon(): void {
  const image = nativeImage.createFromPath(resolveAppIcon());
  if (image.isEmpty()) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    title: "FastVibe",
    icon: resolveAppIcon(),
    backgroundColor: "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.on("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow = window;
}

function broadcastStatus(): void {
  mainWindow?.webContents.send(Ipc.status, omp.status);
}

function registerIpc(): void {
  ipcMain.handle(Ipc.ompGetStatus, () => omp.status);

  ipcMain.handle(Ipc.ompStart, async (_event, payload?: { cwd?: string }) => {
    return omp.start(payload?.cwd ?? omp.cwd);
  });

  ipcMain.handle(Ipc.ompStop, async () => {
    await omp.stop();
    return omp.status;
  });

  ipcMain.handle(
    Ipc.ompPrompt,
    async (
      _event,
      payload: {
        message: string;
        streamingBehavior?: "steer" | "followUp";
        images?: Array<{ type: "image"; data: string; mimeType: string }>;
      },
    ) => {
      await omp.prompt(payload.message, {
        streamingBehavior: payload.streamingBehavior,
        images: payload.images,
      });
    },
  );

  ipcMain.handle(
    Ipc.ompSteer,
    async (_event, payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => {
      await omp.steer(payload.message, payload.images);
    },
  );

  ipcMain.handle(
    Ipc.ompFollowUp,
    async (_event, payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => {
      await omp.followUp(payload.message, payload.images);
    },
  );

  ipcMain.handle(Ipc.ompAbort, async () => {
    await omp.abort();
  });

  ipcMain.handle(Ipc.ompClearQueue, async () => {
    return omp.clearQueue();
  });

  ipcMain.handle(Ipc.ompCompact, async (_event, payload?: { customInstructions?: string }) => {
    return omp.compact(payload?.customInstructions);
  });

  ipcMain.handle(Ipc.ompGetCommands, async () => {
    return omp.getCommands();
  });

  ipcMain.handle(Ipc.ompGetSubagents, async () => {
    return omp.getSubagents();
  });

  ipcMain.handle(Ipc.ompGetSubagentMessages, async (_event, payload: { subagentId: string }) => {
    return omp.getSubagentMessages(payload.subagentId);
  });

  ipcMain.handle(
    Ipc.ompPermissionRespond,
    (_event, payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean }) => {
      omp.respondPermission(payload);
    },
  );

  ipcMain.handle(Ipc.ompNewSession, async () => {
    await omp.newSession();
  });

  ipcMain.handle(Ipc.ompGetState, async () => {
    return omp.getState();
  });

  ipcMain.handle(Ipc.ompGetModels, async () => {
    return omp.getAvailableModels();
  });

  ipcMain.handle(Ipc.ompSetModel, async (_event, payload: { provider: string; modelId: string }) => {
    return omp.setModel(payload.provider, payload.modelId);
  });

  ipcMain.handle(Ipc.ompSetThinking, async (_event, payload: { level: string }) => {
    return omp.setThinkingLevel(payload.level);
  });
  ipcMain.handle(Ipc.ompSetInterrupt, async (_event, payload: { mode: "immediate" | "wait" }) => {
    return omp.setInterruptMode(payload.mode);
  });
  ipcMain.handle(Ipc.ompSetAutoCompact, async (_event, payload: { enabled: boolean }) => {
    return omp.setAutoCompaction(payload.enabled);
  });
  ipcMain.handle(Ipc.ompBranch, async (_event, payload: { entryId: string }) => {
    return omp.branch(payload.entryId);
  });
  ipcMain.handle(Ipc.ompGetMessages, async () => {
    return omp.loadMessages();
  });
  ipcMain.handle(Ipc.ompGetStats, async () => {
    return omp.getSessionStats();
  });
  ipcMain.handle(Ipc.ompSetSteering, async (_event, payload: { mode: "all" | "one-at-a-time" }) => {
    return omp.setSteeringMode(payload.mode);
  });
  ipcMain.handle(Ipc.ompSetFollowUp, async (_event, payload: { mode: "all" | "one-at-a-time" }) => {
    return omp.setFollowUpMode(payload.mode);
  });
  ipcMain.handle(Ipc.ompExportHtml, async () => {
    const path = await omp.exportHtml();
    if (path) await shell.openPath(path);
    return path;
  });

  ipcMain.handle(Ipc.providersList, async () => {
    return omp.listProviders();
  });
  ipcMain.handle(
    Ipc.providersFetch,
    async (_event, payload: { baseUrl: string; apiKey: string }) => {
      return omp.fetchModels(payload.baseUrl, payload.apiKey);
    },
  );
  ipcMain.handle(
    Ipc.providersSaveFastVibe,
    async (_event, payload: { apiKey: string; models: ProviderModel[] }) => {
      return omp.saveFastVibe(payload.apiKey, payload.models);
    },
  );
  ipcMain.handle(
    Ipc.providersAdd,
    async (_event, payload: { name: string; baseUrl: string; apiKey: string; models: ProviderModel[] }) => {
      return omp.addProvider(
        { name: payload.name, baseUrl: payload.baseUrl, apiKey: payload.apiKey },
        payload.models,
      );
    },
  );
  ipcMain.handle(
    Ipc.providersUpdate,
    async (
      _event,
      payload: { id: string; name?: string; baseUrl?: string; apiKey?: string; models?: ProviderModel[] },
    ) => {
      return omp.updateProvider(payload.id, {
        name: payload.name,
        baseUrl: payload.baseUrl,
        apiKey: payload.apiKey,
        models: payload.models,
      });
    },
  );
  ipcMain.handle(Ipc.providersRemove, async (_event, payload: { id: string }) => {
    return omp.removeProvider(payload.id);
  });
  ipcMain.handle(Ipc.providersRefresh, async (_event, payload: { id: string }) => {
    return omp.refreshProviderModels(payload.id);
  });

  ipcMain.handle(Ipc.conversationsList, () => omp.listWorkspace());
  ipcMain.handle(Ipc.conversationsCreate, async (_event, payload?: { project?: string }) => {
    return omp.createConversation(payload?.project);
  });
  ipcMain.handle(Ipc.conversationsOpen, async (_event, payload: { id: string }) => {
    return omp.openConversation(payload.id);
  });
  ipcMain.handle(Ipc.conversationsRename, (_event, payload: { id: string; title: string }) => {
    return omp.renameConversation(payload.id, payload.title);
  });
  ipcMain.handle(Ipc.conversationsDelete, async (_event, payload: { id: string }) => {
    return omp.deleteConversation(payload.id);
  });
  ipcMain.handle(Ipc.conversationsRecordPrompt, (_event, payload: { id: string; text: string }) => {
    return omp.recordPrompt(payload.id, payload.text);
  });
  ipcMain.handle(Ipc.conversationsSetProject, async (_event, payload: { id: string; project: string | null }) => {
    return omp.setConversationProject(payload.id, payload.project);
  });
  ipcMain.handle(Ipc.projectsAdd, async () => {
    const result = await dialog.showOpenDialog({
      title: "打开项目",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return omp.addProject(result.filePaths[0]);
  });
  ipcMain.handle(Ipc.projectsRename, (_event, payload: { cwd: string; name: string }) => {
    return omp.renameProject(payload.cwd, payload.name);
  });
  ipcMain.handle(Ipc.projectsRemove, async (_event, payload: { cwd: string }) => {
    return omp.removeProject(payload.cwd);
  });
  ipcMain.handle(Ipc.workspaceReveal, async (_event, payload: { cwd: string }) => {
    if (!payload.cwd) return;
    try {
      if (statSync(payload.cwd).isFile()) {
        shell.showItemInFolder(payload.cwd);
        return;
      }
    } catch {
      // fall through
    }
    await shell.openPath(payload.cwd);
  });
  ipcMain.handle(Ipc.workspacePreview, (_event, payload: { path: string }) => {
    if (!payload.path) return { kind: "error", path: "", name: "", message: "路径无效" };
    return readFilePreview(payload.path);
  });
  ipcMain.handle(Ipc.appGetInfo, () => {
    const paths = getFastVibePaths();
    const meta = loadModelsDev().stats;
    return {
      version: app.getVersion(),
      userData: paths.userData,
      runtimeRoot: paths.ompRoot,
      platform: process.platform,
      modelsDev: {
        models: meta.models,
        aliases: meta.aliases,
        generatedAt: meta.generatedAt,
        path: meta.path,
      },
    };
  });

  ipcMain.handle(Ipc.workspacePick, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择项目",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const cwd = result.filePaths[0];
    omp.addProject(cwd);
    await omp.start(cwd);
    return { cwd, status: omp.status };
  });
}

app.whenReady().then(async () => {
  applyAppIcon();
  registerIpc();

  omp.onStatus(() => broadcastStatus());
  omp.onEvent((event) => {
    if (event.type === "extension_ui_request") {
      void omp.handleExtensionUi(event);
    }
    mainWindow?.webContents.send(Ipc.event, event);
  });

  createWindow();
  void omp.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let stopping = false;

app.on("before-quit", (event) => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  void omp.stop().finally(() => app.quit());
});
