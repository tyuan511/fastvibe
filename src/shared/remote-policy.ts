import { Ipc } from "./ipc.ts";

/**
 * Which methods a remote client may call.
 *
 * Shared rather than main-only, and imported by a relative path so `node --test` can
 * resolve it: the server reads this to *refuse* a call, and the renderer reads the same
 * table to *hide* the control that would make it. Two lists would drift the moment one
 * is edited, and the drift is silent in the direction that matters — a button that is
 * still there, does nothing, and says nothing about why.
 *
 * Stated as an exhaustive classification — every registered method is named in exactly
 * one of the two sets below, and `assertPolicyCoverage` refuses to start the server if
 * the call table holds one that is in neither. A denylist alone would fail *open*: the
 * next method somebody adds would be remotely callable because nobody remembered to
 * think about it. This way adding a method breaks the server until it is classified,
 * which is the failure that gets noticed.
 *
 * The bar for denying is narrow on purpose. Whoever holds the password can already ask
 * the agent to run commands on this machine, so blocking the terminal or a git write
 * buys no safety and costs a working client. What is denied is only:
 *
 *   (a) calls that would *hang* — a native dialog opens on the machine running the
 *       server, where nobody is looking, and the promise never settles;
 *   (b) calls that act on the wrong machine's desktop — opening a shell, revealing a
 *       folder, driving a window, launching a browser for an OAuth flow;
 *   (c) levers an attacker would not otherwise have — pointing the app at an arbitrary
 *       URL with arbitrary credentials, or packaging up the logs.
 */

/** Denied, with the reason the client is told. */
const DENIED = new Map<string, string>([
  // (a) Native dialogs: they open where nobody is looking, and never resolve.
  [Ipc.workspacePick, "\u8be5\u64cd\u4f5c\u4f1a\u5728\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111\u4e0a\u6253\u5f00\u6587\u4ef6\u9009\u62e9\u6846\uff0c\u8fdc\u7a0b\u65e0\u6cd5\u5b8c\u6210"],
  [Ipc.projectsAdd, "\u8be5\u64cd\u4f5c\u4f1a\u5728\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111\u4e0a\u6253\u5f00\u6587\u4ef6\u9009\u62e9\u6846\uff0c\u8fdc\u7a0b\u65e0\u6cd5\u5b8c\u6210"],
  [Ipc.engineImportSkill, "\u8be5\u64cd\u4f5c\u4f1a\u5728\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111\u4e0a\u6253\u5f00\u6587\u4ef6\u9009\u62e9\u6846\uff0c\u8fdc\u7a0b\u65e0\u6cd5\u5b8c\u6210"],
  [Ipc.engineExportHtml, "\u5bfc\u51fa\u4f1a\u5199\u5165\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111\uff0c\u8fdc\u7a0b\u65e0\u6cd5\u53d6\u56de"],
  [Ipc.appExportLogs, "\u65e5\u5fd7\u5bfc\u51fa\u4f1a\u5199\u5165\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111\uff0c\u8fdc\u7a0b\u65e0\u6cd5\u53d6\u56de"],

  // (b) Acts on the desktop that is running the server, not on the client's.
  [Ipc.workspaceReveal, "\u8be5\u64cd\u4f5c\u53ea\u4f5c\u7528\u4e8e\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111"],
  [Ipc.workspaceOpenTerminal, "\u8be5\u64cd\u4f5c\u53ea\u4f5c\u7528\u4e8e\u8fd0\u884c\u670d\u52a1\u7aef\u7684\u7535\u8111"],
  [Ipc.windowNew, "\u8fdc\u7a0b\u5ba2\u6237\u7aef\u6ca1\u6709\u7a97\u53e3"],
  [Ipc.windowMinimize, "\u8fdc\u7a0b\u5ba2\u6237\u7aef\u6ca1\u6709\u7a97\u53e3"],
  [Ipc.windowToggleMaximize, "\u8fdc\u7a0b\u5ba2\u6237\u7aef\u6ca1\u6709\u7a97\u53e3"],
  [Ipc.windowClose, "\u8fdc\u7a0b\u5ba2\u6237\u7aef\u6ca1\u6709\u7a97\u53e3"],
  [Ipc.windowIsMaximized, "\u8fdc\u7a0b\u5ba2\u6237\u7aef\u6ca1\u6709\u7a97\u53e3"],
  [Ipc.updateCheck, "\u5e94\u7528\u66f4\u65b0\u53ea\u80fd\u5728\u672c\u673a\u8fdb\u884c"],
  [Ipc.updateDownload, "\u5e94\u7528\u66f4\u65b0\u53ea\u80fd\u5728\u672c\u673a\u8fdb\u884c"],
  [Ipc.updateInstall, "\u5b89\u88c5\u66f4\u65b0\u4f1a\u9000\u51fa\u5e94\u7528\uff0c\u53ea\u80fd\u5728\u672c\u673a\u8fdb\u884c"],
  // The browser-use bridge runs in a renderer `<webview>`, which a web client has no
  // equivalent of; a request forwarded here would wait for a reply that never comes.
  [Ipc.browserResponse, "\u6d4f\u89c8\u5668\u5de5\u5177\u4f9d\u8d56\u684c\u9762\u7aef\u7684\u5185\u5d4c\u6d4f\u89c8\u5668"],
  [Ipc.browserListProfiles, "\u6d4f\u89c8\u5668\u5de5\u5177\u4f9d\u8d56\u684c\u9762\u7aef\u7684\u5185\u5d4c\u6d4f\u89c8\u5668"],
  [Ipc.browserImportProfile, "\u6d4f\u89c8\u5668\u5de5\u5177\u4f9d\u8d56\u684c\u9762\u7aef\u7684\u5185\u5d4c\u6d4f\u89c8\u5668"],
  [Ipc.browserClearData, "\u6d4f\u89c8\u5668\u5de5\u5177\u4f9d\u8d56\u684c\u9762\u7aef\u7684\u5185\u5d4c\u6d4f\u89c8\u5668"],
  [Ipc.browserListEngines, "\u6d4f\u89c8\u5668\u5de5\u5177\u4f9d\u8d56\u684c\u9762\u7aef\u7684\u5185\u5d4c\u6d4f\u89c8\u5668"],
  // Granting the driver its macOS permissions opens System Settings and a TCC prompt on
  // the machine running the server \u2014 (a) and (b) at once. The `computer_*` tools
  // themselves stay available remotely: the agent runs on the host, so driving the host's
  // desktop is what a remote client is asking for, not a misdirected action.
  [Ipc.computerPermissions, "\u7535\u8111\u64cd\u4f5c\u6743\u9650\u53ea\u80fd\u5728\u672c\u673a\u67e5\u770b\u548c\u6388\u6743"],
  [Ipc.computerRequestPermissions, "\u7535\u8111\u64cd\u4f5c\u6743\u9650\u53ea\u80fd\u5728\u672c\u673a\u67e5\u770b\u548c\u6388\u6743"],
  [Ipc.computerOpenSettings, "\u7535\u8111\u64cd\u4f5c\u6743\u9650\u53ea\u80fd\u5728\u672c\u673a\u67e5\u770b\u548c\u6388\u6743"],
  [Ipc.computerListApps, "\u7535\u8111\u64cd\u4f5c\u6743\u9650\u53ea\u80fd\u5728\u672c\u673a\u67e5\u770b\u548c\u6388\u6743"],
  // A drag has to start from a real window's webContents, and the panel it starts from
  // is a window opened on the server's own screen. A web client has neither.
  [Ipc.computerStartDrag, "\u62d6\u62fd\u6388\u6743\u53ea\u80fd\u5728\u684c\u9762\u7aef\u5b8c\u6210"],
  [Ipc.computerStartGrantFlow, "\u62d6\u62fd\u6388\u6743\u53ea\u80fd\u5728\u684c\u9762\u7aef\u5b8c\u6210"],
  [Ipc.computerCancelGrantFlow, "\u62d6\u62fd\u6388\u6743\u53ea\u80fd\u5728\u684c\u9762\u7aef\u5b8c\u6210"],
  [Ipc.computerGetGrantFlow, "\u62d6\u62fd\u6388\u6743\u53ea\u80fd\u5728\u684c\u9762\u7aef\u5b8c\u6210"],
  // A subscription login opens the system browser on the server's machine and waits on
  // a loopback callback there. Nothing about it can complete from another device.
  [Ipc.providersOAuthLogin, "\u8ba2\u9605\u767b\u5f55\u9700\u8981\u5728\u672c\u673a\u6d4f\u89c8\u5668\u4e2d\u5b8c\u6210"],
  [Ipc.providersOAuthAnswer, "\u8ba2\u9605\u767b\u5f55\u9700\u8981\u5728\u672c\u673a\u6d4f\u89c8\u5668\u4e2d\u5b8c\u6210"],
  [Ipc.providersOAuthCancel, "\u8ba2\u9605\u767b\u5f55\u9700\u8981\u5728\u672c\u673a\u6d4f\u89c8\u5668\u4e2d\u5b8c\u6210"],

  // SSH host profiles and tunnels are local desktop controls. A browser already
  // connected to this machine must not be able to rewrite its SSH destinations.
  // Sanitized config is readable remotely (see ALLOWED below); saving or probing a local
  // HTTP endpoint from Main is a lever a remote caller should not have, and there is no
  // benefit to letting a phone configure which model runs on this desktop.
  [Ipc.decisionSaveConfig, "决策模型只能在本机配置"],
  [Ipc.decisionTest, "决策模型只能在本机配置"],
  [Ipc.decisionSetKey, "决策模型只能在本机配置"],
  [Ipc.sshHosts, "SSH 主机只能在本机管理"],
  [Ipc.sshHostSave, "SSH 主机只能在本机管理"],
  [Ipc.sshHostRemove, "SSH 主机只能在本机管理"],
  [Ipc.sshPickIdentityFile, "SSH 主机只能在本机管理"],
  [Ipc.sshTest, "SSH 主机只能在本机管理"],
  [Ipc.sshHostKeyScan, "SSH 主机只能在本机管理"],
  [Ipc.sshHostKeyTrust, "SSH 主机只能在本机管理"],
  [Ipc.sshStopAgent, "SSH 主机只能在本机管理"],
  [Ipc.sshConnect, "SSH 主机只能在本机管理"],
  [Ipc.sshDisconnect, "SSH 主机只能在本机管理"],
  [Ipc.sshState, "SSH 主机只能在本机管理"],
  [Ipc.sshStates, "SSH 主机只能在本机管理"],

  // Remote access administers itself only from the desktop. A stolen token must not be
  // able to change the password, revoke the owner's other devices, or switch the server
  // off — that turns one compromised client into a locked-out owner.
  [Ipc.remoteGetState, "远程访问的设置只能在本机更改"],
  [Ipc.remoteSetPassword, "远程访问的设置只能在本机更改"],
  [Ipc.remoteClearPassword, "远程访问的设置只能在本机更改"],
  [Ipc.remoteStart, "远程访问的设置只能在本机更改"],
  [Ipc.remoteStop, "远程访问的设置只能在本机更改"],
  [Ipc.remoteListDevices, "远程访问的设置只能在本机更改"],
  [Ipc.remoteRevokeDevice, "远程访问的设置只能在本机更改"],
  [Ipc.remoteTunnelTools, "远程访问的设置只能在本机更改"],
  [Ipc.remoteTunnelSet, "远程访问的设置只能在本机更改"],

  // (c) A request to any URL the caller names, carrying any credential the caller
  // names, issued from this machine and from this network. That is a probe into
  // whatever the machine can reach, and it needs no agent to use.
  [Ipc.providersFetch, "\u8be5\u64cd\u4f5c\u4f1a\u4ece\u670d\u52a1\u7aef\u53d1\u8d77\u4efb\u610f\u5916\u90e8\u8bf7\u6c42\uff0c\u8fdc\u7a0b\u4e0d\u53ef\u7528"],
  // The same arbitrary-URL request as `providers:fetch`, minus the credential — which
  // makes it the more useful probe, not the less: no key is needed to map what this
  // machine can reach.
  [Ipc.providersProbeGateway, "\u8be5\u64cd\u4f5c\u4f1a\u4ece\u670d\u52a1\u7aef\u53d1\u8d77\u4efb\u610f\u5916\u90e8\u8bf7\u6c42\uff0c\u8fdc\u7a0b\u4e0d\u53ef\u7528"],
  [Ipc.providersIdentifyGateway, "\u8be5\u64cd\u4f5c\u4f1a\u4ece\u670d\u52a1\u7aef\u53d1\u8d77\u4efb\u610f\u5916\u90e8\u8bf7\u6c42\uff0c\u8fdc\u7a0b\u4e0d\u53ef\u7528"],
]);

/**
 * Allowed, named one by one.
 *
 * Listing these out is the point: it is what makes a newly added method fail the
 * coverage check instead of quietly becoming reachable from the internet.
 */
const ALLOWED = new Set<string>([
  Ipc.appGetInfo,
  Ipc.appLog,
  Ipc.conversationsCreate,
  Ipc.conversationsCreateSide,
  Ipc.conversationsDelete,
  Ipc.conversationsList,
  Ipc.conversationsOpen,
  Ipc.conversationsRecordPrompt,
  Ipc.conversationsRestorePrompt,
  Ipc.conversationsRename,
  Ipc.conversationsSearch,
  Ipc.conversationsSetProject,
  Ipc.conversationsCreateWorktree,
  Ipc.conversationsBindWorktree,
  Ipc.conversationsUnbindWorktree,
  Ipc.conversationsListWorktrees,
  // No secret in either — the Jev key never leaves Main — so a remote client reading
  // which decision model is selected, and whether a key exists, costs nothing.
  Ipc.decisionGetConfig,
  Ipc.decisionKeyState,
  Ipc.engineAbort,
  Ipc.engineAbortSubagent,
  Ipc.engineBranch,
  Ipc.engineClearQueue,
  Ipc.engineCompact,
  Ipc.engineContinue,
  Ipc.engineCreateSkill,
  Ipc.engineFollowUp,
  Ipc.engineFork,
  Ipc.engineGetCheckpoint,
  Ipc.engineGetCommands,
  Ipc.engineGetConversationMessages,
  Ipc.engineGetExtensions,
  Ipc.engineGetMessages,
  Ipc.engineGetMessagesSince,
  Ipc.engineGetModels,
  Ipc.engineGetRunning,
  Ipc.engineGetSnapshot,
  Ipc.engineGetState,
  Ipc.engineGetStats,
  Ipc.engineGetStatus,
  Ipc.engineGetSubagentMessages,
  Ipc.engineGetSubagents,
  Ipc.engineListAgentConfigs,
  Ipc.engineRemoveAgentConfig,
  Ipc.engineSaveAgentConfig,
  Ipc.engineImportCandidates,
  Ipc.engineImportSessions,
  Ipc.engineImportSources,
  Ipc.engineInstallExtensionPackage,
  Ipc.engineListExtensionPackages,
  Ipc.engineListMarketPackages,
  Ipc.engineListMcpServers,
  Ipc.engineListSkills,
  Ipc.engineNewSession,
  Ipc.enginePermissionRespond,
  Ipc.enginePrompt,
  Ipc.enginePromptConversation,
  Ipc.engineQueueAdd,
  Ipc.engineQueueCancel,
  Ipc.engineQueueRecall,
  Ipc.engineQueueReorder,
  Ipc.engineQueueResume,
  Ipc.engineQueueSendNow,
  Ipc.engineRemoveExtensionPackage,
  Ipc.engineRemoveSkill,
  Ipc.engineReplaceSteering,
  Ipc.engineRestoreCheckpoint,
  Ipc.engineSaveMcpServers,
  Ipc.engineSetAutoCompact,
  // The headless Agent additionally requires the per-SSH token established during
  // bootstrap; listing this here only lets the App Protocol carry that trusted call.
  Ipc.engineSyncConfig,
  Ipc.engineSetFollowUp,
  Ipc.engineSetInterrupt,
  Ipc.engineSetModel,
  Ipc.engineSetSteering,
  Ipc.engineSetThinking,
  Ipc.engineStart,
  Ipc.engineSteer,
  Ipc.engineStop,
  Ipc.modelsDevUpdate,
  Ipc.projectsAddRemote,
  Ipc.projectsRemove,
  Ipc.projectsRename,
  Ipc.projectsReorder,
  Ipc.providersAdd,
  Ipc.providersAddNative,
  Ipc.providersCcSwitchImport,
  Ipc.providersCcSwitchScan,
  Ipc.providersList,
  Ipc.providersLogout,
  Ipc.providersNative,
  // Balance reads are allowed: the URL comes from the stored provider and the key from
  // the engine's own store, so the call can only read an allowance this install already
  // holds — the same bargain `providers:quota` makes for the OpenAI providers.
  Ipc.providersGatewayBalance,
  Ipc.providersGatewayCredentials,
  Ipc.providersQuota,
  Ipc.providersRefresh,
  Ipc.providersRemove,
  Ipc.providersSaveFastVibe,
  Ipc.providersUpdate,
  Ipc.settingsClear,
  Ipc.settingsGet,
  Ipc.settingsSet,
  Ipc.settingsProxySet,
  Ipc.statsUsage,
  Ipc.updateGetState,
  Ipc.workspaceFileIcons,
  Ipc.workspaceGitBranches,
  Ipc.workspaceGitCheckout,
  Ipc.workspaceGitCommit,
  Ipc.workspaceGitGenerateCommitMessage,
  Ipc.workspaceGitCreateBranch,
  Ipc.workspaceGitDiff,
  Ipc.workspaceGitDiscard,
  Ipc.workspaceGitPull,
  Ipc.workspaceGitPush,
  Ipc.workspaceGitStage,
  Ipc.workspaceGitStatus,
  Ipc.workspaceGitUnstage,
  Ipc.workspacePreview,
  Ipc.workspaceReadDir,
  Ipc.workspaceTerminalKill,
  Ipc.workspaceTerminalResize,
  Ipc.workspaceTerminalStart,
  Ipc.workspaceTerminalWrite,
]);

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export function remotePolicy(method: string): PolicyVerdict {
  const reason = DENIED.get(method);
  if (reason !== undefined) return { allowed: false, reason };
  if (ALLOWED.has(method)) return { allowed: true };
  // Unclassified: refuse. `assertPolicyCoverage` should have caught this at startup, so
  // reaching here means the server is running against a table it was not checked
  // against — deny rather than guess.
  return { allowed: false, reason: "\u8be5\u65b9\u6cd5\u672a\u5f00\u653e\u7ed9\u8fdc\u7a0b\u5ba2\u6237\u7aef" };
}

/**
 * Refuse to start against a call table this policy does not cover.
 *
 * Both directions matter. A registered method in neither set would be reachable only
 * because nobody classified it; a classified method that no longer exists is a rename
 * that left a rule guarding nothing, which reads as protection and is not.
 */
export function assertPolicyCoverage(channels: readonly string[], options?: { requireAll?: boolean }): void {
  const known = new Set(channels);
  const unclassified = channels.filter((channel) => !ALLOWED.has(channel) && !DENIED.has(channel));
  const stale = options?.requireAll === false ? [] : [...ALLOWED, ...DENIED.keys()].filter((method) => !known.has(method));
  const problems: string[] = [];
  if (unclassified.length > 0) {
    problems.push(`未分类的方法（请在 policy.ts 中归入 ALLOWED 或 DENIED）: ${unclassified.join(", ")}`);
  }
  if (stale.length > 0) {
    problems.push(`策略中的方法已不存在: ${stale.join(", ")}`);
  }
  if (problems.length > 0) throw new Error(`remote policy coverage: ${problems.join(" / ")}`);
}

/**
 * Why a remote client cannot call this, or null when it can.
 *
 * What the renderer uses to decide whether a control belongs on screen at all
 * (`lib/remote-unavailable.ts`). The reason is the same sentence the server would have
 * answered with, so a tooltip and a refusal never disagree.
 */
export function remoteDenialReason(method: string): string | null {
  const verdict = remotePolicy(method);
  return verdict.allowed ? null : verdict.reason;
}

/** The methods a remote client may call, for the settings pane and for tests. */
export function allowedMethods(): string[] {
  return [...ALLOWED];
}

export function deniedMethods(): string[] {
  return [...DENIED.keys()];
}
