use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use fv_protocol::types::McpServerConfig;
use tokio::io::AsyncReadExt;

const LIMIT: usize = 32 * 1024;

/// Drain continuously so a chatty child cannot fill its stderr pipe and deadlock MCP.
/// Retain bytes, not lines: a child may write an arbitrarily long line or split UTF-8.
pub(crate) struct Diagnostics {
    tail: Mutex<VecDeque<u8>>,
    secrets: Vec<String>,
}

impl Diagnostics {
    pub fn new(config: &McpServerConfig) -> Arc<Self> {
        let mut secrets: Vec<_> = config
            .env
            .values()
            .chain(config.headers.values())
            .filter(|s| !s.is_empty())
            .cloned()
            .collect();
        // Also redact a token if a library logs it without its Bearer/Basic prefix.
        secrets.extend(
            config
                .headers
                .values()
                .filter_map(|v| v.split_once(' ').map(|(_, token)| token.to_owned())),
        );
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        secrets.dedup();
        Arc::new(Self {
            tail: Mutex::new(VecDeque::with_capacity(LIMIT)),
            secrets,
        })
    }

    pub fn text(&self) -> Option<String> {
        let bytes: Vec<_> = self.tail.lock().unwrap().iter().copied().collect();
        if bytes.is_empty() {
            return None;
        }
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        for secret in &self.secrets {
            text = text.replace(secret, "[redacted]");
        }
        text.retain(|c| !c.is_control() || matches!(c, '\n' | '\t'));
        // Redacting many short values can expand the retained bytes.
        if text.len() > LIMIT {
            let mut start = text.len() - LIMIT;
            while !text.is_char_boundary(start) {
                start += 1;
            }
            text.drain(..start);
        }
        Some(text)
    }

    pub fn drain(self: &Arc<Self>, mut pipe: tokio::process::ChildStderr) -> Reader {
        let diagnostics = self.clone();
        let (done, completed) = tokio::sync::watch::channel(());
        let task = tokio::spawn(async move {
            let _done = done;
            let mut buffer = [0; 4096];
            while let Ok(n) = pipe.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                let mut tail = diagnostics.tail.lock().unwrap();
                let discard = (tail.len() + n).saturating_sub(LIMIT);
                tail.drain(..discard);
                tail.extend(&buffer[..n]);
            }
        });
        Reader { task, completed }
    }
}

pub(crate) struct Reader {
    task: tokio::task::JoinHandle<()>,
    completed: tokio::sync::watch::Receiver<()>,
}

impl Reader {
    /// EOF may race with the protocol's EOF. Collect the last diagnostic before reporting
    /// failure; a grandchild inheriting stderr must not hold shutdown open indefinitely.
    pub async fn finish(&self) {
        let mut completed = self.completed.clone();
        let _ =
            tokio::time::timeout(std::time::Duration::from_millis(200), completed.changed()).await;
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.task.abort();
    }
}
