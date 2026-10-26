use fv_protocol::ClientRequest;
use fv_protocol::types::ClientOrigin;

/// Whether a connection of this origin may call this method.
///
/// Local (the owner's own unix socket) and Ssh (ssh already authenticated them) may call
/// everything. A remote origin gets the allowlist below. The `match` is exhaustive on purpose:
/// a method added to the protocol does not compile until someone decides who may call it,
/// where a denylist would have exposed it by default.
pub fn allows(origin: ClientOrigin, request: &ClientRequest) -> bool {
    match origin {
        ClientOrigin::Local | ClientOrigin::Ssh => true,
        ClientOrigin::Lan | ClientOrigin::Official => match request {
            ClientRequest::Initialize { .. }
            | ClientRequest::ThreadList { .. }
            | ClientRequest::ThreadSearch { .. }
            | ClientRequest::ThreadStart { .. }
            | ClientRequest::ThreadResume { .. }
            | ClientRequest::ThreadUnsubscribe { .. }
            | ClientRequest::TurnStart { .. }
            | ClientRequest::TurnInterrupt { .. }
            | ClientRequest::TurnSteer { .. }
            | ClientRequest::TurnRewind { .. }
            | ClientRequest::TurnEnqueue { .. }
            | ClientRequest::TurnQueueRemove { .. }
            | ClientRequest::TurnQueueSendNow { .. }
            | ClientRequest::TurnQueueResume { .. }
            | ClientRequest::ThreadUpdate { .. }
            | ClientRequest::ThreadFork { .. }
            | ClientRequest::ThreadDelete { .. }
            | ClientRequest::ThreadWorktreeCreate { .. }
            | ClientRequest::ThreadWorktreeBind { .. }
            | ClientRequest::ThreadWorktreeUnbind { .. }
            | ClientRequest::ThreadWorktreeList { .. }
            | ClientRequest::ThreadCompactStart { .. }
            | ClientRequest::ThreadModelSet { .. }
            | ClientRequest::ProviderList { .. }
            | ClientRequest::ProviderUpsert { .. }
            | ClientRequest::ProviderDelete { .. }
            | ClientRequest::ProviderReorder { .. }
            | ClientRequest::ModelList { .. }
            | ClientRequest::ModelDefaultsGet { .. }
            | ClientRequest::ModelDefaultsSet { .. }
            | ClientRequest::ProjectList { .. }
            | ClientRequest::ProjectCreate { .. }
            | ClientRequest::ProjectUpdate { .. }
            | ClientRequest::ProjectRemove { .. }
            | ClientRequest::WorkspaceReadDir { .. }
            | ClientRequest::WorkspacePreview { .. }
            | ClientRequest::WorkspaceSearchFiles { .. }
            | ClientRequest::WorkspaceWriteFile { .. }
            | ClientRequest::WorkspaceCreateEntry { .. }
            | ClientRequest::WorkspaceRenameEntry { .. }
            | ClientRequest::WorkspaceDeleteEntry { .. }
            | ClientRequest::WorkspaceGitStatus { .. }
            | ClientRequest::WorkspaceGitDiff { .. }
            | ClientRequest::WorkspaceGitComparison { .. }
            | ClientRequest::WorkspaceGitHistory { .. }
            | ClientRequest::WorkspaceGitStage { .. }
            | ClientRequest::WorkspaceGitUnstage { .. }
            | ClientRequest::WorkspaceGitDiscard { .. }
            | ClientRequest::WorkspaceGitDeleteUntracked { .. }
            | ClientRequest::WorkspaceGitCommit { .. }
            // A terminal is a shell the whole machine can be driven from. A client with the
            // password can already ask the agent to run commands, so this is the same trust — but
            // it must be a decision, and this is it.
            | ClientRequest::TerminalStart { .. }
            | ClientRequest::TerminalWrite { .. }
            | ClientRequest::TerminalResize { .. }
            | ClientRequest::TerminalRead { .. }
            | ClientRequest::TerminalCopy { .. }
            | ClientRequest::TerminalKill { .. }
            | ClientRequest::SettingsGet { .. }
            | ClientRequest::SkillList { .. }
            | ClientRequest::MemoryRead { .. }
            | ClientRequest::MemoryConfigure { .. }
            | ClientRequest::MemoryRun { .. }
            | ClientRequest::MemoryClear { .. }
            | ClientRequest::McpList { .. }
            | ClientRequest::McpSet { .. }
            | ClientRequest::McpUpdate { .. }
            | ClientRequest::McpAuthBegin { .. }
            | ClientRequest::McpAuthComplete { .. }
            | ClientRequest::McpAuthCancel { .. }
            | ClientRequest::McpAuthForget { .. }
            | ClientRequest::McpImport { .. }
            | ClientRequest::McpReconnect { .. }
            | ClientRequest::McpResources { .. }
            | ClientRequest::McpResourceTemplates { .. }
            | ClientRequest::McpReadResource { .. }
            | ClientRequest::SkillRead { .. }
            | ClientRequest::SkillCreate { .. }
            | ClientRequest::SkillImport { .. }
            | ClientRequest::SkillRemove { .. }
            | ClientRequest::SettingsSet { .. } => true,
            // Fetching a provider's model list makes this machine request an address the
            // caller chose: a lever a remote client does not need.
            ClientRequest::ProviderFetchModels { .. } => false,
        },
    }
}
