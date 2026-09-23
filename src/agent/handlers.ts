import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { Ipc } from "@shared/ipc";
import type { AgentConfigSyncPayload } from "@shared/agent-config";
import type { CallerContext } from "../main/ipc/registry";
import { broadcast, subscribe } from "../main/ipc/broadcast";
import { dispatch, handle, handlerChannels } from "../main/ipc/registry";
import type { PiProcessManager } from "../main/pi/process-manager";
import { readFilePreview } from "../main/engine/file-preview";
import { readWorkspaceDir } from "../main/engine/workspace-fs";
import { TerminalSessions } from "../main/engine/terminal-sessions";
import { applyLanguages } from "../main/engine/ai-language";
import { applyPermissionMode, clearAppSettings, invalidateAppSettingsCache, readAppSettings, writeAppSettings } from "../main/engine/runtime-settings";
import { writeAgentConfig } from "../main/engine/runtime-config";
import type { FastVibePaths } from "../main/engine/paths";
import type { GitBranch, GitDiffSource, GitStatus } from "@shared/ipc";
import type { ImportSourceId, ProviderModel, UsageRange, McpServerConfig, SkillDraft, SubagentDraft } from "@shared/types";
import type { AgentRuntime } from "./runtime";

const execFileAsync = promisify(execFile);

export type AgentIpcDeps = {
  runtime: AgentRuntime;
  terminals: TerminalSessions;
  log: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void };
};

/** Register the Electron-free part of the shared call table for a Linux Agent. */
export function registerAgentIpc(deps: AgentIpcDeps): void {
  const engine = deps.runtime.engine;
  const paths = deps.runtime.paths;
  const terminals = deps.terminals;

  handle(Ipc.engineGetStatus, () => engine.status);
  handle(Ipc.engineStart, async (payload?: { cwd?: string }) => engine.start(payload?.cwd ?? engine.cwd));
  handle(Ipc.engineStop, async () => { await engine.stop(); return engine.status; });
  handle(Ipc.enginePrompt, async (payload: { message: string; streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string }) => {
    await engine.prompt(payload.message, { streamingBehavior: payload.streamingBehavior, images: payload.images, conversationId: payload.conversationId });
  });
  handle(Ipc.engineSteer, async (payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string }) => engine.steer(payload.message, payload.images, payload.conversationId));
  handle(Ipc.engineFollowUp, async (payload: { message: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; conversationId?: string }) => engine.followUp(payload.message, payload.images, payload.conversationId));
  handle(Ipc.engineAbort, async (payload?: { conversationId?: string }) => engine.abort(payload?.conversationId));
  handle(Ipc.engineAbortSubagent, async (payload: { subagentId: string; conversationId?: string }) => engine.abortSubagent(payload.subagentId, payload.conversationId));
  handle(Ipc.engineContinue, async (payload?: { conversationId?: string }) => engine.continueTurn(payload?.conversationId));
  handle(Ipc.engineClearQueue, async (payload?: { conversationId?: string }) => engine.clearQueue(payload?.conversationId));
  handle(Ipc.engineCompact, async (payload?: { customInstructions?: string; conversationId?: string }) => engine.compact(payload?.customInstructions, payload?.conversationId));
  handle(Ipc.engineGetCommands, (payload?: { conversationId?: string }) => engine.getCommands(payload?.conversationId));
  handle(Ipc.engineReplaceSteering, (payload: { items: Array<{ text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }>; conversationId?: string }) => engine.replaceSteering(payload.items, payload.conversationId));
  handle(Ipc.engineGetExtensions, () => engine.getExtensions());
  handle(Ipc.engineInstallExtensionPackage, (payload: { source: string }) => engine.installExtensionPackage(payload.source));
  handle(Ipc.engineRemoveExtensionPackage, (payload: { source: string }) => engine.removeExtensionPackage(payload.source));
  handle(Ipc.engineListExtensionPackages, () => engine.listExtensionPackages());
  handle(Ipc.engineListMcpServers, () => engine.listMcpServers());
  handle(Ipc.engineSaveMcpServers, (payload: { configs: McpServerConfig[] }) => engine.saveMcpServers(payload.configs));
  handle(Ipc.engineListSkills, () => engine.listSkills());
  handle(Ipc.engineCreateSkill, (payload: SkillDraft) => engine.createSkill(payload));
  handle(Ipc.engineRemoveSkill, (payload: { name: string }) => engine.removeSkill(payload.name));
  handle(Ipc.engineGetSubagents, (payload?: { conversationId?: string }) => engine.getSubagents(payload?.conversationId));
  handle(Ipc.engineListAgentConfigs, () => engine.getAgentConfigs());
  handle(Ipc.engineSaveAgentConfig, (payload: SubagentDraft) => engine.saveAgentConfig(payload));
  handle(Ipc.engineRemoveAgentConfig, (payload: { id: string }) => engine.removeAgentConfig(payload.id));
  handle(Ipc.engineGetSubagentMessages, (payload: { subagentId: string; conversationId?: string }) => engine.getSubagentMessages(payload.subagentId, payload.conversationId));
  handle(Ipc.engineGetCheckpoint, (payload: { conversationId: string }) => engine.getCheckpoint(payload.conversationId));
  handle(Ipc.engineRestoreCheckpoint, (payload: { conversationId: string }) => engine.restoreCheckpoint(payload.conversationId));
  handle(Ipc.enginePermissionRespond, (payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean; answers?: Array<string | null>; planAction?: "approve" | "revise" | "ignore" }) => engine.respondPermission(payload));
  handle(Ipc.engineNewSession, () => engine.newSession());
  handle(Ipc.engineGetState, (payload?: { conversationId?: string }) => engine.getState(payload?.conversationId));
  handle(Ipc.engineGetRunning, () => engine.getRunningConversations());
  handle(Ipc.engineGetPendingUi, () => engine.getPendingUi());
  handle(Ipc.engineGetModels, () => engine.getAvailableModels());
  handle(Ipc.engineSyncConfig, async (payload: AgentConfigSyncPayload) => {
    const expectedToken = process.env.FASTVIBE_AGENT_SYNC_TOKEN;
    if (!expectedToken || payload?.syncToken !== expectedToken) throw new Error("配置同步凭据无效");
    const previousMcp = readFileOrEmpty(paths.mcpFile);
    const { syncToken: _syncToken, ...snapshot } = payload;
    writeAgentConfig(paths, snapshot);
    invalidateAppSettingsCache();
    const settings = readAppSettings(paths);
    applyPermissionMode(settings);
    applyLanguages(settings);
    await engine.reloadProviders();
    if (payload && "mcp" in payload && payload.mcp !== previousMcp) {
      const parsed = typeof payload.mcp === "string" ? JSON.parse(payload.mcp) as unknown : [];
      await engine.saveMcpServers(Array.isArray(parsed) ? parsed : []);
    }
  });
  handle(Ipc.engineSetModel, (payload: { provider: string; modelId: string; conversationId?: string }) => engine.setModel(payload.provider, payload.modelId, payload.conversationId));
  handle(Ipc.engineSetThinking, (payload: { level: string; conversationId?: string }) => engine.setThinkingLevel(payload.level, payload.conversationId));
  handle(Ipc.engineSetInterrupt, (payload: { mode: "immediate" | "wait"; conversationId?: string }) => engine.setInterruptMode(payload.mode, payload.conversationId));
  handle(Ipc.engineSetAutoCompact, (payload: { enabled: boolean; conversationId?: string }) => engine.setAutoCompaction(payload.enabled, payload.conversationId));
  handle(Ipc.engineBranch, (payload: { entryId: string; conversationId?: string }) => engine.branch(payload.entryId, payload.conversationId));
  handle(Ipc.engineGetMessages, (payload?: { conversationId?: string }) => engine.loadMessages(payload?.conversationId));
  handle(Ipc.engineGetSnapshot, (payload?: { conversationId?: string }) => engine.getSnapshot(payload?.conversationId));
  handle(Ipc.engineGetStats, (payload?: { conversationId?: string }) => engine.getSessionStats(payload?.conversationId));
  handle(Ipc.engineSetSteering, (payload: { mode: "all" | "one-at-a-time"; conversationId?: string }) => engine.setSteeringMode(payload.mode, payload.conversationId));
  handle(Ipc.engineSetFollowUp, (payload: { mode: "all" | "one-at-a-time"; conversationId?: string }) => engine.setFollowUpMode(payload.mode, payload.conversationId));
  handle(Ipc.enginePromptConversation, (payload: { id: string; message: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }) => engine.promptConversation(payload.id, payload.message, payload.images));
  handle(Ipc.engineGetConversationMessages, (payload: { id: string }) => engine.getConversationMessages(payload.id));

  handle(Ipc.conversationsList, () => engine.listWorkspace());
  handle(Ipc.conversationsCreate, (payload?: { project?: string; activate?: boolean }) => engine.createConversation(payload?.project, { activate: payload?.activate !== false }));
  handle(Ipc.conversationsOpen, (payload: { id: string }) => engine.openConversation(payload.id));
  handle(Ipc.conversationsRename, (payload: { id: string; title: string }) => engine.renameConversation(payload.id, payload.title));
  handle(Ipc.conversationsDelete, (payload: { id: string }) => engine.deleteConversation(payload.id));
  handle(Ipc.conversationsRecordPrompt, (payload: { id: string; text: string }) => engine.recordPrompt(payload.id, payload.text));
  handle(Ipc.conversationsSetProject, (payload: { id: string; project: string | null }) => engine.setConversationProject(payload.id, payload.project));
  handle(Ipc.conversationsSearch, (payload: { query?: string }) => engine.searchConversations(payload?.query ?? ""));
  handle(Ipc.conversationsCreateSide, (payload: { project?: string; parentId?: string; title?: string }) => engine.createSideConversation(payload?.project, payload?.parentId, payload?.title));
  handle(Ipc.projectsAddRemote, (payload: { cwd?: string }) => {
    const value = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
    if (!value) throw new Error("远程项目目录不能为空");
    return engine.addProject(value);
  });
  handle(Ipc.projectsRename, (payload: { cwd: string; name: string }) => engine.renameProject(payload.cwd, payload.name));
  handle(Ipc.projectsRemove, (payload: { cwd: string }) => engine.removeProject(payload.cwd));
  handle(Ipc.projectsReorder, (payload: { cwds: string[] }) => engine.reorderProjects(Array.isArray(payload?.cwds) ? payload.cwds : []));

  handle(Ipc.workspacePreview, (payload: { path: string }) => readFilePreview(payload.path));
  handle(Ipc.workspaceReadDir, (payload: { path: string }) => readWorkspaceDir(payload.path));
  handle(Ipc.workspaceGitStatus, (payload: { cwd: string }) => readGitStatus(payload.cwd));
  handle(Ipc.workspaceGitBranches, (payload: { cwd: string }) => gitBranches(payload.cwd));
  handle(Ipc.workspaceGitCheckout, (payload: { cwd: string; branch: string }) => gitCheckout(payload.cwd, payload.branch));
  handle(Ipc.workspaceGitCreateBranch, (payload: { cwd: string; branch: string }) => gitCreateBranch(payload.cwd, payload.branch));
  handle(Ipc.workspaceGitStage, (payload: { cwd: string; paths?: string[]; all?: boolean }) => gitStage(payload.cwd, payload.paths, payload.all));
  handle(Ipc.workspaceGitCommit, (payload: { cwd: string; message: string }) => gitCommit(payload.cwd, payload.message));
  handle(Ipc.workspaceGitDiff, (payload: { cwd: string; path?: string; source?: GitDiffSource }) => gitDiff(payload.cwd, payload.path, payload.source));
  handle(Ipc.workspaceGitUnstage, (payload: { cwd: string; paths: string[] }) => gitUnstage(payload.cwd, payload.paths));
  handle(Ipc.workspaceGitDiscard, (payload: { cwd: string; paths: string[] }) => gitDiscard(payload.cwd, payload.paths));
  handle(Ipc.workspaceGitPull, (payload: { cwd: string }) => gitRemote(payload.cwd, "pull"));
  handle(Ipc.workspaceGitPush, (payload: { cwd: string }) => gitRemote(payload.cwd, "push"));
  handle(Ipc.workspaceTerminalStart, (payload: { cwd?: string; cols?: number; rows?: number }) => terminals.start(payload.cwd || homedir(), { cols: payload.cols, rows: payload.rows }));
  handle(Ipc.workspaceTerminalWrite, (payload: { id: string; data: string }) => terminals.write(payload.id, payload.data));
  handle(Ipc.workspaceTerminalResize, (payload: { id: string; cols: number; rows: number }) => terminals.resize(payload.id, payload.cols, payload.rows));
  handle(Ipc.workspaceTerminalKill, (payload: { id: string }) => terminals.kill(payload.id));

  handle(Ipc.settingsGet, () => readAppSettings(paths));
  handle(Ipc.settingsSet, (payload: Record<string, unknown>) => {
    writeAppSettings(paths, payload && typeof payload === "object" ? payload : {});
    applyPermissionMode(payload ?? {});
    return undefined;
  });
  handle(Ipc.settingsClear, () => {
    clearAppSettings(paths);
    applyPermissionMode({});
  });
  handle(Ipc.appGetInfo, () => ({ version: process.env.FASTVIBE_VERSION ?? "agent", userData: paths.userData, runtimeRoot: paths.runtimeRoot, platform: process.platform }));
  handle(Ipc.workspaceFileIcons, () => ({ files: {}, folders: {} }));
  handle(Ipc.statsUsage, (_payload?: { range?: UsageRange }) => ({ range: "30d", from: "", to: "", totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, requests: 0, toolCalls: 0, activeDays: 0 }, days: [], models: [], sessions: 0, longestSessionMinutes: 0, currentStreak: 0, longestStreak: 0 }));

  handle(Ipc.providersList, () => engine.listProviders());
  handle(Ipc.providersNative, () => engine.listNativeProviders());
  handle(Ipc.providersAdd, (payload: { name: string; baseUrl: string; apiKey: string; api?: any; models: ProviderModel[] }) => engine.addProvider({ name: payload.name, baseUrl: payload.baseUrl, apiKey: payload.apiKey, api: payload.api }, payload.models));
  handle(Ipc.providersUpdate, (payload: { id: string; name?: string; baseUrl?: string; api?: any; enabled?: boolean; apiKey?: string; models?: ProviderModel[] }) => engine.updateProvider(payload.id, payload));
  handle(Ipc.providersRemove, (payload: { id: string }) => engine.removeProvider(payload.id));
  handle(Ipc.providersRefresh, (payload: { id: string }) => engine.refreshProviderModels(payload.id));
  handle(Ipc.providersSaveFastVibe, (payload: { apiKey: string; models: ProviderModel[] }) => engine.saveFastVibe(payload.apiKey, payload.models));
  handle(Ipc.providersAddNative, (payload: { id: string; apiKey: string; models: ProviderModel[] }) => engine.addNativeProvider(payload.id, payload.apiKey, payload.models));
  handle(Ipc.providersLogout, (payload: { id: string }) => engine.logoutProvider(payload.id));
  handle(Ipc.providersQuota, (payload: { id: "openai" | "openai-codex"; force?: boolean }) => engine.getOpenAIAccountQuota(payload.id, payload.force === true));
  handle(Ipc.modelsDevUpdate, () => import("../main/engine/models-dev-update").then(({ updateModelsDevSnapshot }) => updateModelsDevSnapshot()));

  bindAgentPush(engine, terminals);
}

export function agentChannels(): readonly string[] {
  return handlerChannels();
}

export function bindAgentPush(engine: PiProcessManager, terminals: TerminalSessions): void {
  engine.onStatus((status) => broadcast(Ipc.status, status));
  engine.onConversationReady((payload) => broadcast(Ipc.conversationReady, payload));
  engine.onWorkspaceChange((snapshot) => broadcast(Ipc.workspaceChanged, snapshot));
  engine.onOAuthEvent((payload) => broadcast(Ipc.providersOAuthEvent, payload));
  terminals.onData((event) => broadcast(Ipc.workspaceTerminalData, event));
  engine.onEvent((event) => {
    if (event.type === "extension_ui_request") void engine.handleExtensionUi(event);
    broadcast(Ipc.event, event);
  });
}

function readFileOrEmpty(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function cwd(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseBranchHeader(header: string): string {
  // `main...origin/main [ahead 1]`, `No commits yet on main`, `HEAD (no branch)`.
  const name = header.split("...")[0]?.split(" ")[0] ?? "";
  return name === "HEAD" ? "" : name;
}

function parseGitNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split(/\r?\n/)) {
    const [added, removed] = line.split("\t", 3);
    if (/^\d+$/.test(added ?? "")) additions += Number(added);
    if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
  }
  return { additions, deletions };
}

async function readGitStatus(root: string): Promise<GitStatus> {
  const dir = cwd(root);
  const empty: GitStatus = { cwd: dir, isRepository: false, changed: 0, staged: 0, additions: 0, deletions: 0, files: [] };
  if (!dir) return empty;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "status", "--short", "--branch"], { timeout: 5000, maxBuffer: 256 * 1024 });
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const header = lines.shift() ?? "";
    if (!header.startsWith("## ")) return empty;
    const branch = parseBranchHeader(header.slice(3));
    const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0);
    const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0);
    let changed = 0;
    let staged = 0;
    const files: GitStatus["files"] = [];
    for (const line of lines) {
      if (line.length < 2) continue;
      changed += 1;
      if (line[0] !== " " && line[0] !== "?") staged += 1;
      files.push({ index: line[0] === "?" ? "?" : line[0], worktree: line[1] ?? " ", path: line.slice(3).trim() });
    }
    let additions = 0;
    let deletions = 0;
    try {
      const diff = await execFileAsync("git", ["-C", dir, "diff", "--numstat", "HEAD", "--"], { timeout: 5000, maxBuffer: 256 * 1024 });
      ({ additions, deletions } = parseGitNumstat(diff.stdout));
    } catch {
      // An unborn branch has no HEAD: sum the staged and unstaged layers instead.
      const [stagedDiff, workingDiff] = await Promise.all([
        execFileAsync("git", ["-C", dir, "diff", "--numstat", "--cached", "--"], { timeout: 5000, maxBuffer: 256 * 1024 }).catch(() => ({ stdout: "" })),
        execFileAsync("git", ["-C", dir, "diff", "--numstat", "--"], { timeout: 5000, maxBuffer: 256 * 1024 }).catch(() => ({ stdout: "" })),
      ]);
      const stagedStats = parseGitNumstat(stagedDiff.stdout);
      const workingStats = parseGitNumstat(workingDiff.stdout);
      additions = stagedStats.additions + workingStats.additions;
      deletions = stagedStats.deletions + workingStats.deletions;
    }
    return { cwd: dir, isRepository: true, branch, changed, staged, additions, deletions, ahead, behind, files };
  } catch {
    return empty;
  }
}

async function gitBranches(root: string): Promise<GitBranch[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd(root), "for-each-ref", "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)", "refs/heads"], { timeout: 5000, maxBuffer: 128 * 1024 });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [name, head, upstream] = line.split("\t"); return { name, current: head === "*", upstream: upstream || undefined }; });
}

async function gitCheckout(root: string, branch: string): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), "switch", branch], { timeout: 10000 }); return readGitStatus(root); }
async function gitCreateBranch(root: string, branch: string): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), "switch", "-c", branch], { timeout: 10000 }); return readGitStatus(root); }
async function gitStage(root: string, paths?: string[], all?: boolean): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), "add", all || !paths?.length ? "-A" : "--", ...(paths ?? [])], { timeout: 10000 }); return readGitStatus(root); }
async function gitCommit(root: string, message: string): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), "commit", "-m", message], { timeout: 30000 }); return readGitStatus(root); }
async function gitDiff(root: string, path?: string, source: GitDiffSource = "unstaged"): Promise<string> { const args = ["-C", cwd(root), "diff", "--no-ext-diff", "--unified=3"]; if (source === "staged") args.push("--cached"); else if (source === "branch") args.push("@{upstream}...HEAD"); else if (source === "last-turn") args.push("HEAD"); if (path) args.push("--", path); try { const { stdout } = await execFileAsync("git", args, { timeout: 10000, maxBuffer: 1024 * 1024 }); return stdout; } catch (error: any) { return typeof error?.stdout === "string" ? error.stdout : ""; } }
async function gitUnstage(root: string, paths: string[]): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), "restore", "--staged", "--", ...paths], { timeout: 10000 }); return readGitStatus(root); }
async function gitDiscard(root: string, paths: string[]): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), "restore", "--worktree", "--source=HEAD", "--", ...paths], { timeout: 10000 }); return readGitStatus(root); }
async function gitRemote(root: string, command: "pull" | "push"): Promise<GitStatus> { await execFileAsync("git", ["-C", cwd(root), command, ...(command === "pull" ? ["--ff-only"] : [])], { timeout: 60000 }); return readGitStatus(root); }
