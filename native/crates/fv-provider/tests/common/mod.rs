#![allow(dead_code)]
//! A one-purpose HTTP server: it answers each request with the next prepared reply and keeps
//! what it was sent, so tests can look at both directions of a model call.

use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use fv_agent::{Model, ModelError, ModelEvent, ModelRequest};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn sse(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            body: body.to_string(),
        }
    }

    pub fn status(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string(),
        }
    }

    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

#[derive(Clone, Debug)]
pub struct Captured {
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Captured {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

pub struct Mock {
    pub url: String,
    pub captured: Arc<Mutex<Vec<Captured>>>,
}

pub async fn serve(replies: Vec<Reply>) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let captured = Arc::new(Mutex::new(Vec::new()));
    let queue = Arc::new(Mutex::new(
        replies
            .into_iter()
            .collect::<std::collections::VecDeque<_>>(),
    ));
    let seen = captured.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let queue = queue.clone();
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head_end, content_length) = loop {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_string();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + content_length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.lines();
                let path = lines
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                let headers = lines
                    .filter_map(|l| {
                        l.split_once(':')
                            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                    })
                    .collect();
                let body = serde_json::from_slice(&buf[head_end..]).unwrap_or(Value::Null);
                seen.lock().unwrap().push(Captured {
                    path,
                    headers,
                    body,
                });

                let reply = queue
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or(Reply::status(500, "{\"error\":\"no more replies\"}"));
                let mut out = format!(
                    "HTTP/1.1 {} X\r\nconnection: close\r\ncontent-length: {}\r\n",
                    reply.status,
                    reply.body.len()
                );
                for (k, v) in &reply.headers {
                    out.push_str(&format!("{k}: {v}\r\n"));
                }
                out.push_str("\r\n");
                out.push_str(&reply.body);
                let _ = socket.write_all(out.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    Mock { url, captured }
}

pub async fn collect(
    model: &dyn Model,
    request: ModelRequest,
) -> Vec<Result<ModelEvent, ModelError>> {
    model.stream(request).collect().await
}

pub fn events(results: Vec<Result<ModelEvent, ModelError>>) -> Vec<ModelEvent> {
    results
        .into_iter()
        .map(|r| r.unwrap_or_else(|e| panic!("stream failed: {e}")))
        .collect()
}

pub fn done(events: &[ModelEvent]) -> &fv_core::AssistantMessage {
    match events.last() {
        Some(ModelEvent::Done(m)) => m,
        other => panic!("stream did not end with Done: {other:?}"),
    }
}
