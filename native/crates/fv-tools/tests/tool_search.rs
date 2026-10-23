use std::sync::Arc;

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use fv_tools::ToolSearchTool;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// A tool that is not offered until it has been found.
struct Hidden {
    name: &'static str,
    description: &'static str,
}

impl Tool for Hidden {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.into(),
            description: self.description.into(),
            schema: json!({"type": "object", "properties": {"title": {"type": "string", "description": "The title"}}}),
        }
    }
    fn deferred(&self) -> bool {
        true
    }
    fn call(&self, _: ToolCtx, _: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async { ToolOutput::ok("done") })
    }
}

fn registry() -> Arc<ToolRegistry> {
    let mut r = ToolRegistry::new();
    r.register(ToolSearchTool)
        .register(Hidden {
            name: "github_create_issue",
            description: "Create a new issue in a GitHub repository",
        })
        .register(Hidden {
            name: "github_list_pulls",
            description: "List open pull requests in a GitHub repository",
        })
        .register(Hidden {
            name: "calendar_add_event",
            description: "Add an event to the user's calendar",
        });
    Arc::new(r)
}

fn ctx(registry: &Arc<ToolRegistry>) -> ToolCtx {
    let mut c = ToolCtx::new(CancellationToken::new(), None);
    c.registry = registry.clone();
    c
}

#[tokio::test]
async fn searching_loads_the_matches_for_the_next_request() {
    let reg = registry();
    let c = ctx(&reg);
    let loaded = c.loaded.clone();
    assert_eq!(
        reg.specs_for(&loaded)
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["tool_search"]
    );

    let out = ToolSearchTool
        .call(c, json!({"query": "create an issue on github"}))
        .await;
    assert!(!out.is_error, "{}", out.content);
    assert!(
        out.content
            .contains("github_create_issue: Create a new issue"),
        "{}",
        out.content
    );
    assert!(loaded.contains("github_create_issue"));
    assert!(
        !loaded.contains("calendar_add_event"),
        "an unrelated tool was loaded"
    );

    let names: Vec<String> = reg.specs_for(&loaded).into_iter().map(|s| s.name).collect();
    assert!(
        names.contains(&"github_create_issue".to_string())
            && !names.contains(&"calendar_add_event".to_string()),
        "{names:?}"
    );
}

#[tokio::test]
async fn a_second_search_says_what_was_already_there_and_limit_is_honoured() {
    let reg = registry();
    let c = ctx(&reg);
    let loaded = c.loaded.clone();
    ToolSearchTool.call(c, json!({"query": "github"})).await;
    assert!(loaded.contains("github_create_issue") && loaded.contains("github_list_pulls"));

    let mut again = ctx(&reg);
    again.loaded = loaded.clone();
    let out = ToolSearchTool
        .call(again, json!({"query": "github", "limit": 1}))
        .await;
    assert_eq!(
        out.content.lines().filter(|l| l.starts_with("- ")).count(),
        1,
        "{}",
        out.content
    );
    assert!(
        out.content.contains("(already available)"),
        "{}",
        out.content
    );
}

#[tokio::test]
async fn no_match_and_bad_arguments_are_plain_answers() {
    let reg = registry();
    let none = ToolSearchTool
        .call(ctx(&reg), json!({"query": "zebra"}))
        .await;
    assert!(!none.is_error);
    assert_eq!(none.content, "No tools match `zebra`.");
    assert!(
        ToolSearchTool
            .call(ctx(&reg), json!({"query": "  "}))
            .await
            .is_error
    );
    assert!(
        ToolSearchTool
            .call(ctx(&reg), json!({"query": "x", "limit": 0}))
            .await
            .is_error
    );
    assert!(
        ToolSearchTool
            .call(ctx(&reg), json!({}))
            .await
            .content
            .contains("failed to parse")
    );
}

#[test]
fn the_search_tool_is_only_offered_when_there_is_something_to_find() {
    let mut r = ToolRegistry::new();
    r.register(ToolSearchTool);
    assert!(
        r.specs().is_empty(),
        "tool_search offered with nothing deferred"
    );
    r.register(Hidden {
        name: "x_tool",
        description: "something",
    });
    assert_eq!(r.specs().len(), 1);
}
