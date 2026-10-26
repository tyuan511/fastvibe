use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use fv_core::{Answers, ImagePart, Question};
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
    /// Pictures the model should see along with the text.
    pub images: Vec<ImagePart>,
}

impl ToolOutput {
    pub fn ok(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: false,
            images: Vec::new(),
        }
    }

    pub fn with_images(mut self, images: Vec<ImagePart>) -> Self {
        self.images = images;
        self
    }

    pub fn err(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            is_error: true,
            images: Vec::new(),
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
    /// What the tools may do, and how to ask when they may not; absent means no limits.
    pub permissions: Option<Arc<crate::Permissions>>,
    /// Whether the model can look at images.
    pub vision: bool,
    /// Every tool, for one (`tool_search`) that has to look at the others.
    pub registry: Arc<ToolRegistry>,
    /// The deferred tools this conversation has loaded; `tool_search` adds to it.
    pub loaded: LoadedTools,
}

impl ToolCtx {
    /// A context with no way to ask the user; what most tools (and tests) need.
    pub fn new(cancel: CancellationToken, cwd: Option<PathBuf>) -> Self {
        Self {
            cancel,
            cwd,
            call_id: String::new(),
            ui: None,
            permissions: None,
            vision: true,
            registry: Arc::new(ToolRegistry::new()),
            loaded: LoadedTools::default(),
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

    /// A deferred tool is not described to the model until it has been found with
    /// `tool_search`. For tools there are too many of to list in every request.
    fn deferred(&self) -> bool {
        false
    }

    /// Whether the tool is offered at all, given the others. `tool_search` is pointless when
    /// nothing is deferred.
    fn enabled(&self, _registry: &ToolRegistry) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput>;
}

/// The names of deferred tools a conversation has loaded. Shared, so a tool that loads some
/// is seen by the next request.
#[derive(Clone, Default)]
pub struct LoadedTools(Arc<Mutex<BTreeSet<String>>>);

impl LoadedTools {
    pub fn load(&self, names: impl IntoIterator<Item = String>) {
        self.0.lock().unwrap().extend(names);
    }

    pub fn contains(&self, name: &str) -> bool {
        self.0.lock().unwrap().contains(name)
    }

    pub fn names(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().cloned().collect()
    }
}

#[derive(Clone, Default)]
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

    /// Extend a per-turn snapshot without changing a registry another turn is using.
    pub fn register_shared(&mut self, tool: Arc<dyn Tool>) -> &mut Self {
        self.tools.insert(tool.spec().name, tool);
        self
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// What a request offers: the tools that are not deferred, plus the deferred ones that
    /// have been loaded. In name order, so two requests with the same tools are byte-identical
    /// (prompt caches).
    pub fn specs_for(&self, loaded: &LoadedTools) -> Vec<ToolSpec> {
        self.tools
            .values()
            .filter(|t| t.enabled(self) && (!t.deferred() || loaded.contains(&t.spec().name)))
            .map(|t| t.spec())
            .collect()
    }

    /// The tools offered when nothing has been loaded.
    pub fn specs(&self) -> Vec<ToolSpec> {
        self.specs_for(&LoadedTools::default())
    }

    pub fn has_deferred(&self) -> bool {
        self.tools.values().any(|t| t.deferred())
    }

    /// The deferred tools, for `tool_search` to look through.
    pub fn deferred_specs(&self) -> Vec<ToolSpec> {
        self.tools
            .values()
            .filter(|t| t.deferred())
            .map(|t| t.spec())
            .collect()
    }
}
