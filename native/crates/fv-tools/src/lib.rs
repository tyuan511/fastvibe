//! The built-in tools, adapted from codex's (`codex-rs/core/src/tools`). Names, argument
//! shapes, limits and output formats follow codex so that models trained on its tools use
//! these the same way; where FastVibe differs (relative paths, no sandbox, in-process search)
//! it says so in `NOTICE.md`.

mod apply_patch;
mod exec_command;
mod paths;
mod truncate;

use fv_agent::ToolRegistry;

pub use apply_patch::ApplyPatchTool;
pub use exec_command::ExecCommandTool;
pub use truncate::truncate_middle;

/// Every built-in tool.
pub fn register_builtin(registry: &mut ToolRegistry) {
    registry.register(ApplyPatchTool).register(ExecCommandTool);
}
