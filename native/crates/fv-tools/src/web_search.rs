//! A capability grant for the provider's hosted search; never a local HTTP search proxy.
use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use serde_json::{Value, json};
pub struct HostedWebSearch;
impl Tool for HostedWebSearch {
    fn spec(&self) -> ToolSpec {
        ToolSpec{name:"web_search".into(),description:"Provider-hosted web search, available only when enabled on a Responses model. The provider performs it; it cannot be invoked through code_mode or as a local function.".into(),schema:json!({"type":"object","properties":{}})}
    }
    fn hosted(&self) -> bool {
        true
    }
    fn mutates(&self) -> bool {
        false
    }
    fn call(&self, _ctx: ToolCtx, _args: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async {
            ToolOutput::err(
                "web_search is hosted by the configured Responses endpoint, not a local function. Enable it on a supported model and let that model invoke its hosted tool.",
            )
        })
    }
}
