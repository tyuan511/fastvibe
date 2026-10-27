//! The built-in tools, adapted from codex's (`codex-rs/core/src/tools`). Names, argument
//! shapes, limits and output formats follow codex so that models trained on its tools use
//! these the same way; where FastVibe differs (relative paths, pipe stdin, lifecycle ownership)
//! it says so in `NOTICE.md`.

mod apply_patch;
mod bm25;
mod code_mode;
mod computer;
pub use code_mode::CodeMode;
pub use computer::ComputerTool;
mod exec_command;
mod exec_sessions;
mod paths;
mod request_user_input;
mod tool_search;
mod truncate;
mod update_plan;
mod view_image;
mod web_search;
mod write_stdin;

use fv_agent::ToolRegistry;

pub use apply_patch::ApplyPatchTool;
pub use exec_command::ExecCommandTool;
pub use exec_sessions::ExecSessions;
pub use request_user_input::RequestUserInputTool;
pub use tool_search::ToolSearchTool;
pub use truncate::truncate_middle;
pub use update_plan::UpdatePlanTool;
pub use view_image::ViewImageTool;
pub use write_stdin::WriteStdinTool;

/// Every built-in tool.
pub fn register_builtin(registry: &mut ToolRegistry) {
    registry
        .register(ApplyPatchTool)
        .register(UpdatePlanTool)
        .register(RequestUserInputTool)
        .register(ViewImageTool)
        .register(ComputerTool)
        .register(ToolSearchTool)
        .register(web_search::HostedWebSearch);
    std::sync::Arc::new(ExecSessions::default()).register(registry);
    std::sync::Arc::new(CodeMode::default()).register(registry);
}
