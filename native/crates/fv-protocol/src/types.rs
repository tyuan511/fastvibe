//! Thread → Turn → Item, and the parameter/response types of the methods.

use schemars::JsonSchema;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::jsonrpc::RequestId;

pub type ThreadId = String;
pub type TurnId = String;
pub type ItemId = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ClientOrigin {
    Local,
    Lan,
    Official,
    Ssh,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    /// Accept methods and notifications marked experimental.
    #[serde(default)]
    pub experimental_api: bool,
    /// Notification methods this client does not want.
    #[serde(default)]
    pub opt_out_notifications: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    pub protocol_version: u32,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResponse {
    pub server_version: String,
    pub protocol_version: u32,
    /// Features actually implemented by this running process. Old servers omit this list.
    #[serde(default)]
    pub features: Vec<String>,
    /// Where the server keeps its data; informational for clients on the same machine.
    pub data_dir: String,
    /// A digest of the running server executable. Development builds compare it with the one
    /// just built instead of treating every GUI launch as a server upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_fingerprint: Option<String>,
    /// Whether any conversation has a turn or a yielded command in flight. A restart must
    /// not interrupt either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_running_turns: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Empty {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: ThreadId,
    pub title: String,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub unread: bool,
    /// `provider/model` this conversation uses; the default model when absent.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<ThinkingLevel>,
    /// Kept at the top of the sidebar.
    #[serde(default)]
    pub pinned: bool,
    /// The isolated checkout this conversation runs in, when it is bound to one.
    #[serde(default)]
    pub worktree: Option<ThreadWorktree>,
}

/// `thread/update`: the fields to change; the rest stay.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUpdateParams {
    pub thread_id: ThreadId,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListParams {
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    pub threads: Vec<Thread>,
}

/// Literal, case-insensitive search of titles, project names and visible transcript text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchParams {
    pub query: String,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchHit {
    pub thread: Thread,
    /// A bounded excerpt around the first body match; absent for metadata-only matches.
    pub snippet: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSearchResponse {
    pub hits: Vec<ThreadSearchHit>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams {
    pub cwd: Option<String>,
    pub project: Option<String>,
    /// `provider/model`; the server's default when absent.
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResponse {
    pub thread: Thread,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdParams {
    pub thread_id: ThreadId,
}

/// `thread/resume`: the snapshot and the subscription are one atomic step. Events with a
/// `seq` at or below `seq` here are already reflected in `turns` and must be dropped.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeResponse {
    pub thread: Thread,
    /// How full the conversation's context window is, when it can be told.
    #[serde(default)]
    pub token_usage: Option<TokenUsage>,
    #[serde(default)]
    pub stats: SessionStats,
    pub turns: Vec<Turn>,
    pub seq: u64,
    pub running: bool,
    /// Prompts queued behind the reply in flight, so a client that connects mid-run draws them.
    #[serde(default)]
    pub queue: QueueState,
    /// The standing guess at the user's next message, so a client that opens the thread later
    /// still offers it.
    #[serde(default)]
    pub suggestion: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: TurnId,
    pub items: Vec<Item>,
    /// When the user's message was accepted (milliseconds since the epoch).
    #[serde(default)]
    pub started_at: Option<i64>,
    /// When the last tool call finished: the end of the work a settled turn folds away
    /// (用时), as opposed to the whole turn (耗时).
    #[serde(default)]
    pub process_ended_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
}

impl Turn {
    pub fn new(id: TurnId, items: Vec<Item>) -> Self {
        Self {
            id,
            items,
            started_at: None,
            process_ended_at: None,
            completed_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    UserMessage {
        id: ItemId,
        text: String,
    },
    AgentMessage {
        id: ItemId,
        text: String,
    },
    Reasoning {
        id: ItemId,
        text: String,
    },
    ToolCall {
        id: ItemId,
        name: String,
        arguments: serde_json::Value,
        output: Option<String>,
        is_error: bool,
    },
    Error {
        id: ItemId,
        message: String,
    },
    /// The conversation was summarized to make room; everything before this is no longer
    /// sent to the model (but is still shown).
    ContextCompaction {
        id: ItemId,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    pub thread_id: ThreadId,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResponse {
    pub turn_id: TurnId,
}

/// One prompt waiting its turn: what the user typed while a reply was still being written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub text: String,
    /// When it was queued, by the server's clock.
    #[serde(default)]
    pub at: i64,
}

/// Why the queue is standing still. Each one is a different sentence beside the prompts, and
/// only the user's own 继续 starts it again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum QueuePauseReason {
    /// The user stopped the reply. The prompts after it were not meant to be abandoned, but
    /// nothing should run without them saying so.
    Stopped,
    /// The reply failed. Sending the rest of the queue would feed a run that is already broken.
    Failed,
}

/// A conversation's queue, in the order the prompts will be sent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    pub items: Vec<QueueItem>,
    /// Set when the queue stopped on its own: nothing is sent until the user says so. `None`
    /// means it will drain as replies finish.
    #[serde(default)]
    pub pause: Option<QueuePauseReason>,
}

/// `turn/enqueue`: queue a prompt for after the reply in flight.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnqueueParams {
    pub thread_id: ThreadId,
    pub text: String,
}

/// `turn/rewind`: run the conversation again from one of its turns — the reply to it is thrown
/// away and asked for once more, or (with `text`) the user's words are replaced first.
///
/// `turn_id` names the turn to run *again*, so a retry names the last one and an edit names the
/// one being corrected. Everything after it is dropped from the history; the transcript keeps
/// the lines and records a rewind marker, so nothing is destroyed on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnRewindParams {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// Replacement words for that turn; absent keeps the ones it already has (a retry).
    #[serde(default)]
    pub text: Option<String>,
    /// Put the workspace back to how it was before that turn's run first.
    ///
    /// A retry that leaves the tree alone re-runs the prompt against code the abandoned attempt
    /// already changed — it reads files the first run edited, or its patch finds the change
    /// already applied and does nothing. Both are silent. The caller asks the user, so this is
    /// never implied: `false` means "keep my files", which is what someone repeating a prompt
    /// after their own edits wants.
    #[serde(default)]
    pub rewind_files: bool,
}

/// What `turn/rewind` did to the workspace, so the client can report it honestly.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilesRewound {
    /// Files written back to their pre-turn content.
    pub restored: usize,
    /// Files the turn created, now removed.
    pub removed: usize,
    /// Paths that could not be put back, with the reason.
    #[serde(default)]
    pub skipped: Vec<SkippedPath>,
    /// Whether a checkpoint existed at all: a turn that changed nothing, or a workspace that is
    /// not a git repository, has nothing to put back.
    pub had_checkpoint: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPath {
    pub path: String,
    pub reason: String,
}

/// `turn/steer`: something the user says while a run is working.
///
/// Not a new turn and not a queued prompt: the words join the run that is in flight, at the top
/// of its next model request (codex's `turn/steer`). `expectedTurnId` is required and must match
/// the run that is live, so a steer can never land in a run the client did not mean — the answer
/// names the turn it actually found when they differ.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams {
    pub thread_id: ThreadId,
    pub expected_turn_id: TurnId,
    pub text: String,
}

/// The turn that took over, and what happened to the files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnRewindResponse {
    pub turn_id: TurnId,
    pub files: FilesRewound,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResponse {
    /// The run that is live: the one the client named, or the one that replaced it.
    pub turn_id: TurnId,
}

/// One queued prompt by id, for `turn/queue/remove` and `turn/queue/sendNow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueueItemParams {
    pub thread_id: ThreadId,
    pub item_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadEvent<T> {
    pub thread_id: ThreadId,
    /// Monotonic per thread.
    pub seq: u64,
    #[serde(flatten)]
    pub body: T,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub turn_id: TurnId,
    pub item: Item,
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub turn_id: TurnId,
    pub item_id: ItemId,
    pub delta: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnRef {
    pub turn_id: TurnId,
    /// When it happened, by the server's clock.
    #[serde(default)]
    pub at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CatalogChanged {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    /// Stopped by the user (`turn/interrupt`). Not a failure.
    Interrupted,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompleted {
    pub turn_id: TurnId,
    pub status: TurnStatus,
    pub error: Option<String>,
    #[serde(default)]
    pub at: Option<i64>,
}

// ---- the workspace the file tree and the preview read

/// One row of a directory listing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Absolute, so a client can ask for it back without knowing the tree's root.
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    File,
    Directory,
}

/// `workspace/readDir`: one directory, `.git` and `node_modules` hidden.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirParams {
    pub path: String,
    /// Resolves a relative path, so a client can pass what a listing gave it relative to the
    /// conversation instead of joining paths itself.
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirResponse {
    pub entries: Vec<DirEntry>,
}

/// Create one empty file or folder in the project's tree. `path` names its parent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateEntryParams {
    pub cwd: String,
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
}

/// Change only the final path component; never move across directories or replace a target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameEntryParams {
    pub cwd: String,
    pub path: String,
    pub name: String,
}

/// Default deletion uses the server machine's Trash. Failure never implies permanent deletion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteEntryParams {
    pub cwd: String,
    pub path: String,
    #[serde(default)]
    pub permanent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EntryChangeKind {
    Created,
    Renamed,
    Deleted,
}

/// Global workspace notification: invalidate listings, and remap open paths after a rename.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryChange {
    pub cwd: String,
    /// Old path for rename/delete; the new path for creation.
    pub path: String,
    pub kind: EntryChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<DirEntry>,
}

/// `workspace/preview`: what the pane draws for one file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreviewParams {
    pub path: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// What a preview is. The kind decides the view, and every field that only one kind needs is
/// absent on the others rather than empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FilePreviewKind {
    Image,
    Video,
    Pdf,
    /// An Office document, drawn by rendering a page rather than by reading bytes.
    Office,
    Markdown,
    Html,
    Code,
    Diff,
    /// A delimited file, already split into rows.
    Table,
    /// Named, but not something this app draws: the system's own app is the way out.
    Unsupported,
    /// Too big to read, or not text at all.
    Binary,
    /// The file could not be read; `reason` says what to do about it.
    Error,
}

/// Why a preview failed. Every producer of a failure picks one, so the pane can draw the right
/// way out instead of printing an errno.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PreviewFailure {
    Missing,
    Permission,
    NotAFile,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum OfficeFormat {
    Docx,
    Xlsx,
    Pptx,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FilePreview {
    /// Loaded by the client from a URL rather than carried in this message: a photo or a movie
    /// never becomes a base64 frame.
    Media {
        kind: FilePreviewKind,
        path: String,
        name: String,
        mime_type: String,
        size: u64,
    },
    Office {
        path: String,
        name: String,
        format: OfficeFormat,
        size: u64,
    },
    Unsupported {
        path: String,
        name: String,
        format: String,
    },
    Binary {
        path: String,
        name: String,
        size: u64,
    },
    Text {
        kind: FilePreviewKind,
        path: String,
        name: String,
        /// The highlighter's name for the language, when it is not the extension.
        #[serde(default)]
        language: Option<String>,
        text: String,
    },
    Table {
        path: String,
        name: String,
        rows: Vec<Vec<String>>,
        truncated: bool,
        total_rows: u64,
    },
    Error {
        path: String,
        name: String,
        /// The conclusion, in words a reader acts on. Never an errno.
        message: String,
        reason: PreviewFailure,
        /// The host's own words, for the small print.
        #[serde(default)]
        detail: Option<String>,
        /// The directory the file should be in, so the pane can open it.
        #[serde(default)]
        directory: Option<String>,
    },
}

/// `workspace/writeFile`: replace a text file the pane has open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileParams {
    pub path: String,
    pub text: String,
    #[serde(default)]
    pub cwd: Option<String>,
}

// ---- git, as the 变更 view reads it

/// One changed file. `index` and `worktree` are git's own two columns (`M`, `A`, `D`, `R`, `?`),
/// so a file can be both staged and further edited.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// Relative to the directory the pane is showing.
    pub path: String,
    pub index: String,
    pub worktree: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub cwd: String,
    pub is_repository: bool,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub ahead: u32,
    #[serde(default)]
    pub behind: u32,
    pub changed: u32,
    pub staged: u32,
    /// Text-line totals across the tracked working tree relative to `HEAD`.
    pub additions: u32,
    pub deletions: u32,
    pub files: Vec<GitFileChange>,
}

/// Which layer a patch is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DiffSource {
    /// The working tree against the index.
    Unstaged,
    /// The index against `HEAD`.
    Staged,
    /// A branch (or one commit) against its base, from the upstream merge base.
    Branch,
    /// The working tree against `HEAD` — everything this branch has not committed.
    LastTurn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffParams {
    pub cwd: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default = "default_diff_source")]
    pub source: DiffSource,
    /// A bare commit id for a history comparison; never an expression.
    #[serde(default)]
    pub revision: Option<String>,
}

fn default_diff_source() -> DiffSource {
    DiffSource::Unstaged
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitComparison {
    /// The merge base (or the parent of the compared commit).
    pub base: String,
    /// `HEAD`, or the commit being opened.
    pub target: String,
    pub files: Vec<GitFileChange>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum GitRefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitReference {
    pub name: String,
    pub kind: GitRefKind,
    /// The branch this repository is checked out on.
    #[serde(default)]
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    /// Every parent, so a merge is drawn with both of its lines.
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    /// ISO-8601, as git printed it.
    pub date: String,
    pub body: String,
    pub refs: Vec<GitReference>,
    pub is_head: bool,
}

/// `all` walks every branch and tag; `current` only the checked-out branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HistoryScope {
    All,
    Current,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryParams {
    pub cwd: String,
    #[serde(default)]
    pub skip: Option<u32>,
    #[serde(default = "default_scope")]
    pub scope: HistoryScope,
    /// The first page's tips, so later pages read the same commits.
    #[serde(default)]
    pub tips: Option<Vec<String>>,
}

fn default_scope() -> HistoryScope {
    HistoryScope::All
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
    /// What the next page must pass back.
    pub tips: Vec<String>,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

/// Stage these paths, or the whole tree with `all`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitPathsParams {
    pub cwd: String,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitParams {
    pub cwd: String,
    pub message: String,
    #[serde(default)]
    pub amend: bool,
}

// ---- the side pane's terminals

/// A colour a shell asked for. `None` on a span means the terminal's own default, which only the
/// client knows (it follows the theme).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TerminalColor {
    /// One of the 256 xterm palette entries: 0–15 are the ANSI colours.
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// A run of cells with the same styling.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpan {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg: Option<TerminalColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<TerminalColor>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub dim: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    /// Foreground and background swapped. Left to the client, which knows the defaults.
    #[serde(default, skip_serializing_if = "is_false")]
    pub inverse: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub strikethrough: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One row of a terminal's screen. `text` is the whole row; `spans` is the same text cut into
/// styled runs (their texts concatenate to `text`), so a client that cannot style still reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRow {
    pub text: String,
    #[serde(default)]
    pub spans: Vec<TerminalSpan>,
    /// One width per Unicode scalar in `text`: 0 for combining marks, 2 for wide cells.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub widths: Vec<u8>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub wrapped: bool,
}

/// What a client needs to draw one terminal: the grid, the cursor, and whether the shell is gone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFrame {
    pub id: String,
    /// The directory the shell was started in, so a client can say where it is.
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// One entry per row, top to bottom.
    pub lines: Vec<TerminalRow>,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_hidden: bool,
    /// The shell has exited; the screen stays readable until the tab is closed.
    pub exited: bool,
    #[serde(default)]
    pub history: u32,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub anchor: TerminalAnchor,
    #[serde(default)]
    pub bracketed_paste: bool,
    #[serde(default)]
    pub application_cursor: bool,
    #[serde(default)]
    pub alternate_screen: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TerminalAnchor {
    pub epoch: u64,
    pub serial: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadParams {
    pub id: String,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub anchor: Option<TerminalAnchor>,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub struct TerminalPoint {
    pub line: i64,
    pub column: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCopyParams {
    pub id: String,
    pub epoch: u64,
    pub start: TerminalPoint,
    pub end: TerminalPoint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TerminalCopyResponse {
    pub text: String,
}

/// `terminal/start`: a shell in a directory, at a size.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartParams {
    pub cwd: String,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

/// `terminal/write`: keystrokes, as the terminal sends them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteParams {
    pub id: String,
    pub data: String,
}

/// `terminal/resize`: the client's grid changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdParams {
    pub id: String,
}

/// The isolated checkout a conversation is bound to, instead of its project's own tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktree {
    pub path: String,
    /// The branch checked out there, or `HEAD` when detached.
    pub branch: String,
}

/// One checkout of a repository, as `git worktree list` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub bare: bool,
    #[serde(default)]
    pub detached: bool,
    /// Held by another operation; git refuses to remove it without saying so first.
    #[serde(default)]
    pub locked: bool,
    /// Git says its directory is gone.
    #[serde(default)]
    pub prunable: bool,
    /// The checkout the conversation asking is in.
    #[serde(default)]
    pub current: bool,
}

/// `thread/worktree/create`: make an isolated checkout and bind the conversation to it.
///
/// A branch that already exists is checked out; one that does not is created from `HEAD`. An
/// omitted path lands under `~/.fastvibe/worktree/<project>/`, which is the only place this app
/// will later delete from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeParams {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// Names the default branch and directory; the conversation's title when absent.
    #[serde(default)]
    pub label: Option<String>,
}

/// `thread/worktree/bind`: adopt a checkout that already exists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BindWorktreeParams {
    pub path: String,
}

/// `thread/worktree/unbind`: return to the project, and optionally delete the checkout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UnbindWorktreeParams {
    /// Only a checkout this app created is deleted; one the user made is left in place.
    #[serde(default)]
    pub remove: bool,
}

/// The thread these worktree calls act on, plus the call's own fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeCreateParams {
    pub thread_id: ThreadId,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeBindParams {
    pub thread_id: ThreadId,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeUnbindParams {
    pub thread_id: ThreadId,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadWorktreeListResponse {
    pub worktrees: Vec<GitWorktree>,
}

/// One `@` mention: what the composer shows, and the path handed to the model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    /// Project-relative, `/`-separated. A multi-folder project names the folder first
    /// (`web/src/App.tsx`) so two `README.md` can be told apart.
    pub relative: String,
    /// Absolute, so the model can read it.
    pub path: String,
}

/// `workspace/searchFiles`: the `@` menu's rows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesParams {
    /// The project's primary folder. Absent means "no project", and the answer is empty.
    #[serde(default)]
    pub cwd: Option<String>,
    /// What has been typed so far. Empty lists the project's surface.
    #[serde(default)]
    pub query: Option<String>,
    /// A multi-folder project's other folders; they are ranked together with the primary's.
    #[serde(default)]
    pub other_folders: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResponse {
    pub hits: Vec<FileHit>,
}

/// A repository directory.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CwdParams {
    pub cwd: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitComparisonParams {
    pub cwd: String,
    #[serde(default)]
    pub revision: Option<String>,
}

/// A turn and everything after it was dropped, because it is running again (a retry or an edit).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Rewound {
    pub turn_id: TurnId,
}

/// 回复推荐: what the user is likely to say next, offered as the composer's placeholder until they
/// type. `None` withdraws it — the guess was not worth showing, or a new run has made it stale.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[serde(default)]
    pub text: Option<String>,
}

/// `running` is true from the moment a turn is accepted until it has fully settled.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStatus {
    pub running: bool,
}

// ---- the plan (update_plan)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub step: String,
    pub status: PlanStatus,
}

/// The model replaced its checklist. Each update is the whole list, not a change to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanUpdated {
    pub turn_id: TurnId,
    pub explanation: Option<String>,
    pub plan: Vec<PlanStep>,
}

// ---- questions to the user (request_user_input)

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// What the answer is filed under.
    pub id: String,
    /// A short heading, 12 characters or fewer.
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    /// Offer a free-form "Other" answer besides the options.
    pub is_other: bool,
}

/// `item/question/request`: the agent is stopped until the user answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserInputRequest {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// The tool call the questions belong to.
    pub call_id: String,
    pub questions: Vec<Question>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputAnswer {
    pub answers: Vec<String>,
}

/// The client's answer to an `item/question/request`: each question's id to what was chosen or
/// typed. A client that will not answer replies with an error instead.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UserInputResponse {
    pub answers: BTreeMap<String, UserInputAnswer>,
}

/// A request to the client has been answered or withdrawn (by whichever client got there
/// first, or because the turn was stopped); every other client takes its prompt down.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestResolved {
    pub request_id: RequestId,
}

// ---- providers and models

/// The wire format a provider speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApiProtocol {
    /// OpenAI Chat Completions, and everything that imitates it.
    Chat,
    /// OpenAI Responses.
    Responses,
    /// Anthropic Messages.
    Anthropic,
    /// Google Gemini.
    Google,
}

/// How hard the model is asked to think. There is deliberately no "off".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// What the provider calls it.
    pub id: String,
    pub name: Option<String>,
    /// This model's own protocol, when it differs from its provider's.
    #[serde(default)]
    pub protocol: Option<ApiProtocol>,
    /// Whether it can look at images.
    #[serde(default = "default_true")]
    pub supports_images: bool,
    #[serde(default)]
    pub context_window: Option<u32>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
}

fn default_true() -> bool {
    true
}

/// A provider as clients see it. The API key is never part of it: `has_key` says one is set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    pub has_key: bool,
    pub enabled: bool,
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderListResponse {
    pub providers: Vec<ProviderInfo>,
}

/// Create a provider (no `id`) or replace one. The key is write-only: absent keeps the stored
/// one, an empty string clears it, anything else replaces it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpsertParams {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpsertResponse {
    pub provider: ProviderInfo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdParams {
    pub provider_id: String,
}

/// The providers in the order they should be listed; one left out goes to the end.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderReorderParams {
    pub ids: Vec<String>,
}

/// Ask a provider which models it has: a saved one (`provider_id`, using its stored key) or one
/// not saved yet (`protocol`, `base_url`, `api_key`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsParams {
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub protocol: Option<ApiProtocol>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsResponse {
    pub models: Vec<ModelInfo>,
}

/// One model a conversation can use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub provider_id: String,
    pub provider_name: String,
    pub model: ModelInfo,
    /// `provider_id/model_id`: what a conversation stores to name it.
    pub label: String,
}

/// The models of every enabled provider that has a key, in provider order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub models: Vec<ModelEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelDefaults {
    /// `provider/model` used by a conversation that names none.
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadModelParams {
    pub thread_id: ThreadId,
    pub model: Option<String>,
    pub thinking: Option<ThinkingLevel>,
}

/// How much of the model's context window the conversation takes. Summarizing starts at 90%.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub used: u64,
    pub window: u64,
}

/// Cumulative uncached input/output and cache traffic. Cache writes are not cache hits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestUsage {
    pub output_tokens: u64,
    pub duration_ms: Option<u64>,
}

/// Whole-transcript totals survive compaction; `turn` starts at the latest user input.
/// Speed always pairs the latest completed assistant request's output with its own time.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub tokens: TokenCounts,
    pub turn: Option<TokenCounts>,
    pub last_request: Option<RequestUsage>,
    pub steps: u64,
    /// USD; absent until model pricing is known, never a guessed zero.
    pub cost: Option<f64>,
}

// ---- app settings

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Stdio,
    Http,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: McpTransport,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Deferred tools are exposed by tool_search instead of filling every model request.
    #[serde(default = "default_true")]
    pub deferred: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub config: McpServerConfig,
    pub connected: bool,
    pub connecting: bool,
    pub tools: Vec<String>,
    pub error: Option<String>,
    /// Bounded, redacted stderr from this connection attempt. Never broadcast in notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<String>,
    /// Whether this server has private OAuth credentials; tokens are never returned.
    #[serde(default)]
    pub oauth_credentials: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpListResponse {
    pub servers: Vec<McpServerStatus>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpSetParams {
    pub servers: Vec<McpServerConfig>,
}

/// Compare-and-edit one server without overwriting other clients' configuration changes.
/// `expected: null` creates, `config: null` removes; otherwise replaces the matching config.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpUpdateParams {
    pub server_id: String,
    pub expected: Option<McpServerConfig>,
    pub config: Option<McpServerConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpServerParams {
    pub server_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthBeginParams {
    pub server_id: String,
    pub redirect_uri: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthBeginResponse {
    pub flow_id: String,
    pub authorization_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthCompleteParams {
    pub flow_id: String,
    pub callback_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpAuthCancelParams {
    pub flow_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpImportParams {
    pub json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceParams {
    pub server_id: String,
    pub uri: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceListParams {
    pub server_id: Option<String>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceResponse {
    pub data: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SkillScope {
    Project,
    Managed,
    Global,
    Builtin,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: SkillScope,
    pub removable: bool,
    pub manual_only: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillListParams {
    pub cwd: Option<String>,
    #[serde(default)]
    pub other_folders: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillListResponse {
    pub skills: Vec<SkillInfo>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConfig {
    pub enabled: bool,
    /// Native provider/model label. None follows the default authenticated model.
    pub model: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MemoryPhase {
    #[default]
    Idle,
    Extracting,
    Consolidating,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MemoryState {
    pub revision: u64,
    pub config: MemoryConfig,
    pub phase: MemoryPhase,
    pub conversations: u32,
    pub pending: u32,
    pub ready: bool,
    pub last_run_at: Option<i64>,
    pub error: Option<String>,
    pub folder: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillNameParams {
    pub cwd: Option<String>,
    #[serde(default)]
    pub other_folders: Vec<String>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillReadResponse {
    pub skill: SkillInfo,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateParams {
    pub name: String,
    pub description: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportParams {
    pub path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    Light,
    Dark,
    /// Follow the operating system.
    System,
}

/// What every client of this server shares about how the app looks. Ids name themes from the
/// clients' own catalog; one a client does not know falls back to its default.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme_mode: ThemeMode,
    pub light_theme: String,
    pub dark_theme: String,
    /// 玻璃效果: the translucent window, where the platform has a blur to show.
    pub glass: bool,
    /// How much of the machine a command may touch (codex's `sandbox_mode`).
    #[serde(default)]
    pub sandbox_mode: SandboxMode,
    /// When the user is asked before something runs (codex's `approval_policy`).
    #[serde(default)]
    pub approval_policy: ApprovalPolicy,
    /// Whether sandboxed commands may use the network.
    #[serde(default)]
    pub sandbox_network: bool,
    #[serde(default)]
    pub sidebar: SidebarSettings,
    /// 回复推荐: guess the user's next message and offer it as the composer's placeholder. On
    /// unless turned off, like the Electron app's `replySuggestions`.
    #[serde(default = "default_true")]
    pub reply_suggestions: bool,
}

/// How much of the machine a command may touch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SandboxMode {
    /// Read anything, write nothing.
    ReadOnly,
    /// Read anything; write in the project's folders and the temporary directories.
    #[default]
    WorkspaceWrite,
    /// No sandbox.
    DangerFullAccess,
}

/// When the user is asked before something runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalPolicy {
    /// Ask before anything that is not known to be read-only.
    Untrusted,
    /// Run in the sandbox; ask only to run again outside it after it was in the way.
    OnFailure,
    /// Run in the sandbox; the model asks when it needs to leave it.
    #[default]
    OnRequest,
    /// Never ask.
    Never,
}

/// What the agent wants to do that needs the user's say-so.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ApprovalKind {
    Command {
        command: String,
        cwd: Option<String>,
    },
    Patch {
        files: Vec<String>,
    },
}

/// `item/approval/request`: the agent is stopped until the user answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestParams {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    /// The tool call it is for.
    pub call_id: String,
    pub kind: ApprovalKind,
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    /// This once.
    Approved,
    /// This, and the same again for the rest of the conversation.
    ApprovedForSession,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    pub decision: ApprovalDecision,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_mode: ThemeMode::System,
            light_theme: "github-light".into(),
            dark_theme: "github-dark".into(),
            glass: false,
            sandbox_mode: SandboxMode::default(),
            approval_policy: ApprovalPolicy::default(),
            sandbox_network: false,
            sidebar: SidebarSettings::default(),
            reply_suggestions: true,
        }
    }
}

/// `settings/set`: the fields to change; the rest stay.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsPatch {
    #[serde(default)]
    pub theme_mode: Option<ThemeMode>,
    #[serde(default)]
    pub light_theme: Option<String>,
    #[serde(default)]
    pub dark_theme: Option<String>,
    #[serde(default)]
    pub glass: Option<bool>,
    #[serde(default)]
    pub sandbox_mode: Option<SandboxMode>,
    #[serde(default)]
    pub approval_policy: Option<ApprovalPolicy>,
    #[serde(default)]
    pub sandbox_network: Option<bool>,
    #[serde(default)]
    pub sidebar: Option<SidebarSettingsPatch>,
    #[serde(default)]
    pub reply_suggestions: Option<bool>,
}

impl AppSettings {
    pub fn apply(&mut self, patch: AppSettingsPatch) {
        if let Some(v) = patch.sidebar {
            self.sidebar.apply(v);
        }
        if let Some(v) = patch.reply_suggestions {
            self.reply_suggestions = v;
        }
        if let Some(v) = patch.theme_mode {
            self.theme_mode = v;
        }
        if let Some(v) = patch.light_theme {
            self.light_theme = v;
        }
        if let Some(v) = patch.dark_theme {
            self.dark_theme = v;
        }
        if let Some(v) = patch.glass {
            self.glass = v;
        }
        if let Some(v) = patch.sandbox_mode {
            self.sandbox_mode = v;
        }
        if let Some(v) = patch.approval_policy {
            self.approval_policy = v;
        }
        if let Some(v) = patch.sandbox_network {
            self.sandbox_network = v;
        }
    }
}

// ---- sidebar preferences (shared and persisted through settings/*)

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SidebarSort {
    #[default]
    Manual,
    Updated,
    Created,
    Title,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase")]
pub struct SidebarSettings {
    pub width: f32,
    pub collapsed: bool,
    pub closed_projects: Vec<String>,
    pub expanded_projects: Vec<String>,
    pub project_order: Vec<String>,
    /// Each section owns its order: "pinned", "chats", or "project:<absolute path>".
    pub order: BTreeMap<String, Vec<String>>,
    pub sort: SidebarSort,
}

impl Default for SidebarSettings {
    fn default() -> Self {
        Self {
            width: 288.0,
            collapsed: false,
            closed_projects: vec![],
            expanded_projects: vec![],
            project_order: vec![],
            order: BTreeMap::new(),
            sort: SidebarSort::Manual,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSettingsPatch {
    pub width: Option<f32>,
    pub collapsed: Option<bool>,
    pub closed_projects: Option<Vec<String>>,
    pub expanded_projects: Option<Vec<String>>,
    pub project_order: Option<Vec<String>>,
    /// Merge section keys, preserving orders belonging to other sections.
    pub order: Option<BTreeMap<String, Vec<String>>>,
    pub sort: Option<SidebarSort>,
}

impl SidebarSettings {
    pub fn apply(&mut self, patch: SidebarSettingsPatch) {
        if let Some(v) = patch.width.filter(|v| v.is_finite()) {
            self.width = v.clamp(200.0, 480.0);
        }
        if let Some(v) = patch.collapsed {
            self.collapsed = v;
        }
        if let Some(v) = patch.closed_projects {
            self.closed_projects = v;
        }
        if let Some(v) = patch.expanded_projects {
            self.expanded_projects = v;
        }
        if let Some(v) = patch.project_order {
            self.project_order = v;
        }
        if let Some(v) = patch.order {
            self.order.extend(v);
        }
        if let Some(v) = patch.sort {
            self.sort = v;
        }
    }
}

// ---- projects

/// A folder the user works in; its conversations are listed under it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// The primary folder, absolute: the project's identity, and what a conversation's
    /// `project` and `cwd` hold.
    pub path: String,
    pub name: String,
    /// The other folders, in order. A project with none is one folder.
    #[serde(default)]
    pub folders: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListResponse {
    pub projects: Vec<ProjectInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathParams {
    pub path: String,
}

/// `project/create`: a name (the first folder's name when absent) and its folders, the first
/// being the primary one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateParams {
    #[serde(default)]
    pub name: Option<String>,
    pub folders: Vec<String>,
}

/// `project/update`: replace a project's name and folders. `path` names the project as it is
/// now; `folders` is the whole list as it should be, the first being the primary one. When the
/// primary changes, the project's conversations move to the new one (each keeps its own cwd).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateParams {
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
    pub folders: Vec<String>,
}
