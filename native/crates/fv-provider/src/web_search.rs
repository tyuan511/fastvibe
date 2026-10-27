//! Responses metadata omitted by genai's normalized stream. Capture only search and
//! citation/text fields, never raw frames/headers, and share one state per model request.
use fv_agent::ModelEvent;
use fv_core::{ContentBlock, SearchStatus, UrlCitation, WebSearchCall, WebSource, safe_web_url};
use genai::chat::{ChatFrameSink, FrameCtx, RawFrameRef};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
type Part = (u64, u64);
#[derive(Default)]
struct TextPart {
    text: Option<String>,
    citations: Vec<UrlCitation>,
}
#[derive(Default)]
struct State {
    calls: BTreeMap<String, WebSearchCall>,
    order: BTreeMap<String, u64>,
    parts: BTreeMap<Part, TextPart>,
    source_count: usize,
    citation_count: usize,
    terminal: bool,
}
pub(crate) struct Capture {
    pub activity: AtomicBool,
    prefix: String,
    state: Mutex<State>,
    tx: tokio::sync::mpsc::UnboundedSender<ModelEvent>,
}
impl Capture {
    pub fn new(tx: tokio::sync::mpsc::UnboundedSender<ModelEvent>) -> Self {
        Self {
            activity: AtomicBool::new(false),
            prefix: uuid::Uuid::new_v4().to_string(),
            state: Default::default(),
            tx,
        }
    }
    fn search(
        &self,
        s: &mut State,
        id: &str,
        status: SearchStatus,
        action: Option<&Value>,
        index: u64,
    ) {
        if id.is_empty() || id.len() > 256 || (!s.calls.contains_key(id) && s.calls.len() >= 128) {
            return;
        }
        self.activity.store(true, Ordering::Release);
        let old = s.calls.get(id).cloned();
        let mut call = old.clone().unwrap_or_else(|| WebSearchCall {
            id: format!("web:{}:{id}", self.prefix),
            status,
            action: Value::Null,
            sources: Vec::new(),
        });
        // A late in-progress frame cannot reopen a completed search.
        if old.as_ref().is_none_or(|o| !o.status.terminal()) || status.terminal() {
            call.status = status;
        }
        if let Some(action) = action {
            let mut clean = serde_json::Map::new();
            for key in ["type", "query", "url", "pattern"] {
                if let Some(v) = action.get(key).and_then(Value::as_str) {
                    clean.insert(key.into(), Value::String(v.chars().take(4096).collect()));
                }
            }
            if let Some(queries) = action.get("queries").and_then(Value::as_array) {
                clean.insert(
                    "queries".into(),
                    json!(
                        queries
                            .iter()
                            .filter_map(Value::as_str)
                            .take(16)
                            .map(|q| q.chars().take(4096).collect::<String>())
                            .collect::<Vec<_>>()
                    ),
                );
            }
            if !clean.is_empty() {
                call.action = Value::Object(clean);
            }
            if let Some(sources) = action.get("sources").and_then(Value::as_array) {
                for source in sources.iter().take(200) {
                    if s.source_count >= 2000 {
                        break;
                    }
                    let Some(url) = source
                        .get("url")
                        .and_then(Value::as_str)
                        .and_then(safe_web_url)
                        .filter(|v| v.len() <= 8192)
                    else {
                        continue;
                    };
                    if call.sources.iter().any(|old| old.url == url) {
                        continue;
                    }
                    let title = source
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(&url)
                        .chars()
                        .take(1000)
                        .collect();
                    call.sources.push(WebSource { url, title });
                    s.source_count += 1;
                }
            }
        }
        s.order.entry(id.into()).or_insert(index);
        if old.as_ref() != Some(&call) {
            let _ = self.tx.send(ModelEvent::HostedSearch(call.clone()));
            s.calls.insert(id.into(), call);
        }
    }
    fn citation(&self, s: &mut State, key: Part, value: &Value, live: bool) {
        if value.get("type").and_then(Value::as_str) != Some("url_citation")
            || s.citation_count >= 500
        {
            return;
        }
        let Some(url) = value
            .get("url")
            .and_then(Value::as_str)
            .and_then(safe_web_url)
            .filter(|v| v.len() <= 8192)
        else {
            return;
        };
        let start = value
            .get("start_index")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let end = value.get("end_index").and_then(Value::as_u64).unwrap_or(0);
        let (Ok(start_index), Ok(end_index)) = (usize::try_from(start), usize::try_from(end))
        else {
            return;
        };
        let citation = UrlCitation {
            start_index,
            end_index,
            url,
            title: value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("来源")
                .chars()
                .take(1000)
                .collect(),
        };
        let part = s.parts.entry(key).or_default();
        if part.citations.contains(&citation) {
            return;
        }
        part.citations.push(citation.clone());
        s.citation_count += 1;
        if live {
            let mut citation = citation;
            let mut base = Some(0usize);
            for (_, p) in s.parts.range(..key) {
                base = base.and_then(|n| {
                    p.text
                        .as_ref()
                        .and_then(|t| n.checked_add(t.chars().count()))
                });
            }
            if let Some(base) = base {
                citation.start_index = citation.start_index.saturating_add(base);
                citation.end_index = citation.end_index.saturating_add(base);
            } else {
                citation.start_index = 0;
                citation.end_index = 0;
            }
            let _ = self.tx.send(ModelEvent::Citations(vec![citation]));
        }
    }
    fn item(&self, s: &mut State, index: u64, item: &Value) {
        match item.get("type").and_then(Value::as_str) {
            Some("web_search_call") => {
                let status = status(
                    item.get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("completed"),
                );
                self.search(
                    s,
                    item.get("id").and_then(Value::as_str).unwrap_or(""),
                    status,
                    item.get("action"),
                    index,
                );
            }
            Some("message") => {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for (ci, part) in parts.iter().enumerate().take(128) {
                        if part.get("type").and_then(Value::as_str) != Some("output_text") {
                            continue;
                        }
                        let key = (index, ci as u64);
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            s.parts.entry(key).or_default().text = Some(text.into());
                        }
                        if let Some(annotations) = part.get("annotations").and_then(Value::as_array)
                        {
                            for c in annotations.iter().take(500) {
                                self.citation(s, key, c, false);
                            }
                        }
                    }
                }
            }
            _ => (),
        }
    }
    pub fn decorate(&self, reply: &mut fv_core::AssistantMessage) {
        let s = self.state.lock().unwrap();
        let text = if s.parts.values().all(|p| p.text.is_some()) {
            s.parts
                .values()
                .filter_map(|p| p.text.as_deref())
                .collect::<String>()
        } else {
            String::new()
        };
        let mut citations = Vec::new();
        let mut base = Some(0usize);
        for part in s.parts.values() {
            for c in &part.citations {
                let mut c = c.clone();
                if let Some(base) = base {
                    c.start_index = c.start_index.saturating_add(base);
                    c.end_index = c.end_index.saturating_add(base);
                } else {
                    // An earlier part has no final text. Keep the source as a footer
                    // rather than attach it to an unrelated range in streamed text.
                    c.start_index = 0;
                    c.end_index = 0;
                }
                citations.push(c);
            }
            base = base.and_then(|n| {
                part.text
                    .as_ref()
                    .and_then(|t| n.checked_add(t.chars().count()))
            });
        }
        let text = if text.is_empty() { reply.text() } else { text };
        if !text.is_empty() {
            let at = reply
                .content
                .iter()
                .position(|b| matches!(b, ContentBlock::Text { .. }))
                .unwrap_or(reply.content.len());
            reply
                .content
                .retain(|b| !matches!(b, ContentBlock::Text { .. }));
            reply.content.insert(
                at.min(reply.content.len()),
                ContentBlock::Text {
                    text: fv_core::citation_markdown(&text, &citations),
                },
            );
        }
        let mut calls = s.calls.iter().collect::<Vec<_>>();
        calls.sort_by_key(|(id, _)| s.order.get(*id).copied().unwrap_or(u64::MAX));
        let at = reply
            .content
            .iter()
            .position(|b| matches!(b, ContentBlock::Text { .. }))
            .unwrap_or(reply.content.len());
        reply.content.splice(
            at..at,
            calls.into_iter().map(|(_, call)| {
                let mut call = call.clone();
                if !call.status.terminal() {
                    call.status = SearchStatus::Interrupted;
                }
                ContentBlock::HostedSearch(call)
            }),
        );
        if !citations.is_empty() {
            reply.content.push(ContentBlock::Citations { citations });
        }
        if !s.calls.is_empty() && !s.terminal {
            reply.stop = fv_core::StopReason::Error {
                message: "The Responses stream ended before the hosted search response completed."
                    .into(),
            };
        }
    }
}
fn status(s: &str) -> SearchStatus {
    match s {
        "completed" => SearchStatus::Completed,
        "failed" => SearchStatus::Failed,
        "searching" => SearchStatus::Searching,
        "interrupted" => SearchStatus::Interrupted,
        _ => SearchStatus::InProgress,
    }
}
impl ChatFrameSink for Capture {
    fn on_frame(&self, _ctx: &FrameCtx, frame: RawFrameRef<'_>) {
        let known = |event: &str| {
            matches!(
                event,
                "response.output_item.added"
                    | "response.output_item.done"
                    | "response.output_text.done"
                    | "response.output_text.delta"
                    | "response.output_text.annotation.added"
                    | "response.completed"
                    | "response.incomplete"
                    | "response.failed"
                    | "response.web_search_call.in_progress"
                    | "response.web_search_call.searching"
                    | "response.web_search_call.completed"
            )
        };
        if frame.event.is_some_and(|event| !known(event)) {
            return;
        }
        let Some(value) = frame.json() else {
            return;
        };
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .or(frame.event)
            .unwrap_or("");
        if !known(kind) {
            return;
        }
        let mut s = self.state.lock().unwrap();
        let index = value
            .get("output_index")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let content = value
            .get("content_index")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        match kind {
            "response.output_item.added" | "response.output_item.done" => {
                if let Some(item) = value.get("item") {
                    self.item(&mut s, index, item);
                }
            }
            "response.output_text.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    s.parts
                        .entry((index, content))
                        .or_default()
                        .text
                        .get_or_insert_with(String::new)
                        .push_str(delta);
                }
            }
            "response.output_text.done" => {
                if let Some(text) = value.get("text").and_then(Value::as_str) {
                    s.parts.entry((index, content)).or_default().text = Some(text.into());
                }
            }
            "response.output_text.annotation.added" => {
                if let Some(annotation) = value.get("annotation") {
                    self.citation(&mut s, (index, content), annotation, true);
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                s.terminal = true;
                if let Some(items) = value.pointer("/response/output").and_then(Value::as_array) {
                    for (index, item) in items.iter().enumerate() {
                        self.item(&mut s, index as u64, item);
                    }
                }
            }
            _ => {
                let status = status(kind.rsplit('.').next().unwrap_or("in_progress"));
                self.search(
                    &mut s,
                    value.get("item_id").and_then(Value::as_str).unwrap_or(""),
                    status,
                    None,
                    index,
                );
            }
        }
    }
}
