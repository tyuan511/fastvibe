use fv_agent::ToolRegistry;

/// The tools the server offers a model. A tool that is written but not registered is invisible
/// to the model, and nothing else notices, so the list is pinned here.
#[test]
fn every_builtin_tool_is_registered_under_its_codex_name() {
    let mut registry = ToolRegistry::new();
    fv_tools::register_builtin(&mut registry);
    let names: Vec<String> = registry.specs().into_iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        [
            "apply_patch",
            "exec_command",
            "request_user_input",
            "update_plan"
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
