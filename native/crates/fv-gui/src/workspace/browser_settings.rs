//! Browser selection and cookie import, shared by Settings and the browser menu.
use super::*;
use crate::ui;
use fv_browser::{Engine, Profile, SystemBrowser};
use gpui_kit::prelude::FluentBuilder as _;
use std::sync::Arc;

#[derive(Default, Clone, Copy, PartialEq)]
pub(super) enum BrowserMenu {
    #[default]
    Main,
    Downloads,
    History,
    Import,
    Device,
    Clear,
}
pub(super) use crate::pane_layout::Download;
pub(super) struct BrowserServices {
    pub engines: Vec<Engine>,
    pub profiles: Vec<Profile>,
    pub loading: bool,
    pub importing: Option<String>,
    pub notice: Option<String>,
    pub system: Arc<tokio::sync::Mutex<SystemBrowser>>,
    pub cookie_surface: Option<crate::webview::Surface>,
    pub menu: BrowserMenu,
    pub downloads: Vec<Download>,
    pub clear: [bool; 4],
    pub agent_tabs: HashSet<String>,
}
impl Default for BrowserServices {
    fn default() -> Self {
        Self {
            engines: vec![],
            profiles: vec![],
            loading: false,
            importing: None,
            notice: None,
            system: Arc::new(tokio::sync::Mutex::new(SystemBrowser::new(
                std::env::temp_dir().join("fastvibe-browser-profile"),
            ))),
            cookie_surface: None,
            menu: BrowserMenu::Main,
            downloads: vec![],
            clear: [true, false, false, false],
            agent_tabs: Default::default(),
        }
    }
}
impl Workspace {
    pub(super) fn refresh_browser_profiles(&mut self, cx: &mut Context<Self>) {
        if self.browser_services.loading {
            return;
        }
        self.browser_services.loading = true;
        let task = cx
            .background_executor()
            .spawn(async { (fv_browser::engines(), fv_browser::profiles()) });
        cx.spawn(async move |this, cx| {
            let (engines, profiles) = task.await;
            let _ = this.update(cx, |this, cx| {
                this.browser_services.engines = engines;
                this.browser_services.profiles = profiles;
                this.browser_services.loading = false;
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn import_browser_profile(
        &mut self,
        profile: Profile,
        system: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.browser_services.importing.is_some() {
            return;
        }
        self.browser_services.importing = Some(profile.id.clone());
        self.browser_services.notice = None;
        let engine = self.app_settings.browser_engine.clone();
        let browser = self.browser_services.system.clone();
        let backend = self.backend.clone();
        let task = cx
            .background_executor()
            .spawn(async move { fv_browser::read_cookies(&profile) });
        cx.spawn_in(window, async move |this, cx| {
            let result =
                match task.await {
                    Ok((cookies, skipped)) if system => {
                        if let Some(backend) = backend {
                            backend
                                .spawn(async move {
                                    browser.lock().await.import(&engine, &cookies).await.map(
                                        |count| {
                                            (count, skipped + cookies.len().saturating_sub(count))
                                        },
                                    )
                                })
                                .await
                                .unwrap_or_else(|e| Err(e.to_string()))
                        } else {
                            Err("Backend is unavailable".into())
                        }
                    }
                    Ok((cookies, skipped)) => cx
                        .update(|window, cx| {
                            this.update(cx, |this, _| {
                                let surface =
                                    this.browser_services.cookie_surface.get_or_insert_with(|| {
                                        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
                                        crate::webview::Surface::browser(
                                            "about:blank".into(),
                                            tx,
                                            crate::webview::download_directory(""),
                                        )
                                    });
                                surface.import_cookies(&cookies, window).map(|count| {
                                    (count, skipped + cookies.len().saturating_sub(count))
                                })
                            })
                        })
                        .map_err(|e| e.to_string())
                        .and_then(|r| r.map_err(|e| e.to_string()))
                        .and_then(|r| r),
                    Err(e) => Err(e),
                };
            let _ = this.update(cx, |this, cx| {
                let english = this.app_settings.language == fv_protocol::types::UiLanguage::English;
                this.browser_services.importing = None;
                this.browser_services.notice = Some(match result {
                    Ok((count, skipped)) => tr!(
                        english,
                        "browser.import_done",
                        count = count,
                        skipped = skipped
                    ),
                    Err(error) => error,
                });
                if !system
                    && let Some(tab) = this
                        .panes
                        .get(this.selected.as_deref().unwrap_or("__draft__"))
                        .and_then(|p| p.active.clone())
                    && let Some(view) = this.web_views.get_mut(&tab)
                {
                    view.notice = this.browser_services.notice.clone();
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn browser_control_settings(&self, cx: &mut Context<Self>) -> AnyElement {
        use super::settings::{card, outline_button, setting_row, switch};
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let p = &self.palette;
        let system = self.app_settings.browser_use_system;
        let mut choices = div().flex().flex_wrap().gap(px(4.));
        for (id, label) in std::iter::once((
            "auto".to_string(),
            trs!(english, "browser.auto").to_string(),
        ))
        .chain(
            self.browser_services
                .engines
                .iter()
                .map(|e| (e.id.into(), e.label.into())),
        ) {
            let selected = id == self.app_settings.browser_engine;
            choices = choices.child(
                outline_button(SharedString::from(format!("browser-engine-{id}")), p)
                    .when(selected, |d| d.bg(p.c(fv_theme::Token::Accent)))
                    .when(!system, |d| d.opacity(0.5).cursor_default())
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if system {
                            this.patch_settings(
                                fv_protocol::types::AppSettingsPatch {
                                    browser_engine: Some(id.clone()),
                                    ..Default::default()
                                },
                                cx,
                            );
                        }
                    })),
            );
        }
        let mut imports = card(p).child(setting_row(
            trs!(english, "browser.import_title"),
            trs!(
                english,
                if system {
                    "browser.import_system_desc"
                } else {
                    "browser.import_desc"
                }
            ),
            false,
            p,
            outline_button("browser-refresh-profiles", p)
                .child(trs!(english, "browser.refresh"))
                .on_click(cx.listener(|this, _, _, cx| this.refresh_browser_profiles(cx))),
        ));
        if self.browser_services.loading || self.browser_services.profiles.is_empty() {
            imports = imports.child(setting_row(
                if self.browser_services.loading {
                    trs!(english, "browser.loading")
                } else {
                    trs!(english, "browser.no_profiles")
                },
                "",
                true,
                p,
                div(),
            ));
        }
        for profile in &self.browser_services.profiles {
            let profile = profile.clone();
            let busy = self.browser_services.importing.is_some();
            let importing = self.browser_services.importing.as_deref() == Some(&profile.id);
            imports = imports.child(setting_row(
                &format!("{} · {}", profile.browser, profile.name),
                trs!(english, "browser.profile_desc"),
                true,
                p,
                outline_button(
                    SharedString::from(format!("browser-import-{}", profile.id)),
                    p,
                )
                .when(busy, |d| d.opacity(0.5).cursor_default())
                .child(if importing {
                    trs!(english, "browser.importing")
                } else {
                    trs!(english, "browser.import_action")
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    if !busy {
                        this.import_browser_profile(profile.clone(), system, window, cx);
                    }
                })),
            ));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(
                card(p)
                    .child(setting_row(
                        trs!(english, "browser.use_system"),
                        trs!(english, "browser.use_system_desc"),
                        false,
                        p,
                        switch("browser-use-system".into(), system, p).on_click(cx.listener(
                            move |this, _, _, cx| {
                                this.patch_settings(
                                    fv_protocol::types::AppSettingsPatch {
                                        browser_use_system: Some(!system),
                                        ..Default::default()
                                    },
                                    cx,
                                )
                            },
                        )),
                    ))
                    .child(setting_row(
                        trs!(english, "browser.engine"),
                        trs!(english, "browser.engine_desc"),
                        true,
                        p,
                        div().max_w(px(288.)).child(choices),
                    )),
            )
            .child(imports)
            .children(
                self.browser_services
                    .notice
                    .clone()
                    .map(|s| div().text_size(px(ui::TEXT_XS)).child(s)),
            )
            .into_any_element()
    }
}
