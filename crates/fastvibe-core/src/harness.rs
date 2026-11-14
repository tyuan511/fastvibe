//! Harness boundary. UI and storage consume typed events, never wire JSON.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::process::Stdio;
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::watch,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessId {
    Codex,
    ClaudeCode,
}
impl HarnessId {
    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
        }
    }
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HarnessCapabilities {
    pub streaming: bool,
    pub tools: bool,
    pub resume: bool,
    pub model_selection: bool,
    pub thinking: bool,
    pub plans: bool,
    pub usage: bool,
    pub permissions: bool,
    pub questions: bool,
    pub replay: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelSpec {
    pub id: String,
    pub label: String,
    pub reasoning: Vec<String>,
    #[serde(default)]
    pub config_options: Vec<ConfigOption>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigOption {
    pub id: String,
    pub label: String,
    pub kind: ConfigOptionKind,
    #[serde(default)]
    pub options: Vec<ConfigChoice>,
    #[serde(default)]
    pub default: Option<ConfigValue>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfigOptionKind {
    Select,
    Boolean,
    Text,
    Number,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigChoice {
    pub value: String,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ConfigValue {
    String(String),
    Bool(bool),
    Number(i64),
    Null,
}
#[derive(Debug, Clone)]
pub struct AgentRequest {
    pub prompt: String,
    pub working_directory: PathBuf,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub config: BTreeMap<String, ConfigValue>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    Text,
    Thinking,
    Tool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Starting,
    Running,
    Waiting,
    Completed,
    Failed,
    Stopped,
    Interrupted,
}
impl RunState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Waiting)
    }
    pub fn is_terminal(self) -> bool {
        !self.is_active()
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AgentEvent {
    SessionReady(String),
    Configuration {
        model: Option<String>,
        provider: Option<String>,
        config: BTreeMap<String, ConfigValue>,
    },
    StateChanged {
        state: RunState,
        stop_reason: Option<String>,
    },
    MessageUpsert {
        key: String,
        role: crate::session::Role,
        kind: ContentKind,
        text: String,
        append: bool,
        final_: bool,
        state: RunState,
    },
    ToolCallUpsert {
        key: String,
        name: Option<String>,
        title: Option<String>,
        status: ToolStatus,
        input: Option<String>,
        output: Option<String>,
        error: Option<String>,
    },
    PlanUpsert {
        plan_id: String,
        entries: Vec<PlanEntry>,
    },
    PermissionRequest {
        request_id: String,
        title: String,
        details: Option<String>,
    },
    QuestionRequest {
        request_id: String,
        question: String,
    },
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        reasoning_tokens: Option<u64>,
        cost: Option<f64>,
    },
    Notice {
        level: NoticeLevel,
        text: String,
    },
    Compaction {
        summary: Option<String>,
    },
    Content {
        key: String,
        kind: ContentKind,
        text: String,
        append: bool,
        name: Option<String>,
        state: RunState,
    },
    Finished {
        state: RunState,
        error: Option<String>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCommand {
    PermissionResponse { request_id: String, approved: bool },
    QuestionResponse { request_id: String, answer: String },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub priority: Option<String>,
    pub status: String,
}
impl AgentEvent {
    pub fn text(
        key: impl Into<String>,
        kind: ContentKind,
        text: impl Into<String>,
        append: bool,
    ) -> Self {
        Self::MessageUpsert {
            key: key.into(),
            role: crate::session::Role::Assistant,
            kind,
            text: text.into(),
            append,
            final_: !append,
            state: if append {
                RunState::Running
            } else {
                RunState::Completed
            },
        }
    }
}
pub struct AgentRun {
    pub events: async_channel::Receiver<AgentEvent>,
    cancel: watch::Sender<bool>,
    commands: async_channel::Sender<AgentCommand>,
}
impl AgentRun {
    pub fn stop(&self) {
        let _ = self.cancel.send(true);
    }
    pub fn respond(
        &self,
        command: AgentCommand,
    ) -> Result<(), async_channel::TrySendError<AgentCommand>> {
        self.commands.try_send(command)
    }
}
impl Drop for AgentRun {
    fn drop(&mut self) {
        self.stop();
    }
}
pub trait Harness: Send + Sync {
    fn id(&self) -> HarnessId;
    fn executable(&self) -> &str;
    fn capabilities(&self) -> HarnessCapabilities {
        HarnessCapabilities {
            streaming: true,
            tools: true,
            resume: true,
            model_selection: true,
            thinking: true,
            plans: false,
            usage: false,
            permissions: false,
            questions: false,
            replay: true,
        }
    }
    /// Models and reasoning levels exposed by this harness without making the
    /// UI know CLI-specific aliases. Harnesses with a live registry may return
    /// an empty list here and populate it through their discovery endpoint.
    fn model_catalog(&self) -> Vec<ModelSpec> {
        Vec::new()
    }
    /// Discover the current model catalog. A harness may use a local static
    /// capability catalog or query its own daemon/registry.
    fn discover_models(&self) -> async_channel::Receiver<Result<Vec<ModelSpec>, String>> {
        let (tx, rx) = async_channel::bounded(1);
        let _ = tx.send_blocking(Ok(self.model_catalog()));
        rx
    }
    fn run(&self, request: AgentRequest) -> AgentRun {
        let (tx, events) = async_channel::bounded(256);
        let (commands, command_rx) = async_channel::bounded(32);
        let (cancel, rx) = watch::channel(false);
        let id = self.id();
        let executable = self.executable().to_owned();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let outcome = match runtime {
                Ok(rt) => rt.block_on(run_process(
                    id,
                    &executable,
                    request,
                    tx.clone(),
                    rx,
                    command_rx,
                )),
                Err(e) => Err(e.into()),
            };
            if let Err(error) = outcome {
                let _ = tx.send_blocking(AgentEvent::Finished {
                    state: RunState::Failed,
                    error: Some(format!("{error:#}")),
                });
            }
        });
        AgentRun {
            events,
            cancel,
            commands,
        }
    }
}
#[derive(Default)]
pub struct CodexHarness {
    pub executable: String,
}
impl Harness for CodexHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Codex
    }
    fn capabilities(&self) -> HarnessCapabilities {
        HarnessCapabilities {
            streaming: true,
            tools: true,
            resume: true,
            model_selection: true,
            thinking: true,
            replay: true,
            permissions: true,
            plans: false,
            usage: false,
            questions: false,
        }
    }
    fn executable(&self) -> &str {
        if self.executable.is_empty() {
            "codex"
        } else {
            &self.executable
        }
    }
    fn model_catalog(&self) -> Vec<ModelSpec> {
        vec![ModelSpec {
            id: "default".into(),
            label: "默认模型".into(),
            reasoning: vec!["low".into(), "medium".into(), "high".into()],
            config_options: vec![],
        }]
    }
    fn discover_models(&self) -> async_channel::Receiver<Result<Vec<ModelSpec>, String>> {
        discover_codex_models()
    }
}
#[derive(Default)]
pub struct ClaudeCodeHarness {
    pub executable: String,
}
impl Harness for ClaudeCodeHarness {
    fn id(&self) -> HarnessId {
        HarnessId::ClaudeCode
    }
    fn executable(&self) -> &str {
        if self.executable.is_empty() {
            "claude"
        } else {
            &self.executable
        }
    }
    fn model_catalog(&self) -> Vec<ModelSpec> {
        vec![
            ModelSpec {
                id: "default".into(),
                label: "自动选择".into(),
                reasoning: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                config_options: vec![],
            },
            ModelSpec {
                id: "sonnet".into(),
                label: "Claude Sonnet".into(),
                reasoning: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                config_options: vec![],
            },
            ModelSpec {
                id: "opus".into(),
                label: "Claude Opus".into(),
                reasoning: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                config_options: vec![],
            },
            ModelSpec {
                id: "haiku".into(),
                label: "Claude Haiku".into(),
                reasoning: vec![
                    "low".into(),
                    "medium".into(),
                    "high".into(),
                    "xhigh".into(),
                    "max".into(),
                ],
                config_options: vec![],
            },
        ]
    }
}
pub fn default_harnesses() -> Vec<Arc<dyn Harness>> {
    vec![
        Arc::new(CodexHarness::default()),
        Arc::new(ClaudeCodeHarness::default()),
    ]
}

pub fn claude_command(executable: &str, request: &AgentRequest) -> Command {
    let mut cmd = Command::new(executable);
    cmd.current_dir(&request.working_directory).args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--dangerously-skip-permissions",
    ]);
    if let Some(id) = &request.session_id {
        cmd.args(["--resume", id]);
    }
    if let Some(model) = request
        .model
        .as_deref()
        .filter(|x| !x.is_empty() && *x != "default")
    {
        cmd.args(["--model", model]);
    }
    if let Some(effort) = request
        .reasoning
        .as_deref()
        .filter(|x| !x.is_empty() && *x != "default")
    {
        cmd.args(["--effort", effort]);
    }
    // Prompt travels on stdin, avoiding argv length limits and flag injection.
    cmd
}
async fn kill(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}
struct Rpc {
    stdin: Option<ChildStdin>,
    lines: tokio::io::Lines<BufReader<ChildStdout>>,
    next: u64,
    pending: std::collections::VecDeque<Value>,
}
impl Rpc {
    async fn send(&mut self, v: Value) -> Result<()> {
        self.stdin
            .as_mut()
            .context("stdin closed")?
            .write_all(format!("{v}\n").as_bytes())
            .await?;
        self.stdin.as_mut().context("stdin closed")?.flush().await?;
        Ok(())
    }
    async fn next(&mut self) -> Result<Value> {
        if let Some(value) = self.pending.pop_front() {
            return Ok(value);
        }
        self.read_wire().await
    }
    async fn read_wire(&mut self) -> Result<Value> {
        loop {
            let line = self
                .lines
                .next_line()
                .await?
                .context("Harness disconnected before completing the turn")?;
            if let Ok(value) = serde_json::from_str(&line) {
                return Ok(value);
            }
        }
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        loop {
            // RPC responses must be read from the wire directly. `next()` may
            // return a queued notification, which would otherwise be queued
            // forever while waiting for this response.
            let v = self.read_wire().await?;
            if v["id"] == id {
                if !v["error"].is_null() {
                    anyhow::bail!("{method}: {}", v["error"])
                }
                return Ok(v["result"].clone());
            }
            // Notifications can arrive while an RPC request is in flight. Keep
            // them for the turn loop instead of silently dropping streamed data.
            self.pending.push_back(v);
        }
    }
    async fn init(&mut self) -> Result<()> {
        self.call("initialize",json!({"clientInfo":{"name":"fastvibe","title":"FastVibe","version":env!("CARGO_PKG_VERSION")}})).await?;
        self.send(json!({"method":"initialized"})).await
    }
}
async fn run_process(
    id: HarnessId,
    exe: &str,
    request: AgentRequest,
    tx: async_channel::Sender<AgentEvent>,
    mut cancel: watch::Receiver<bool>,
    commands: async_channel::Receiver<AgentCommand>,
) -> Result<()> {
    let mut cmd = if id == HarnessId::Codex {
        let mut c = Command::new(exe);
        c.arg("app-server").current_dir(&request.working_directory);
        c
    } else {
        claude_command(exe, &request)
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().with_context(|| {
        format!(
            "Could not start {}. Install and sign in to the CLI first",
            id.label()
        )
    })?;
    let stderr = child.stderr.take().unwrap();
    let diagnostic = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(l)) = lines.next_line().await {
            tail.push_str(&l);
            tail.push('\n');
            if tail.len() > 16384 {
                tail = tail
                    .chars()
                    .rev()
                    .take(8192)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        }
        tail
    });
    let mut rpc = Rpc {
        stdin: Some(child.stdin.take().unwrap()),
        lines: BufReader::new(child.stdout.take().unwrap()).lines(),
        next: 0,
        pending: std::collections::VecDeque::new(),
    };
    tx.send(AgentEvent::StateChanged {
        state: RunState::Starting,
        stop_reason: None,
    })
    .await?;
    let job = async {
        if id == HarnessId::Codex {
            run_codex(&mut rpc, &request, &tx, &commands).await
        } else {
            run_claude(&mut rpc, &request, &tx).await
        }
    };
    let outcome = tokio::select! {
        result=job=> result,
        _=cancel.changed()=>Ok((RunState::Stopped,None)),
        _=tx.closed()=>Ok((RunState::Stopped,None)),
    };
    // Always reap both the harness and its tool subprocess group, including protocol failures.
    kill(&mut child).await;
    let diag = diagnostic.await.unwrap_or_default();
    let (state, error) = match outcome {
        Ok(result) => result,
        Err(e) => (
            RunState::Failed,
            Some(if diag.is_empty() {
                format!("{e:#}")
            } else {
                format!("{e:#}\n{diag}")
            }),
        ),
    };
    let _ = tx.send(AgentEvent::Finished { state, error }).await;
    Ok(())
}
async fn run_codex(
    rpc: &mut Rpc,
    req: &AgentRequest,
    tx: &async_channel::Sender<AgentEvent>,
    commands: &async_channel::Receiver<AgentCommand>,
) -> Result<(RunState, Option<String>)> {
    tokio::time::timeout(std::time::Duration::from_secs(30), rpc.init()).await??;
    let model = req
        .model
        .as_deref()
        .filter(|x| !x.is_empty() && *x != "default");
    let mut params = json!({"cwd":req.working_directory,"model":model,"approvalPolicy":"never","sandbox":"danger-full-access"});
    let method = if let Some(id) = &req.session_id {
        params["threadId"] = json!(id);
        "thread/resume"
    } else {
        "thread/start"
    };
    let thread = tokio::time::timeout(std::time::Duration::from_secs(30), rpc.call(method, params))
        .await??;
    let id = thread["thread"]["id"]
        .as_str()
        .context("Codex omitted thread.id")?
        .to_owned();
    tx.send(AgentEvent::SessionReady(id.clone())).await?;
    tx.send(AgentEvent::Configuration {
        model: req.model.clone(),
        provider: None,
        config: req.config.clone(),
    })
    .await?;
    tx.send(AgentEvent::StateChanged {
        state: RunState::Running,
        stop_reason: None,
    })
    .await?;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        rpc.call("turn/start",json!({"threadId":id,"model":model,"effort":req.reasoning.as_deref().filter(|x| *x!="default"),"input":[{"type":"text","text":req.prompt}]})),
    )
    .await??;
    loop {
        let v = tokio::time::timeout(std::time::Duration::from_secs(300), rpc.next()).await??;
        if v.get("id").is_some() && v.get("method").is_some() {
            let request_id = v["id"].to_string();
            let method = v["method"].as_str().unwrap_or("unknown");
            if method.contains("requestApproval") {
                tx.send(AgentEvent::PermissionRequest {
                    request_id: request_id.clone(),
                    title: method.into(),
                    details: Some(v["params"].to_string()),
                })
                .await?;
                let response = commands.recv().await?;
                match response {
                    AgentCommand::PermissionResponse {
                        request_id: id,
                        approved,
                    } if id == request_id => {
                        let decision = if approved { "accept" } else { "decline" };
                        rpc.send(json!({"id":v["id"],"result":{"decision":decision}}))
                            .await?;
                        tx.send(AgentEvent::StateChanged {
                            state: RunState::Running,
                            stop_reason: None,
                        })
                        .await?;
                    }
                    _ => anyhow::bail!("Unexpected response for harness request {request_id}"),
                }
                continue;
            }
            rpc.send(json!({"id":v["id"],"error":{"code":-32601,"message":"FastVibe does not implement this blocking request"}})).await?;
            anyhow::bail!("Harness requires input: {method}");
        }
        for e in parse_codex(&v) {
            tx.send(e).await?;
        }
        if v["method"] == "turn/completed" {
            let turn = &v["params"]["turn"];
            let state = match turn["status"].as_str() {
                Some("completed") => RunState::Completed,
                Some("interrupted") => RunState::Stopped,
                _ => RunState::Failed,
            };
            return Ok((state, turn["error"]["message"].as_str().map(str::to_owned)));
        }
        if v["method"] == "error" && v["params"]["willRetry"] != true {
            anyhow::bail!("{}", v["params"]["error"]);
        }
    }
}
pub fn parse_codex(v: &Value) -> Vec<AgentEvent> {
    let p = &v["params"];
    let method = v["method"].as_str().unwrap_or("");
    let key = p["itemId"].as_str().unwrap_or("");
    match method {
        "item/agentMessage/delta" => vec![AgentEvent::text(
            key,
            ContentKind::Text,
            p["delta"].as_str().unwrap_or(""),
            true,
        )],
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => vec![AgentEvent::text(
            format!("{key}-thinking"),
            ContentKind::Thinking,
            p["delta"].as_str().unwrap_or(""),
            true,
        )],
        "item/commandExecution/outputDelta" => vec![AgentEvent::ToolCallUpsert {
            key: key.into(),
            name: None,
            title: Some("Terminal".into()),
            status: ToolStatus::Running,
            input: None,
            output: Some(p["delta"].as_str().unwrap_or("").into()),
            error: None,
        }],
        "item/started" | "item/completed" => {
            let item = &p["item"];
            let key = item["id"].as_str().unwrap_or("").to_owned();
            let done = method == "item/completed";
            let state = if !done {
                RunState::Running
            } else if matches!(item["status"].as_str(), Some("failed" | "declined")) {
                RunState::Failed
            } else {
                RunState::Completed
            };
            match item["type"].as_str().unwrap_or("") {
                "agentMessage" if done => vec![AgentEvent::text(
                    key,
                    ContentKind::Text,
                    item["text"].as_str().unwrap_or(""),
                    false,
                )],
                "commandExecution" => vec![AgentEvent::ToolCallUpsert {
                    key,
                    name: Some("Terminal".into()),
                    title: Some("Terminal".into()),
                    status: if state == RunState::Failed {
                        ToolStatus::Failed
                    } else if done {
                        ToolStatus::Completed
                    } else {
                        ToolStatus::Running
                    },
                    input: Some(item["command"].as_str().unwrap_or("").into()),
                    output: Some(item["aggregatedOutput"].as_str().unwrap_or("").into()),
                    error: item["error"].as_str().map(str::to_owned),
                }],
                "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch" => {
                    vec![AgentEvent::ToolCallUpsert {
                        key,
                        name: Some(
                            item["tool"]
                                .as_str()
                                .or(item["type"].as_str())
                                .unwrap_or("Tool")
                                .into(),
                        ),
                        title: item["type"].as_str().map(str::to_owned),
                        status: if state == RunState::Failed {
                            ToolStatus::Failed
                        } else if done {
                            ToolStatus::Completed
                        } else {
                            ToolStatus::Running
                        },
                        input: Some(serde_json::to_string_pretty(item).unwrap_or_default()),
                        output: None,
                        error: None,
                    }]
                }
                _ => vec![],
            }
        }
        _ => vec![],
    }
}
#[derive(Default)]
pub struct ClaudeParser {
    pub blocks: HashMap<u64, (String, ContentKind, Option<String>)>,
    pub streamed: std::collections::HashSet<String>,
    pub message: String,
}
impl ClaudeParser {
    pub fn parse(&mut self, v: &Value) -> Vec<AgentEvent> {
        if v["type"] == "system" && v["subtype"] == "init" {
            return v["session_id"]
                .as_str()
                .map(|x| vec![AgentEvent::SessionReady(x.into())])
                .unwrap_or_default();
        }
        if v["type"] == "stream_event" {
            let e = &v["event"];
            let ix = e["index"].as_u64().unwrap_or(0);
            match e["type"].as_str().unwrap_or("") {
                "message_start" => {
                    self.message = e["message"]["id"].as_str().unwrap_or("assistant").into();
                    self.blocks.clear();
                }
                "content_block_start" => {
                    let b = &e["content_block"];
                    let kind = match b["type"].as_str() {
                        Some("tool_use") => ContentKind::Tool,
                        Some("thinking") => ContentKind::Thinking,
                        _ => ContentKind::Text,
                    };
                    let key = b["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{}-{ix}", self.message));
                    let name = b["name"].as_str().map(str::to_owned);
                    self.blocks.insert(ix, (key.clone(), kind, name.clone()));
                    self.streamed.insert(key.clone());
                    if kind == ContentKind::Tool {
                        return vec![AgentEvent::ToolCallUpsert {
                            key,
                            name,
                            title: Some("Tool call".into()),
                            status: ToolStatus::Pending,
                            input: None,
                            output: None,
                            error: None,
                        }];
                    }
                    return vec![AgentEvent::MessageUpsert {
                        key,
                        role: crate::session::Role::Assistant,
                        kind,
                        text: b["text"].as_str().unwrap_or("").into(),
                        append: false,
                        final_: false,
                        state: RunState::Running,
                    }];
                }
                "content_block_delta" => {
                    if let Some((key, kind, name)) = self.blocks.get(&ix) {
                        let d = &e["delta"];
                        let text = d["text"]
                            .as_str()
                            .or(d["thinking"].as_str())
                            .or(d["partial_json"].as_str())
                            .unwrap_or("")
                            .to_owned();
                        if *kind == ContentKind::Tool {
                            return vec![AgentEvent::ToolCallUpsert {
                                key: key.clone(),
                                name: name.clone(),
                                title: Some("Tool call".into()),
                                status: ToolStatus::Running,
                                input: Some(text),
                                output: None,
                                error: None,
                            }];
                        }
                        return vec![AgentEvent::MessageUpsert {
                            key: key.clone(),
                            role: crate::session::Role::Assistant,
                            kind: *kind,
                            text,
                            append: true,
                            final_: false,
                            state: RunState::Running,
                        }];
                    }
                }
                _ => {}
            }
            return vec![];
        }
        let mut out = vec![];
        if (v["type"] == "assistant" || v["type"] == "user")
            && let Some(blocks) = v["message"]["content"].as_array()
        {
            for (i, b) in blocks.iter().enumerate() {
                let typ = b["type"].as_str().unwrap_or("");
                let msgid = v["message"]["id"].as_str().unwrap_or(&self.message);
                let key = b["id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{msgid}-{i}"));
                match typ {
                    "text" if v["type"] == "assistant" => out.push(AgentEvent::text(
                        key,
                        ContentKind::Text,
                        b["text"].as_str().unwrap_or(""),
                        false,
                    )),
                    "thinking" => out.push(AgentEvent::text(
                        key,
                        ContentKind::Thinking,
                        b["thinking"].as_str().unwrap_or(""),
                        false,
                    )),
                    "tool_use" => out.push(AgentEvent::ToolCallUpsert {
                        key,
                        name: b["name"].as_str().map(str::to_owned),
                        title: Some("Tool call".into()),
                        status: ToolStatus::Pending,
                        input: Some(serde_json::to_string_pretty(&b["input"]).unwrap_or_default()),
                        output: None,
                        error: None,
                    }),
                    "tool_result" => out.push(AgentEvent::ToolCallUpsert {
                        key: b["tool_use_id"].as_str().unwrap_or("").into(),
                        name: None,
                        title: Some("Tool result".into()),
                        status: if b["is_error"] == true {
                            ToolStatus::Failed
                        } else {
                            ToolStatus::Completed
                        },
                        input: None,
                        output: Some(
                            b["content"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| b["content"].to_string()),
                        ),
                        error: if b["is_error"] == true {
                            Some(b["content"].to_string())
                        } else {
                            None
                        },
                    }),
                    _ => {}
                }
            }
        }
        out
    }
}
async fn run_claude(
    rpc: &mut Rpc,
    req: &AgentRequest,
    tx: &async_channel::Sender<AgentEvent>,
) -> Result<(RunState, Option<String>)> {
    let mut input = rpc.stdin.take().context("stdin closed")?;
    input.write_all(req.prompt.as_bytes()).await?;
    drop(input);
    let mut parser = ClaudeParser::default();
    tx.send(AgentEvent::Configuration {
        model: req.model.clone(),
        provider: None,
        config: req.config.clone(),
    })
    .await?;
    tx.send(AgentEvent::StateChanged {
        state: RunState::Running,
        stop_reason: None,
    })
    .await?;
    loop {
        let v = rpc.next().await?;
        for e in parser.parse(&v) {
            tx.send(e).await?;
        }
        if v["type"] == "result" {
            let failed = v["is_error"] == true;
            let error = if failed {
                Some(
                    v["errors"]
                        .as_array()
                        .map(|e| {
                            e.iter()
                                .map(|x| x.as_str().unwrap_or(""))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_else(|| {
                            v["result"].as_str().unwrap_or("Claude Code failed").into()
                        }),
                )
            } else {
                None
            };
            return Ok((
                if failed {
                    RunState::Failed
                } else {
                    RunState::Completed
                },
                error,
            ));
        }
    }
}
/// Ask the installed Codex registry, including custom provider models. No static model names.
pub fn discover_codex_models() -> async_channel::Receiver<Result<Vec<ModelSpec>, String>> {
    let (tx, rx) = async_channel::bounded(1);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(async {
            let mut child = Command::new("codex")
                .arg("app-server")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()?;
            let mut rpc = Rpc {
                stdin: Some(child.stdin.take().unwrap()),
                lines: BufReader::new(child.stdout.take().unwrap()).lines(),
                next: 0,
                pending: std::collections::VecDeque::new(),
            };
            let query = async {
                rpc.init().await?;
                let mut models = vec![];
                let mut cursor = Value::Null;
                loop {
                    let v = rpc
                        .call("model/list", json!({"cursor":cursor,"limit":100}))
                        .await?;
                    for m in v["data"].as_array().context("Codex omitted models")? {
                        models.push(ModelSpec {
                            id: m["model"]
                                .as_str()
                                .or(m["id"].as_str())
                                .unwrap_or("")
                                .into(),
                            label: m["displayName"]
                                .as_str()
                                .or(m["model"].as_str())
                                .unwrap_or("Model")
                                .into(),
                            reasoning: m["supportedReasoningEfforts"]
                                .as_array()
                                .map(|e| {
                                    e.iter()
                                        .filter_map(|x| {
                                            x["reasoningEffort"].as_str().map(str::to_owned)
                                        })
                                        .collect()
                                })
                                .unwrap_or_default(),
                            config_options: vec![],
                        });
                    }
                    cursor = v["nextCursor"].clone();
                    if cursor.is_null() {
                        break;
                    }
                }
                Ok::<_, anyhow::Error>(models)
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(25), query).await;
            let _ = child.kill().await;
            let _ = child.wait().await;
            result.context("Codex model discovery timed out")?
        });
        let _ = tx.send_blocking(result.map_err(|e| format!("{e:#}")));
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_stream_parser_separates_thinking_text_and_tool_result() {
        let mut parser = ClaudeParser::default();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": {"type": "message_start", "message": {"id": "m1"}}
        });
        assert!(parser.parse(&start).is_empty());
        let tool = parser.parse(&serde_json::json!({
            "type": "stream_event",
            "event": {"type": "content_block_start", "index": 0,
                "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"}}
        }));
        assert!(
            matches!(tool.as_slice(), [AgentEvent::ToolCallUpsert { name: Some(name), status: ToolStatus::Pending, .. }] if name == "Bash")
        );
        let result = parser.parse(&serde_json::json!({
            "type": "user",
            "message": {"id": "u1", "content": [{"type": "tool_result", "tool_use_id": "tool-1", "content": "ok"}]}
        }));
        assert!(
            matches!(result.as_slice(), [AgentEvent::ToolCallUpsert { key, status: ToolStatus::Completed, .. }] if key == "tool-1")
        );
    }

    #[test]
    fn codex_parser_keeps_stream_delta_and_final_item_key_stable() {
        let delta = parse_codex(&serde_json::json!({
            "method": "item/agentMessage/delta",
            "params": {"itemId": "a1", "delta": "hi"}
        }));
        assert!(
            matches!(delta.as_slice(), [AgentEvent::MessageUpsert { key, append: true, kind: ContentKind::Text, .. }] if key == "a1")
        );
        let final_item = parse_codex(&serde_json::json!({
            "method": "item/completed",
            "params": {"item": {"id": "a1", "type": "agentMessage", "text": "hi", "status": "completed"}}
        }));
        assert!(
            matches!(final_item.as_slice(), [AgentEvent::MessageUpsert { key, append: false, .. }] if key == "a1")
        );
    }

    #[test]
    fn harness_owns_model_and_reasoning_catalog() {
        let claude = ClaudeCodeHarness::default();
        let models = claude.model_catalog();
        assert!(models.iter().any(|model| model.id == "sonnet"));
        assert!(
            models
                .iter()
                .find(|model| model.id == "sonnet")
                .is_some_and(|model| model.reasoning.iter().any(|effort| effort == "max"))
        );
        let discovered = claude.discover_models().recv_blocking().unwrap().unwrap();
        assert_eq!(discovered, models);
    }
}
