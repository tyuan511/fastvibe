//! A shared message board for one tree of agents: the main conversation and every child it
//! started. `send_input` and `wait_agent` only go from a parent to its direct child; the board
//! lets any member leave a note the others read when they next look (findings, a decision, a
//! file one of them is about to change), without going through the parent.
//!
//! It is stored per tree (`board:<root thread id>` in the settings table, newest 100 notes) and
//! deleted with the root conversation.

use std::sync::{Arc, Mutex, Weak};

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::state::{ServerState, now_ms};

const KEEP: usize = 100;
const SHOWN: usize = 30;

/// Reads and writes of the board are one step each, so two agents posting at once keep both notes.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
struct Note {
    id: u64,
    from: String,
    at: i64,
    text: String,
}

fn key(root: &str) -> String {
    format!("board:{root}")
}

fn load(state: &ServerState, root: &str) -> Vec<Note> {
    state
        .store
        .db
        .get_setting(&key(root))
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn post(state: &ServerState, root: &str, from: &str, text: &str) -> u64 {
    let _guard = WRITE.lock().unwrap();
    let mut notes = load(state, root);
    let id = notes.last().map_or(1, |n| n.id + 1);
    notes.push(Note {
        id,
        from: from.into(),
        at: now_ms(),
        text: text.into(),
    });
    if notes.len() > KEEP {
        notes.drain(..notes.len() - KEEP);
    }
    if let Ok(text) = serde_json::to_string(&notes) {
        let _ = state.store.db.set_setting(&key(root), Some(&text));
    }
    id
}

fn render(notes: &[Note], after: u64) -> String {
    let fresh: Vec<&Note> = notes.iter().filter(|n| n.id > after).collect();
    let skipped = fresh.len().saturating_sub(SHOWN);
    let lines: Vec<String> = fresh
        .iter()
        .skip(skipped)
        .map(|n| format!("#{} {}: {}", n.id, n.from, n.text))
        .collect();
    if lines.is_empty() {
        "No new notes.".into()
    } else if skipped > 0 {
        format!("({skipped} older notes not shown)\n{}", lines.join("\n"))
    } else {
        lines.join("\n")
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Post,
    Read,
}

struct BoardTool {
    state: Weak<ServerState>,
    thread: String,
    kind: Kind,
}

/// Register the board tools for a thread that is part of a tree of agents.
pub fn register(state: &Arc<ServerState>, thread: &str, registry: &mut ToolRegistry) {
    for kind in [Kind::Post, Kind::Read] {
        registry.register(BoardTool {
            state: Arc::downgrade(state),
            thread: thread.into(),
            kind,
        });
    }
}

impl Tool for BoardTool {
    fn spec(&self) -> ToolSpec {
        match self.kind {
            Kind::Post => ToolSpec {
                name: "post_to_board".into(),
                description: "Leave a note on the board shared by every agent in this conversation's tree (the main conversation and all its children), for example a finding, a decision, or a file you are about to change. Keep it short.".into(),
                schema: json!({
                    "type": "object",
                    "properties": {"text": {"type": "string"}},
                    "required": ["text"],
                    "additionalProperties": false
                }),
            },
            Kind::Read => ToolSpec {
                name: "read_board".into(),
                description: "Read the notes the agents in this conversation's tree have left. Pass `after` (a note number) to read only newer ones.".into(),
                schema: json!({
                    "type": "object",
                    "properties": {"after": {"type": "integer", "minimum": 0}},
                    "additionalProperties": false
                }),
            },
        }
    }

    /// Only an agent tree has anyone to talk to.
    fn enabled(&self, _: &ToolRegistry) -> bool {
        let Some(state) = self.state.upgrade() else {
            return false;
        };
        crate::subagents::is_child(&state, &self.thread)
            || crate::subagents::descendants(&state, &self.thread).is_ok_and(|d| !d.is_empty())
    }

    fn mutates(&self) -> bool {
        matches!(self.kind, Kind::Post)
    }

    fn call(&self, _: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let state = self.state.upgrade();
        let thread = self.thread.clone();
        let kind = self.kind;
        Box::pin(async move {
            let Some(state) = state else {
                return ToolOutput::err("Server closed.");
            };
            let Ok(root) = crate::subagents::root_id(&state, &thread) else {
                return ToolOutput::err("This conversation is gone.");
            };
            match kind {
                Kind::Post => {
                    let text = arguments
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if text.is_empty() {
                        return ToolOutput::err("text must not be empty");
                    }
                    let from = if thread == root {
                        "main".to_string()
                    } else {
                        thread.chars().take(8).collect()
                    };
                    let id = post(
                        &state,
                        &root,
                        &from,
                        &text.chars().take(2000).collect::<String>(),
                    );
                    ToolOutput::ok(format!("Posted note #{id}."))
                }
                Kind::Read => {
                    let after = arguments.get("after").and_then(Value::as_u64).unwrap_or(0);
                    ToolOutput::ok(render(&load(&state, &root), after))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: u64) -> Note {
        Note {
            id,
            from: "main".into(),
            at: 0,
            text: format!("n{id}"),
        }
    }

    #[test]
    fn only_newer_notes_show_and_a_long_board_is_cut_from_the_old_end() {
        let notes: Vec<Note> = (1..=40).map(note).collect();
        assert_eq!(render(&notes, 38), "#39 main: n39\n#40 main: n40");
        let all = render(&notes, 0);
        assert!(all.starts_with("(10 older notes not shown)\n#11 "));
        assert_eq!(render(&notes, 40), "No new notes.");
    }
}
