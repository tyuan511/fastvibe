use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, UserInput};
use fv_core::{AnswerList, Answers, Question};
use fv_tools::{RequestUserInputTool, UpdatePlanTool};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

async fn call(tool: &dyn Tool, ctx: ToolCtx, args: Value) -> ToolOutput {
    tool.call(ctx, args).await
}

fn bare() -> ToolCtx {
    ToolCtx::new(CancellationToken::new(), None)
}

#[tokio::test]
async fn update_plan_acknowledges_a_well_formed_plan() {
    let out = call(
        &UpdatePlanTool,
        bare(),
        json!({"explanation": "starting", "plan": [
            {"step": "read the code", "status": "completed"},
            {"step": "fix it", "status": "in_progress"},
            {"step": "test", "status": "pending"}
        ]}),
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    assert_eq!(out.content, "Plan updated");
}

#[tokio::test]
async fn update_plan_rejects_a_malformed_one() {
    for bad in [
        json!({}),
        json!({"plan": [{"step": "x", "status": "doing"}]}),
        json!({"plan": [{"status": "pending"}]}),
        json!({"plan": "nope"}),
    ] {
        let out = call(&UpdatePlanTool, bare(), bad.clone()).await;
        assert!(
            out.is_error
                && out
                    .content
                    .starts_with("failed to parse function arguments"),
            "{bad}: {}",
            out.content
        );
    }
}

/// Answers every question with its first option, and remembers what it was asked.
struct FirstOption(Mutex<Vec<(String, Vec<Question>)>>);

impl UserInput for FirstOption {
    fn ask(
        &self,
        call_id: String,
        questions: Vec<Question>,
    ) -> BoxFuture<'static, Option<Answers>> {
        let answers = Answers {
            answers: questions
                .iter()
                .map(|q| {
                    (
                        q.id.clone(),
                        AnswerList {
                            answers: vec![q.options[0].label.clone()],
                        },
                    )
                })
                .collect(),
        };
        self.0.lock().unwrap().push((call_id, questions));
        Box::pin(async move { Some(answers) })
    }
}

struct Nobody;

impl UserInput for Nobody {
    fn ask(&self, _: String, _: Vec<Question>) -> BoxFuture<'static, Option<Answers>> {
        Box::pin(async { None })
    }
}

fn question() -> Value {
    json!({"questions": [{
        "id": "scope",
        "header": "Scope",
        "question": "How much should I change?",
        "options": [
            {"label": "Just this file (Recommended)", "description": "Smallest change"},
            {"label": "The whole module", "description": "Larger refactor"}
        ]
    }]})
}

fn with_ui(ui: Arc<dyn UserInput>, call_id: &str) -> ToolCtx {
    let mut ctx = bare();
    ctx.ui = Some(ui);
    ctx.call_id = call_id.into();
    ctx
}

#[tokio::test]
async fn request_user_input_returns_the_answers_as_json() {
    let ui = Arc::new(FirstOption(Mutex::default()));
    let out = call(
        &RequestUserInputTool,
        with_ui(ui.clone(), "call-7"),
        question(),
    )
    .await;
    assert!(!out.is_error, "{}", out.content);
    let parsed: Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(
        parsed,
        json!({"answers": {"scope": {"answers": ["Just this file (Recommended)"]}}})
    );

    // The client was told which call it belongs to, and to offer a free-form "Other".
    let asked = ui.0.lock().unwrap();
    assert_eq!(asked[0].0, "call-7");
    assert!(asked[0].1[0].is_other);
    assert_eq!(asked[0].1[0].header, "Scope");
}

#[tokio::test]
async fn request_user_input_says_so_when_nobody_answers_or_nobody_can() {
    let out = call(
        &RequestUserInputTool,
        with_ui(Arc::new(Nobody), "c"),
        question(),
    )
    .await;
    assert!(
        out.is_error
            && out
                .content
                .contains("cancelled before receiving a response"),
        "{}",
        out.content
    );

    let out = call(&RequestUserInputTool, bare(), question()).await;
    assert!(
        out.is_error && out.content.contains("no client is connected"),
        "{}",
        out.content
    );
}

#[tokio::test]
async fn request_user_input_checks_its_arguments_before_asking() {
    let ui = Arc::new(FirstOption(Mutex::default()));
    let no_options =
        json!({"questions": [{"id": "a", "header": "A", "question": "Q?", "options": []}]});
    let out = call(&RequestUserInputTool, with_ui(ui.clone(), "c"), no_options).await;
    assert!(
        out.is_error && out.content.contains("non-empty options"),
        "{}",
        out.content
    );
    let out = call(
        &RequestUserInputTool,
        with_ui(ui.clone(), "c"),
        json!({"questions": []}),
    )
    .await;
    assert!(
        out.is_error && out.content.contains("at least one question"),
        "{}",
        out.content
    );
    let out = call(
        &RequestUserInputTool,
        with_ui(ui.clone(), "c"),
        json!({"nope": 1}),
    )
    .await;
    assert!(
        out.is_error && out.content.contains("failed to parse function arguments"),
        "{}",
        out.content
    );
    assert!(
        ui.0.lock().unwrap().is_empty(),
        "the user was bothered with an invalid question"
    );
}
