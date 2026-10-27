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
fn defaults() -> Vec<SubagentRole> {
    vec![
        SubagentRole { id:"explorer".into(),name:"代码探索".into(),description:"Read-only investigation, code navigation and review.".into(),system_prompt:"Investigate the assigned question and report concrete findings with file references. Do not modify files or delegate work.".into(),model:None,thinking:None,read_only:true,tools:None },
        SubagentRole { id:"worker".into(),name:"执行任务".into(),description:"Implement and verify a focused task in the shared workspace.".into(),system_prompt:"Complete the assigned task, verify the result and report changed files, checks and remaining issues. Other agents share this workspace; preserve their edits.".into(),model:None,thinking:None,read_only:false,tools:None },
    ]
}
pub fn read(state: &ServerState) -> Result<Vec<SubagentRole>, ErrorObject> {
    state
        .store
        .db
        .get_setting(KEY)
        .map_err(internal)?
        .map(|s| serde_json::from_str(&s).map_err(internal))
        .transpose()
        .map(|roles| roles.unwrap_or_else(defaults))
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
        roles: read(state)?,
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
    validate(state, &params.role)?;
    {
        let _gate = state.subagents_lock.lock().unwrap();
        let mut roles = read(state)?;
        let current = roles.iter().find(|r| r.id == params.role.id);
        if current != params.expected.as_ref() {
            return Err(invalid(
                "This role changed elsewhere. Reload it before saving.",
            ));
        }
        if let Some(old) = params.expected.as_ref()
            && old.id != params.role.id
        {
            return Err(invalid("A saved role id cannot be changed."));
        }
        if let Some(index) = roles.iter().position(|r| r.id == params.role.id) {
            roles[index] = params.role;
        } else {
            if roles.len() >= 32 {
                return Err(invalid("At most 32 roles can be saved."));
            }
            roles.push(params.role);
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
        if !roles.iter().any(|r| r == &params.expected) {
            return Err(invalid(
                "This role changed elsewhere. Reload it before deleting.",
            ));
        }
        roles.retain(|r| r.id != params.expected.id);
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
    let role = read(state)?
        .into_iter()
        .find(|r| r.id == name)
        .ok_or_else(|| invalid(format!("Unknown agent_type `{name}`. Choose a saved role.")))?;
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
