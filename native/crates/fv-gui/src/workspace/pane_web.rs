//! Conversation-owned browser tabs and native document previews. Pages have no IPC
//! bridge. Native children are hidden whenever a GPUI menu/modal covers the workspace.
use super::{
    Workspace,
    pane::{PaneTab, PaneTabKind, new_tab_id},
};
use crate::ui::px;
use crate::{
    ui::{self, Muted as _, TEXT_XS, icon_button_xs},
    web_content::Document,
    webview::{Surface, WebEvent},
};
use fv_protocol::types::{FilePreview, FilePreviewKind, UiLanguage};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    component::input::{InputEvent, InputState},
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
    /// Set once WebKit commits the page being navigated to.
    committed: bool,
    /// Page zoom of this tab (1.0 is 100%).
    pub(super) zoom: f64,
    can_back: bool,
    can_forward: bool,
    external: Option<String>,
    pub(super) controls: super::browser_controls::BrowserControls,
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
    fn record_browser_history(&mut self, url: &str, cx: &mut Context<Self>) {
        if url == "about:blank" || fv_core::safe_web_url(url).is_none() {
            return;
        }
        if self
            .browser_history
            .last()
            .is_some_and(|entry| entry.url == url)
        {
            return;
        }
        self.browser_history.push(crate::pane_layout::HistoryEntry {
            title: url.to_string(),
            url: url.to_string(),
            visited_at: chrono::Utc::now().timestamp_millis(),
        });
        if self.browser_history.len() > 500 {
            let excess = self.browser_history.len() - 500;
            self.browser_history.drain(..excess);
        }
        self.schedule_pane_save(cx);
    }

    pub(super) fn toggle_browser_bookmark(
        &mut self,
        url: &str,
        title: &str,
        cx: &mut Context<Self>,
    ) {
        if let Some(index) = self.browser_bookmarks.iter().position(|b| b.url == url) {
            self.browser_bookmarks.remove(index);
        } else if fv_core::safe_web_url(url).is_some() {
            self.browser_bookmarks.push(crate::pane_layout::Bookmark {
                title: if title.trim().is_empty() {
                    url.to_string()
                } else {
                    title.chars().take(160).collect()
                },
                url: url.to_string(),
            });
            if self.browser_bookmarks.len() > 200 {
                self.browser_bookmarks.remove(0);
            }
        }
        self.schedule_pane_save(cx);
        cx.notify();
    }

    pub(super) fn browser_menu_in_native_layer(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.browser_menu.is_some() && self.web_menu_layer.is_some()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }
    #[cfg(not(target_os = "macos"))]
    pub(super) fn open_browser_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_settings(super::settings::Section::Browser, window, cx);
    }
    /// Whether a native page may be on screen. A splitter drag is not a reason to hide it: AppKit
    /// sends every dragged event to the view the button went down in, so the page cannot take the
    /// drag, and hiding it blanked the pane for the whole drag, which read as the page re-rendering.
    pub(super) fn native_views_allowed(&self) -> bool {
        !self.side_pane_collapsed
            && !self.web_drag_blocked
            && self.settings.is_none()
            && !self.schedules_ui.open
            && self.search_box.is_none()
            && self.project_dialog.is_none()
            && self.entry_dialog.is_none()
            && (!self.any_menu_open() || self.browser_menu_in_native_layer())
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
        let english = self.app_settings.language == UiLanguage::English;
        let state = self.panes.entry(owner.into()).or_default();
        if state
            .tabs
            .iter()
            .filter(|t| matches!(t.kind, PaneTabKind::Browser { .. }))
            .count()
            >= 32
        {
            state.notice = Some(trs!(english, "pane_web.a_chat_can_have_at").into());
            cx.notify();
            return;
        }
        let id = new_tab_id();
        state.tabs.push(PaneTab {
            id: id.clone(),
            title: trs!(english, "pane_web.browser").into(),
            kind: PaneTabKind::Browser { url },
        });
        state.activate(id);
        cx.notify();
    }
    /// The capture fixture: the right pane open on a browser tab at the homepage.
    pub fn open_browser_for_fixture(&mut self, cx: &mut Context<Self>) {
        let Some(conversation) = self.selected.clone() else {
            return;
        };
        self.side_pane_collapsed = false;
        let url = std::env::var("FV_FIXTURE_URL").unwrap_or_else(|_| "https://example.com".into());
        self.open_browser_tab(&conversation, &url, cx);
        // `FV_FIXTURE_BROWSER_MENU=1` also opens the ⋯ menu, and a bookmark gives its star a state.
        if std::env::var_os("FV_FIXTURE_BROWSER_MENU").is_some()
            && let Some(tab) = self.panes.get(&conversation).and_then(|p| p.active.clone())
        {
            self.browser_bookmarks.push(crate::pane_layout::Bookmark {
                title: "Example".into(),
                url: "https://example.com/".into(),
            });
            self.browser_history.push(crate::pane_layout::HistoryEntry {
                title: "Example Domain".into(),
                url: "https://example.com/".into(),
                visited_at: 1,
            });
            self.browser_menu = Some((
                gpui_kit::point(gpui_kit::px(1180.0), gpui_kit::px(96.0)),
                tab,
            ));
        }
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
        let english = self.app_settings.language == UiLanguage::English;
        if let WebEvent::Shortcut(command) = &event {
            self.browser_shortcut(key, command, cx);
            return;
        }
        let history_url = match &event {
            WebEvent::Location(url) if self.web_views.get(key).is_some_and(|view| view.browser) => {
                Some(url.clone())
            }
            _ => None,
        };
        let Some(view) = self.web_views.get_mut(key) else {
            return;
        };
        match event {
            WebEvent::Location(url) if view.browser => {
                if let Ok(url) = crate::webview::address(&url) {
                    if view.url != url {
                        view.controls.picking = false;
                        view.controls.found = None;
                    }
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
                    if let Some(entry) = self
                        .browser_history
                        .iter_mut()
                        .rev()
                        .find(|e| e.url == view.url)
                    {
                        entry.title = title.clone();
                    }
                    for pane in self.panes.values_mut() {
                        if let Some(tab) = pane.tabs.iter_mut().find(|t| t.id == key) {
                            tab.title = title.clone();
                        }
                    }
                }
            }
            WebEvent::Loading(loading) => {
                view.loading = loading;
                view.committed |= loading;
                (view.can_back, view.can_forward) = view.surface.can_go();
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
            WebEvent::Cleared => {
                view.notice = Some(trs!(english, "browser.cleared").into());
                let _ = view.surface.command("reload");
            }
            WebEvent::Found(found) => view.controls.found = Some(found),
            WebEvent::Captured(result) => {
                view.controls.capturing = false;
                view.notice = Some(match result {
                    Ok(path) => tr!(english, "browser.capture_saved", path = path.display()),
                    Err(e) => e,
                });
            }
            WebEvent::DownloadChanged(download) => {
                let start = download.complete.is_none() && !download.paused;
                if let Some(row) = self
                    .browser_services
                    .downloads
                    .iter_mut()
                    .find(|d| d.id == download.id)
                {
                    *row = download;
                } else {
                    self.browser_services.downloads.push(download);
                }
                if start && !view.controls.polling_downloads {
                    view.controls.polling_downloads = true;
                    self.poll_browser_downloads(key, cx);
                }
            }
            WebEvent::Notice(text) => view.notice = Some(text),
            WebEvent::External(url) => view.external = fv_core::safe_web_url(&url),
            WebEvent::Crashed => {
                view.loading = false;
                view.surface.hide();
                view.surface.error =
                    Some(trs!(english, "pane_web.the_web_process_exited_retry").into());
                if let Some(tab) = key.strip_prefix("office-live:")
                    && let Some(office) = self.office_views.get_mut(tab)
                {
                    office.live_ready = false;
                    office.url = None;
                    office.watch_error =
                        Some(trs!(english, "pane_web.the_web_process_exited_refresh").into());
                }
            }
            WebEvent::Popup(url) => self.navigate_browser(key, &url, cx),
            _ => (),
        }
        if let Some(url) = history_url {
            self.record_browser_history(&url, cx);
        }
        self.schedule_pane_save(cx);
        cx.notify();
    }
    pub(super) fn navigate_browser(&mut self, key: &str, value: &str, cx: &mut Context<Self>) {
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
                            // WebKit reports a start only once the server answers, so a
                            // failed connection is otherwise a spinner that never ends.
                            let (key, target) = (key.to_string(), url.clone());
                            let english = self.app_settings.language == UiLanguage::English;
                            cx.spawn(async move |this, cx| {
                                cx.background_executor()
                                    .timer(std::time::Duration::from_secs(20))
                                    .await;
                                this.update(cx, |this, cx| {
                                    if let Some(view) = this.web_views.get_mut(&key)
                                        && view.loading
                                        && !view.committed
                                        && view.url == target
                                    {
                                        view.loading = false;
                                        view.notice = Some(
                                            trs!(english, "pane_web.page_did_not_start_loading")
                                                .into(),
                                        );
                                        cx.notify();
                                    }
                                })
                                .ok();
                            })
                            .detach();
                            view.committed = false;
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
    const ZOOM_STEPS: [f64; 15] = [
        0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 5.0,
    ];

    /// `step` of -1/+1 moves to the neighbouring zoom level, 0 goes back to 100%.
    pub(super) fn browser_zoom(&mut self, key: &str, step: i32, cx: &mut Context<Self>) {
        let Some(view) = self.web_views.get_mut(key) else {
            return;
        };
        let at = Self::ZOOM_STEPS
            .iter()
            .position(|z| (*z - view.zoom).abs() < 0.001)
            .unwrap_or_else(|| {
                Self::ZOOM_STEPS
                    .iter()
                    .position(|z| *z >= view.zoom)
                    .unwrap_or(Self::ZOOM_STEPS.len() - 1)
            });
        let next = match step {
            0 => 1.0,
            s => {
                Self::ZOOM_STEPS
                    [(at as i32 + s).clamp(0, Self::ZOOM_STEPS.len() as i32 - 1) as usize]
            }
        };
        match view.surface.set_zoom(next) {
            Ok(()) => view.zoom = next,
            Err(error) => view.notice = Some(error),
        }
        cx.notify();
    }

    pub(super) fn web_command(&mut self, key: &str, command: &str, cx: &mut Context<Self>) {
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
                input.update(cx, |input, cx| {
                    input.focus(window, cx);
                    input.select_all(window, cx);
                });
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
    pub(super) fn ensure_browser_view(&mut self, id: &str, url: &str, cx: &mut Context<Self>) {
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
                    committed: false,
                    zoom: 1.0,
                    can_back: false,
                    can_forward: false,
                    external: None,
                    controls: Default::default(),
                },
            );
            self.web_events(id.into(), 0, rx, cx);
        }
    }
    pub(super) fn prepare_agent_browsers(&mut self, window: &Window, cx: &mut Context<Self>) {
        let live: std::collections::HashSet<_> = self
            .panes
            .values()
            .flat_map(|p| &p.tabs)
            .map(|t| t.id.clone())
            .collect();
        self.browser_services
            .agent_tabs
            .retain(|id| live.contains(id));
        let tabs: Vec<_> = self
            .panes
            .values()
            .flat_map(|p| &p.tabs)
            .filter(|t| self.browser_services.agent_tabs.contains(&t.id))
            .filter_map(|t| match &t.kind {
                PaneTabKind::Browser { url } => Some((t.id.clone(), url.clone())),
                _ => None,
            })
            .collect();
        for (id, url) in tabs {
            self.ensure_browser_view(&id, &url, cx);
            self.web_views
                .get_mut(&id)
                .unwrap()
                .surface
                .set_download_directory(&self.app_settings.browser_download_dir);
            if let Some(view) = self.web_views.get_mut(&id)
                && let Err(error) = view.surface.mount_hidden(window)
            {
                view.notice = Some(error);
            }
        }
    }
    pub(super) fn browser_body(
        &mut self,
        id: &str,
        url: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let english = self.app_settings.language == UiLanguage::English;
        self.ensure_browser_view(id, url, cx);
        if self.web_views[id].address.is_none() {
            let address = cx.new(|cx| {
                InputState::new(window, cx)
                    .placeholder(trs!(english, "pane_web.enter_a_url_or_search"))
            });
            let key = id.to_string();
            cx.subscribe(&address, move |this, input, event: &InputEvent, cx| {
                match event {
                    InputEvent::PressEnter { .. } => {
                        let value = input.read(cx).value().to_string();
                        this.navigate_browser(&key, &value, cx);
                    }
                    // The native web view keeps AppKit's first responder after a click in
                    // the page, so keys never reach this field unless the window takes it back.
                    InputEvent::Focus => {
                        // Select the entire URL on focus, as the Electron address bar does.
                        this.web_views.get_mut(&key).unwrap().controls.focus_address = true;
                        if let Some(view) = this.web_views.get(&key) {
                            let _ = view.surface.command("focus_parent");
                        }
                    }
                    _ => (),
                }
            })
            .detach();
            self.web_views.get_mut(id).unwrap().address = Some(address);
        }
        self.web_views
            .get_mut(id)
            .unwrap()
            .surface
            .set_download_directory(&self.app_settings.browser_download_dir);
        let view = self.web_views.get_mut(id).unwrap();
        let address = view.address.clone().unwrap();
        if view.controls.focus_address {
            view.controls.focus_address = false;
            address.update(cx, |s, cx| {
                s.focus(window, cx);
                s.select_all(window, cx);
            });
        }
        let view = &self.web_views[id];
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
        // The Electron browser's bar: back / forward / reload in one pill, then the address as a
        // rounded field that carries 在默认浏览器中打开 at its end.
        let mut toolbar = div()
            .relative()
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .h(px(48.))
            .flex_none()
            .border_b_1()
            .border_color(p.c(fv_theme::Token::Border).opacity(0.6));
        let (can_back, can_forward) = (view.can_back, view.can_forward);
        let mut nav = div()
            .flex_none()
            .flex()
            .items_center()
            .p(px(2.))
            .rounded_full()
            .border_1()
            .border_color(p.c(fv_theme::Token::Border).opacity(0.6));
        for (command, glyph, label) in [
            ("back", "arrow-left01", trs!(english, "pane_web.back")),
            (
                "forward",
                "arrow-right01",
                trs!(english, "pane_web.forward"),
            ),
            (
                if loading { "stop" } else { "reload" },
                if loading { "cancel01" } else { "refresh01" },
                if loading {
                    trs!(english, "pane_web.stop_loading")
                } else {
                    trs!(english, "pane_web.reload")
                },
            ),
        ] {
            let key = id.to_string();
            let enabled = match command {
                "back" => can_back,
                "forward" => can_forward,
                _ => true,
            };
            nav = nav.child(
                icon_button_xs(
                    SharedString::from(format!("browser-{id}-{command}")),
                    glyph,
                    &p,
                )
                .rounded_full()
                .aria_label(label)
                .when(!enabled, |d| d.opacity(0.5).cursor_default())
                .on_click(cx.listener(move |this, _, _, cx| {
                    if enabled {
                        this.web_command(&key, command, cx);
                    }
                })),
            );
        }
        let pick_key = id.to_string();
        toolbar = toolbar.child(nav).child(
            ui::icon_button_xs_tinted(
                "browser-pick",
                "cursor-rectangle-selection01",
                if view.controls.picking {
                    p.c(fv_theme::Token::Primary)
                } else {
                    p.c(fv_theme::Token::MutedForeground)
                },
                &p,
            )
            .aria_label(trs!(
                english,
                if view.controls.picking {
                    "browser.pick_cancel"
                } else {
                    "browser.pick"
                }
            ))
            .on_click(cx.listener(move |this, _, _, cx| this.toggle_browser_pick(&pick_key, cx))),
        );
        let external_url = current.clone();
        toolbar = toolbar.child(
            div()
                .relative()
                .flex_1()
                .min_w_0()
                .h(px(32.))
                .pl(px(12.))
                .pr(px(28.))
                .flex()
                .items_center()
                .rounded_full()
                .border_1()
                .border_color(p.c(fv_theme::Token::Input))
                .bg(p.c(fv_theme::Token::Muted).opacity(0.4))
                .child(
                    div().flex_1().min_w_0().child(
                        crate::ui::input(&address)
                            .h_8()
                            .py_0()
                            .appearance(false)
                            .bordered(false)
                            .text_size(px(TEXT_XS))
                            .line_height(px(16.0)),
                    ),
                )
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .right(px(2.))
                        .flex()
                        .items_center()
                        .child(
                            icon_button_xs("browser-external", "link-square02", &p)
                                .aria_label(trs!(english, "pane_web.open_in_system_browser"))
                                .on_click(move |_, _, cx| {
                                    if let Some(url) = fv_core::safe_web_url(&external_url) {
                                        cx.open_url(&url);
                                    }
                                }),
                        ),
                ),
        );
        let downloads_key = id.to_string();
        toolbar = toolbar.child(
            icon_button_xs("browser-downloads", "download01", &p)
                .aria_label(trs!(english, "browser.downloads"))
                .on_click(cx.listener(move |this, e: &ClickEvent, _, cx| {
                    this.close_menus(cx);
                    this.browser_services.menu = super::browser_settings::BrowserMenu::Downloads;
                    this.browser_menu = Some((e.position(), downloads_key.clone()));
                    cx.notify();
                })),
        );
        // The scroll wrapper is `size_full` unless told otherwise: without a height of its own the
        // bar takes the whole column and the page below it is laid out zero pixels tall.
        let menu_key = id.to_string();
        toolbar = toolbar.child(
            icon_button_xs("browser-more", "more-horizontal", &p)
                .aria_label(trs!(english, "pane_web.more"))
                .on_click(cx.listener(move |this, e: &ClickEvent, _, cx| {
                    let at = e.position();
                    this.close_menus(cx);
                    this.browser_services.menu = super::browser_settings::BrowserMenu::Main;
                    this.refresh_browser_profiles(cx);
                    this.browser_menu = Some((at, menu_key.clone()));
                    cx.notify();
                })),
        );
        let view = self.web_views.get_mut(id).unwrap();
        view.surface
            .set_viewport(view.controls.viewport.dimensions(view.controls.landscape));
        let surface = self.web_surface(id, cx);
        let controls = &self.web_views[id].controls;
        let picking = controls.picking;
        let finding = controls.finding;
        let dimensions = controls.viewport.dimensions(controls.landscape);
        let device_bar = dimensions.map(|_| self.browser_viewport_bar(id, cx));
        let find_bar = finding.then(|| self.browser_find_bar(id, window, cx));
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(toolbar)
            .when(loading, |d| {
                d.child(
                    div()
                        .h(px(2.))
                        .w_full()
                        .flex_none()
                        .bg(p.c(fv_theme::Token::Primary).opacity(0.6)),
                )
            })
            .children(device_bar)
            .children(find_bar)
            .when(picking, |d| {
                d.child(
                    div()
                        .px(px(8.))
                        .py(px(4.))
                        .text_size(px(TEXT_XS))
                        .child(trs!(english, "browser.pick_hint")),
                )
            })
            .children(notice.map(|text| {
                div()
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .child(text)
            }))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .child(surface),
            )
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
                            committed: false,
                            zoom: 1.0,
                            can_back: false,
                            can_forward: false,
                            external: None,
                            controls: Default::default(),
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
                    .child(
                        if self.app_settings.language == fv_protocol::types::UiLanguage::English {
                            "Open link in system browser"
                        } else {
                            "在系统浏览器中打开链接"
                        },
                    )
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
                            committed: false,
                            zoom: 1.0,
                            can_back: false,
                            can_forward: false,
                            external: None,
                            controls: Default::default(),
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
                        .child(
                            if self.app_settings.language == fv_protocol::types::UiLanguage::English
                            {
                                "Retry"
                            } else {
                                "重试"
                            },
                        )
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
