//! The `browser` tool: the agent working a page in the conversation's browser pane.
//!
//! The pane is a native web view that only the desktop app owns, so the server does not drive it.
//! A call becomes a `browser/request` sent to the clients watching the thread; the app runs it on
//! the page and answers with text. A thread nobody is watching, or a client with no browser
//! (a phone), leaves the call unanswered until it times out, and the model is told so.

use std::sync::{Arc, Weak};
use std::time::Duration;

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use fv_protocol::{RequestId, ServerRequest, types};
use serde_json::{Value, json};

use crate::prompt::request_frame;
use crate::state::{Reply, ServerState};

pub const NAME: &str = "browser";

/// How long a page action may take before the model is told nobody answered.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(45);

const ACTIONS: &[&str] = &[
    "open", "navigate", "search", "list", "evaluate", "snapshot", "click", "type", "press",
    "scroll", "back", "forward", "reload", "text",
];

struct BrowserTool {
    state: Weak<ServerState>,
    thread: String,
}

pub fn register(state: &Arc<ServerState>, thread: &str, registry: &mut ToolRegistry) {
    registry.register(BrowserTool {
        state: Arc::downgrade(state),
        thread: thread.into(),
    });
}

impl Tool for BrowserTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: NAME.into(),
            description: "Use this conversation’s browser (the embedded pane, or the installed browser selected in Browser control settings). `list` lists tabs; `search` searches for text; `evaluate` runs a JavaScript function body. Pass `newTab: true` to open another tab. `open` loads a URL (or a search). `snapshot` lists the page's interactive elements, each with a `ref` like `e3`, a role and a label. `click` and `type` act on an element by `ref` (take a fresh snapshot first: refs belong to one snapshot). `press` sends a key (Enter, Escape, Tab…) to the focused element. `scroll` moves the page. `text` returns the readable text of the page. `back`, `forward` and `reload` navigate.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ACTIONS},
                    "url": {"type": "string", "description": "For open: an http(s) address, or words to search for."},
                    "selector": {"type":"string","description":"CSS selector for click or type; alternatively use a snapshot ref."},
                    "script": {"type":"string","description":"For evaluate: JavaScript function body; use return for its result."},
                    "newTab": {"type":"boolean","description":"For open: create another tab instead of reusing the current one."},
                    "tabId": {"type":"string","description":"Optional browser tab id from list."},
                    "ref": {"type": "string", "description": "For click and type: the element's ref from the latest snapshot."},
                    "text": {"type": "string", "description": "For type: what to enter."},
                    "submit": {"type": "boolean", "description": "For type: press Enter afterwards."},
                    "key": {"type": "string", "description": "For press: the key name."},
                    "direction": {"type": "string", "enum": ["up", "down", "top", "bottom"], "description": "For scroll."}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
        }
    }

    // One page, one pointer: actions on it never overlap.
    fn mutates(&self) -> bool {
        true
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let state = self.state.upgrade();
        let thread = self.thread.clone();
        Box::pin(async move {
            let Some(state) = state else {
                return ToolOutput::err("Server closed.");
            };
            let Some(action) = arguments.get("action").and_then(Value::as_str) else {
                return ToolOutput::err("action is required");
            };
            if !ACTIONS.contains(&action) {
                return ToolOutput::err(format!("unknown action `{action}`"));
            }
            // A child's browser is its root conversation's: that is the pane the user can see.
            let owner =
                crate::subagents::root_id(&state, &thread).unwrap_or_else(|_| thread.clone());
            let id = RequestId::String(uuid::Uuid::new_v4().to_string());
            let request = ServerRequest::Browser {
                id: id.clone(),
                params: types::BrowserRequest {
                    thread_id: owner.clone(),
                    call_id: ctx.call_id.clone(),
                    action: action.to_string(),
                    args: arguments.clone(),
                },
            };
            let answer = state.park_prompt(id.clone(), &owner, request.clone());
            let rt = state.runtime(&owner);
            rt.send_frame(&state, request_frame(&request)).await;
            let reply = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => {
                    state.take_prompt(&id);
                    return ToolOutput::err("Stopped by the user before the page answered.");
                }
                reply = tokio::time::timeout(ANSWER_TIMEOUT, answer) => reply,
            };
            match reply {
                Ok(Ok(Reply::Browser(Some(r)))) if r.is_error => ToolOutput::err(r.output),
                Ok(Ok(Reply::Browser(Some(r)))) => ToolOutput::ok(r.output),
                Ok(_) => ToolOutput::err("The browser pane could not do that."),
                Err(_) => {
                    state.take_prompt(&id);
                    ToolOutput::err(
                        "Nothing answered for the browser pane: it needs the desktop app with this conversation open.",
                    )
                }
            }
        })
    }
}
