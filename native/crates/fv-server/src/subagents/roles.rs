//! Named role definitions are editable; an already created child keeps its own snapshot.
use super::*;

const KEY: &str = "subagent_roles_v1";
pub const READ_ONLY_TOOLS: &[&str] = &[
    "code_mode",
    "web_search",
    "wait",
    "exec_command",
    "write_stdin",
    "view_image",
    "request_user_input",
    "update_plan",
];

/// Built-in roles are compiled into the binary, after codex's `core/src/agent/role.rs`
/// (`mod built_in`): never stored in the database, never editable or deletable, always
/// available for `spawn_agent`. A saved role with the same id and different content
/// shadows one, so a user can still override the built-ins by name.
fn built_ins() -> Vec<SubagentRole> {
    vec![
        SubagentRole {
            id: "explorer".into(),
            name: "代码探索".into(),
            description: "Read-only investigation of the codebase. Use for specific, well-scoped questions; spawn several in parallel for independent questions and keep working while they run; trust their results instead of re-verifying; reuse an existing explorer for follow-ups rather than spawning a new one.".into(),
            system_prompt: "Investigate the assigned question and report concrete findings with file references. Do not modify files or delegate work.".into(),
            model: None,
            thinking: None,
            read_only: true,
            tools: None,
            builtin: true,
        },
        SubagentRole {
            id: "worker".into(),
            name: "执行任务".into(),
            description: "Execution and production work: implementing a feature slice, fixing bugs or tests, or one independent chunk of a large refactor. Assign explicit file/module ownership per worker, tell each that others edit the same workspace, and never revert changes the worker did not make.".into(),
            system_prompt: "Complete the assigned task, verify the result and report changed files, checks and remaining issues. Other agents share this workspace; preserve their edits.".into(),
            model: None,
            thinking: None,
            read_only: false,
            tools: None,
            builtin: true,
        },
    ]
}

/// True when a saved role is bit-for-bit the built-in definition. Installations seeded by
/// the pre-builtin builds stored the defaults in the database; an unmodified copy is the
/// built-in itself and must not render as a second, deletable row next to it.
fn is_untouched_built_in(saved: &SubagentRole, builtin: &SubagentRole) -> bool {
    saved.id == builtin.id
        && saved.name == builtin.name
        && saved.description == builtin.description
        && saved.system_prompt == builtin.system_prompt
        && saved.model == builtin.model
        && saved.thinking == builtin.thinking
        && saved.read_only == builtin.read_only
        && saved.tools == builtin.tools
}

pub fn read(state: &ServerState) -> Result<Vec<SubagentRole>, ErrorObject> {
    state
        .store
        .db
        .get_setting(KEY)
        .map_err(internal)?
        .map(|s| serde_json::from_str(&s).map_err(internal))
        .transpose()
        .map(|roles| roles.unwrap_or_default())
}

/// Saved roles first, then the built-ins an install has not overridden, mirroring codex's
/// `resolve_role_config`: user-configured roles win by name, built-ins fill the rest.
pub fn merged(state: &ServerState) -> Result<Vec<SubagentRole>, ErrorObject> {
    let saved = read(state)?;
    let mut kept: Vec<SubagentRole> = Vec::with_capacity(saved.len());
    let mut shadowed: Vec<bool> = vec![false; saved.len()];
    let mut trailing: Vec<SubagentRole> = Vec::with_capacity(2);
    for builtin in built_ins() {
        // A saved role with the same id overrides the built-in — unless it is an
        // untouched legacy seed of it, which is the built-in itself and gets replaced.
        let mut overridden = false;
        for (index, role) in saved.iter().enumerate() {
            if role.id == builtin.id {
                if is_untouched_built_in(role, &builtin) {
                    shadowed[index] = true;
                } else {
                    overridden = true;
                }
            }
        }
        if !overridden {
            trailing.push(builtin);
        }
    }
    // Saved roles lead, built-ins after — the order codex's spawn description uses, so
    // an install's own roles lead the list the model and the settings page see.
    for (index, role) in saved.into_iter().enumerate() {
        if !shadowed[index] {
            kept.push(role);
        }
    }
    kept.extend(trailing);
    Ok(kept)
}
fn registry(state: &Arc<ServerState>) -> ToolRegistry {
    let mut snapshot = state.mcp.snapshot(&state.agent.tools).tools;
    super::register(state, "", "", &mut snapshot);
    snapshot
}
pub fn list(state: &Arc<ServerState>) -> Result<SubagentRolesResponse, ErrorObject> {
    let registry = registry(state);
    let mut tools = BTreeMap::new();
    for spec in registry.all_specs() {
        tools.insert(
            spec.name.clone(),
            SubagentToolChoice {
                name: spec.name.clone(),
                description: spec.description.chars().take(512).collect(),
                read_only_allowed: READ_ONLY_TOOLS.contains(&spec.name.as_str()),
            },
        );
    }
    Ok(SubagentRolesResponse {
        roles: merged(state)?,
        tools: tools.into_values().collect(),
    })
}
fn validate(state: &Arc<ServerState>, role: &SubagentRole) -> Result<(), ErrorObject> {
    let id = &role.id;
    if id == "default" {
        return Err(invalid(
            "The role id 'default' is reserved for a general child.",
        ));
    }
    if id.is_empty()
        || id.len() > 64
        || !id.as_bytes()[0].is_ascii_alphabetic()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(invalid(
            "Role id must start with a letter and contain at most 64 letters, numbers, '-' or '_'.",
        ));
    }
    if role.name.trim().is_empty()
        || role.name.chars().count() > 64
        || role.description.chars().count() > 512
        || role.system_prompt.chars().count() > 32_000
    {
        return Err(invalid(
            "Use a role name of 1–64 characters, description up to 512 and instructions up to 32000.",
        ));
    }
    if let Some(model) = &role.model {
        crate::providers::resolve(state, model, role.thinking).map_err(invalid)?;
    }
    if let Some(tools) = &role.tools {
        if tools.len() > 128 || tools.iter().collect::<HashSet<_>>().len() != tools.len() {
            return Err(invalid("Select up to 128 distinct tools."));
        }
        let registry = registry(state);
        for name in tools {
            if registry.get(name).is_none() {
                return Err(invalid(format!(
                    "Tool `{name}` is unavailable. Reconnect its MCP service or remove it from the role."
                )));
            }
            if role.read_only && !READ_ONLY_TOOLS.contains(&name.as_str()) {
                return Err(invalid(format!(
                    "Tool `{name}` is not allowed in a read-only role."
                )));
            }
        }
    }
    Ok(())
}
pub fn upsert(
    state: &Arc<ServerState>,
    params: SubagentRoleUpsertParams,
) -> Result<SubagentRolesResponse, ErrorObject> {
    // Only the compiled-in definitions are built-in; a client cannot mark a saved role as one.
    let mut role = params.role;
    role.builtin = false;
    validate(state, &role)?;
    {
        let _gate = state.subagents_lock.lock().unwrap();
        let mut roles = read(state)?;
        // The "current" definition a save is compared against: the saved role, or the built-in
        // it would override — codex's user-configured roles override the compiled-in ones by
        // name. A create (`expected: None`) may shadow a built-in but never a saved role;
        // an edit must name the exact role the editor read, built-in or saved.
        let saved_current = roles.iter().find(|r| r.id == role.id).cloned();
        let built_in = built_ins().into_iter().find(|r| r.id == role.id);
        // `builtin` is server-owned, so it never participates in a comparison: an editor
        // that read a built-in holds `builtin: true` while the override it saved stores false.
        let strip = |mut role: SubagentRole| {
            role.builtin = false;
            role
        };
        match params.expected {
            None => {
                if saved_current.is_some() {
                    return Err(invalid(
                        "A role with this id is already saved. Reload it before saving.",
                    ));
                }
            }
            Some(ref expected) => {
                if saved_current.map(strip).or(built_in.map(strip)) != Some(strip(expected.clone()))
                {
                    return Err(invalid(
                        "This role changed elsewhere. Reload it before saving.",
                    ));
                }
            }
        }
        if let Some(old) = params.expected.as_ref()
            && old.id != role.id
        {
            return Err(invalid("A saved role id cannot be changed."));
        }
        if let Some(index) = roles.iter().position(|r| r.id == role.id) {
            roles[index] = role;
        } else {
            if roles.len() >= 32 {
                return Err(invalid("At most 32 roles can be saved."));
            }
            roles.push(role);
        }
        state
            .store
            .db
            .set_setting(KEY, Some(&serde_json::to_string(&roles).map_err(internal)?))
            .map_err(internal)?;
    }
    state.broadcast(ServerNotification::SubagentRolesChanged(Empty {}));
    list(state)
}
pub fn delete(
    state: &Arc<ServerState>,
    params: SubagentRoleDeleteParams,
) -> Result<SubagentRolesResponse, ErrorObject> {
    {
        let _gate = state.subagents_lock.lock().unwrap();
        let mut roles = read(state)?;
        // `builtin` is server-owned; it never decides whether a delete still matches.
        let expected = {
            let mut expected = params.expected;
            expected.builtin = false;
            expected
        };
        if !roles.iter().any(|r| {
            let mut r = r.clone();
            r.builtin = false;
            r == expected
        }) {
            return Err(invalid(
                "This role changed elsewhere. Reload it before deleting.",
            ));
        }
        roles.retain(|r| r.id != expected.id);
        state
            .store
            .db
            .set_setting(KEY, Some(&serde_json::to_string(&roles).map_err(internal)?))
            .map_err(internal)?;
    }
    state.broadcast(ServerNotification::SubagentRolesChanged(Empty {}));
    list(state)
}

/// Saved choices are rechecked when spawning, since a service may have disconnected.
pub fn for_spawn(
    state: &Arc<ServerState>,
    name: Option<&str>,
) -> Result<Option<SubagentRole>, ErrorObject> {
    let Some(name) = name else { return Ok(None) };
    if name == "default" {
        return Ok(None);
    }
    let role = merged(state)?
        .into_iter()
        .find(|r| r.id == name)
        .ok_or_else(|| {
            invalid(format!(
                "Unknown agent_type `{name}`. Choose a saved role or a built-in."
            ))
        })?;
    validate(state, &role)?;
    Ok(Some(role))
}
pub fn of_thread(state: &ServerState, id: &str) -> Option<SubagentRole> {
    state
        .store
        .db
        .subagent(id)
        .ok()
        .flatten()
        .and_then(|a| a.role)
}
pub fn restrict(role: Option<&SubagentRole>, registry: &mut ToolRegistry) {
    if let Some(role) = role {
        registry.retain(|name| {
            (!role.read_only || READ_ONLY_TOOLS.contains(&name))
                && role
                    .tools
                    .as_ref()
                    .is_none_or(|tools| tools.iter().any(|t| t == name))
        });
    }
}
