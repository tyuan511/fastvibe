//! Lifecycle hooks: places where the host may look at what the agent is about to do or just did.
//!
//! The loop knows nothing about where hooks come from (a `hooks.json`, a plugin); it only asks
//! this trait. Every method has a default that changes nothing, so a host implements the
//! events it cares about.

use futures_util::future::BoxFuture;
use serde_json::Value;

/// The tool call a hook is told about.
#[derive(Clone, Debug)]
pub struct HookToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
    pub cwd: Option<std::path::PathBuf>,
}

pub enum PromptHook {
    /// Go ahead, optionally with extra context for the model.
    Allow(Option<String>),
    /// Do not run this turn at all; the reason is shown to the user.
    Block(String),
}

pub enum PreToolHook {
    Proceed,
    /// Run the tool with these arguments instead.
    Rewrite(Value),
    /// Do not run it; the reason is what the model reads as the tool's result.
    Block(String),
}

pub trait Hooks: Send + Sync {
    fn user_prompt_submit(&self, _prompt: &str) -> BoxFuture<'static, PromptHook> {
        Box::pin(async { PromptHook::Allow(None) })
    }

    fn pre_tool_use(&self, _call: &HookToolCall) -> BoxFuture<'static, PreToolHook> {
        Box::pin(async { PreToolHook::Proceed })
    }

    /// Extra text appended to the tool's result, if the hook has something to add.
    fn post_tool_use(
        &self,
        _call: &HookToolCall,
        _output: &str,
        _is_error: bool,
    ) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }

    /// The model is about to finish its turn. `Some(reason)` keeps it working: the reason is
    /// said to it as a user message.
    fn stop(&self) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}
