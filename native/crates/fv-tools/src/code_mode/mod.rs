//! Isolated JavaScript cells. No host filesystem, process, network or module loader is
//! installed. Every external capability goes through the current native tool dispatcher.
mod runtime;
use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;
const MAX_BYTES: usize = 1024 * 1024;
const DEFAULT_TOKENS: usize = 10_000;
#[derive(Default)]
pub struct CodeMode {
    cells: Mutex<BTreeMap<String, Arc<Cell>>>,
    values: Mutex<BTreeMap<String, Value>>,
}
struct Cell {
    id: String,
    cancel: CancellationToken,
    state: Mutex<CellState>,
    exited: std::sync::atomic::AtomicBool,
    changed: Notify,
    observation: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct CellState {
    output: Vec<String>,
    images: Vec<fv_core::ImagePart>,
    audio: Vec<fv_core::AudioPart>,
    bytes: usize,
    done: bool,
    collected: bool,
    error: Option<String>,
    batches: std::collections::VecDeque<Batch>,
}
#[derive(Default)]
struct Batch {
    output: Vec<String>,
    images: Vec<fv_core::ImagePart>,
    audio: Vec<fv_core::AudioPart>,
}
impl Cell {
    fn text(&self, text: String) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        if s.bytes.saturating_add(text.len()) > MAX_BYTES {
            return Err("Code-mode output exceeds 1 MiB; print a smaller result.".into());
        }
        s.bytes += text.len();
        s.output.push(text);
        Ok(())
    }
    fn image(&self, value: Value) -> Result<(), String> {
        if self.exited.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Script exited".into());
        }
        use base64::Engine;
        let (mime, data) = if let Some(uri) = value
            .as_str()
            .or_else(|| value.get("image_url").and_then(Value::as_str))
        {
            let (mime, data) = uri
                .strip_prefix("data:")
                .and_then(|s| s.split_once(";base64,"))
                .ok_or("image requires a base64 data URL or MCP image block.")?;
            (mime.to_string(), data.to_string())
        } else {
            (
                value
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .ok_or("Image mimeType is missing.")?
                    .to_string(),
                value
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or("Image data is missing.")?
                    .to_string(),
            )
        };
        if !matches!(
            mime.as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) || data.len() > 8 * 1024 * 1024
        {
            return Err("Unsupported or oversized image (8 MiB encoded maximum).".into());
        }
        base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|_| "Invalid base64 image.")?;
        let mut s = self.state.lock().unwrap();
        let existing = s
            .images
            .iter()
            .chain(s.batches.iter().flat_map(|b| &b.images))
            .collect::<Vec<_>>();
        let bytes: usize = existing
            .iter()
            .map(|i| match &i.source {
                fv_core::ImageSource::Base64 { data } => data.len(),
                _ => 0,
            })
            .sum();
        if existing.len() >= 8 || bytes.saturating_add(data.len()) > 16 * 1024 * 1024 {
            return Err("At most eight images per output batch.".into());
        }
        s.images.push(fv_core::ImagePart {
            mime,
            source: fv_core::ImageSource::Base64 { data },
        });
        Ok(())
    }
    fn audio(&self, value: Value) -> Result<(), String> {
        if self.exited.load(std::sync::atomic::Ordering::Acquire) {
            return Err("Script exited".into());
        }
        use base64::Engine;
        let (mime, data) = if let Some(uri) = value
            .as_str()
            .or_else(|| value.get("audio_url").and_then(Value::as_str))
        {
            let (mime, data) = uri
                .strip_prefix("data:")
                .and_then(|s| s.split_once(";base64,"))
                .ok_or("audio requires a base64 data URL or {mimeType,data}.")?;
            (mime.to_string(), data.to_string())
        } else {
            (
                value
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .ok_or("Audio mimeType is missing.")?
                    .to_string(),
                value
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or("Audio data is missing.")?
                    .to_string(),
            )
        };
        if !matches!(
            mime.as_str(),
            "audio/mpeg"
                | "audio/mp3"
                | "audio/wav"
                | "audio/ogg"
                | "audio/webm"
                | "audio/mp4"
                | "audio/aac"
        ) || data.len() > 16 * 1024 * 1024
        {
            return Err("Unsupported or oversized audio (16 MiB encoded maximum).".into());
        }
        base64::engine::general_purpose::STANDARD
            .decode(&data)
            .map_err(|_| "Invalid base64 audio.")?;
        let mut state = self.state.lock().unwrap();
        let existing =
            state.audio.len() + state.batches.iter().map(|b| b.audio.len()).sum::<usize>();
        if existing >= 4 {
            return Err("At most four audio clips per output batch.".into());
        }
        state.audio.push(fv_core::AudioPart {
            mime,
            source: fv_core::AudioSource::Base64 { data },
        });
        Ok(())
    }
    fn finish(&self, error: Option<String>) {
        let mut s = self.state.lock().unwrap();
        s.done = true;
        s.error = error.map(|e| e.chars().take(8000).collect());
        drop(s);
        self.changed.notify_waiters();
    }
    fn yield_now(&self) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        if s.batches.len() >= 32 {
            return Err(
                "Collect pending output before yielding again (32 batches maximum).".into(),
            );
        }
        let batch = Batch {
            output: std::mem::take(&mut s.output),
            images: std::mem::take(&mut s.images),
            audio: std::mem::take(&mut s.audio),
        };
        s.batches.push_back(batch);
        drop(s);
        self.changed.notify_waiters();
        Ok(())
    }
}
impl CodeMode {
    pub fn register(self: &Arc<Self>, registry: &mut ToolRegistry) {
        registry
            .register(Execute(self.clone()))
            .register(Wait(self.clone()));
    }
    pub fn has_running(&self) -> bool {
        self.cells
            .lock()
            .unwrap()
            .values()
            .any(|c| !c.state.lock().unwrap().done)
    }
    pub fn cancel_all(&self) {
        for cell in self.cells.lock().unwrap().values() {
            cell.cancel.cancel();
        }
    }
    pub async fn settle(&self) {
        self.cancel_all();
        let cells = self
            .cells
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for cell in cells {
            loop {
                let changed = cell.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if cell.state.lock().unwrap().done {
                    break;
                }
                changed.await;
            }
        }
        self.cells.lock().unwrap().clear();
    }
    fn stored(&self, key: String, value: Value) -> Result<(), String> {
        let mut values = self.values.lock().unwrap();
        let mut next = values.clone();
        next.insert(key, value);
        if next.len() > 128
            || serde_json::to_vec(&next).map_err(|e| e.to_string())?.len() > MAX_BYTES
        {
            return Err("Stored values exceed 128 keys / 1 MiB per conversation.".into());
        }
        *values = next;
        Ok(())
    }
    async fn execute(self: Arc<Self>, ctx: ToolCtx, p: ExecuteArgs) -> ToolOutput {
        let (code, yield_ms, tokens) = match parse(p) {
            Ok(p) => p,
            Err(e) => return ToolOutput::err(e),
        };
        if ctx.nested.is_none() {
            return ToolOutput::err("Code mode requires the native nested tool dispatcher.");
        }
        let (cell, permit) = {
            let mut cells = self.cells.lock().unwrap();
            if cells.len() >= 32 {
                return ToolOutput::err(
                    "Collect completed cells with wait before creating more (32 pending results maximum).",
                );
            }
            if cells
                .values()
                .filter(|c| !c.state.lock().unwrap().done)
                .count()
                >= 4
            {
                return ToolOutput::err(
                    "At most four live cells per conversation; wait or terminate one first.",
                );
            }
            static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
            let permit = match SLOTS
                .get_or_init(|| Arc::new(Semaphore::new(16)))
                .clone()
                .try_acquire_owned()
            {
                Ok(p) => p,
                Err(_) => {
                    return ToolOutput::err(
                        "The code-mode worker limit is reached; wait for an existing cell.",
                    );
                }
            };
            let cell = Arc::new(Cell {
                id: uuid::Uuid::new_v4().to_string(),
                cancel: ctx.cancel.child_token(),
                state: Default::default(),
                exited: Default::default(),
                changed: Default::default(),
                observation: Default::default(),
            });
            cells.insert(cell.id.clone(), cell.clone());
            (cell, permit)
        };
        let worker_cell = cell.clone();
        let pool = self.clone();
        let host = tokio::runtime::Handle::current();
        let result = std::thread::Builder::new()
            .name("fastvibe-code-mode".into())
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                let _permit = permit;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|e| e.to_string())?
                        .block_on(runtime::run(pool, worker_cell.clone(), ctx, host, code))
                }));
                worker_cell.finish(match result {
                    Ok(Ok(())) => None,
                    Ok(Err(e)) => Some(e),
                    Err(_) => Some("Code-mode worker failed.".into()),
                });
            });
        if let Err(e) = result {
            cell.finish(Some(format!("Could not start JavaScript worker: {e}")));
        }
        self.observe(cell, yield_ms, tokens, false).await
    }
    async fn observe(
        &self,
        cell: Arc<Cell>,
        yield_ms: u64,
        tokens: usize,
        terminate: bool,
    ) -> ToolOutput {
        let _observation = cell.observation.lock().await;
        if terminate {
            cell.cancel.cancel();
        }
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(if terminate { 10_000 } else { yield_ms });
        loop {
            let changed = cell.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let ready = {
                let s = cell.state.lock().unwrap();
                s.done || (!terminate && !s.batches.is_empty())
            };
            if ready {
                break;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                break;
            }
        }
        let mut s = cell.state.lock().unwrap();
        if s.collected {
            return ToolOutput::err("This cell result has already been collected.");
        }
        let explicit_yield = !terminate && !s.batches.is_empty();
        let batch = if terminate {
            let mut batch = Batch::default();
            while let Some(next) = s.batches.pop_front() {
                batch.output.extend(next.output);
                batch.images.extend(next.images);
                batch.audio.extend(next.audio);
            }
            batch.output.append(&mut s.output);
            batch.images.append(&mut s.images);
            batch.audio.append(&mut s.audio);
            batch
        } else {
            s.batches.pop_front().unwrap_or_else(|| Batch {
                output: std::mem::take(&mut s.output),
                images: std::mem::take(&mut s.images),
                audio: std::mem::take(&mut s.audio),
            })
        };
        let drained: usize = batch.output.iter().map(String::len).sum();
        s.bytes = s.bytes.saturating_sub(drained);
        let done = s.done
            && s.batches.is_empty()
            && s.output.is_empty()
            && s.images.is_empty()
            && s.audio.is_empty();
        // A yielded batch is an explicit observation boundary even if the worker has
        // already completed; the terminal result follows after queued output is consumed.
        let done = done && !explicit_yield;
        s.collected = done;
        let error = if done { s.error.take() } else { None };
        drop(s);
        let mut content = if done {
            if error.is_some() {
                "Script failed".into()
            } else {
                "Script completed".into()
            }
        } else {
            format!(
                "Script running with cell ID {}. Use wait to continue.",
                cell.id
            )
        };
        let mut text = batch.output.join("\n");
        if let Some(e) = &error {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(e);
        }
        if !text.is_empty() {
            content.push('\n');
            content.push_str(&crate::truncate_middle(&text, tokens.saturating_mul(4)).0);
        }
        let images = batch.images;
        if done {
            self.cells.lock().unwrap().remove(&cell.id);
        }
        ToolOutput {
            content,
            is_error: error.is_some(),
            images,
            audio: batch.audio,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteArgs {
    code: String,
    yield_time_ms: Option<u64>,
    max_output_tokens: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    cell_id: String,
    yield_time_ms: Option<u64>,
    max_tokens: Option<usize>,
    #[serde(default)]
    terminate: bool,
}
fn bounded(ms: u64, tokens: usize) -> Result<(u64, usize), String> {
    if ms > 300_000 || !(1..=50_000).contains(&tokens) {
        return Err(
            "yield_time_ms must be 0–300000; the output token limit must be 1–50000.".into(),
        );
    }
    Ok((ms, tokens))
}
fn parse(p: ExecuteArgs) -> Result<(String, u64, usize), String> {
    if p.code.trim().is_empty() || p.code.len() > 256 * 1024 {
        return Err("code must contain 1–262144 bytes of JavaScript source.".into());
    }
    let pragma = p
        .code
        .lines()
        .next()
        .map(str::trim)
        .and_then(|s| s.strip_prefix("// @exec:"));
    #[derive(Deserialize, Default)]
    #[serde(deny_unknown_fields)]
    struct Pragma {
        yield_time_ms: Option<u64>,
        max_output_tokens: Option<usize>,
    }
    let pragma = pragma
        .map(|s| {
            serde_json::from_str::<Pragma>(s).map_err(|e| format!("Invalid @exec pragma: {e}"))
        })
        .transpose()?
        .unwrap_or_default();
    let (ms, tokens) = bounded(
        p.yield_time_ms.or(pragma.yield_time_ms).unwrap_or(10_000),
        p.max_output_tokens
            .or(pragma.max_output_tokens)
            .unwrap_or(DEFAULT_TOKENS),
    )?;
    Ok((p.code, ms, tokens))
}
struct Execute(Arc<CodeMode>);
impl Tool for Execute {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "code_mode".into(),
            description: include_str!("instructions.md").into(),
            schema: json!({"type":"object","properties":{"code":{"type":"string","description":"Raw JavaScript source (not a code fence)."},"yield_time_ms":{"type":"integer","minimum":0,"maximum":300000},"max_output_tokens":{"type":"integer","minimum":1,"maximum":50000}},"required":["code"],"additionalProperties":false}),
        }
    }
    fn orchestrates(&self) -> bool {
        true
    }
    fn finish_turn(&self) -> BoxFuture<'static, ()> {
        let pool = self.0.clone();
        Box::pin(async move { pool.settle().await })
    }
    fn call(&self, ctx: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        let pool = self.0.clone();
        Box::pin(async move {
            match serde_json::from_value(args) {
                Ok(p) => pool.execute(ctx, p).await,
                Err(e) => ToolOutput::err(format!("Invalid code_mode arguments: {e}")),
            }
        })
    }
}
struct Wait(Arc<CodeMode>);
impl Tool for Wait {
    fn spec(&self) -> ToolSpec {
        ToolSpec{name:"wait".into(),description:"Continue a code_mode cell only after it returned a running cell ID. Returns only new output. terminate=true cancels that cell and its pending tool calls; IDs are conversation-scoped and are invalid after completion/restart.".into(),schema:json!({"type":"object","properties":{"cell_id":{"type":"string"},"yield_time_ms":{"type":"integer","minimum":0,"maximum":300000},"max_tokens":{"type":"integer","minimum":1,"maximum":50000},"terminate":{"type":"boolean"}},"required":["cell_id"],"additionalProperties":false})}
    }
    fn orchestrates(&self) -> bool {
        true
    }
    fn call(&self, _ctx: ToolCtx, args: Value) -> BoxFuture<'static, ToolOutput> {
        let pool = self.0.clone();
        Box::pin(async move {
            let p: WaitArgs = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return ToolOutput::err(format!("Invalid wait arguments: {e}")),
            };
            let (ms, tokens) = match bounded(
                p.yield_time_ms.unwrap_or(10_000),
                p.max_tokens.unwrap_or(DEFAULT_TOKENS),
            ) {
                Ok(p) => p,
                Err(e) => return ToolOutput::err(e),
            };
            let cell = pool.cells.lock().unwrap().get(&p.cell_id).cloned();
            match cell {
                Some(cell) => pool.observe(cell, ms, tokens, p.terminate).await,
                None => ToolOutput::err(
                    "Unknown, completed or stale code-mode cell ID in this conversation.",
                ),
            }
        })
    }
}

#[cfg(test)]
mod tests;
