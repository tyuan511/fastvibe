//! Conversation-owned browser tabs and native document previews. Pages have no IPC
//! bridge. Native children are hidden whenever a GPUI menu/modal covers the workspace.
use super::{
    Workspace,
    pane::{PaneTab, PaneTabKind, new_tab_id},
};
use crate::{
    ui::{Muted as _, TEXT_XS, icon_button_xs},
    web_content::Document,
    webview::{Surface, WebEvent},
};
use fv_protocol::types::{FilePreview, FilePreviewKind};
use gpui_kit::{
    component::{
        Sizable as _,
        input::{Input, InputEvent, InputState},
    },
    *,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

pub(super) struct ContentView {
    pub surface: Surface,
    signature: u64,
    pub url: String,
    address: Option<Entity<InputState>>,
    pub loading: bool,
    pub notice: Option<String>,
    browser: bool,
    external: Option<String>,
}
pub(super) fn live_key(tab: &str) -> String {
    format!("office-live:{tab}")
}
pub(super) fn preview_key(tab: &str) -> String {
    format!("preview:{tab}")
}
fn signature(path: &str, text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    text.hash(&mut h);
    h.finish()
}
pub(super) fn promote_draft(
    panes: &mut std::collections::HashMap<String, super::pane::PaneState>,
    id: &str,
) {
    if !panes.contains_key(id)
        && let Some(draft) = panes.remove("__draft__")
    {
        panes.insert(id.into(), draft);
    }
}
impl Workspace {
    pub(super) fn native_views_allowed(&self) -> bool {
        !self.side_pane_collapsed
            && !self.web_drag_blocked
            && self.side_pane_resize.is_none()
            && self.sidebar_resize.is_none()
            && self.pane_tree_resize.is_none()
            && self.settings.is_none()
            && !self.schedules_ui.open
            && self.search_box.is_none()
            && self.project_dialog.is_none()
            && self.entry_dialog.is_none()
            && !self.any_menu_open()
    }
    pub(super) fn prepare_web_views(&mut self, cx: &mut Context<Self>) {
        let live = self
            .panes
            .values()
            .flat_map(|p| p.tabs.iter().map(|t| t.id.clone()))
            .collect::<std::collections::HashSet<_>>();
        let closed = self
            .office_views
            .keys()
            .filter(|key| !live.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        for tab in closed {
            self.close_office(&tab, cx);
        }
        self.web_views.retain(|key, _| {
            live.contains(key)
                || key
                    .strip_prefix("preview:")
                    .is_some_and(|id| live.contains(id))
        });
        let active = self
            .native_views_allowed()
            .then(|| {
                let pane = self
                    .panes
                    .get(self.selected.as_deref().unwrap_or("__draft__"))?;
                let tab = pane.active_tab()?;
                match &tab.kind {
                    PaneTabKind::Browser { .. } => Some(tab.id.clone()),
                    PaneTabKind::Files { .. } if pane.show_preview => match &pane.preview {
                        Some(FilePreview::Text {
                            kind: FilePreviewKind::Html,
                            ..
                        }) if !pane.editing => Some(preview_key(&tab.id)),
                        Some(FilePreview::Media { .. }) => Some(preview_key(&tab.id)),
                        Some(FilePreview::Office { .. }) => Some(
                            if self.office_views.get(&tab.id).is_some_and(|v| v.live_ready) {
                                live_key(&tab.id)
                            } else {
                                preview_key(&tab.id)
                            },
                        ),
                        _ => None,
                    },
                    _ => None,
                }
            })
            .flatten();
        for (key, view) in &mut self.web_views {
            if Some(key) != active.as_ref() {
                view.surface.hide();
            }
        }
    }
    pub(super) fn open_browser_tab(&mut self, owner: &str, url: &str, cx: &mut Context<Self>) {
        let requested = if url == "about:blank" {
            &self.app_settings.browser_homepage
        } else {
            url
        };
        let url = match crate::webview::address_with_search(
            requested,
            &self.app_settings.browser_search_engine,
        ) {
            Ok(url) => url,
            Err(_) => return,
        };
        let state = self.panes.entry(owner.into()).or_default();
        if state
            .tabs
            .iter()
            .filter(|t| matches!(t.kind, PaneTabKind::Browser { .. }))
            .count()
            >= 32
        {
            state.notice = Some("一个对话最多打开 32 个浏览器标签".into());
            cx.notify();
            return;
        }
        let id = new_tab_id();
        state.tabs.push(PaneTab {
            id: id.clone(),
            title: "浏览器".into(),
            kind: PaneTabKind::Browser { url },
        });
        state.activate(id);
        cx.notify();
    }
    fn web_events(
        &self,
        key: String,
        signature: u64,
        mut rx: tokio::sync::mpsc::UnboundedReceiver<WebEvent>,
        cx: &mut Context<Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Some(event) = rx.recv().await {
                if this
                    .update(cx, |this, cx| {
                        if this
                            .web_views
                            .get(&key)
                            .is_none_or(|v| v.signature != signature)
                        {
                            return false;
                        }
                        this.web_event(&key, event, cx);
                        true
                    })
                    .ok()
                    != Some(true)
                {
                    break;
                }
            }
        })
        .detach();
    }
    fn web_event(&mut self, key: &str, event: WebEvent, cx: &mut Context<Self>) {
        let Some(view) = self.web_views.get_mut(key) else {
            return;
        };
        match event {
            WebEvent::Location(url) if view.browser => {
                if let Ok(url) = crate::webview::address(&url) {
                    view.url = url.clone();
                    view.surface.remember_location(&url);
                    for pane in self.panes.values_mut() {
                        if let Some(tab) = pane.tabs.iter_mut().find(|t| t.id == key) {
                            tab.kind = PaneTabKind::Browser { url: url.clone() };
                        }
                    }
                }
            }
            WebEvent::Title(title) if view.browser => {
                if !title.trim().is_empty() {
                    for pane in self.panes.values_mut() {
                        if let Some(tab) = pane.tabs.iter_mut().find(|t| t.id == key) {
                            tab.title = title.clone();
                        }
                    }
                }
            }
            WebEvent::Loading(loading) => {
                view.loading = loading;
                if let Some(tab) = key.strip_prefix("office-live:")
                    && let Some(office) = self.office_views.get_mut(tab)
                    && loading
                {
                    office.live_ready = false;
                }
            }
            WebEvent::DocumentReady => {
                if let Some(tab) = key.strip_prefix("office-live:")
                    && let Some(office) = self.office_views.get_mut(tab)
                {
                    office.live_ready = true;
                }
            }
            WebEvent::Notice(text) => view.notice = Some(text),
            WebEvent::External(url) => view.external = fv_core::safe_web_url(&url),
            WebEvent::Crashed => {
                view.loading = false;
                view.surface.hide();
                view.surface.error = Some("网页进程已退出，请重试".into());
                if let Some(tab) = key.strip_prefix("office-live:")
                    && let Some(office) = self.office_views.get_mut(tab)
                {
                    office.live_ready = false;
                    office.url = None;
                    office.watch_error = Some("网页进程已退出，请刷新文档预览".into());
                }
            }
            WebEvent::Popup(url) => {
                if let Some(owner) = self
                    .panes
                    .iter()
                    .find(|(_, p)| p.tabs.iter().any(|t| t.id == key))
                    .map(|(id, _)| id.clone())
                {
                    self.open_browser_tab(&owner, &url, cx);
                }
            }
            _ => (),
        }
        cx.notify();
    }
    fn navigate_browser(&mut self, key: &str, value: &str, cx: &mut Context<Self>) {
        match crate::webview::address_with_search(value, &self.app_settings.browser_search_engine) {
            Ok(url) => {
                if let Some(view) = self.web_views.get_mut(key) {
                    match view.surface.navigate(&url) {
                        Ok(()) => {
                            view.url = url.clone();
                            for pane in self.panes.values_mut() {
                                if let Some(tab) = pane.tabs.iter_mut().find(|t| t.id == key) {
                                    tab.kind = PaneTabKind::Browser { url: url.clone() };
                                }
                            }
                            view.loading = true;
                            view.notice = None;
                        }
                        Err(error) => view.notice = Some(error),
                    }
                }
            }
            Err(error) => {
                if let Some(view) = self.web_views.get_mut(key) {
                    view.notice = Some(error);
                }
            }
        }
        cx.notify();
    }
    fn web_command(&mut self, key: &str, command: &str, cx: &mut Context<Self>) {
        if let Some(view) = self.web_views.get_mut(key) {
            if let Err(error) = view.surface.command(command) {
                view.notice = Some(error);
            }
            if command == "stop" {
                view.loading = false;
            }
        }
        cx.notify();
    }
    pub(super) fn on_browser_address(
        &mut self,
        _: &super::BrowserAddress,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .and_then(|p| p.active_tab())
            .filter(|t| matches!(t.kind, PaneTabKind::Browser { .. }))
            .map(|t| t.id.clone());
        if self.settings.is_some() || self.schedules_ui.open || self.side_pane_collapsed {
            return;
        }
        if let Some(view) = key.as_ref().and_then(|key| self.web_views.get_mut(key)) {
            let _ = view.surface.command("focus_parent");
            if let Some(input) = view.address.clone() {
                input.update(cx, |input, cx| input.focus(window, cx));
            }
        }
    }
    pub(super) fn on_browser_reload(
        &mut self,
        _: &super::BrowserReload,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() || self.schedules_ui.open || self.side_pane_collapsed {
            return;
        }
        let key = self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .and_then(|p| p.active_tab())
            .filter(|t| matches!(t.kind, PaneTabKind::Browser { .. }))
            .map(|t| t.id.clone());
        if let Some(key) = key {
            self.web_command(&key, "reload", cx);
        }
    }
    pub(super) fn browser_body(
        &mut self,
        id: &str,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if !self.web_views.contains_key(id) {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            self.web_views.insert(
                id.into(),
                ContentView {
                    surface: Surface::browser(
                        url.into(),
                        tx,
                        crate::webview::download_directory(&self.app_settings.browser_download_dir),
                    ),
                    signature: 0,
                    url: url.into(),
                    address: None,
                    loading: false,
                    notice: None,
                    browser: true,
                    external: None,
                },
            );
            self.web_events(id.into(), 0, rx, cx);
        }
        if self.web_views[id].address.is_none() {
            let address = cx.new(|cx| InputState::new(window, cx).placeholder("输入网址或搜索"));
            let key = id.to_string();
            cx.subscribe(&address, move |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    let value = input.read(cx).value().to_string();
                    this.navigate_browser(&key, &value, cx);
                }
            })
            .detach();
            self.web_views.get_mut(id).unwrap().address = Some(address);
        }
        let view = &self.web_views[id];
        let address = view.address.clone().unwrap();
        if !address.read(cx).focus_handle(cx).is_focused(window)
            && address.read(cx).value().as_ref() != view.url
        {
            let value = if view.url == "about:blank" {
                ""
            } else {
                &view.url
            };
            address.update(cx, |input, cx| input.set_value(value, window, cx));
        }
        let loading = view.loading;
        let current = view.url.clone();
        let notice = view.notice.clone();
        let p = self.palette.clone();
        let mut toolbar = div()
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(6.))
            .h(px(38.))
            .flex_none()
            .border_b_1()
            .border_color(p.c(fv_theme::Token::Border));
        for (command, glyph, label) in [
            ("back", "arrow-left01", "后退"),
            ("forward", "arrow-right01", "前进"),
            (
                if loading { "stop" } else { "reload" },
                if loading { "cancel01" } else { "refresh" },
                if loading {
                    "停止加载"
                } else {
                    "重新加载"
                },
            ),
        ] {
            let key = id.to_string();
            toolbar = toolbar.child(
                icon_button_xs(
                    SharedString::from(format!("browser-{id}-{command}")),
                    glyph,
                    &p,
                )
                .aria_label(label)
                .on_click(cx.listener(move |this, _, _, cx| this.web_command(&key, command, cx))),
            );
        }
        toolbar = toolbar.child(div().flex_1().min_w_0().child(Input::new(&address).small()));
        toolbar = toolbar.child(
            icon_button_xs("browser-external", "link-square02", &p)
                .aria_label("在系统浏览器中打开")
                .on_click(move |_, _, cx| {
                    if let Some(url) = fv_core::safe_web_url(&current) {
                        cx.open_url(&url);
                    }
                }),
        );
        let surface = self.web_surface(id, cx);
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .children(notice.map(|text| {
                div()
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .child(text)
            }))
            .child(div().flex_1().min_h_0().w_full().child(surface))
            .into_any_element()
    }
    pub(super) fn document_body(
        &mut self,
        path: &str,
        text: Option<&str>,
        mime: Option<&str>,
        revision: Option<&str>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let tab = self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .and_then(|p| p.active.clone());
        let Some(tab) = tab else {
            return div().into_any_element();
        };
        let key = preview_key(&tab);
        let sig = signature(path, revision.or(text).or(mime).unwrap_or(""));
        if self.web_views.get(&key).is_none_or(|v| v.signature != sig) {
            let document = if let Some(text) = text {
                Ok(Document::Html(text.into()))
            } else {
                Document::media(path, mime.unwrap_or("")).map_err(|e| format!("无法读取预览：{e}"))
            };
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let surface = document.and_then(|document| Surface::document(document, tx));
            match surface {
                Ok(surface) => {
                    self.web_views.insert(
                        key.clone(),
                        ContentView {
                            surface,
                            signature: sig,
                            url: String::new(),
                            address: None,
                            loading: false,
                            notice: None,
                            browser: false,
                            external: None,
                        },
                    );
                    self.web_events(key.clone(), sig, rx, cx);
                }
                Err(error) => return div().p(px(12.)).child(error).into_any_element(),
            }
        }
        let surface = self.web_surface(&key, cx);
        let external = self.web_views.get(&key).and_then(|v| v.external.clone());
        div()
            .size_full()
            .flex()
            .flex_col()
            .children(external.map(|url| {
                div()
                    .id("preview-external-link")
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(TEXT_XS))
                    .cursor_pointer()
                    .child("在系统浏览器中打开链接")
                    .on_click(move |_, _, cx| cx.open_url(&url))
            }))
            .child(div().flex_1().min_h_0().child(surface))
            .into_any_element()
    }
    pub(super) fn live_document_body(
        &mut self,
        tab: &str,
        url: &str,
        ready: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = live_key(tab);
        let sig = signature(url, "");
        if self.web_views.get(&key).is_none_or(|v| v.signature != sig) {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            match Surface::live(url.into(), tx) {
                Ok(surface) => {
                    self.web_views.insert(
                        key.clone(),
                        ContentView {
                            surface,
                            signature: sig,
                            url: url.into(),
                            address: None,
                            loading: true,
                            notice: None,
                            browser: false,
                            external: None,
                        },
                    );
                    self.web_events(key.clone(), sig, rx, cx);
                }
                Err(error) => return div().child(error).into_any_element(),
            }
        }
        if ready {
            return self.web_surface(&key, cx);
        }
        let workspace = cx.entity().downgrade();
        canvas(
            move |bounds, window, cx| {
                let clip = window.content_mask().bounds;
                workspace
                    .update(cx, |this, cx| {
                        if !this.native_views_allowed() {
                            return;
                        }
                        if let Some(view) = this.web_views.get_mut(&key) {
                            let had_error = view.surface.error.is_some();
                            view.surface.preload(bounds, clip, window);
                            if !had_error && let Some(error) = view.surface.error.clone() {
                                if let Some(tab) = key.strip_prefix("office-live:")
                                    && let Some(office) = this.office_views.get_mut(tab)
                                {
                                    office.url = None;
                                    office.live_ready = false;
                                    office.watch_error = Some(error);
                                }
                                cx.notify();
                            }
                        }
                    })
                    .ok();
            },
            |_, _, _, _| {},
        )
        .size_full()
        .into_any_element()
    }
    fn web_surface(&self, key: &str, cx: &mut Context<Self>) -> AnyElement {
        if let Some(error) = self
            .web_views
            .get(key)
            .and_then(|v| v.surface.error.clone())
        {
            let key = key.to_string();
            return div()
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .text_size(px(TEXT_XS))
                .child(error)
                .child(
                    div()
                        .id("web-retry")
                        .cursor_pointer()
                        .child("重试")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(view) = this.web_views.get_mut(&key) {
                                view.surface.retry();
                            }
                            cx.notify();
                        })),
                )
                .into_any_element();
        }
        let key = key.to_string();
        let workspace = cx.entity().downgrade();
        canvas(
            move |bounds, window, cx| {
                let clip = window.content_mask().bounds;
                workspace
                    .update(cx, |this, cx| {
                        if !this.native_views_allowed() {
                            return;
                        }
                        if let Some(view) = this.web_views.get_mut(&key) {
                            let had_error = view.surface.error.is_some();
                            view.surface.place(bounds, clip, window);
                            if !had_error && view.surface.error.is_some() {
                                cx.notify();
                            }
                        }
                    })
                    .ok();
            },
            |_, _, _, _| {},
        )
        .size_full()
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{PaneTab, PaneTabKind, promote_draft};
    #[test]
    fn a_browser_opened_before_the_first_message_moves_to_its_new_conversation() {
        let mut pane = super::super::pane::PaneState::default();
        pane.tabs.push(PaneTab {
            id: "web".into(),
            title: "Docs".into(),
            kind: PaneTabKind::Browser {
                url: "https://example.com".into(),
            },
        });
        pane.activate("web".into());
        let mut panes = std::collections::HashMap::from([("__draft__".into(), pane)]);
        promote_draft(&mut panes, "created-chat");
        assert!(!panes.contains_key("__draft__"));
        assert_eq!(panes["created-chat"].active.as_deref(), Some("web"));
        promote_draft(&mut panes, "other-chat");
        assert!(!panes.contains_key("other-chat"));
        assert_eq!(panes["created-chat"].tabs.len(), 1);
    }
}
