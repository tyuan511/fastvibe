use std::sync::{Arc, RwLock};

use fv_agent::testing::{Reply, ScriptedModel};
use fv_agent::{AgentContext, MemorySource, ToolRegistry, TurnOutcome, run_turn};
use fv_core::Message;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Source(RwLock<Option<String>>);
impl MemorySource for Source {
    fn snapshot(&self) -> Option<String> {
        self.0.read().unwrap().clone()
    }
    fn instructions(&self) -> String {
        if self.snapshot().is_some() {
            "STABLE_MEMORY_RULES\n".into()
        } else {
            String::new()
        }
    }
}

fn context(model: Arc<ScriptedModel>, memory: Arc<Source>) -> AgentContext {
    AgentContext {
        model,
        tools: Arc::new(ToolRegistry::new()),
        system: "base".into(),
        cwd: None,
        ui: None,
        permissions: None,
        loaded: Default::default(),
        steer: None,
        memory: Some(memory),
        budget: Default::default(),
        compaction: None,
    }
}

#[tokio::test]
async fn memory_snapshots_survive_reload_deduplicate_and_append_on_change() {
    let model = Arc::new(ScriptedModel::new(
        (0..3).map(|_| Reply::new().text("done").done()),
    ));
    let memory = Arc::new(Source(RwLock::new(Some("v1\nmap one".into()))));
    let ctx = context(model.clone(), memory.clone());
    let (events, _rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let mut history = Vec::new();
    assert_eq!(
        run_turn(&ctx, &mut history, "first".into(), &events, &cancel).await,
        TurnOutcome::Completed
    );
    let mut history: Vec<Message> =
        serde_json::from_str(&serde_json::to_string(&history).unwrap()).unwrap();
    assert_eq!(
        run_turn(&ctx, &mut history, "second".into(), &events, &cancel).await,
        TurnOutcome::Completed
    );
    assert_eq!(
        history
            .iter()
            .filter(|m| matches!(m, Message::MemoryContext { .. }))
            .count(),
        1
    );
    *memory.0.write().unwrap() = Some("v1\nmap two".into());
    assert_eq!(
        run_turn(&ctx, &mut history, "third".into(), &events, &cancel).await,
        TurnOutcome::Completed
    );
    assert_eq!(
        history
            .iter()
            .filter(|m| matches!(m, Message::MemoryContext { .. }))
            .count(),
        2
    );
    let requests = model.requests();
    assert_eq!(
        &requests[1].messages[..requests[0].messages.len()],
        &requests[0].messages
    );
    assert_eq!(requests[0].system, requests[2].system);
    assert!(
        requests[2]
            .messages
            .iter()
            .any(|m| matches!(m, Message::User { text } if text.contains("map two")))
    );
}

#[tokio::test]
async fn disabled_memory_is_filtered_and_compaction_reinjects_without_summarizing_hidden_maps() {
    let model = Arc::new(ScriptedModel::new(
        (0..4).map(|_| Reply::new().text("done").done()),
    ));
    let memory = Arc::new(Source(RwLock::new(Some("v1\nHIDDEN_MAP".into()))));
    let ctx = context(model.clone(), memory.clone());
    let (events, _rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let mut history = Vec::new();
    run_turn(&ctx, &mut history, "first".into(), &events, &cancel).await;
    *memory.0.write().unwrap() = None;
    let literal = "literal <fastvibe-memory-context> written by a user";
    run_turn(&ctx, &mut history, literal.into(), &events, &cancel).await;
    let request = &model.requests()[1];
    assert!(!request.system.contains("STABLE_MEMORY_RULES"));
    assert!(!format!("{:?}", request.messages).contains("HIDDEN_MAP"));
    assert!(
        request
            .messages
            .iter()
            .any(|m| matches!(m, Message::User { text } if text == literal))
    );
    assert!(
        history
            .iter()
            .any(|m| matches!(m, Message::MemoryContext { .. }))
    );
    *memory.0.write().unwrap() = Some("v1\nHIDDEN_MAP".into());
    fv_agent::compact(&ctx, &mut history, &events, &cancel)
        .await
        .unwrap();
    assert!(!format!("{:?}", model.requests()[2].messages).contains("HIDDEN_MAP"));
    run_turn(&ctx, &mut history, "after compact".into(), &events, &cancel).await;
    assert!(format!("{:?}", model.requests()[3].messages).contains("HIDDEN_MAP"));
    assert_eq!(
        history
            .iter()
            .filter(|m| matches!(m, Message::MemoryContext { .. }))
            .count(),
        1
    );
}
