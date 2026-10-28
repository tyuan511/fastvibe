//! Install identity and the model catalog. Async answers belong to one settings instance.
use super::Workspace;
use super::personalization::{BadgeKind, badge, group, primary_button, rich_row};
use super::settings::{Section, outline_button};
use crate::ui::px;
use crate::ui::{Muted as _, TEXT_XS, icon};
use fv_protocol::catalog::ModelCatalogInfo;
use fv_protocol::methods::{
    AppUpdateCheck, DiagnosticsGet, ModelCatalogGet, ModelCatalogRefresh, SettingsReset,
};
use fv_protocol::types::{Empty, UiLanguage};
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
pub struct AboutSettings {
    session: u64,
    request: u64,
    loading: bool,
    refreshing: bool,
    catalog: Option<ModelCatalogInfo>,
    notice: Option<String>,
    error: Option<String>,
    dirty: bool,
    diagnostics: Option<fv_protocol::types::Diagnostics>,
    diagnostics_loading: bool,
    update: Option<fv_protocol::types::AppUpdateInfo>,
    update_loading: bool,
}
impl Default for AboutSettings {
    fn default() -> Self {
        Self {
            session: next_id(),
            request: 0,
            loading: false,
            refreshing: false,
            catalog: None,
            notice: None,
            error: None,
            dirty: false,
            diagnostics: None,
            diagnostics_loading: false,
            update: None,
            update_loading: false,
        }
    }
}
impl Workspace {
    fn check_update(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(settings) = self.settings.as_mut() else {
            return;
        };
        if settings.about.update_loading {
            return;
        }
        settings.about.update_loading = true;
        let session = settings.about.session;
        let call = backend.call::<AppUpdateCheck>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.app_settings.language == UiLanguage::English;
                if let Some(settings) = this
                    .settings
                    .as_mut()
                    .filter(|settings| settings.about.session == session)
                {
                    settings.about.update_loading = false;
                    match result {
                        Ok(update) => settings.about.update = Some(update),
                        Err(error) => {
                            settings.about.error = Some(tr!(
                                english,
                                "about.update_check_failed_error",
                                error = error
                            ))
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_diagnostics(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(settings) = self.settings.as_mut() else {
            return;
        };
        if settings.about.diagnostics_loading {
            return;
        }
        settings.about.diagnostics_loading = true;
        let session = settings.about.session;
        let call = backend.call::<DiagnosticsGet>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Some(settings) = this
                    .settings
                    .as_mut()
                    .filter(|settings| settings.about.session == session)
                {
                    settings.about.diagnostics_loading = false;
                    if let Ok(diagnostics) = result {
                        cx.write_to_clipboard(ClipboardItem::new_string(diagnostics_text(
                            &diagnostics,
                        )));
                        settings.about.diagnostics = Some(diagnostics);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn copy_diagnostics(&mut self, cx: &mut Context<Self>) {
        if let Some(diagnostics) = self
            .settings
            .as_ref()
            .and_then(|settings| settings.about.diagnostics.as_ref())
        {
            cx.write_to_clipboard(ClipboardItem::new_string(diagnostics_text(diagnostics)));
        } else {
            self.load_diagnostics(cx);
        }
    }

    fn reset_preferences(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let call = backend.call::<SettingsReset>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.app_settings.language == UiLanguage::English;
                match result {
                    Ok(settings) => {
                        this.observe_personalization(&settings.custom_system_prompt);
                        this.app_settings = settings;
                        this.appearance_dirty = true;
                        this.sidebar_notice =
                            Some(trs!(english, "about.preferences_restored_to_defaults").into());
                    }
                    Err(error) => {
                        this.sidebar_notice =
                            Some(tr!(english, "about.reset_failed_error", error = error))
                    }
                }
                this.refresh_app_settings(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn refresh_about(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self
            .settings
            .as_mut()
            .filter(|s| s.section == Section::About)
        else {
            return;
        };
        let s = &mut s.about;
        if s.loading || s.refreshing {
            s.dirty = true;
            return;
        }
        s.loading = true;
        s.error = None;
        s.request = next_id();
        let (session, request) = (s.session, s.request);
        let call = backend.call::<ModelCatalogGet>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.english();
                let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.about.session == session && s.about.request == request)
                else {
                    return;
                };
                s.about.loading = false;
                match result {
                    Ok(catalog) => s.about.catalog = Some(catalog),
                    Err(error) => {
                        s.about.error = Some(tr!(
                            english,
                            "about.could_not_read_the_model",
                            error = error
                        ))
                    }
                }
                let again = std::mem::take(&mut s.about.dirty);
                if again {
                    this.refresh_about(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    fn update_catalog(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let s = &mut s.about;
        if s.refreshing {
            return;
        }
        s.refreshing = true;
        s.loading = false;
        s.notice = None;
        s.error = None;
        s.request = next_id();
        let (session, request) = (s.session, s.request);
        let call = backend.call::<ModelCatalogRefresh>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.english();
                let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.about.session == session && s.about.request == request)
                else {
                    return;
                };
                s.about.refreshing = false;
                match result {
                    Ok(update) => {
                        s.about.catalog = Some(update.catalog);
                        s.about.notice = Some(
                            if update.changed {
                                trs!(english, "about.model_catalog_updated")
                            } else {
                                trs!(english, "about.model_catalog_is_up_to")
                            }
                            .into(),
                        );
                    }
                    Err(error) => {
                        s.about.error = Some(tr!(
                            english,
                            "about.update_failed_the_previous_catalog",
                            error = error
                        ))
                    }
                }
                let again = std::mem::take(&mut s.about.dirty);
                if again {
                    this.refresh_about(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    pub(super) fn about_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(settings) = self.settings.as_ref() else {
            return div().into_any_element();
        };
        let s = &settings.about;
        let p = &self.palette;
        let english = self.english();
        let fg = p.c(Token::Foreground);
        // `Button size="xs"`: 24px, 12px text and glyph.
        let xs = |id: &'static str, glyph: Option<&'static str>, text: SharedString| {
            outline_button(id, p)
                .h(px(24.0))
                .px(px(8.0))
                .gap(px(4.0))
                .rounded(px(8.0))
                .text_size(px(TEXT_XS))
                .when_some(glyph, |d, g| d.child(icon(g, 12.0, fg)))
                .child(text)
        };

        // 模型目录's description: what the catalog holds and where it came from.
        let mut catalog = div().flex().flex_col().gap(px(2.0));
        if let Some(info) = &s.catalog {
            catalog = catalog
                .child(if info.models == 0 {
                    trs!(english, "about.no_model_catalog_yet_unknown").into()
                } else {
                    tr!(
                        english,
                        "about.catalog_stats",
                        models = info.models,
                        aliases = info.aliases,
                        source = if info.bundled {
                            trs!(english, "about.bundled")
                        } else {
                            trs!(english, "about.downloaded")
                        }
                    )
                })
                .child(tr!(
                    english,
                    "about.updated_arg1",
                    arg1 = timestamp(info.generated_at)
                ));
        } else {
            catalog = catalog.child(if s.loading {
                trs!(english, "about.loading_model_catalog")
            } else {
                trs!(english, "about.model_catalog_desc")
            });
        }
        if let Some(notice) = &s.notice {
            catalog = catalog.child(SharedString::from(notice.clone()));
        }
        if let Some(error) = &s.error {
            catalog = catalog.child(
                div()
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(error.clone())),
            );
        }
        let refreshing = s.refreshing;
        let diagnostics = s.diagnostics.clone();
        let diagnostics_loading = s.diagnostics_loading;
        let update = s.update.clone();
        let update_loading = s.update_loading;
        let status: SharedString = if update_loading {
            trs!(english, "about.checking").into()
        } else {
            match update.as_ref().and_then(|u| u.latest_version.as_deref()) {
                Some(version)
                    if update
                        .as_ref()
                        .is_some_and(|u| u.current_version != version) =>
                {
                    tr!(
                        english,
                        "about.new_version_v_version_available",
                        version = version
                    )
                    .into()
                }
                Some(_) => trs!(english, "about.already_up_to_date").into(),
                None => trs!(english, "about.check_the_latest_github_release").into(),
            }
        };
        let release = update.and_then(|u| u.release_url);

        let header = div()
            .flex()
            .items_center()
            .gap(px(16.0))
            .child(
                img("app-icon.png")
                    .size(px(56.0))
                    .flex_none()
                    .rounded(px(14.0)),
            )
            .child(
                div()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(px(18.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("FastVibe"),
                            )
                            .child(
                                badge(
                                    BadgeKind::Secondary,
                                    None,
                                    format!("v{}", env!("CARGO_PKG_VERSION")),
                                    p,
                                )
                                .font_family(crate::assets::MONO_FONT),
                            ),
                    )
                    .child(
                        div()
                            .mt(px(4.0))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "about.tagline")),
                    ),
            );

        let open_source = group(
            Some(trs!(english, "about.open_source")),
            p,
            [rich_row(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        div()
                            .size(px(28.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon("github", 16.0, fg)),
                    )
                    .child(
                        div()
                            .font_family(crate::assets::MONO_FONT)
                            .text_size(px(13.0))
                            .font_weight(FontWeight::NORMAL)
                            .child("tyuan511/fastvibe"),
                    ),
                None,
                false,
                p,
                primary_button("about-repository", p)
                    .h(px(24.0))
                    .px(px(8.0))
                    .text_size(px(TEXT_XS))
                    .child(icon("star", 12.0, p.c(Token::PrimaryForeground)))
                    .child(trs!(english, "about.star"))
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.open_url("https://github.com/tyuan511/fastvibe")
                    })),
            )
            .into_any_element()],
        );

        let updates = group(
            Some(trs!(english, "about.updates")),
            p,
            [rich_row(
                trs!(english, "about.check_for_updates"),
                Some(div().child(status).into_any_element()),
                false,
                p,
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .when_some(release, |d, url| {
                        d.child(
                            xs(
                                "open-release",
                                Some("link-square02"),
                                trs!(english, "about.open_release_page").into(),
                            )
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                        )
                    })
                    .child(
                        xs(
                            "check-app-update",
                            Some("refresh01"),
                            trs!(english, "about.check_for_updates").into(),
                        )
                        .when(update_loading, |d| d.opacity(0.5))
                        .when(!update_loading, |button| {
                            button.on_click(cx.listener(|this, _, _, cx| this.check_update(cx)))
                        }),
                    ),
            )
            .into_any_element()],
        );

        let diagnostics_desc = diagnostics
            .as_ref()
            .map(|d| SharedString::from(diagnostics_text(d)))
            .unwrap_or_else(|| trs!(english, "about.diagnostics_desc").into());
        let more = group(
            Some(trs!(english, "about.more")),
            p,
            [
                rich_row(
                    trs!(english, "about.model_catalog"),
                    Some(catalog.into_any_element()),
                    false,
                    p,
                    xs(
                        "update-model-catalog",
                        Some("refresh01"),
                        if refreshing {
                            trs!(english, "about.updating")
                        } else {
                            trs!(english, "about.update_model_catalog")
                        }
                        .into(),
                    )
                    .when(refreshing, |d| d.opacity(0.5))
                    .on_click(cx.listener(|this, _, _, cx| this.update_catalog(cx))),
                )
                .into_any_element(),
                rich_row(
                    trs!(english, "about.diagnostics"),
                    Some(div().child(diagnostics_desc).into_any_element()),
                    true,
                    p,
                    xs(
                        "load-diagnostics",
                        Some("copy01"),
                        if diagnostics_loading {
                            trs!(english, "about.loading")
                        } else if diagnostics.is_some() {
                            trs!(english, "about.copy_diagnostics")
                        } else {
                            trs!(english, "about.read_and_copy")
                        }
                        .into(),
                    )
                    .when(!diagnostics_loading, |button| {
                        button.on_click(cx.listener(|this, _, _, cx| this.copy_diagnostics(cx)))
                    }),
                )
                .into_any_element(),
                rich_row(
                    trs!(english, "about.reset_title"),
                    Some(
                        div()
                            .child(trs!(
                                english,
                                "about.reset_themes_sandbox_shortcuts_browser"
                            ))
                            .into_any_element(),
                    ),
                    true,
                    p,
                    xs(
                        "reset-preferences",
                        Some("rotate-ccw"),
                        trs!(english, "about.reset").into(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.reset_preferences(cx))),
                )
                .into_any_element(),
            ],
        );

        div()
            .flex()
            .flex_col()
            .gap(px(24.0))
            .child(header)
            .child(open_source)
            .child(updates)
            .child(more)
            .into_any_element()
    }
}
fn diagnostics_text(diagnostics: &fv_protocol::types::Diagnostics) -> String {
    format!(
        "FastVibe v{} · protocol {} · {} · {} providers · {} models · {} threads · {} MCP · memory {}",
        diagnostics.app_version,
        diagnostics.protocol_version,
        diagnostics.platform,
        diagnostics.providers,
        diagnostics.models,
        diagnostics.threads,
        diagnostics.mcp_servers,
        if diagnostics.memory_enabled {
            "on"
        } else {
            "off"
        },
    )
}
fn timestamp(ms: u64) -> String {
    i64::try_from(ms)
        .ok()
        .filter(|n| *n > 0)
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "—".into())
}
