//! File tree menus, dialogs and path changes. Child of pane so drafts stay with their tabs.
use super::*;
use crate::workspace::settings::{dialog_card, dialog_foot, dialog_head, modal};
use gpui_kit::component::input::{Input, InputEvent, InputState};

#[derive(Clone)]
pub(crate) struct EntryMenu {
    pub at: Point<Pixels>,
    pub root: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_root: bool,
}
#[derive(Clone, Copy)]
pub(crate) enum Intent {
    Create(EntryKind),
    Rename,
    Delete { permanent: bool },
}
pub(crate) struct EntryDialog {
    id: String,
    conversation: String,
    root: String,
    path: String,
    intent: Intent,
    name: Entity<InputState>,
    focus: FocusHandle,
    pub(in crate::workspace) busy: bool,
    error: Option<String>,
}

fn under(path: &str, base: &str) -> bool {
    std::path::Path::new(path).starts_with(base)
}
fn moved(path: &str, from: &str, to: &str) -> Option<String> {
    let tail = std::path::Path::new(path).strip_prefix(from).ok()?;
    if tail.as_os_str().is_empty() {
        return Some(to.to_string());
    }
    Some(std::path::Path::new(to).join(tail).display().to_string())
}
fn rename_preview(preview: &mut Option<FilePreview>, from: &str, to: &str) {
    let Some(preview) = preview else {
        return;
    };
    let (path, name) = match preview {
        FilePreview::Text { path, name, .. }
        | FilePreview::Media { path, name, .. }
        | FilePreview::Office { path, name, .. }
        | FilePreview::Unsupported { path, name, .. }
        | FilePreview::Binary { path, name, .. }
        | FilePreview::Table { path, name, .. }
        | FilePreview::Error { path, name, .. } => (path, name),
    };
    if let Some(next) = moved(path, from, to) {
        *name = std::path::Path::new(&next)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        *path = next;
    }
    if let FilePreview::Error {
        directory: Some(directory),
        ..
    } = preview
        && let Some(next) = moved(directory, from, to)
    {
        *directory = next;
    }
}

impl PaneState {
    fn entry_changed(&mut self, change: &WorkspaceEntryChange) {
        self.listing_epoch = self.listing_epoch.wrapping_add(1);
        self.loading.clear();
        self.preview_epoch = self.preview_epoch.wrapping_add(1);
        self.preview_loading = None;
        let from = &change.path;
        match change.kind {
            EntryChangeKind::Created => (),
            EntryChangeKind::Renamed => {
                let Some(entry) = &change.entry else {
                    return;
                };
                let to = &entry.path;
                self.expanded = self
                    .expanded
                    .drain()
                    .map(|path| moved(&path, from, to).unwrap_or(path))
                    .collect();
                self.listings = self
                    .listings
                    .drain()
                    .map(|(path, mut rows)| {
                        for row in &mut rows {
                            if let Some(next) = moved(&row.path, from, to) {
                                row.name = std::path::Path::new(&next)
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();
                                row.path = next;
                            }
                        }
                        (moved(&path, from, to).unwrap_or(path), rows)
                    })
                    .collect();
                for tab in &mut self.tabs {
                    if let PaneTabKind::Files { path } = &mut tab.kind
                        && let Some(next) = moved(path, from, to)
                    {
                        tab.title = std::path::Path::new(&next)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        *path = next;
                    }
                }
                rename_preview(&mut self.preview, from, to);
                for saved in self.saved_files.values_mut() {
                    rename_preview(&mut saved.preview, from, to);
                }
            }
            EntryChangeKind::Deleted => {
                self.expanded.retain(|path| !under(path, from));
                self.listings.retain(|path, _| !under(path, from));
                let removed: HashSet<_> = self
                    .tabs
                    .iter()
                    .filter_map(|tab| match &tab.kind {
                        PaneTabKind::Files { path } if under(path, from) => Some(tab.id.clone()),
                        _ => None,
                    })
                    .collect();
                self.tabs.retain(|tab| !removed.contains(&tab.id));
                self.saved_files.retain(|id, _| !removed.contains(id));
                if self.active.as_ref().is_some_and(|id| removed.contains(id)) {
                    self.active = None;
                    self.preview = None;
                    self.editor = None;
                    self.draft = None;
                    self.baseline = None;
                    if let Some(tab) = self.tabs.first() {
                        self.activate(tab.id.clone());
                    }
                }
            }
        }
        if let Some(parent) = std::path::Path::new(from).parent() {
            self.listings
                .retain(|known, _| std::path::Path::new(known) != parent);
        }
        if let Some(entry) = &change.entry
            && let Some(parent) = std::path::Path::new(&entry.path).parent()
        {
            self.listings
                .retain(|known, _| std::path::Path::new(known) != parent);
        }
    }
}

impl Workspace {
    pub(in crate::workspace) fn on_entry_changed(
        &mut self,
        change: &WorkspaceEntryChange,
        cx: &mut Context<Self>,
    ) {
        for state in self.panes.values_mut() {
            state.entry_changed(change);
        }
        if let Some((path, title)) = &mut self.pending_open {
            match change.kind {
                EntryChangeKind::Renamed => {
                    if let Some(entry) = &change.entry
                        && let Some(next) = moved(path, &change.path, &entry.path)
                    {
                        *title = std::path::Path::new(&next)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        *path = next;
                    }
                }
                EntryChangeKind::Deleted if under(path, &change.path) => self.pending_open = None,
                _ => (),
            }
        }
        // The selected repository is re-read too; an inactive tab will fetch when opened.
        if self
            .selected
            .as_ref()
            .is_some_and(|id| self.git_views.contains_key(id))
        {
            self.load_git_status(cx);
        }
        cx.notify();
    }

    pub(in crate::workspace) fn open_entry_menu(
        &mut self,
        menu: EntryMenu,
        cx: &mut Context<Self>,
    ) {
        self.close_menus(cx);
        self.entry_menu = Some(menu);
        cx.notify();
    }

    fn open_entry_dialog(
        &mut self,
        menu: EntryMenu,
        intent: Intent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_menus(cx);
        let path = if matches!(intent, Intent::Create(_)) && menu.kind == EntryKind::File {
            std::path::Path::new(&menu.path)
                .parent()
                .unwrap_or(std::path::Path::new(&menu.root))
                .display()
                .to_string()
        } else {
            menu.path
        };
        let initial = if matches!(intent, Intent::Rename) {
            std::path::Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        } else {
            String::new()
        };
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("名称 / Name"));
        name.update(cx, |state, cx| state.set_value(initial, window, cx));
        cx.subscribe_in(&name, window, |this, source, event: &InputEvent, _, cx| {
            if this
                .entry_dialog
                .as_ref()
                .is_none_or(|dialog| dialog.name.entity_id() != source.entity_id())
            {
                return;
            }
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.submit_entry(cx);
            }
            if matches!(event, InputEvent::Change)
                && let Some(dialog) = &mut this.entry_dialog
            {
                dialog.error = None;
                cx.notify();
            }
        })
        .detach();
        self.entry_dialog = Some(EntryDialog {
            id: new_tab_id(),
            conversation: self.selected.clone().unwrap_or_default(),
            root: menu.root,
            path,
            intent,
            name: name.clone(),
            focus: cx.focus_handle(),
            busy: false,
            error: None,
        });
        if !matches!(intent, Intent::Delete { .. }) {
            name.update(cx, |state, cx| state.focus(window, cx));
        } else if let Some(dialog) = &self.entry_dialog {
            dialog.focus.focus(window, cx);
        }
        cx.notify();
    }

    fn submit_entry(&mut self, cx: &mut Context<Self>) {
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let Some(dialog) = &mut self.entry_dialog else {
            return;
        };
        if dialog.busy {
            return;
        }
        let name = dialog.name.read(cx).value().trim().to_string();
        if !matches!(dialog.intent, Intent::Delete { .. }) && name.is_empty() {
            return;
        }
        let Some(backend) = self.backend.clone() else {
            dialog.error = Some(
                if english {
                    "Not connected to the server"
                } else {
                    "未连接到服务端"
                }
                .into(),
            );
            cx.notify();
            return;
        };
        dialog.busy = true;
        dialog.error = None;
        let (id, conversation, cwd, path, intent) = (
            dialog.id.clone(),
            dialog.conversation.clone(),
            dialog.root.clone(),
            dialog.path.clone(),
            dialog.intent,
        );
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = match intent {
                Intent::Create(kind) => backend
                    .call::<WorkspaceCreateEntry>(CreateEntryParams {
                        cwd,
                        path: path.clone(),
                        name,
                        kind,
                    })
                    .await
                    .map(Some),
                Intent::Rename => backend
                    .call::<WorkspaceRenameEntry>(RenameEntryParams {
                        cwd,
                        path: path.clone(),
                        name,
                    })
                    .await
                    .map(Some),
                Intent::Delete { permanent } => backend
                    .call::<WorkspaceDeleteEntry>(DeleteEntryParams {
                        cwd,
                        path: path.clone(),
                        permanent,
                    })
                    .await
                    .map(|_| None),
            };
            this.update(cx, |this, cx| {
                // The global notification carries path changes even to a dialog's old chat.
                // This response only closes its own dialog or opens the file just created.
                let current = this
                    .entry_dialog
                    .as_ref()
                    .is_some_and(|dialog| dialog.id == id);
                match result {
                    Ok(entry) => {
                        if current {
                            this.entry_dialog = None;
                        }
                        if let Intent::Create(_) = intent {
                            if let Some(state) = this.panes.get_mut(&conversation) {
                                state.expanded.insert(path);
                            }
                            if this.selected.as_deref() == Some(&conversation)
                                && let Some(entry) = entry.filter(|e| e.kind == EntryKind::File)
                            {
                                this.pending_open = Some((entry.path, entry.name));
                            }
                        }
                    }
                    Err(error) => {
                        if current && let Some(dialog) = &mut this.entry_dialog {
                            dialog.busy = false;
                            dialog.error = Some(if english {
                                format!("Operation failed: {error}")
                            } else {
                                error.to_string()
                            });
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(in crate::workspace) fn entry_menu_view(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let target = self.entry_menu.clone()?;
        let p = &self.palette;
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let at = crate::workspace::sidebar_actions::popup_origin(target.at, 184.0, 216.0, window);
        let mut menu = crate::workspace::settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(184.0));
        let mut actions = vec![
            (
                if english { "New file" } else { "新建文件" },
                Intent::Create(EntryKind::File),
            ),
            (
                if english {
                    "New folder"
                } else {
                    "新建文件夹"
                },
                Intent::Create(EntryKind::Directory),
            ),
        ];
        if !target.is_root {
            actions.extend([
                (if english { "Rename" } else { "重命名" }, Intent::Rename),
                (
                    if english {
                        "Move to Trash…"
                    } else {
                        "移到废纸篓…"
                    },
                    Intent::Delete { permanent: false },
                ),
                (
                    if english {
                        "Delete permanently…"
                    } else {
                        "永久删除…"
                    },
                    Intent::Delete { permanent: true },
                ),
            ]);
        }
        for (index, (label, intent)) in actions.into_iter().enumerate() {
            let target = target.clone();
            menu = menu.child(
                crate::workspace::settings::menu_item(
                    format!("entry-menu-{index}").into(),
                    false,
                    p.c(Token::Accent),
                )
                .child(label)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_entry_dialog(target.clone(), intent, window, cx)
                })),
            );
        }
        let path = if target.kind == EntryKind::Directory {
            target.path
        } else {
            std::path::Path::new(&target.path)
                .parent()?
                .display()
                .to_string()
        };
        menu = menu.child(
            crate::workspace::settings::menu_item(
                "entry-refresh".into(),
                false,
                p.c(Token::Accent),
            )
            .child(
                if self.app_settings.language == fv_protocol::types::UiLanguage::English {
                    "Refresh"
                } else {
                    "刷新"
                },
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.close_menus(cx);
                if let Some(state) = this.selected.as_ref().and_then(|id| this.panes.get_mut(id)) {
                    state.listings.remove(&path);
                    state.loading.clear();
                    state.listing_epoch = state.listing_epoch.wrapping_add(1);
                }
                this.load_dir(path.clone(), cx);
                cx.notify();
            })),
        );
        Some(crate::ui::float(menu).into_any_element())
    }

    pub(in crate::workspace) fn entry_dialog_view(
        &self,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let d = self.entry_dialog.as_ref()?;
        let p = &self.palette;
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let label = match d.intent {
            Intent::Create(EntryKind::File) => {
                if english {
                    "New file"
                } else {
                    "新建文件"
                }
            }
            Intent::Create(EntryKind::Directory) => {
                if english {
                    "New folder"
                } else {
                    "新建文件夹"
                }
            }
            Intent::Rename => {
                if english {
                    "Rename"
                } else {
                    "重命名"
                }
            }
            Intent::Delete { permanent: false } => {
                if english {
                    "Move to Trash"
                } else {
                    "移到废纸篓"
                }
            }
            Intent::Delete { permanent: true } => {
                if english {
                    "Delete permanently"
                } else {
                    "永久删除"
                }
            }
        };
        let deleting = matches!(d.intent, Intent::Delete { .. });
        let description = match d.intent {
            Intent::Delete { permanent: true } => {
                if english {
                    "The selected file or folder and its contents will be permanently deleted and cannot be restored from Trash. Related file tabs will close and unsaved edits will be discarded."
                } else {
                    "所选文件或文件夹及其内容将永久删除，无法从废纸篓恢复。相关文件标签会关闭，未保存的编辑也会丢弃。"
                }
            }
            Intent::Delete { permanent: false } => {
                if english {
                    "Move to the server computer's Trash. Related file tabs will close and unsaved edits will be discarded."
                } else {
                    "移到服务端电脑的废纸篓。相关文件标签会关闭，未保存的编辑也会丢弃。"
                }
            }
            _ => "",
        };
        let body = dialog_card(p, 432.0)
            .track_focus(&d.focus)
            .key_context("FileEntryDialog")
            .child(dialog_head(label, description, p))
            .child(
                div()
                    .px(px(20.0))
                    .pb(px(16.0))
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(ui::truncate(d.path.clone())),
                    )
                    .when(!deleting, |col| col.child(Input::new(&d.name)))
                    .when_some(d.error.clone(), |col, error| {
                        col.child(
                            div()
                                .text_size(px(TEXT_SM))
                                .text_color(p.c(Token::Destructive))
                                .child(SharedString::from(error)),
                        )
                    }),
            )
            .child(dialog_foot(
                p,
                cx,
                |this, cx| {
                    if this
                        .entry_dialog
                        .as_ref()
                        .is_some_and(|dialog| !dialog.busy)
                    {
                        this.entry_dialog = None;
                    }
                    cx.notify();
                },
                if d.busy {
                    if english {
                        "Working…"
                    } else {
                        "正在处理…"
                    }
                } else {
                    label
                },
                |this, _, cx| this.submit_entry(cx),
                d.busy || (!deleting && d.name.read(cx).value().trim().is_empty()),
            ));
        Some(modal(body, p, cx, |this| {
            if this
                .entry_dialog
                .as_ref()
                .is_some_and(|dialog| !dialog.busy)
            {
                this.entry_dialog = None;
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{FileViewState, PaneState, PaneTab, PaneTabKind, preview_path, rename_preview};
    use fv_protocol::types::{
        DirEntry, EntryChangeKind, EntryKind, FilePreview, FilePreviewKind, WorkspaceEntryChange,
    };
    fn preview(path: &str, text: &str) -> Option<FilePreview> {
        Some(FilePreview::Text {
            kind: FilePreviewKind::Code,
            path: path.into(),
            name: std::path::Path::new(path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            language: None,
            text: text.into(),
        })
    }
    fn tab(id: &str, path: &str) -> PaneTab {
        PaneTab {
            id: id.into(),
            title: id.into(),
            kind: PaneTabKind::Files { path: path.into() },
        }
    }
    fn renamed() -> WorkspaceEntryChange {
        WorkspaceEntryChange {
            cwd: "/repo".into(),
            path: "/repo/dir".into(),
            kind: EntryChangeKind::Renamed,
            entry: Some(DirEntry {
                name: "renamed".into(),
                path: "/repo/renamed".into(),
                kind: EntryKind::Directory,
            }),
        }
    }
    #[test]
    fn directory_renames_move_active_and_parked_drafts_and_expanded_children() {
        let mut state = PaneState {
            tabs: vec![
                tab("a", "/repo/dir/a.rs"),
                tab("b", "/repo/dir/nested/b.rs"),
                tab("sibling", "/repo/directory/c.rs"),
            ],
            active: Some("a".into()),
            preview: preview("/repo/dir/a.rs", "original"),
            draft: Some("unsaved active".into()),
            baseline: Some("original".into()),
            ..Default::default()
        };
        state.saved_files.insert(
            "b".into(),
            FileViewState {
                preview: preview("/repo/dir/nested/b.rs", "old"),
                draft: Some("unsaved parked".into()),
                ..Default::default()
            },
        );
        state.expanded.extend([
            "/repo/dir".into(),
            "/repo/dir/nested".into(),
            "/repo/directory".into(),
        ]);
        state.listings.insert(
            "/repo/dir/nested".into(),
            vec![DirEntry {
                name: "b.rs".into(),
                path: "/repo/dir/nested/b.rs".into(),
                kind: EntryKind::File,
            }],
        );
        state.entry_changed(&renamed());
        assert_eq!(
            preview_path(state.preview.as_ref()).as_deref(),
            Some("/repo/renamed/a.rs")
        );
        assert_eq!(state.draft.as_deref(), Some("unsaved active"));
        assert_eq!(
            state.saved_files["b"].draft.as_deref(),
            Some("unsaved parked")
        );
        assert_eq!(
            preview_path(state.saved_files["b"].preview.as_ref()).as_deref(),
            Some("/repo/renamed/nested/b.rs")
        );
        assert!(state.expanded.contains("/repo/renamed/nested"));
        assert!(!state.expanded.contains("/repo/dir"));
        assert_eq!(
            state.listings["/repo/renamed/nested"][0].path,
            "/repo/renamed/nested/b.rs"
        );
        assert_eq!(
            state.tabs[2].kind,
            PaneTabKind::Files {
                path: "/repo/directory/c.rs".into()
            }
        );
    }
    #[test]
    fn deletion_closes_only_descendants_and_drops_their_drafts_not_a_similar_prefix() {
        let mut state = PaneState {
            tabs: vec![tab("a", "/repo/dir/a.rs"), tab("b", "/repo/directory/b.rs")],
            active: Some("a".into()),
            preview: preview("/repo/dir/a.rs", "old"),
            draft: Some("discard after confirmation".into()),
            ..Default::default()
        };
        state.saved_files.insert(
            "b".into(),
            FileViewState {
                preview: preview("/repo/directory/b.rs", "keep"),
                draft: Some("keep draft".into()),
                ..Default::default()
            },
        );
        state.entry_changed(&WorkspaceEntryChange {
            cwd: "/repo".into(),
            path: "/repo/dir".into(),
            kind: EntryChangeKind::Deleted,
            entry: None,
        });
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.active.as_deref(), Some("b"));
        assert_eq!(state.draft.as_deref(), Some("keep draft"));
        assert_eq!(
            preview_path(state.preview.as_ref()).as_deref(),
            Some("/repo/directory/b.rs")
        );
    }
    #[test]
    fn a_renamed_file_has_no_trailing_separator_and_changes_its_display_name() {
        let mut value = preview("/repo/old.rs", "data");
        rename_preview(&mut value, "/repo/old.rs", "/repo/new.rs");
        assert_eq!(
            preview_path(value.as_ref()).as_deref(),
            Some("/repo/new.rs")
        );
        assert!(
            matches!(value, Some(FilePreview::Text { name, text, .. }) if name == "new.rs" && text == "data")
        );
    }
}
