//! The built-in tools, adapted from codex's (`codex-rs/core/src/tools`). Names, argument
//! shapes, limits and output formats follow codex so that models trained on its tools use
//! these the same way; where FastVibe differs (relative paths, no sandbox)
//! it says so in `NOTICE.md`.

mod apply_patch;
mod exec_command;
mod paths;
mod request_user_input;
mod truncate;
mod update_plan;

use fv_agent::ToolRegistry;

pub use apply_patch::ApplyPatchTool;
pub use exec_command::ExecCommandTool;
pub use request_user_input::RequestUserInputTool;
pub use truncate::truncate_middle;
pub use update_plan::UpdatePlanTool;

/// Every built-in tool.
pub fn register_builtin(registry: &mut ToolRegistry) {
    registry
        .register(ApplyPatchTool)
        .register(ExecCommandTool)
        .register(UpdatePlanTool)
        .register(RequestUserInputTool);
}
