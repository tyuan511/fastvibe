import { dialog, shell } from "electron";
import { Ipc } from "@shared/ipc";
import type { ImportSourceId } from "@shared/types";
import { handle } from "./registry";
import { uiText } from "../engine/ui-text";
import { fetchPackageCatalog } from "../pi/package-catalog";
import { PiProcessManager } from "../pi/process-manager";

/** Register engine/session IPC without mixing it into the Electron bootstrap. */
export function registerEngineIpc(engine: PiProcessManager): void {
  handle(Ipc.engineGetStatus, () => engine.status);

  handle(Ipc.engineStart, async (payload?: { cwd?: string }) => {
    return engine.start(payload?.cwd ?? engine.cwd);
  });

  handle(Ipc.engineStop, async () => {
    await engine.stop();
    return engine.status;
  });

  handle(
    Ipc.enginePrompt,
    async (
      payload: {
        message: string;
        streamingBehavior?: "steer" | "followUp";
        images?: Array<{ type: "image"; data: string; mimeType: string }>;
        /** Omitted by single-window callers, which mean "the chat on screen". */
        conversationId?: string;
      },
    ) => {
      await engine.prompt(payload.message, {
        streamingBehavior: payload.streamingBehavior,
        images: payload.images,
        conversationId: payload.conversationId,
      });
    },
  );

  handle(
    Ipc.engineSteer,
    async (
      payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string },
    ) => {
      await engine.steer(payload.message, payload.images, payload.conversationId);
    },
  );

  handle(
    Ipc.engineFollowUp,
    async (
      payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string },
    ) => {
      await engine.followUp(payload.message, payload.images, payload.conversationId);
    },
  );

  handle(Ipc.engineAbort, async (payload?: { conversationId?: string }) => {
    await engine.abort(payload?.conversationId);
  });

  handle(Ipc.engineAbortSubagent, async (payload: { subagentId: string; conversationId?: string }) => {
    await engine.abortSubagent(payload.subagentId, payload.conversationId);
  });

  handle(Ipc.engineContinue, async (payload?: { conversationId?: string }) => {
    await engine.continueTurn(payload?.conversationId);
  });

  handle(Ipc.engineClearQueue, async (payload?: { conversationId?: string }) => {
    return engine.clearQueue(payload?.conversationId);
  });

  handle(
    Ipc.engineReplaceSteering,
    async (
      payload: {
        items: Array<{ text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }>;
        conversationId?: string;
      },
    ) => {
      await engine.replaceSteering(payload.items, payload.conversationId);
    },
  );

  handle(Ipc.engineQueueAdd, async (payload: Parameters<typeof engine.enqueueMessage>[0]) => {
    return engine.enqueueMessage(payload);
  });
  handle(Ipc.engineQueueCancel, async (payload: { id: string }) => engine.cancelQueued(payload.id));
  handle(Ipc.engineQueueRecall, async (payload: { id: string }) => engine.recallQueued(payload.id));
  handle(Ipc.engineQueueSendNow, async (payload: { id: string }) => engine.sendQueuedNow(payload.id));
  handle(Ipc.engineQueueReorder, async (payload: { conversationId: string; ids: string[] }) =>
    engine.reorderQueued(payload.conversationId, payload.ids));
  handle(Ipc.engineQueueResume, async (payload: { conversationId: string }) =>
    engine.resumeQueue(payload.conversationId));

  handle(Ipc.engineCompact, async (payload?: { customInstructions?: string; conversationId?: string }) => {
    return engine.compact(payload?.customInstructions, payload?.conversationId);
  });

  handle(Ipc.engineGetCommands, async (payload?: { conversationId?: string }) => {
    return engine.getCommands(payload?.conversationId);
  });
  handle(Ipc.engineGetExtensions, async () => engine.getExtensions());
  handle(Ipc.engineListExtensionPackages, async () => engine.listExtensionPackages());
  handle(
    Ipc.engineInstallExtensionPackage,
    async (payload: { source: string }) => engine.installExtensionPackage(payload.source),
  );
  handle(
    Ipc.engineRemoveExtensionPackage,
    async (payload: { source: string }) => engine.removeExtensionPackage(payload.source),
  );
  handle(
    Ipc.engineListMarketPackages,
    async (payload: import("@shared/types").MarketPackageQuery) => fetchPackageCatalog(payload),
  );
  handle(Ipc.engineListMcpServers, async () => engine.listMcpServers());
  handle(Ipc.engineSaveMcpServers, async (payload: { configs: import("@shared/types").McpServerConfig[] }) => engine.saveMcpServers(payload.configs));
  handle(Ipc.engineListSkills, async () => engine.listSkills());
  handle(Ipc.engineCreateSkill, async (payload: import("@shared/types").SkillDraft) => engine.createSkill(payload));
  handle(Ipc.engineImportSkill, async () => {
    const result = await dialog.showOpenDialog({
      title: uiText("导入技能", "Import skill"),
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return engine.importSkill(result.filePaths[0]);
  });
  handle(Ipc.engineRemoveSkill, async (payload: { name: string }) => engine.removeSkill(payload.name));

  handle(Ipc.engineGetSubagents, async (payload?: { conversationId?: string }) => {
    return engine.getSubagents(payload?.conversationId);
  });
  handle(Ipc.engineListAgentConfigs, () => engine.getAgentConfigs());
  handle(Ipc.engineSaveAgentConfig, (payload: import("@shared/types").SubagentDraft) => engine.saveAgentConfig(payload));
  handle(Ipc.engineRemoveAgentConfig, (payload: { id: string }) => engine.removeAgentConfig(payload.id));

  handle(Ipc.engineGetSubagentMessages, async (payload: { subagentId: string; conversationId?: string }) => {
    return engine.getSubagentMessages(payload.subagentId, payload.conversationId);
  });

  handle(Ipc.engineGetCheckpoint, (payload: { conversationId: string }) => {
    return engine.getCheckpoint(payload.conversationId);
  });

  handle(Ipc.engineRestoreCheckpoint, async (payload: { conversationId: string }) => {
    return engine.restoreCheckpoint(payload.conversationId);
  });

  handle(Ipc.conversationsSearch, (payload: { query?: string }) => {
    return engine.searchConversations(payload?.query ?? "");
  });

  handle(
    Ipc.enginePermissionRespond,
    (payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean; answers?: Array<string | null>; planAction?: "approve" | "revise" | "ignore" }) => {
      engine.respondPermission(payload);
    },
  );

  handle(Ipc.engineNewSession, async () => {
    await engine.newSession();
  });

  handle(Ipc.engineGetState, async (payload?: { conversationId?: string }) => {
    return engine.getState(payload?.conversationId);
  });

  handle(Ipc.engineGetRunning, async () => {
    return engine.getRunningConversations();
  });

  handle(Ipc.engineGetPendingUi, () => engine.getPendingUi());

  handle(Ipc.engineGetModels, async () => {
    return engine.getAvailableModels();
  });

  // The SSH gateway invokes this on the headless Agent. Keep the method in the
  // desktop table for protocol coverage, but never accept it as a local write.
  handle(Ipc.engineSyncConfig, async () => {
    throw new Error("配置同步只能由 SSH Agent 接收");
  });

  handle(
    Ipc.engineSetModel,
    async (payload: { provider: string; modelId: string; conversationId?: string }) => {
      return engine.setModel(payload.provider, payload.modelId, payload.conversationId);
    },
  );

  handle(
    Ipc.engineSetThinking,
    async (payload: { level: string; conversationId?: string }) => {
      return engine.setThinkingLevel(payload.level, payload.conversationId);
    },
  );
  handle(Ipc.engineSetInterrupt, async (payload: { mode: "immediate" | "wait"; conversationId?: string }) => {
    return engine.setInterruptMode(payload.mode, payload.conversationId);
  });
  handle(Ipc.engineSetAutoCompact, async (payload: { enabled: boolean; conversationId?: string }) => {
    return engine.setAutoCompaction(payload.enabled, payload.conversationId);
  });
  handle(Ipc.engineBranch, async (payload: { entryId: string; conversationId?: string }) => {
    return engine.branch(payload.entryId, payload.conversationId);
  });
  handle(Ipc.engineFork, async (payload?: { entryId?: string; conversationId?: string }) => {
    return engine.fork(payload?.entryId, payload?.conversationId);
  });
  handle(Ipc.engineGetMessages, async (payload?: { conversationId?: string }) => {
    return engine.loadMessages(payload?.conversationId);
  });
  handle(Ipc.engineGetMessagesSince, async (payload?: { anchorEntryId?: string; conversationId?: string }) => {
    const anchor = payload?.anchorEntryId;
    if (!anchor) return { mode: "full", messages: await engine.loadMessages(payload?.conversationId) };
    return engine.loadMessagesSince(anchor, payload?.conversationId);
  });
  handle(Ipc.engineGetSnapshot, async (payload?: { conversationId?: string }) => {
    return engine.getSnapshot(payload?.conversationId);
  });
  handle(Ipc.engineGetStats, async (payload?: { conversationId?: string }) => {
    return engine.getSessionStats(payload?.conversationId);
  });
  handle(Ipc.engineSetSteering, async (payload: { mode: "all" | "one-at-a-time"; conversationId?: string }) => {
    return engine.setSteeringMode(payload.mode, payload.conversationId);
  });
  handle(Ipc.engineSetFollowUp, async (payload: { mode: "all" | "one-at-a-time"; conversationId?: string }) => {
    return engine.setFollowUpMode(payload.mode, payload.conversationId);
  });
  handle(Ipc.engineExportHtml, async () => {
    const path = await engine.exportHtml();
    if (path) await shell.openPath(path);
    return path;
  });
  // 设置 → 导入. Read-only scans of the other agents' data plus an explicit import;
  // nothing here runs on the live engine, so a scan cannot disturb the chat in flight.
  handle(Ipc.engineImportSources, async () => engine.importSources());
  handle(Ipc.engineImportCandidates, async (payload: { source: ImportSourceId }) =>
    engine.importCandidates(payload.source),
  );
  handle(Ipc.engineImportSessions, async (payload: { source: ImportSourceId; ids: string[] }) =>
    engine.importSessions(payload.source, payload.ids),
  );

}
