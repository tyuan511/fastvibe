//! Translate live pane entities into recoverable, per-client metadata.
use std::collections::{BTreeMap, HashMap};

use fv_protocol::types::{FilePreview, TerminalSession};
use gpui_kit::component::input::{EditorState, InputEvent};
use gpui_kit::{App, AppContext as _, Context, Entity, Window};

use super::{FileViewState, PaneState, PaneTab, PaneTabKind, Workspace, editable_text, new_tab_id};
use crate::pane_layout::{self as saved, Layout, Storage};

impl PaneState {
    fn saved_layout(
        &self,
        mut value: impl FnMut(&Entity<EditorState>) -> String,
        mut session: impl FnMut(&str) -> Option<TerminalSession>,
    ) -> saved::Pane {
        let file = |preview: &Option<FilePreview>,
                    draft: &Option<String>,
                    baseline: &Option<String>,
                    editor: &Option<Entity<EditorState>>,
                    editing: bool,
                    showing: bool,
                    value: &mut dyn FnMut(&Entity<EditorState>) -> String| {
            let text = editor.as_ref().map(value).or_else(|| draft.clone());
            let recovery = preview
                .as_ref()
                .filter(|p| editable_text(p).is_some())
                .and_then(|preview| {
                    text.filter(|text| Some(text.as_str()) != baseline.as_deref())
                        .map(|text| saved::Recovery {
                            preview: preview.clone(),
                            baseline: baseline.clone(),
                            text,
                        })
                });
            saved::File {
                editing,
                showing,
                recovery,
            }
        };
        let tabs = self
            .tabs
            .iter()
            .map(|tab| {
                let kind = match &tab.kind {
                    PaneTabKind::Files { path } => {
                        let record = if self.active.as_ref() == Some(&tab.id) {
                            file(
                                &self.preview,
                                &self.draft,
                                &self.baseline,
                                &self.editor,
                                self.editing,
                                self.show_preview,
                                &mut value,
                            )
                        } else if let Some(view) = self.saved_files.get(&tab.id) {
                            file(
                                &view.preview,
                                &view.draft,
                                &view.baseline,
                                &view.editor,
                                view.editing,
                                view.show_preview,
                                &mut value,
                            )
                        } else {
                            saved::File::default()
                        };
                        saved::TabKind::File {
                            path: path.clone(),
                            file: record,
                        }
                    }
                    PaneTabKind::Chat { thread_id } => saved::TabKind::Chat {
                        thread_id: thread_id.clone(),
                    },
                    PaneTabKind::Git => saved::TabKind::Git,
                    PaneTabKind::Browser { url } => saved::TabKind::Browser { url: url.clone() },
                    PaneTabKind::Terminal => saved::TabKind::Terminal {
                        session: session(&tab.id),
                    },
                };
                saved::Tab {
                    id: tab.id.clone(),
                    title: tab.title.clone(),
                    kind,
                }
            })
            .collect();
        let mut expanded: Vec<_> = self.expanded.iter().cloned().collect();
        expanded.sort();
        saved::Pane {
            tabs,
            active: self.active.clone(),
            expanded,
            tree_width: self.tree_width,
        }
    }

    fn recovered(saved: saved::Pane) -> (Self, Vec<(String, Option<TerminalSession>)>) {
        let mut state = Self {
            tree_width: finite_width(saved.tree_width, super::TREE_WIDTH),
            expanded: saved.expanded.into_iter().collect(),
            ..Default::default()
        };
        let mut terminals = Vec::new();
        let mut ids = HashMap::new();
        for tab in saved.tabs {
            if ids.contains_key(&tab.id) {
                continue;
            }
            // Runtime IDs are always fresh; old counters or two windows cannot alias a new tab.
            let id = new_tab_id();
            ids.insert(tab.id, id.clone());
            let kind = match tab.kind {
                saved::TabKind::File { path, file } => {
                    let mut view = FileViewState {
                        editing: file.editing,
                        show_preview: file.showing,
                        restoring: true,
                        ..Default::default()
                    };
                    if let Some(recovery) = file.recovery
                        && super::preview_path(Some(&recovery.preview)).as_deref() == Some(&path)
                        && editable_text(&recovery.preview).is_some()
                    {
                        view.preview = Some(recovery.preview);
                        view.baseline = recovery.baseline;
                        view.draft = Some(recovery.text);
                    }
                    state.saved_files.insert(id.clone(), view);
                    PaneTabKind::Files { path }
                }
                saved::TabKind::Chat { thread_id } => PaneTabKind::Chat { thread_id },
                saved::TabKind::Git => PaneTabKind::Git,
                saved::TabKind::Browser { url } => PaneTabKind::Browser {
                    url: fv_core::safe_web_url(&url).unwrap_or_else(|| "about:blank".into()),
                },
                saved::TabKind::Terminal { session } => {
                    terminals.push((id.clone(), session));
                    PaneTabKind::Terminal
                }
            };
            state.tabs.push(PaneTab {
                id,
                title: tab.title,
                kind,
            });
        }
        if let Some(id) = saved
            .active
            .and_then(|id| ids.get(&id).cloned())
            .or_else(|| state.tabs.first().map(|tab| tab.id.clone()))
        {
            state.activate(id);
        }
        (state, terminals)
    }
}

fn finite_width(width: f32, fallback: f32) -> f32 {
    if width.is_finite() {
        width.clamp(120.0, 4096.0)
    } else {
        fallback
    }
}

impl Workspace {
    pub(in crate::workspace) fn forget_pane(&mut self, conversation: &str, cx: &mut Context<Self>) {
        self.git_views.remove(conversation);
        if let Some(pane) = self.panes.remove(conversation) {
            for tab in pane.tabs {
                self.pane_chat_inputs.remove(&tab.id);
                self.close_office(&tab.id, cx);
                self.web_views.remove(&tab.id);
                self.web_views
                    .remove(&super::super::pane_web::preview_key(&tab.id));
                if let Some(view) = self.terminals.remove(&tab.id)
                    && let (Some(session), Some(backend)) = (view.session, self.backend.clone())
                {
                    cx.spawn(async move |_, _| {
                        let _ = backend
                            .call::<fv_protocol::methods::TerminalKill>(
                                fv_protocol::types::TerminalIdParams { id: session.id },
                            )
                            .await;
                    })
                    .detach();
                }
            }
        }
        cx.notify();
    }

    pub(in crate::workspace) fn restore_panes(&mut self, storage: Storage) {
        let layout = storage.last.clone();
        self.browser_bookmarks = layout.browser_bookmarks.clone();
        self.browser_history = layout.browser_history.clone();
        self.side_pane_collapsed = layout.collapsed;
        self.side_pane_width = layout
            .width
            // The old fixed default was saved for every pane nobody had sized.
            .filter(|width| *width != super::DEFAULT_WIDTH)
            .map(|width| finite_width(width, super::DEFAULT_WIDTH).max(super::MIN_WIDTH));
        self.side_pane_maximized = layout.maximized;
        if self.selected.is_none() {
            self.selected = layout.selected;
        }
        for (conversation, pane) in layout.panes {
            // Edits made while the connection starts take precedence over the saved layout.
            if self.panes.contains_key(&conversation) {
                continue;
            }
            let (pane, terminals) = PaneState::recovered(pane);
            self.panes.insert(conversation, pane);
            for (id, session) in terminals {
                let connected = session.is_some();
                self.terminals.insert(
                    id.clone(),
                    super::super::pane_terminal::TerminalView {
                        session,
                        notice: (!connected).then(|| "原终端会话已结束".into()),
                        ..Default::default()
                    },
                );
            }
        }
        self.pane_storage = Some(storage);
    }

    fn pane_layout(&self, cx: &App) -> Layout {
        let panes = self
            .panes
            .iter()
            .map(|(id, pane)| {
                (
                    id.clone(),
                    pane.saved_layout(
                        |editor| editor.read(cx).value().to_string(),
                        |tab| self.terminals.get(tab).and_then(|v| v.session.clone()),
                    ),
                )
            })
            .collect::<BTreeMap<_, _>>();
        Layout {
            selected: self.selected.clone(),
            collapsed: self.side_pane_collapsed,
            width: self.side_pane_width,
            maximized: self.side_pane_maximized,
            browser_bookmarks: self.browser_bookmarks.clone(),
            browser_history: self.browser_history.clone(),
            panes,
            ..Default::default()
        }
    }

    /// Observe notifications rather than rendering: hidden files and editor changes must save too.
    pub(in crate::workspace) fn schedule_pane_save(&mut self, cx: &mut Context<Self>) {
        if self.pane_storage.is_none() || self.pane_save_pending {
            return;
        }
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        self.pane_save_pending = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(300))
                .await;
            let job = this
                .update(cx, |this, cx| {
                    let layout = this.pane_layout(cx);
                    let job = this
                        .pane_storage
                        .as_mut()
                        .and_then(|storage| storage.changed(&layout).then(|| storage.save(layout)));
                    if job.is_none() {
                        this.pane_save_pending = false;
                    }
                    job
                })
                .ok()
                .flatten();
            if let Some(job) = job {
                let serial = job.serial();
                let result = cx
                    .background_executor()
                    .spawn(async move { job.run() })
                    .await;
                this.update(cx, |this, cx| {
                    this.pane_save_pending = false;
                    if let Err(error) = result {
                        if this
                            .pane_storage
                            .as_ref()
                            .is_none_or(|s| !s.is_current(serial))
                        {
                            return;
                        }
                        // Retry the current layout on the next notification, and surface the failure.
                        if let Some(storage) = this.pane_storage.as_mut() {
                            storage.invalidate();
                        }
                        let message = tr!(
                            english,
                            "pane_persistence.could_not_save_workspace_recovery",
                            error = error
                        );
                        if this
                            .notice
                            .as_ref()
                            .is_none_or(|notice| notice.text() != message)
                        {
                            this.notice = Some(super::super::Notice::Failed(message));
                            cx.notify();
                        }
                    } else {
                        // One follow-up catches edits made during the write. Never queue multiple
                        // disk tasks behind a slow filesystem; an unchanged follow-up stops here.
                        this.schedule_pane_save(cx);
                    }
                })
                .ok();
            }
        })
        .detach();
    }

    pub(in crate::workspace) fn pane_save_job(&mut self, cx: &App) -> Option<saved::Save> {
        let layout = self.pane_layout(cx);
        Some(self.pane_storage.as_mut()?.save(layout))
    }

    pub(super) fn make_file_editor(
        &self,
        text: String,
        language: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<EditorState> {
        let editor = cx.new(|cx| {
            let mut editor = EditorState::new(window, cx).line_number(true);
            editor.set_value(text, window, cx);
            if let Some(language) = language {
                editor.set_highlighter(language, cx);
                editor.refresh(cx);
            }
            editor
        });
        cx.subscribe(&editor, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
        editor
    }

    pub(super) fn ensure_restored_pane(
        &mut self,
        conversation: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(state) = self.panes.get(conversation) else {
            return;
        };
        if state.editor.is_none()
            && let Some(preview) = state.preview.as_ref()
        {
            if let Some(text) = state.draft.clone().or_else(|| editable_text(preview)) {
                let language = match preview {
                    FilePreview::Text { language, .. } => language.clone(),
                    _ => None,
                };
                let editor = self.make_file_editor(text, language, window, cx);
                if let Some(state) = self.panes.get_mut(conversation) {
                    state.editor = Some(editor);
                    state.restoring = false;
                }
            }
        } else if state.show_preview
            && state.preview.is_none()
            && state.preview_loading.is_none()
            && let Some(PaneTab {
                kind: PaneTabKind::Files { path },
                ..
            }) = state.active_tab()
        {
            let path = path.clone();
            self.load_preview(path, window, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PaneState, PaneTabKind, saved};
    use fv_protocol::types::{FilePreview, FilePreviewKind, TerminalSession};

    #[test]
    fn recovery_keeps_tabs_expansion_active_and_parked_drafts_with_new_ids() {
        let dirty = |path: &str, text: &str| saved::TabKind::File {
            path: path.into(),
            file: saved::File {
                editing: true,
                showing: true,
                recovery: Some(saved::Recovery {
                    preview: FilePreview::Text {
                        path: path.into(),
                        name: "same.rs".into(),
                        kind: FilePreviewKind::Code,
                        language: Some("rust".into()),
                        text: "original".into(),
                    },
                    baseline: Some("original".into()),
                    text: text.into(),
                }),
            },
        };
        let pane = saved::Pane {
            tabs: vec![
                saved::Tab {
                    id: "a".into(),
                    title: "A".into(),
                    kind: dirty("/a/same.rs", "draft A"),
                },
                saved::Tab {
                    id: "b".into(),
                    title: "B".into(),
                    kind: dirty("/b/same.rs", "draft B"),
                },
                saved::Tab {
                    id: "git".into(),
                    title: "Git".into(),
                    kind: saved::TabKind::Git,
                },
                saved::Tab {
                    id: "terminal".into(),
                    title: "Terminal".into(),
                    kind: saved::TabKind::Terminal {
                        session: Some(TerminalSession {
                            id: "pty-1".into(),
                            cwd: "/b".into(),
                            cols: 80,
                            rows: 24,
                        }),
                    },
                },
            ],
            active: Some("b".into()),
            expanded: vec!["/a/src".into(), "/b/src".into()],
            tree_width: 250.0,
        };
        let (mut restored, terminals) = PaneState::recovered(pane);
        assert_eq!(restored.active_tab().unwrap().title, "B");
        assert_eq!(restored.draft.as_deref(), Some("draft B"));
        assert_eq!(restored.baseline.as_deref(), Some("original"));
        assert!(restored.expanded.contains("/a/src"));
        assert_eq!(restored.tree_width, 250.0);
        assert_eq!(terminals[0].1.as_ref().unwrap().id, "pty-1");
        assert!(
            restored
                .tabs
                .iter()
                .all(|t| !["a", "b", "git", "terminal"].contains(&t.id.as_str()))
        );
        restored.activate(restored.tabs[0].id.clone());
        assert_eq!(restored.draft.as_deref(), Some("draft A"));
        let saved = restored.saved_layout(|_| unreachable!(), |_| None);
        let (mut again, _) = PaneState::recovered(saved);
        again.activate(again.tabs[1].id.clone());
        assert_eq!(again.draft.as_deref(), Some("draft B"));
    }

    #[test]
    fn browser_recovery_keeps_order_owner_and_address_without_serializing_a_native_view() {
        let pane = saved::Pane {
            tabs: vec![
                saved::Tab {
                    id: "web-1".into(),
                    title: "Docs".into(),
                    kind: saved::TabKind::Browser {
                        url: "https://example.com/docs#native".into(),
                    },
                },
                saved::Tab {
                    id: "web-2".into(),
                    title: "Invalid".into(),
                    kind: saved::TabKind::Browser {
                        url: "file:///private/secret".into(),
                    },
                },
            ],
            active: Some("web-1".into()),
            expanded: Vec::new(),
            tree_width: 224.,
        };
        let bytes = serde_json::to_vec(&pane).unwrap();
        let (state, terminals) = PaneState::recovered(serde_json::from_slice(&bytes).unwrap());
        assert!(terminals.is_empty());
        assert!(
            matches!(&state.active_tab().unwrap().kind,PaneTabKind::Browser{url}if url=="https://example.com/docs#native")
        );
        assert!(matches!(&state.tabs[1].kind,PaneTabKind::Browser{url}if url=="about:blank"));
        let saved = state.saved_layout(|_| unreachable!(), |_| None);
        assert_eq!(saved.tabs.len(), 2);
        assert_eq!(saved.tabs[0].title, "Docs");
        assert!(
            !String::from_utf8(serde_json::to_vec(&saved).unwrap())
                .unwrap()
                .contains("private/secret")
        );
    }

    #[test]
    fn clean_files_reopen_from_server_and_invalid_selection_falls_back() {
        let (state, _) = PaneState::recovered(saved::Pane {
            tabs: vec![saved::Tab {
                id: "file".into(),
                title: "Clean".into(),
                kind: saved::TabKind::File {
                    path: "/clean".into(),
                    file: saved::File {
                        showing: true,
                        ..Default::default()
                    },
                },
            }],
            active: Some("missing".into()),
            expanded: vec![],
            tree_width: f32::NAN,
        });
        assert!(state.active_tab().is_some());
        assert!(state.show_preview);
        assert!(state.preview.is_none());
        assert!(state.tree_width.is_finite());
    }

    #[test]
    fn auxiliary_chat_tabs_round_trip_the_child_thread_id() {
        let pane = saved::Pane {
            tabs: vec![saved::Tab {
                id: "chat".into(),
                title: "辅助对话".into(),
                kind: saved::TabKind::Chat {
                    thread_id: "child-1".into(),
                },
            }],
            active: Some("chat".into()),
            expanded: Vec::new(),
            tree_width: 224.0,
        };
        let (state, terminals) = PaneState::recovered(pane);
        assert!(terminals.is_empty());
        assert!(matches!(
            &state.active_tab().unwrap().kind,
            PaneTabKind::Chat { thread_id } if thread_id == "child-1"
        ));
        let saved = state.saved_layout(|_| unreachable!(), |_| None);
        assert!(matches!(
            &saved.tabs[0].kind,
            saved::TabKind::Chat { thread_id } if thread_id == "child-1"
        ));
    }

    #[test]
    fn hidden_drafts_survive_recovery_and_saved_text_is_not_cached() {
        use super::{PaneTab, PaneTabKind};
        let mut state = PaneState {
            tabs: vec![PaneTab {
                id: "file".into(),
                title: "File".into(),
                kind: PaneTabKind::Files {
                    path: "/file.rs".into(),
                },
            }],
            active: Some("file".into()),
            preview: Some(FilePreview::Text {
                kind: FilePreviewKind::Code,
                path: "/file.rs".into(),
                name: "file.rs".into(),
                language: None,
                text: "old".into(),
            }),
            baseline: Some("old".into()),
            draft: Some("new".into()),
            show_preview: false,
            ..Default::default()
        };
        let (restored, _) = PaneState::recovered(state.saved_layout(|_| unreachable!(), |_| None));
        assert!(!restored.show_preview);
        assert_eq!(restored.draft.as_deref(), Some("new"));
        state.baseline = Some("new".into());
        let saved = state.saved_layout(|_| unreachable!(), |_| None);
        let saved::TabKind::File { file, .. } = &saved.tabs[0].kind else {
            panic!("file");
        };
        assert!(file.recovery.is_none());
    }

    #[test]
    fn invalid_recovery_cannot_put_another_files_bytes_in_a_tab() {
        let record = saved::Tab {
            id: "same-id".into(),
            title: "File".into(),
            kind: saved::TabKind::File {
                path: "/file.rs".into(),
                file: saved::File {
                    showing: true,
                    editing: false,
                    recovery: Some(saved::Recovery {
                        preview: FilePreview::Text {
                            kind: FilePreviewKind::Code,
                            path: "/different.rs".into(),
                            name: "different.rs".into(),
                            language: None,
                            text: "old".into(),
                        },
                        baseline: Some("old".into()),
                        text: "wrong draft".into(),
                    }),
                },
            },
        };
        let (state, _) = PaneState::recovered(saved::Pane {
            tabs: vec![record.clone(), record],
            active: Some("same-id".into()),
            expanded: vec![],
            tree_width: 200.0,
        });
        assert_eq!(state.tabs.len(), 1);
        assert!(state.preview.is_none());
        assert!(state.draft.is_none());
        assert!(state.show_preview);
    }
}
