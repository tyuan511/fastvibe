//! Derive the resource panel from the same transcript the conversation renders.
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use fv_protocol::types::{Item, Turn};
#[cfg(test)]
use fv_protocol::types::{PlanStatus, PlanStep};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Output {
    pub path: String,
    pub turn: String,
    pub title: Option<String>,
}

/// A new user turn retires the old checklist. Successful calls survive reconnects;
/// the live notification may be newer than the completed tool item.
#[cfg(test)]
pub fn plan(turns: &[Turn], live: Option<&fv_protocol::types::PlanUpdated>) -> Vec<PlanStep> {
    let Some(turn) = turns.last() else {
        return Vec::new();
    };
    if let Some(live) = live.filter(|p| p.turn_id == turn.id) {
        return live.plan.clone();
    }
    turn.items
        .iter()
        .rev()
        .find_map(|item| {
            let Item::ToolCall {
                name,
                arguments,
                output: Some(_),
                is_error: false,
                ..
            } = item
            else {
                return None;
            };
            (name == "update_plan")
                .then(|| serde_json::from_value(arguments.get("plan")?.clone()).ok())
                .flatten()
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub fn active_step(steps: &[PlanStep]) -> Option<&PlanStep> {
    steps
        .iter()
        .find(|p| p.status == PlanStatus::InProgress)
        .or_else(|| steps.iter().find(|p| p.status == PlanStatus::Pending))
}

/// Resolve lexically on the host's cwd, without reading the local machine's disk.
/// URLs and inline data never become file-preview requests.
pub fn resolve(path: &str, cwd: Option<&str>) -> Option<String> {
    let path = path.trim();
    if path.is_empty() || path.contains('\0') {
        return None;
    }
    let path = if path.starts_with("file://") {
        url::Url::parse(path).ok()?.to_file_path().ok()?
    } else {
        if path.contains("://")
            || path.starts_with("data:")
            || path.starts_with("https:")
            || path.starts_with("http:")
        {
            return None;
        }
        PathBuf::from(path)
    };
    let path = if path.is_absolute() {
        path
    } else {
        Path::new(cwd?).join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized.to_string_lossy().into_owned())
}

/// Most recent producer wins. Reads, failed calls and deleted files are omitted.
pub fn outputs(turns: &[Turn], cwd: Option<&str>) -> Vec<Output> {
    let mut files = BTreeMap::<String, (usize, Output)>::new();
    let mut order = 0;
    for turn in turns {
        for item in &turn.items {
            let Item::ToolCall {
                name,
                arguments,
                output: Some(_),
                is_error: false,
                ..
            } = item
            else {
                continue;
            };
            let mut add = |path: &str, title: Option<String>| {
                if let Some(path) = resolve(path, cwd) {
                    order += 1;
                    files.insert(
                        path.clone(),
                        (
                            order,
                            Output {
                                path,
                                title,
                                turn: turn.id.clone(),
                            },
                        ),
                    );
                }
            };
            match name.as_str() {
                "apply_patch" => {
                    let patch = arguments
                        .get("input")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let lines: Vec<_> = patch.lines().collect();
                    for (i, line) in lines.iter().enumerate() {
                        if let Some(path) = line.strip_prefix("*** Delete File: ") {
                            if let Some(path) = resolve(path, cwd) {
                                files.remove(&path);
                            }
                        } else if let Some(path) = line
                            .strip_prefix("*** Add File: ")
                            .or_else(|| line.strip_prefix("*** Update File: "))
                        {
                            // A rename is produced at its destination, never the old path.
                            let moved = lines
                                .get(i + 1)
                                .and_then(|l| l.strip_prefix("*** Move to: "));
                            if let Some(to) = moved {
                                if let Some(old) = resolve(path, cwd) {
                                    files.remove(&old);
                                }
                                order += 1;
                                if let Some(path) = resolve(to, cwd) {
                                    files.insert(
                                        path.clone(),
                                        (
                                            order,
                                            Output {
                                                path,
                                                title: None,
                                                turn: turn.id.clone(),
                                            },
                                        ),
                                    );
                                }
                            } else {
                                order += 1;
                                if let Some(path) = resolve(path, cwd) {
                                    files.insert(
                                        path.clone(),
                                        (
                                            order,
                                            Output {
                                                path,
                                                title: None,
                                                turn: turn.id.clone(),
                                            },
                                        ),
                                    );
                                }
                            }
                        }
                    }
                }
                "write" | "write_file" | "create_file" | "edit" | "edit_file" | "str_replace" => {
                    if let Some(path) = [
                        "path",
                        "file_path",
                        "filePath",
                        "filename",
                        "file",
                        "target_file",
                        "target",
                    ]
                    .into_iter()
                    .find_map(|key| arguments.get(key).and_then(|v| v.as_str()))
                    {
                        add(path, None);
                    }
                }
                "present" => {
                    if let Some(items) = arguments.get("items").and_then(|v| v.as_array()) {
                        for item in items {
                            if let Some(path) = item.as_str().or_else(|| {
                                item.get("source")
                                    .or_else(|| item.get("path"))
                                    .or_else(|| item.get("ref"))
                                    .and_then(|v| v.as_str())
                            }) {
                                add(
                                    path,
                                    item.get("title")
                                        .and_then(|v| v.as_str())
                                        .map(str::to_string),
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let mut files: Vec<_> = files.into_values().collect();
    files.sort_by_key(|(order, _)| std::cmp::Reverse(*order));
    files.into_iter().map(|(_, file)| file).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn tool(name: &str, arguments: serde_json::Value, failed: bool) -> Item {
        Item::ToolCall {
            id: name.into(),
            name: name.into(),
            arguments,
            output: Some("done".into()),
            is_error: failed,
        }
    }
    #[test]
    fn resources_use_only_successful_producers_and_the_latest_owner() {
        let turns = vec![
            Turn::new(
                "a".into(),
                vec![
                    tool("write_file", json!({"path":"out/a.md"}), false),
                    tool("read_file", json!({"path":"secret.txt"}), false),
                    tool("write_file", json!({"path":"failed.txt"}), true),
                ],
            ),
            Turn::new(
                "b".into(),
                vec![tool(
                    "apply_patch",
                    json!({"input":"*** Begin Patch\n*** Update File: out/a.md\n*** Move to: out/b.md\n@@\n-old\n+new\n*** Add File: out/c.md\n+hi\n*** Delete File: out/c.md\n*** End Patch"}),
                    false,
                )],
            ),
        ];
        assert_eq!(
            outputs(&turns, Some("/workspace")),
            vec![Output {
                path: "/workspace/out/b.md".into(),
                turn: "b".into(),
                title: None
            }]
        );
        assert_eq!(
            resolve("../report.md", Some("/workspace/out")),
            Some("/workspace/report.md".into())
        );
        assert_eq!(
            resolve("https://example.com/a.png", Some("/workspace")),
            None
        );
        assert_eq!(
            resolve("data:image/png;base64,abc", Some("/workspace")),
            None
        );
    }
    #[test]
    fn resources_restore_the_current_plan_and_retire_it_on_a_new_turn() {
        let mut turns = vec![Turn::new(
            "a".into(),
            vec![tool(
                "update_plan",
                json!({"plan":[{"step":"Build", "status":"in_progress"}]}),
                false,
            )],
        )];
        let steps = plan(&turns, None);
        assert_eq!(active_step(&steps).unwrap().step, "Build");
        turns.push(Turn::new("b".into(), vec![]));
        assert!(plan(&turns, None).is_empty());
    }

    #[test]
    fn resources_deduplicate_presented_files_and_ignore_unfinished_calls() {
        let mut pending = tool("write_file", json!({"path":"pending.txt"}), false);
        if let Item::ToolCall { output, .. } = &mut pending {
            *output = None;
        }
        let turns = vec![
            Turn::new(
                "a".into(),
                vec![tool("write_file", json!({"path":"./out/a.md"}), false)],
            ),
            Turn::new(
                "b".into(),
                vec![
                    pending,
                    tool(
                        "present",
                        json!({"items":[
                            {"source":"out/a.md", "title":"Report"},
                            "https://example.com/image.png", "data:image/png;base64,a"
                        ]}),
                        false,
                    ),
                ],
            ),
        ];
        assert_eq!(
            outputs(&turns, Some("/workspace")),
            vec![Output {
                path: "/workspace/out/a.md".into(),
                turn: "b".into(),
                title: Some("Report".into())
            }]
        );
    }

    #[test]
    fn resources_live_plan_wins_only_for_the_current_turn() {
        let turns = vec![Turn::new(
            "a".into(),
            vec![
                tool(
                    "update_plan",
                    json!({"plan":[{"step":"Build", "status":"pending"}]}),
                    false,
                ),
                tool(
                    "update_plan",
                    json!({"plan":[{"step":"Invalid", "status":"completed"}]}),
                    true,
                ),
            ],
        )];
        let live = fv_protocol::types::PlanUpdated {
            turn_id: "a".into(),
            explanation: None,
            plan: vec![PlanStep {
                step: "Build".into(),
                status: PlanStatus::Completed,
            }],
        };
        assert_eq!(plan(&turns, Some(&live)), live.plan);
        let stale = fv_protocol::types::PlanUpdated {
            turn_id: "old".into(),
            ..live
        };
        assert_eq!(plan(&turns, Some(&stale))[0].status, PlanStatus::Pending);
    }
}
