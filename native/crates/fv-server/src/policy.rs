use fv_protocol::ClientRequest;
use fv_protocol::types::ClientOrigin;

/// Whether a connection of this origin may call this method.
///
/// Local (the owner's own unix socket) may call everything. SSH is also authenticated,
/// but local Office preview leases name a loopback view on this machine and stay local. A remote origin gets the allowlist below. The `match` is exhaustive on purpose:
/// a method added to the protocol does not compile until someone decides who may call it,
/// where a denylist would have exposed it by default.
pub fn allows(origin: ClientOrigin, request: &ClientRequest) -> bool {
    match origin {
        ClientOrigin::Local => true,
        ClientOrigin::Ssh => !matches!(
            request,
            ClientRequest::OfficeWatchStart { .. }
                | ClientRequest::OfficeWatchStop { .. }
                | ClientRequest::OfficeWatchStateGet { .. }
                | ClientRequest::OfficeSelectionGet { .. }
                | ClientRequest::ComputerInstall { .. }
                | ClientRequest::ComputerHost { .. }
                | ClientRequest::ElectronMigrationScan { .. }
                | ClientRequest::ElectronMigrationCommit { .. }
                | ClientRequest::RemoteStatusGet { .. }
                | ClientRequest::RemoteConfigure { .. }
                | ClientRequest::RemoteSetPassword { .. }
                | ClientRequest::RemoteRevoke { .. }
                | ClientRequest::AccountStatus { .. }
                | ClientRequest::AccountLogin { .. }
                | ClientRequest::AccountCancelLogin { .. }
                | ClientRequest::AccountLogout { .. }
                | ClientRequest::OfficialStatusGet { .. }
                | ClientRequest::OfficialConfigure { .. }
        ),
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
            | ClientRequest::TurnQueueReorder { .. }
            | ClientRequest::TurnQueueEdit { .. }
            | ClientRequest::TurnQueueSendNow { .. }
            | ClientRequest::TurnQueueResume { .. }
            | ClientRequest::ThreadModeSet { .. }
            | ClientRequest::ThreadReviewStart { .. }
            | ClientRequest::ThreadGoalSet { .. }
            | ClientRequest::ThreadGoalPause { .. }
            | ClientRequest::ThreadGoalResume { .. }
            | ClientRequest::ThreadGoalClear { .. }
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
            | ClientRequest::ProviderModelTest { .. }
            | ClientRequest::ProviderModelGet { .. }
            | ClientRequest::ProviderModelUpdate { .. }
            | ClientRequest::ModelCatalogGet { .. }
            | ClientRequest::ModelCatalogRefresh { .. }
            | ClientRequest::ProjectModelDefaultsGet { .. }
            | ClientRequest::ProjectModelDefaultsSet { .. }
            | ClientRequest::ModelDefaultsGet { .. }
            | ClientRequest::ModelDefaultsSet { .. }
            | ClientRequest::ProjectList { .. }
            | ClientRequest::ProjectCreate { .. }
            | ClientRequest::ProjectUpdate { .. }
            | ClientRequest::ProjectRemove { .. }
            | ClientRequest::WorkspaceReadDir { .. }
            | ClientRequest::WorkspaceReadFile { .. }
            | ClientRequest::OfficeRender { .. }
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
            | ClientRequest::WorkspaceGitGenerateCommitMessage { .. }
            | ClientRequest::WorkspaceGitPull { .. }
            | ClientRequest::WorkspaceGitPush { .. }
            // A terminal is a shell the whole machine can be driven from. A client with the
            // password can already ask the agent to run commands, so this is the same trust — but
            // it must be a decision, and this is it.
            | ClientRequest::TerminalStart { .. }
            | ClientRequest::TerminalWrite { .. }
            | ClientRequest::TerminalResize { .. }
            | ClientRequest::TerminalRead { .. }
            | ClientRequest::TerminalCopy { .. }
            | ClientRequest::TerminalKill { .. }
            | ClientRequest::ScheduleList { .. }
            | ClientRequest::ScheduleUpsert { .. }
            | ClientRequest::ScheduleDelete { .. }
            | ClientRequest::ScheduleRunNow { .. }
            | ClientRequest::ScheduleStop { .. }
            | ClientRequest::ScheduleHistory { .. }
            | ClientRequest::SubagentRoleList { .. }
            | ClientRequest::SubagentRoleUpsert { .. }
            | ClientRequest::SubagentRoleDelete { .. }
            | ClientRequest::SubagentList { .. }
            | ClientRequest::SubagentClose { .. }
            | ClientRequest::SubagentResume { .. }
            | ClientRequest::SubagentConfigGet { .. }
            | ClientRequest::SubagentConfigSet { .. }
            | ClientRequest::SettingsGet { .. }
            | ClientRequest::ComputerStatusGet { .. }
            | ClientRequest::SettingsReset { .. }
            | ClientRequest::DiagnosticsGet { .. }
            | ClientRequest::AppUpdateCheck { .. }
            | ClientRequest::StatsUsage { .. }
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
            ClientRequest::ProviderFetchModels { .. }
            | ClientRequest::ProviderCcSwitchScan { .. }
            | ClientRequest::ProviderCcSwitchImport { .. }
            | ClientRequest::ImportScan { .. }
            | ClientRequest::ImportRead { .. }
            | ClientRequest::ImportCommit { .. }
            | ClientRequest::ElectronMigrationScan { .. }
            | ClientRequest::ElectronMigrationCommit { .. }
            | ClientRequest::RemoteStatusGet { .. }
            | ClientRequest::RemoteConfigure { .. }
            | ClientRequest::RemoteSetPassword { .. }
            | ClientRequest::RemoteRevoke { .. }
            | ClientRequest::AccountStatus { .. }
            | ClientRequest::AccountLogin { .. }
            | ClientRequest::AccountCancelLogin { .. }
            | ClientRequest::AccountLogout { .. }
            | ClientRequest::OfficialStatusGet { .. }
            | ClientRequest::OfficialConfigure { .. }
            | ClientRequest::OfficeWatchStart { .. }
            | ClientRequest::OfficeWatchStop { .. }
            | ClientRequest::OfficeWatchStateGet { .. }
            | ClientRequest::OfficeSelectionGet { .. }
            // The driver acts on this machine's desktop, and the socket it is reached through is
            // the host's to name: neither is a lever a remote client should have.
            | ClientRequest::ComputerInstall { .. }
            | ClientRequest::ComputerHost { .. } => false,
        },
    }
}
