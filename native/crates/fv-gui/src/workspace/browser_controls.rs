use super::*;
use crate::ui;
use gpui_kit::prelude::FluentBuilder as _;

#[derive(Default)]
pub(super) struct BrowserControls {
    pub finding: bool,
    pub find: Option<Entity<InputState>>,
    pub found: Option<bool>,
    pub picking: bool,
    pub viewport: Viewport,
    pub landscape: bool,
    pub capturing: bool,
    pub polling_downloads: bool,
    pub focus_address: bool,
    pub focus_find: bool,
}
#[derive(Default, Clone, Copy, PartialEq)]
pub(super) enum Viewport {
    #[default]
    Responsive,
    Mobile,
    Tablet,
}
impl Viewport {
    pub fn dimensions(self, landscape: bool) -> Option<(f32, f32)> {
        let (w, h) = match self {
            Self::Responsive => return None,
            Self::Mobile => (375., 812.),
            Self::Tablet => (768., 1024.),
        };
        Some(if landscape { (h, w) } else { (w, h) })
    }
    pub fn label(self, english: bool) -> &'static str {
        trs!(
            english,
            match self {
                Self::Responsive => "browser.responsive",
                Self::Mobile => "browser.mobile",
                Self::Tablet => "browser.tablet",
            }
        )
    }
}
impl Workspace {
    pub(super) fn toggle_browser_pick(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(view) = self.web_views.get_mut(key) else {
            return;
        };
        if view.controls.picking {
            view.controls.picking = false;
            let _ = view
                .surface
                .eval(include_str!("../browser_scripts/pick-read.js"), |_| {});
            cx.notify();
            return;
        }
        if fv_core::safe_web_url(&view.url).is_none() {
            return;
        }
        view.controls.picking = true;
        if let Err(e) = view
            .surface
            .eval(include_str!("../browser_scripts/pick.js"), |_| {})
        {
            view.controls.picking = false;
            view.notice = Some(e);
            return;
        }
        let key = key.to_string();
        let owner = self.selected.clone();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(120))
                    .await;
                let (tx, rx) = futures_channel::oneshot::channel();
                let tx = std::sync::Mutex::new(Some(tx));
                let active = this
                    .update(cx, |this, _| {
                        let Some(view) = this.web_views.get(&key).filter(|v| v.controls.picking)
                        else {
                            return false;
                        };
                        view.surface
                            .eval("JSON.stringify(window.__fvPicked || null)", move |raw| {
                                if let Some(tx) = tx.lock().unwrap().take() {
                                    let _ = tx.send(raw);
                                }
                            })
                            .is_ok()
                    })
                    .unwrap_or(false);
                if !active {
                    return;
                }
                let raw = match futures_util::future::select(
                    rx,
                    cx.background_executor()
                        .timer(std::time::Duration::from_secs(3)),
                )
                .await
                {
                    futures_util::future::Either::Left((Ok(v), _)) => v,
                    _ => return,
                };
                let decoded = serde_json::from_str::<String>(&raw).unwrap_or(raw);
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&decoded) else {
                    continue;
                };
                if value.is_null() {
                    continue;
                }
                let _ = this.update(cx, |this, cx| {
                    if let Some(view) = this.web_views.get_mut(&key) {
                        view.controls.picking = false;
                        let _ = view
                            .surface
                            .eval(include_str!("../browser_scripts/pick-read.js"), |_| {});
                    }
                    // A tab in a background conversation cannot attach to the foreground draft.
                    if this.selected != owner {
                        return;
                    }
                    let body = format!(
                        "URL: {}\nSelector: {}\n\n{}\n\n{}",
                        value["url"].as_str().unwrap_or(""),
                        value["selector"].as_str().unwrap_or(""),
                        value["text"].as_str().unwrap_or(""),
                        value["html"].as_str().unwrap_or("")
                    );
                    let path = std::env::temp_dir()
                        .join("fastvibe-attachments")
                        .join(format!("browser-element-{}.txt", uuid::Uuid::new_v4()));
                    let result = std::fs::create_dir_all(path.parent().unwrap())
                        .and_then(|_| std::fs::write(&path, body));
                    if let Err(error) = result {
                        if let Some(view) = this.web_views.get_mut(&key) {
                            view.notice = Some(error.to_string());
                        }
                    } else {
                        this.attach_paths(&[path], cx);
                    }
                    cx.notify();
                });
                return;
            }
        })
        .detach();
        cx.notify();
    }
    pub(super) fn browser_capture(&mut self, key: &str, cx: &mut Context<Self>) {
        let Some(view) = self.web_views.get_mut(key) else {
            return;
        };
        if view.controls.capturing {
            return;
        }
        let path = crate::webview::download_directory(&self.app_settings.browser_download_dir)
            .join(format!(
                "FastVibe-{}.png",
                chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f")
            ));
        view.controls.capturing = true;
        if let Err(error) = view.surface.capture(path) {
            view.controls.capturing = false;
            view.notice = Some(error);
        }
        cx.notify();
    }
    pub(super) fn browser_find(&mut self, key: &str, backwards: bool, cx: &mut Context<Self>) {
        let Some(view) = self.web_views.get_mut(key) else {
            return;
        };
        let text = view
            .controls
            .find
            .as_ref()
            .map(|s| s.read(cx).value().to_string())
            .unwrap_or_default();
        view.controls.found = None;
        if text.is_empty() {
            let _ = view
                .surface
                .eval("getSelection()?.removeAllRanges()", |_| {});
        } else if let Err(e) = view.surface.find(&text, backwards) {
            view.notice = Some(e);
        }
        cx.notify();
    }
    pub(super) fn browser_find_bar(
        &mut self,
        key: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let english = self.app_settings.language == UiLanguage::English;
        let view = self.web_views.get_mut(key).unwrap();
        if view.controls.find.is_none() {
            let input = cx.new(|cx| {
                InputState::new(window, cx).placeholder(trs!(english, "browser.find_placeholder"))
            });
            let tab = key.to_string();
            cx.subscribe(&input, move |this, _, event: &InputEvent, cx| match event {
                InputEvent::Change => this.browser_find(&tab, false, cx),
                InputEvent::PressEnter { shift, .. } => this.browser_find(&tab, *shift, cx),
                InputEvent::Focus => {
                    if let Some(view) = this.web_views.get(&tab) {
                        let _ = view.surface.command("focus_parent");
                    }
                }
                _ => (),
            })
            .detach();
            input.update(cx, |s, cx| s.focus(window, cx));
            view.controls.find = Some(input);
        }
        let input = view.controls.find.clone().unwrap();
        if view.controls.focus_find {
            view.controls.focus_find = false;
            input.update(cx, |s, cx| {
                s.focus(window, cx);
                s.select_all(window, cx);
            });
        }
        let found = view.controls.found;
        let p = &self.palette;
        let mut row = div()
            .flex_none()
            .h(px(38.))
            .flex()
            .items_center()
            .gap(px(4.))
            .px(px(8.))
            .child(
                div().flex_1().child(
                    crate::ui::input(&input)
                        .h_6()
                        .px(px(4.0))
                        .py_0()
                        .appearance(false)
                        .bordered(false)
                        .text_size(px(ui::TEXT_XS))
                        .line_height(px(16.0)),
                ),
            )
            .child(div().text_size(px(ui::TEXT_XS)).child(match found {
                Some(true) => trs!(english, "browser.found"),
                Some(false) => trs!(english, "browser.not_found"),
                None => "",
            }));
        for (id, glyph, label, backwards) in [
            ("browser-find-prev", "arrow-up01", "browser.find_prev", true),
            (
                "browser-find-next",
                "arrow-down01",
                "browser.find_next",
                false,
            ),
        ] {
            let key = key.to_string();
            row = row.child(
                ui::icon_button_xs(id, glyph, p)
                    .aria_label(trs!(english, label))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.browser_find(&key, backwards, cx)),
                    ),
            );
        }
        let key = key.to_string();
        row.child(
            ui::icon_button_xs("browser-find-close", "cancel01", p)
                .aria_label(trs!(english, "browser.find_close"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(view) = this.web_views.get_mut(&key) {
                        view.controls.finding = false;
                        view.controls.find = None;
                        let _ = view
                            .surface
                            .eval("getSelection()?.removeAllRanges()", |_| {});
                    }
                    cx.notify();
                })),
        )
        .into_any_element()
    }
    pub(super) fn browser_viewport_bar(&self, key: &str, cx: &mut Context<Self>) -> AnyElement {
        let english = self.app_settings.language == UiLanguage::English;
        let view = &self.web_views[key];
        let mode = view.controls.viewport;
        let (w, h) = mode.dimensions(view.controls.landscape).unwrap();
        let p = &self.palette;
        let tab = key.to_string();
        let close = key.to_string();
        div()
            .flex_none()
            .h(px(32.))
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(8.))
            .text_size(px(ui::TEXT_XS))
            .child(format!("{} · {w} × {h}", mode.label(english)))
            .child(
                ui::icon_button_xs("browser-rotate", "rotate-ccw", p)
                    .aria_label(trs!(english, "browser.rotate"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(view) = this.web_views.get_mut(&tab) {
                            view.controls.landscape = !view.controls.landscape;
                        }
                        cx.notify();
                    })),
            )
            .child(
                ui::icon_button_xs("browser-device-close", "cancel01", p)
                    .aria_label(trs!(english, "browser.device_close"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(view) = this.web_views.get_mut(&close) {
                            view.controls.viewport = Viewport::Responsive;
                        }
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
}

impl Workspace {
    pub(super) fn browser_menu_view(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use super::browser_settings::BrowserMenu as M;
        use super::settings::{menu_item, menu_label, popover};
        use gpui_kit::component::scroll::ScrollableElement as _;
        let (at, key) = self.browser_menu.clone()?;
        let view = self.web_views.get(&key)?;
        let english = self.app_settings.language == UiLanguage::English;
        let p = &self.palette;
        let at = super::sidebar_actions::popup_origin(at, 288., 440., window);
        let hover = p.c(Token::Accent);
        let muted = p.c(Token::MutedForeground);
        let item = |id: String, glyph: &str, label: String| {
            menu_item(SharedString::from(id), false, hover)
                .child(ui::icon(glyph, 16., muted))
                .child(label)
        };
        let mut menu = popover(p)
            .w(px(288.))
            .max_h(px(440.))
            .overflow_y_scrollbar();
        let mode = self.browser_services.menu;
        if mode != M::Main {
            menu = menu.child(
                item(
                    "browser-menu-back".into(),
                    "arrow-left01",
                    trs!(english, "pane_web.back").into(),
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.browser_services.menu = M::Main;
                    cx.notify();
                })),
            );
        }
        match mode {
            M::Main => {
                for (id, glyph, label, action) in [
                    ("find", "search01", "browser.find", "find"),
                    ("print", "printer", "pane_web.print", "print"),
                    ("capture", "camera01", "browser.capture", "capture"),
                ] {
                    let key = key.clone();
                    menu = menu.child(
                        item(format!("browser-{id}"), glyph, trs!(english, label).into()).on_click(
                            cx.listener(move |this, _, _, cx| {
                                this.close_menus(cx);
                                match action {
                                    "find" => {
                                        if let Some(v) = this.web_views.get_mut(&key) {
                                            v.controls.finding = true;
                                            v.controls.focus_find = true;
                                        }
                                        cx.notify();
                                    }
                                    "capture" => this.browser_capture(&key, cx),
                                    _ => this.web_command(&key, "print", cx),
                                }
                            }),
                        ),
                    );
                }
                let zoom_button = |id: &'static str, glyph: &str, label: &str, step| {
                    let key = key.clone();
                    ui::icon_button_xs(id, glyph, p)
                        .aria_label(label.to_string())
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.browser_zoom(&key, step, cx)),
                        )
                };
                menu = menu.child(
                    div()
                        .min_h(px(32.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(div().flex_1().child(trs!(english, "pane_web.zoom")))
                        .child(zoom_button(
                            "browser-zoom-out",
                            "minus-sign",
                            trs!(english, "pane_web.zoom_out"),
                            -1,
                        ))
                        .child(
                            div()
                                .w(px(44.))
                                .text_size(px(ui::TEXT_XS))
                                .child(format!("{}%", (view.zoom * 100.).round())),
                        )
                        .child(zoom_button(
                            "browser-zoom-in",
                            "plus-sign",
                            trs!(english, "pane_web.zoom_in"),
                            1,
                        ))
                        .child(zoom_button(
                            "browser-zoom-reset",
                            "rotate-ccw",
                            trs!(english, "pane_web.zoom_reset"),
                            0,
                        )),
                );
                for (id, glyph, label, next) in [
                    ("device", "computer", "browser.device", M::Device),
                    ("import", "upload01", "browser.import_title", M::Import),
                    ("downloads", "download01", "browser.downloads", M::Downloads),
                    ("history", "clock01", "browser.history", M::History),
                ] {
                    menu = menu.child(
                        item(
                            format!("browser-menu-{id}"),
                            glyph,
                            trs!(english, label).into(),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.browser_services.menu = next;
                            cx.notify();
                        })),
                    );
                }
                let bookmark_url = view.url.clone();
                let bookmark_title = self
                    .browser_history
                    .iter()
                    .rev()
                    .find(|e| e.url == view.url)
                    .map(|e| e.title.clone())
                    .unwrap_or_else(|| view.url.clone());
                let bookmarked = self.browser_bookmarks.iter().any(|b| b.url == view.url);
                menu = menu.child(
                    item(
                        "browser-bookmark".into(),
                        "star",
                        trs!(
                            english,
                            if bookmarked {
                                "pane_web.remove_bookmark"
                            } else {
                                "pane_web.bookmark_this_page"
                            }
                        )
                        .into(),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.toggle_browser_bookmark(&bookmark_url, &bookmark_title, cx);
                        this.close_menus(cx);
                    })),
                );
                let url = view.url.clone();
                menu = menu
                    .child(
                        item(
                            "browser-copy-url".into(),
                            "copy01",
                            trs!(english, "pane_web.copy_url").into(),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                            this.close_menus(cx);
                        })),
                    )
                    .child(
                        item(
                            "browser-clear-data".into(),
                            "delete02",
                            trs!(english, "pane_web.clear_data").into(),
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.browser_services.menu = M::Clear;
                            cx.notify();
                        })),
                    )
                    .child(
                        item(
                            "browser-settings".into(),
                            "settings01",
                            trs!(english, "pane_web.browser_settings").into(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_browser_settings(window, cx);
                            this.close_menus(cx);
                        })),
                    );
            }
            M::Device => {
                for (id, mode) in [
                    ("responsive", Viewport::Responsive),
                    ("mobile", Viewport::Mobile),
                    ("tablet", Viewport::Tablet),
                ] {
                    let key = key.clone();
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("browser-viewport-{id}")),
                            view.controls.viewport == mode,
                            hover,
                        )
                        .child(mode.label(english))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(v) = this.web_views.get_mut(&key) {
                                v.controls.viewport = mode;
                                v.controls.landscape = false;
                            }
                            this.close_menus(cx);
                        })),
                    );
                }
            }
            M::Downloads => {
                menu = menu.child(menu_label(trs!(english, "browser.downloads"), p));
                if self.browser_services.downloads.is_empty() {
                    menu = menu.child(
                        div()
                            .p(px(8.))
                            .text_size(px(ui::TEXT_XS))
                            .child(trs!(english, "browser.no_downloads")),
                    );
                }
                for (index, download) in self.browser_services.downloads.iter().enumerate().rev() {
                    let path = download.path.clone();
                    let download_id = download.id.clone();
                    let tab = key.clone();
                    let paused = download.paused || download.can_resume;
                    let can_control = download.complete.is_none() || download.can_resume;
                    let action_id = download_id.clone();
                    let action_tab = tab.clone();
                    let actions = div().flex().when(can_control, |d| {
                        d.child(
                            ui::icon_button_xs(
                                SharedString::from(format!("browser-download-toggle-{index}")),
                                if paused { "play" } else { "pause" },
                                p,
                            )
                            .aria_label(trs!(
                                english,
                                if paused {
                                    "browser.resume_download"
                                } else {
                                    "browser.pause_download"
                                }
                            ))
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.browser_download_action(
                                        &action_tab,
                                        &action_id,
                                        if paused { "resume" } else { "pause" },
                                        cx,
                                    );
                                },
                            )),
                        )
                        .child(
                            ui::icon_button_xs(
                                SharedString::from(format!("browser-download-cancel-{index}")),
                                "cancel01",
                                p,
                            )
                            .aria_label(trs!(english, "browser.cancel_download"))
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.browser_download_action(&tab, &download_id, "cancel", cx);
                                },
                            )),
                        )
                    });
                    let name = path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("browser-download-{index}")),
                            false,
                            hover,
                        )
                        .child(div().flex_1().min_w_0().child(ui::truncate(name)).child(
                            div().text_size(px(ui::TEXT_XS)).child(trs!(
                                english,
                                if download.paused {
                                    "browser.download_paused"
                                } else {
                                    match download.complete {
                                        Some(true) => "browser.download_complete",
                                        Some(false) => "browser.download_failed",
                                        None => "browser.downloading",
                                    }
                                }
                            )),
                        ))
                        .child(div().text_size(px(ui::TEXT_XS)).child(format!(
                                "{} / {}",
                                download_bytes(download.received),
                                download
                                    .total
                                    .map(download_bytes)
                                    .unwrap_or_else(|| "—".into())
                            )))
                        .child(actions)
                        .child(ui::icon("folder-open", 16., muted))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.reveal_path(&path);
                            this.close_menus(cx);
                        })),
                    );
                }
            }
            M::History => {
                for (index, bookmark) in self.browser_bookmarks.iter().enumerate() {
                    let key = key.clone();
                    let url = bookmark.url.clone();
                    menu = menu.child(
                        item(
                            format!("browser-saved-{index}"),
                            "star",
                            bookmark.title.clone(),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.close_menus(cx);
                            this.navigate_browser(&key, &url, cx);
                        })),
                    );
                }
                menu = menu.child(menu_label(trs!(english, "browser.history"), p));
                if self.browser_history.is_empty() {
                    menu = menu.child(div().p(px(8.)).child(trs!(english, "pane_web.no_history")));
                }
                for (index, entry) in self.browser_history.iter().enumerate().rev() {
                    let key = key.clone();
                    let url = entry.url.clone();
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("browser-history-{index}")),
                            false,
                            hover,
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(ui::truncate(entry.title.clone()))
                                .child(
                                    ui::truncate(entry.url.clone())
                                        .text_size(px(ui::TEXT_XS))
                                        .text_color(muted),
                                ),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.close_menus(cx);
                            this.navigate_browser(&key, &url, cx);
                        })),
                    );
                }
            }
            M::Import => {
                menu = menu.child(menu_label(trs!(english, "browser.import_title"), p));
                if self.browser_services.profiles.is_empty() {
                    menu = menu.child(
                        div()
                            .p(px(8.))
                            .text_size(px(ui::TEXT_XS))
                            .child(trs!(english, "browser.no_profiles")),
                    );
                }
                for profile in &self.browser_services.profiles {
                    let profile = profile.clone();
                    let busy = self.browser_services.importing.is_some();
                    menu = menu.child(
                        item(
                            format!("browser-profile-{}", profile.id),
                            "upload01",
                            format!("{} · {}", profile.browser, profile.name),
                        )
                        .when(busy, |d| d.opacity(0.5))
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                if !busy {
                                    this.import_browser_profile_from_menu(
                                        profile.clone(),
                                        window,
                                        cx,
                                    );
                                    this.close_menus(cx);
                                }
                            },
                        )),
                    );
                }
            }
            M::Clear => {
                menu = menu.child(menu_label(trs!(english, "pane_web.clear_data"), p));
                for (index, label) in [
                    "browser.clear_cache",
                    "browser.clear_cookies",
                    "browser.clear_history",
                    "browser.clear_downloads",
                ]
                .into_iter()
                .enumerate()
                {
                    let selected = self.browser_services.clear[index];
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("browser-clear-{index}")),
                            selected,
                            hover,
                        )
                        .child(ui::icon(
                            if selected { "tick02" } else { "square" },
                            16.,
                            muted,
                        ))
                        .child(trs!(english, label))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.browser_services.clear[index] = !selected;
                            cx.notify();
                        })),
                    );
                }
                let key = key.clone();
                menu = menu.child(
                    item(
                        "browser-confirm-clear".into(),
                        "delete02",
                        trs!(english, "pane_web.clear_data").into(),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let [cache, cookies, history, downloads] = this.browser_services.clear;
                        if history {
                            this.browser_history.clear();
                            this.schedule_pane_save(cx);
                        }
                        if downloads {
                            this.browser_services
                                .downloads
                                .retain(|d| d.complete.is_none());
                        }
                        if let Some(view) = this.web_views.get_mut(&key)
                            && (cache || cookies)
                        {
                            view.notice =
                                Some(match view.surface.clear_selected_data(cache, cookies) {
                                    Ok(()) => trs!(english, "browser.cleared").into(),
                                    Err(e) => e,
                                });
                        }
                        this.close_menus(cx);
                    })),
                );
            }
        }
        Some(
            ui::float(
                div()
                    .absolute()
                    .left(at.x)
                    .top(at.y)
                    .w(px(288.))
                    .child(menu),
            )
            .into_any_element(),
        )
    }
    pub(super) fn import_browser_profile_from_menu(
        &mut self,
        profile: fv_browser::Profile,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        #[cfg(target_os = "macos")]
        if let Some(layer) = self.web_menu_layer {
            let workspace = cx.weak_entity();
            cx.defer(move |cx| {
                let _ = layer.host.update(cx, |_, window, cx| {
                    let _ = workspace.update(cx, |this, cx| {
                        this.import_browser_profile(profile, false, window, cx)
                    });
                });
            });
            return;
        }
        self.import_browser_profile(profile, false, window, cx);
    }
}
impl Workspace {
    pub(super) fn browser_shortcut(&mut self, key: &str, command: &str, cx: &mut Context<Self>) {
        match command {
            "address" => {
                if let Some(v) = self.web_views.get_mut(key) {
                    let _ = v.surface.command("focus_parent");
                    v.controls.focus_address = true;
                }
            }
            "find" => {
                if let Some(v) = self.web_views.get_mut(key) {
                    let _ = v.surface.command("focus_parent");
                    v.controls.finding = true;
                    v.controls.focus_find = true;
                }
            }
            "zoom_in" => self.browser_zoom(key, 1, cx),
            "zoom_out" => self.browser_zoom(key, -1, cx),
            "zoom_reset" => self.browser_zoom(key, 0, cx),
            "escape" => {
                if let Some(v) = self.web_views.get_mut(key) {
                    v.controls.finding = false;
                    v.controls.find = None;
                    if v.controls.picking {
                        v.controls.picking = false;
                        let _ = v
                            .surface
                            .eval(include_str!("../browser_scripts/pick-read.js"), |_| {});
                    } else if v.loading {
                        let _ = v.surface.command("stop");
                        v.loading = false;
                    }
                }
            }
            other => self.web_command(key, other, cx),
        }
        cx.notify();
    }
    pub(super) fn on_browser_find(
        &mut self,
        _: &super::BrowserFind,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.settings.is_some() || self.side_pane_collapsed {
            return;
        }
        if let Some(tab) = self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .and_then(|p| p.active_tab())
            .filter(|t| matches!(t.kind, super::pane::PaneTabKind::Browser { .. }))
            .map(|t| t.id.clone())
        {
            self.browser_shortcut(&tab, "find", cx);
        }
    }
}
impl Workspace {
    pub(super) fn poll_browser_downloads(&mut self, key: &str, cx: &mut Context<Self>) {
        let key = key.to_string();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(1))
                    .await;
                let active = this
                    .update(cx, |this, _| {
                        this.web_views
                            .get(&key)
                            .is_some_and(|v| v.surface.poll_downloads())
                    })
                    .unwrap_or(false);
                if !active {
                    let _ = this.update(cx, |this, _| {
                        if let Some(v) = this.web_views.get_mut(&key) {
                            v.controls.polling_downloads = false;
                        }
                    });
                    return;
                }
            }
        })
        .detach();
    }
    fn browser_download_action(
        &mut self,
        _key: &str,
        id: &str,
        action: &str,
        cx: &mut Context<Self>,
    ) {
        // A download may belong to a different tab from the one showing the shared library.
        for view in self.web_views.values() {
            if view.surface.download_action(id, action).is_ok() {
                break;
            }
        }
        cx.stop_propagation();
        cx.notify();
    }
}
fn download_bytes(value: u64) -> String {
    if value < 1024 {
        format!("{value} B")
    } else if value < 1024 * 1024 {
        format!("{:.1} KB", value as f64 / 1024.)
    } else {
        format!("{:.1} MB", value as f64 / (1024. * 1024.))
    }
}

#[cfg(test)]
mod tests {
    use super::Viewport;
    #[test]
    fn device_dimensions_rotate_and_responsive_fills_available_space() {
        assert_eq!(Viewport::Responsive.dimensions(false), None);
        assert_eq!(Viewport::Mobile.dimensions(false), Some((375., 812.)));
        assert_eq!(Viewport::Mobile.dimensions(true), Some((812., 375.)));
        assert_eq!(Viewport::Tablet.dimensions(false), Some((768., 1024.)));
    }
}
