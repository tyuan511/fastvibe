use fv_agent::ToolRegistry;

/// The tools the server offers a model. A tool that is written but not registered is invisible
/// to the model, and nothing else notices, so the list is pinned here.
#[test]
fn every_builtin_tool_is_registered_under_its_codex_name() {
    let mut registry = ToolRegistry::new();
    fv_tools::register_builtin(&mut registry);
    // `tool_search` is registered too, but only offered once something is deferred.
    let names: Vec<String> = registry.specs().into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "apply_patch",
            "code_mode",
            "computer",
            "current_time",
            "exec_command",
            "get_context_remaining",
            "goal_complete",
            "manage_exec_sessions",
            "new_context_window",
            "request_user_input",
            "sleep",
            "update_plan",
            "view_image",
            "wait",
            "web_search",
            "write_stdin"
        ]
    );
    for spec in registry.specs() {
        assert!(
            !spec.description.trim().is_empty(),
            "{} has no description",
            spec.name
        );
        assert_eq!(spec.schema["type"], "object", "{}", spec.name);
    }
}
