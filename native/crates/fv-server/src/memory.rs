//! Two-stage memory, owned by the server. Only a validated consolidation is published; a
//! disabled/cancelled worker can finish no writes into the live memory folder.
mod plan;
mod workspace;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use futures_util::{StreamExt, stream};
use fv_agent::{
    AgentContext, MemorySource, Model, ModelEvent, ModelRequest, ToolRegistry, TurnOutcome,
};
use fv_core::{Message, StopReason};
use fv_protocol::types::{MemoryConfig, MemoryPhase, MemoryState, Thread};
use fv_protocol::{ErrorObject, ServerNotification};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::state::{ServerState, now_ms};
use plan::{Ledger, Output};

const CONFIG: &str = "memory.config.v1";
const LEDGER: &str = "memory.ledger.v1";
const STAGE_ONE_SYSTEM: &str = include_str!("../../../../resources/memories/stage_one_system.md");
const STAGE_ONE_INPUT: &str = include_str!("../../../../resources/memories/stage_one_input.md");
const CONSOLIDATION: &str = include_str!("../../../../resources/memories/consolidation.md");
const READ_PATH: &str = include_str!("../../../../resources/memories/read_path.md");

fn failed(error: impl std::fmt::Display) -> ErrorObject {
    ErrorObject::new(
        fv_protocol::jsonrpc::code::INTERNAL_ERROR,
        error.to_string(),
    )
}

struct Job {
    generation: u64,
    cancel: CancellationToken,
    done: watch::Receiver<bool>,
}

struct Inner {
    config: MemoryConfig,
    ledger: Ledger,
    phase: MemoryPhase,
    generation: u64,
    job: Option<Job>,
    clearing: bool,
    pending: u32,
    summary: Option<String>,
    ready: bool,
    snapshot_version: u64,
}

pub struct Memory {
    root: PathBuf,
    inner: Mutex<Inner>,
    control: tokio::sync::Mutex<()>,
    model: Mutex<Option<Arc<dyn Model>>>,
    revision: std::sync::atomic::AtomicU64,
}

impl Memory {
    pub fn open(data_dir: &Path, db: &fv_store::Db) -> Result<Arc<Self>, fv_store::StoreError> {
        let config: MemoryConfig = db
            .get_setting(CONFIG)?
            .map(|text| serde_json::from_str(&text))
            .transpose()?
            .unwrap_or_default();
        let mut ledger: Ledger = db
            .get_setting(LEDGER)?
            .map(|text| serde_json::from_str(&text))
            .transpose()?
            .unwrap_or_default();
        let root = data_dir.join("memories");
        if let Err(error) = workspace::recover(&root) {
            ledger.error = Some(format!("memory recovery failed: {error}"));
        }
        let regular = |name| {
            std::fs::symlink_metadata(root.join(name))
                .is_ok_and(|m| m.is_file() && !m.is_symlink() && m.len() > 0)
        };
        let ready = workspace::valid(&ledger.baseline)
            && std::fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir() && !m.is_symlink())
            && regular("MEMORY.md")
            && regular("memory_summary.md");
        Ok(Arc::new(Self {
            root,
            inner: Mutex::new(Inner {
                config,
                ledger,
                phase: MemoryPhase::Idle,
                generation: 0,
                job: None,
                clearing: false,
                pending: 0,
                summary: None,
                ready,
                snapshot_version: 0,
            }),
            control: tokio::sync::Mutex::new(()),
            model: Mutex::new(None),
            revision: std::sync::atomic::AtomicU64::new(1),
        }))
    }

    /// A separate background model is also useful for deterministic pipeline tests.
    pub fn set_model(&self, model: Arc<dyn Model>) {
        *self.model.lock().unwrap() = Some(model);
    }

    pub fn state(&self) -> MemoryState {
        let inner = self.inner.lock().unwrap();
        MemoryState {
            revision: self
                .revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            config: inner.config.clone(),
            phase: inner.phase,
            conversations: inner.ledger.outputs.len() as u32,
            pending: inner.pending,
            ready: inner.ready,
            last_run_at: inner.ledger.last_run_at,
            error: inner.ledger.error.clone(),
            folder: self.root.display().to_string(),
        }
    }

    fn announce(&self, state: &ServerState) {
        state.broadcast(ServerNotification::MemoryChanged(self.state()));
    }

    fn live(&self, generation: u64) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.generation == generation
            && inner.config.enabled
            && !inner.clearing
            && !inner
                .job
                .as_ref()
                .is_some_and(|job| job.generation == generation && job.cancel.is_cancelled())
    }

    fn save(inner: &Inner, state: &ServerState) -> Result<(), String> {
        state
            .store
            .db
            .set_setting(
                LEDGER,
                Some(&serde_json::to_string(&inner.ledger).map_err(|e| e.to_string())?),
            )
            .map_err(|e| e.to_string())
    }

    pub async fn refresh_snapshot(self: &Arc<Self>) {
        let (generation, snapshot_version) = {
            let inner = self.inner.lock().unwrap();
            if !inner.config.enabled || inner.clearing {
                return;
            }
            (inner.generation, inner.snapshot_version)
        };
        let root = self.root.clone();
        let summary = tokio::task::spawn_blocking(move || {
            let file = root.join("memory_summary.md");
            // Never follow an external link or read an unbounded summary into a prompt.
            if std::fs::symlink_metadata(&root).ok()?.is_symlink() {
                return None;
            }
            let meta = std::fs::symlink_metadata(&file).ok()?;
            if !meta.is_file() || meta.is_symlink() || meta.len() > 1024 * 1024 {
                return None;
            }
            let text = std::fs::read_to_string(file).ok()?;
            let handbook = std::fs::symlink_metadata(root.join("MEMORY.md")).ok()?;
            (text.lines().next() == Some("v1")
                && handbook.is_file()
                && !handbook.is_symlink()
                && handbook.len() > 0)
                .then(|| plan::clip(&text, 20_000))
        })
        .await
        .ok()
        .flatten();
        let mut inner = self.inner.lock().unwrap();
        if inner.config.enabled
            && !inner.clearing
            && inner.generation == generation
            && inner.snapshot_version == snapshot_version
        {
            inner.summary = summary;
            inner.ready = inner.summary.is_some();
        }
    }

    pub async fn configure(
        self: &Arc<Self>,
        state: &Arc<ServerState>,
        config: MemoryConfig,
    ) -> Result<MemoryState, ErrorObject> {
        let _control = self.control.lock().await;
        if let Some(label) = &config.model
            && (label.len() > 512 || !label.contains('/'))
        {
            return Err(ErrorObject::new(
                fv_protocol::jsonrpc::code::INVALID_PARAMS,
                "memory model must be provider/model",
            ));
        }
        state
            .store
            .db
            .set_setting(
                CONFIG,
                Some(&serde_json::to_string(&config).map_err(failed)?),
            )
            .map_err(failed)?;
        let enabled;
        {
            let mut inner = self.inner.lock().unwrap();
            enabled = config.enabled && !inner.config.enabled;
            if !config.enabled && inner.config.enabled {
                inner.generation = inner.generation.wrapping_add(1);
                if let Some(job) = &inner.job {
                    job.cancel.cancel();
                }
                inner.summary = None;
                inner.snapshot_version = inner.snapshot_version.wrapping_add(1);
            }
            inner.config = config;
        }
        self.refresh_snapshot().await;
        self.announce(state);
        if enabled {
            let weak = Arc::downgrade(state);
            let memory = self.clone();
            let generation = self.inner.lock().unwrap().generation;
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Some(state) = weak.upgrade()
                    && memory.live(generation)
                {
                    memory.run(&state);
                }
            });
        }
        Ok(self.state())
    }

    pub fn start_timer(self: &Arc<Self>, state: &Arc<ServerState>) {
        let weak = Arc::downgrade(state);
        let memory = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(45)).await;
            loop {
                let Some(state) = weak.upgrade() else { break };
                memory.run(&state);
                drop(state);
                tokio::time::sleep(Duration::from_secs(15 * 60)).await;
            }
        });
    }

    pub fn run(self: &Arc<Self>, state: &Arc<ServerState>) -> MemoryState {
        let (generation, cancel, done) = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.config.enabled || inner.clearing || inner.job.is_some() {
                drop(inner);
                return self.state();
            }
            inner.generation = inner.generation.wrapping_add(1);
            let generation = inner.generation;
            let cancel = CancellationToken::new();
            let (done, watched) = watch::channel(false);
            inner.job = Some(Job {
                generation,
                cancel: cancel.clone(),
                done: watched,
            });
            inner.phase = MemoryPhase::Extracting;
            inner.ledger.error = None;
            (generation, cancel, done)
        };
        self.announce(state);
        let memory = self.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let run = memory.pipeline(&state, generation, &cancel);
            tokio::pin!(run);
            let result = tokio::select! {
                biased;
                result = &mut run => result,
                _ = cancel.cancelled() => { let _ = (&mut run).await; Ok(()) },
                _ = tokio::time::sleep(Duration::from_secs(20 * 60)) => {
                    cancel.cancel();
                    let _ = (&mut run).await;
                    Err("memory pass timed out".into())
                },
            };
            cancel.cancel();
            {
                let mut inner = memory.inner.lock().unwrap();
                if inner
                    .job
                    .as_ref()
                    .is_some_and(|job| job.generation == generation)
                {
                    inner.job = None;
                    inner.phase = MemoryPhase::Idle;
                }
                if inner.generation == generation && inner.config.enabled && !inner.clearing {
                    if let Err(error) = result {
                        inner.ledger.error = Some(plan::redact(&error));
                    } else {
                        inner.ledger.last_run_at = Some(now_ms());
                    }
                    if let Err(error) = Self::save(&inner, &state) {
                        inner.ledger.error = Some(error);
                    }
                }
            }
            let _ = done.send(true);
            memory.announce(&state);
        });
        self.state()
    }

    pub async fn clear(
        self: &Arc<Self>,
        state: &Arc<ServerState>,
    ) -> Result<MemoryState, ErrorObject> {
        let _control = self.control.lock().await;
        let done = {
            let mut inner = self.inner.lock().unwrap();
            inner.clearing = true;
            inner.snapshot_version = inner.snapshot_version.wrapping_add(1);
            inner.ready = false;
            inner.generation = inner.generation.wrapping_add(1);
            inner.summary = None;
            inner.job.as_ref().map(|job| {
                job.cancel.cancel();
                job.done.clone()
            })
        };
        if let Some(mut done) = done {
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        }
        let root = self.root.clone();
        let removal = tokio::task::spawn_blocking(move || {
            match std::fs::symlink_metadata(&root) {
                Ok(meta) if meta.is_symlink() || meta.is_file() => std::fs::remove_file(&root),
                Ok(_) => std::fs::remove_dir_all(&root),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e),
            }?;
            workspace::clear_stages(&root)
        })
        .await;
        let mut result = removal.map_err(failed).and_then(|r| r.map_err(failed));
        {
            let mut inner = self.inner.lock().unwrap();
            inner.clearing = false;
            inner.pending = 0;
            if result.is_ok() {
                inner.ledger = Ledger::default();
                if let Err(error) = Self::save(&inner, state) {
                    inner.ledger.error = Some(error.clone());
                    result = Err(failed(error));
                }
            } else if let Err(error) = &result {
                inner.ledger.error = Some(error.message.clone());
            }
        }
        self.announce(state);
        result?;
        Ok(self.state())
    }

    pub fn note_reply(&self, state: &ServerState, text: &str) {
        let ids = fv_core::memory_citation_ids(text);
        if ids.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        if !inner.config.enabled || inner.clearing {
            return;
        }
        for id in ids {
            if let Some(output) = inner.ledger.outputs.get_mut(&id) {
                output.usage_count = output.usage_count.saturating_add(1);
                output.last_usage = Some(now_ms());
            }
        }
        if let Err(error) = Self::save(&inner, state) {
            inner.ledger.error = Some(error);
        }
    }

    fn background_model(
        &self,
        state: &ServerState,
        threads: &[Thread],
    ) -> Result<Arc<dyn Model>, String> {
        if let Some(model) = self.model.lock().unwrap().clone() {
            return Ok(model);
        }
        let config = self.inner.lock().unwrap().config.clone();
        let defaults = crate::providers::read_defaults(state).map_err(|e| e.message)?;
        let labels = config
            .model
            .into_iter()
            .chain(defaults.model)
            .chain(threads.iter().filter_map(|t| t.model.clone()));
        for label in labels {
            if let Ok(model) = crate::providers::resolve(
                state,
                &label,
                Some(fv_protocol::types::ThinkingLevel::Medium),
            ) {
                return Ok(model);
            }
        }
        for provider in state.store.db.list_providers().map_err(|e| e.to_string())? {
            for model in provider.models {
                if let Ok(model) = crate::providers::resolve(
                    state,
                    &format!("{}/{}", provider.id, model.id),
                    Some(fv_protocol::types::ThinkingLevel::Medium),
                ) {
                    return Ok(model);
                }
            }
        }
        if !crate::providers::any_configured(state) {
            return Ok(state.agent.model.clone());
        }
        Err("没有可用于整理记忆的模型，请选择已配置凭据的模型".into())
    }

    async fn pipeline(
        self: &Arc<Self>,
        state: &Arc<ServerState>,
        generation: u64,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if !self.live(generation) {
            return Ok(());
        }
        let threads = state.threads(true).map_err(|e| e.message)?;
        let now = now_ms();
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return Ok(());
            }
            inner.ledger.outputs.retain(|id, o| {
                threads.iter().any(|t| &t.id == id)
                    && now - o.last_usage.unwrap_or(o.generated_at) <= plan::MAX_UNUSED
            });
            inner
                .ledger
                .empty
                .retain(|id, _| threads.iter().any(|t| &t.id == id));
            inner
                .ledger
                .failures
                .retain(|id, _| threads.iter().any(|t| &t.id == id));
        }
        let mut candidates = Vec::new();
        for thread in &threads {
            if state
                .loaded_runtime(&thread.id)
                .is_some_and(|rt| rt.is_running())
            {
                continue;
            }
            let path = state.store.transcripts.path(&thread.id);
            let Some(mtime) = mtime(&path) else { continue };
            if self
                .inner
                .lock()
                .unwrap()
                .ledger
                .eligible(&thread.id, mtime, now)
            {
                candidates.push((thread.clone(), path, mtime));
            }
        }
        candidates.sort_by_key(|(_, _, mtime)| std::cmp::Reverse(*mtime));
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return Ok(());
            }
            inner.pending = candidates.len() as u32;
        }
        self.announce(state);
        let root = self.root.clone();
        let original = tokio::task::spawn_blocking(move || workspace::read_tree(&root))
            .await
            .map_err(|e| e.to_string())??;
        if !self.live(generation) {
            return Ok(());
        }
        if candidates.is_empty() {
            let unchanged = {
                let inner = self.inner.lock().unwrap();
                let mut projected = original.clone();
                projected.retain(|path, _| {
                    !path.starts_with("rollout_summaries/") && path != "raw_memories.md"
                });
                projected.extend(plan::inputs(&inner.ledger.selected(now_ms())));
                projected == inner.ledger.baseline && workspace::valid(&projected)
            };
            if unchanged {
                self.refresh_snapshot().await;
                return Ok(());
            }
        }
        let no_history = {
            let inner = self.inner.lock().unwrap();
            inner.ledger.outputs.is_empty() && inner.ledger.baseline.is_empty()
        };
        let model = if candidates.is_empty() && original.is_empty() && no_history {
            return Ok(());
        } else {
            self.background_model(state, &threads)?
        };
        let budget = (model.context_window().unwrap_or(150_000) as usize * 28 / 10).min(450_000);
        let jobs = candidates
            .into_iter()
            .take(2)
            .map(|(thread, path, source_mtime)| {
                let model = model.clone();
                async move {
                    let result = self
                        .extract(state, model, &thread, &path, budget, cancel)
                        .await;
                    (thread, path, source_mtime, result)
                }
            });
        let mut jobs = stream::iter(jobs).buffer_unordered(2);
        while let Some((thread, path, source_mtime, result)) = jobs.next().await {
            if !self.live(generation) {
                return Ok(());
            }
            if mtime(&path) != Some(source_mtime)
                || state
                    .loaded_runtime(&thread.id)
                    .is_some_and(|rt| rt.is_running())
                || state.thread(&thread.id).map_err(|e| e.message)?.is_none()
            {
                continue;
            }
            {
                let mut inner = self.inner.lock().unwrap();
                if inner.generation != generation || !inner.config.enabled || inner.clearing {
                    return Ok(());
                }
                inner.pending = inner.pending.saturating_sub(1);
                match result {
                    Ok(Some(result))
                        if !result.raw_memory.is_empty() && !result.rollout_summary.is_empty() =>
                    {
                        let previous = inner.ledger.outputs.get(&thread.id);
                        let output = Output {
                            conversation_id: thread.id.clone(),
                            cwd: thread.cwd.clone().unwrap_or_default(),
                            rollout_path: path.display().to_string(),
                            created_at: thread.created_at,
                            source_updated_at: source_mtime,
                            generated_at: now_ms(),
                            raw_memory: result.raw_memory,
                            rollout_summary: result.rollout_summary,
                            slug: result.rollout_slug,
                            usage_count: previous.map_or(0, |p| p.usage_count),
                            last_usage: previous.and_then(|p| p.last_usage),
                        };
                        inner.ledger.outputs.insert(thread.id.clone(), output);
                        inner.ledger.empty.remove(&thread.id);
                        inner.ledger.failures.remove(&thread.id);
                    }
                    Ok(_) => {
                        inner.ledger.outputs.remove(&thread.id);
                        inner.ledger.empty.insert(thread.id.clone(), source_mtime);
                        inner.ledger.failures.remove(&thread.id);
                    }
                    Err(error) => inner
                        .ledger
                        .failed(&thread.id, source_mtime, now_ms(), error),
                }
                Self::save(&inner, state)?;
            }
            self.announce(state);
        }
        if !self.live(generation) {
            return Ok(());
        }
        let (selected, baseline) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.ledger.selected(now_ms()),
                inner.ledger.baseline.clone(),
            )
        };
        if selected.is_empty() && baseline.is_empty() && original.is_empty() {
            return Ok(());
        }
        let mut tree = original.clone();
        let inputs = plan::inputs(&selected);
        tree.retain(|path, _| !path.starts_with("rollout_summaries/") && path != "raw_memories.md");
        tree.extend(inputs);
        if tree == baseline && workspace::valid(&tree) {
            self.refresh_snapshot().await;
            return Ok(());
        }
        tree.insert(workspace::DIFF.into(), workspace::diff(&baseline, &tree));
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != generation {
                return Ok(());
            }
            inner.phase = MemoryPhase::Consolidating;
        }
        self.announce(state);
        let workspace = workspace::Workspace {
            root: self.root.clone(),
            tree: Arc::new(Mutex::new(tree)),
        };
        let mut registry = ToolRegistry::new();
        registry.register(workspace.clone());
        let ctx = AgentContext { context: Default::default(), hooks: None, model: model.clone(), tools: Arc::new(registry), system: "Use memory_workspace for all filesystem operations. This is an isolated memory consolidation task. No external tools, extensions, user prompts or network access are available.".into(), cwd: Some(self.root.clone()), ui: None, loaded: Default::default(), permissions: None, steer: None, memory: None, budget: Default::default(), compaction: Some(state.auto_compaction.clone()) };
        let prompt = CONSOLIDATION
            .replace("{{ memory_root }}", &self.root.display().to_string())
            .replace("{{ phase2_workspace_diff_file }}", workspace::DIFF);
        let (events, mut received) = mpsc::unbounded_channel();
        let mut history = Vec::new();
        let run = fv_agent::run_turn(&ctx, &mut history, prompt, &events, cancel);
        tokio::pin!(run);
        let outcome = tokio::time::timeout(Duration::from_secs(10 * 60), async {
            loop { tokio::select! { outcome = &mut run => return outcome, Some(_) = received.recv() => {} } }
        }).await.map_err(|_| "memory consolidation timed out")?;
        if outcome != TurnOutcome::Completed {
            return Err(format!("memory consolidation did not finish: {outcome:?}"));
        }
        let mut tree = workspace.tree.lock().unwrap().clone();
        tree.remove(workspace::DIFF);
        if !workspace::valid(&tree) {
            return Err("consolidation must produce a nonempty MEMORY.md and a memory_summary.md beginning with v1".into());
        }
        for text in tree.values_mut() {
            *text = plan::redact(text);
        }
        let memory = self.clone();
        let state = state.clone();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            let prepared = workspace::prepare(&memory.root, &tree, &cancel)?;
            prepared.verify(&memory.root, &original)?;
            let mut inner = memory.inner.lock().unwrap();
            if inner.generation != generation
                || !inner.config.enabled
                || inner.clearing
                || cancel.is_cancelled()
            {
                drop(inner);
                drop(prepared);
                return Ok(());
            }
            // Only the rename, cache update and ledger commit share the publication lock.
            // Preparing/reading/cleaning files never blocks ordinary agent snapshot reads.
            let cleanup = prepared.promote(&memory.root)?;
            inner.summary = tree.get("memory_summary.md").map(|s| plan::clip(s, 20_000));
            inner.ready = true;
            inner.snapshot_version = inner.snapshot_version.wrapping_add(1);
            inner.ledger.baseline = tree;
            let saved = Self::save(&inner, &state);
            drop(inner);
            drop(cleanup);
            saved
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(())
    }

    async fn extract(
        &self,
        state: &Arc<ServerState>,
        model: Arc<dyn Model>,
        thread: &Thread,
        path: &Path,
        budget: usize,
        cancel: &CancellationToken,
    ) -> Result<Option<plan::Extraction>, String> {
        if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
            return Ok(None);
        }
        let state = state.clone();
        let id = thread.id.clone();
        let loaded = tokio::task::spawn_blocking(move || state.store.transcripts.read(&id))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        if loaded.skipped > 0 {
            return Ok(None);
        }
        let Some(contents) = plan::render(&loaded.messages, budget) else {
            return Ok(None);
        };
        let input = STAGE_ONE_INPUT
            .replace("{{ rollout_path }}", &path.display().to_string())
            .replace("{{ rollout_cwd }}", thread.cwd.as_deref().unwrap_or(""))
            .replace("{{ rollout_contents }}", &contents);
        let answer = complete(model, STAGE_ONE_SYSTEM.into(), input, cancel).await?;
        plan::parse(&answer).map(Some)
    }
}

impl MemorySource for Memory {
    fn snapshot(&self) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        if inner.config.enabled && !inner.clearing {
            inner.summary.clone()
        } else {
            None
        }
    }

    fn instructions(&self) -> String {
        if self.snapshot().is_none() {
            return String::new();
        }
        format!("{}\n\n", READ_PATH.replace("{{ base_path }}", &self.root.display().to_string()).replace("{{ memory_summary }}", "Use the latest hidden memory context snapshot in this conversation for the current map."))
    }
}

impl Drop for Memory {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut()
            && let Some(job) = &inner.job
        {
            job.cancel.cancel();
        }
    }
}

fn mtime(path: &Path) -> Option<i64> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.is_symlink() {
        return None;
    }
    Some(
        meta.modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as i64,
    )
}

async fn complete(
    model: Arc<dyn Model>,
    system: String,
    user: String,
    cancel: &CancellationToken,
) -> Result<String, String> {
    let mut stream = model.stream(ModelRequest {
        max_output_tokens: None,
        system,
        messages: vec![Message::User { text: user }],
        tools: Vec::new(),
    });
    let request = async {
        loop {
            match stream.next().await {
                Some(Ok(ModelEvent::Done(message))) => {
                    return match message.stop {
                        StopReason::Stop => Ok(message.text()),
                        _ => Err("memory extraction did not finish normally".into()),
                    };
                }
                Some(Err(error)) => return Err(error.message),
                None => return Err("memory extraction stream ended before completion".into()),
                _ => {}
            }
        }
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("memory extraction cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(5 * 60), request) => result.map_err(|_| "memory extraction timed out".to_string())?,
    }
}
