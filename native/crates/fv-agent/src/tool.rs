use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use fv_core::{Answers, Question};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments.
    pub schema: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolOutput {
    pub content: String,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
        }
    }

    pub fn err(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
        }
    }
}

/// The way a tool asks the user something and waits for the answer.
pub trait UserInput: Send + Sync {
    /// Ask the questions; `None` when nobody answered (the turn was stopped, or the client
    /// declined). `call_id` names the tool call the questions belong to.
    fn ask(&self, call_id: String, questions: Vec<Question>)
    -> BoxFuture<'static, Option<Answers>>;
}

pub struct ToolCtx {
    /// Fires when the user stops the turn; a tool that spawns something long should kill it.
    pub cancel: CancellationToken,
    pub cwd: Option<PathBuf>,
    /// The id the model gave this call.
    pub call_id: String,
    /// Present when a client is there to answer questions.
    pub ui: Option<Arc<dyn UserInput>>,
}

impl ToolCtx {
    /// A context with no way to ask the user; what most tools (and tests) need.
    pub fn new(cancel: CancellationToken, cwd: Option<PathBuf>) -> Self {
        Self {
            cancel,
            cwd,
            call_id: String::new(),
            ui: None,
        }
    }
}

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;

    /// Whether the tool changes anything. Tools that do not may run side by side; one that
    /// does runs alone. The default is the cautious answer.
    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput>;
}

#[derive(Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: impl Tool + 'static) -> &mut Self {
        self.tools.insert(tool.spec().name, Arc::new(tool));
        self
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// In name order, so two requests with the same tools are byte-identical (prompt caches).
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.tools.values().map(|t| t.spec()).collect()
    }
}
