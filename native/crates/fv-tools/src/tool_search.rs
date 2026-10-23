// The tool's name, arguments and idea (BM25 over deferred tool metadata, the matches become
// available for the next model call) follow OpenAI Codex (codex-rs/core/src/tools/handlers/
// tool_search.rs and tool_search_spec.rs), Apache-2.0. See NOTICE.md. Codex hands the search
// to the Responses API's own deferred loading; this works with any provider, by leaving
// deferred tools out of requests until they are found.

use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolRegistry, ToolSpec};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::bm25;

const DEFAULT_LIMIT: usize = 8;

fn default_limit() -> usize {
    DEFAULT_LIMIT
}

#[derive(Deserialize)]
struct Args {
    query: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

/// Finds tools that are not described in every request, and makes them available.
pub struct ToolSearchTool;

impl Tool for ToolSearchTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "tool_search".into(),
            description: "# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nSome of the tools may not have been provided to you upfront, and you should use this tool (`tool_search`) to search for the required tools. Describe what you need in a few words; the tools it finds can be called from your next step.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query for deferred tools."},
                    "limit": {"type": "number", "description": format!("Maximum number of tools to return. Defaults to {DEFAULT_LIMIT}.")}
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        }
    }

    // It changes what the next request offers, so it runs on its own.
    fn mutates(&self) -> bool {
        true
    }

    /// Only offered when there is something to find.
    fn enabled(&self, registry: &ToolRegistry) -> bool {
        registry.has_deferred()
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            let args: Args = match serde_json::from_value(arguments) {
                Ok(a) => a,
                Err(e) => {
                    return ToolOutput::err(format!("failed to parse function arguments: {e}"));
                }
            };
            if args.query.trim().is_empty() {
                return ToolOutput::err("query must not be empty");
            }
            if args.limit == 0 {
                return ToolOutput::err("limit must be greater than zero");
            }
            let specs = ctx.registry.deferred_specs();
            let docs: Vec<String> = specs.iter().map(document_of).collect();
            let ranked = bm25::rank(&docs, &args.query);
            let found: Vec<&ToolSpec> = ranked
                .into_iter()
                .take(args.limit)
                .map(|i| &specs[i])
                .collect();
            if found.is_empty() {
                return ToolOutput::ok(format!("No tools match `{}`.", args.query.trim()));
            }
            let fresh: Vec<String> = found
                .iter()
                .filter(|s| !ctx.loaded.contains(&s.name))
                .map(|s| s.name.clone())
                .collect();
            ctx.loaded.load(found.iter().map(|s| s.name.clone()));
            let mut out = format!(
                "Found {} tool(s). They can be called from your next step:\n",
                found.len()
            );
            for spec in found {
                let note = if fresh.contains(&spec.name) {
                    ""
                } else {
                    " (already available)"
                };
                out.push_str(&format!(
                    "- {}{note}: {}\n",
                    spec.name,
                    first_line(&spec.description)
                ));
            }
            ToolOutput::ok(out)
        })
    }
}

fn first_line(s: &str) -> &str {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

/// What a tool is searched by: its name, its description, and what its parameters are called
/// and say.
fn document_of(spec: &ToolSpec) -> String {
    let mut parts = vec![
        spec.name.clone(),
        spec.name.clone(),
        spec.description.clone(),
    ];
    if let Some(props) = spec.schema.get("properties").and_then(Value::as_object) {
        for (name, p) in props {
            parts.push(name.clone());
            if let Some(d) = p.get("description").and_then(Value::as_str) {
                parts.push(d.to_string());
            }
        }
    }
    parts.join(" ")
}
