//! Install identity and the model catalog. Async answers belong to one settings instance.
use super::Workspace;
use super::settings::{Section, card, outline_button};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};
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
                if let Some(settings) = this
                    .settings
                    .as_mut()
                    .filter(|settings| settings.about.session == session)
                {
                    settings.about.update_loading = false;
                    match result {
                        Ok(update) => settings.about.update = Some(update),
                        Err(error) => settings.about.error = Some(format!("检查更新失败：{error}")),
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
                match result {
                    Ok(settings) => {
                        this.observe_personalization(&settings.custom_system_prompt);
                        this.app_settings = settings;
                        this.appearance_dirty = true;
                        this.sidebar_notice = Some("偏好设置已恢复默认".into());
                    }
                    Err(error) => this.sidebar_notice = Some(format!("恢复默认失败：{error}")),
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
                    Err(error) => s.about.error = Some(format!("读取模型目录失败：{error}")),
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
                                "模型目录已更新"
                            } else {
                                "模型目录已是最新"
                            }
                            .into(),
                        );
                    }
                    Err(error) => {
                        s.about.error = Some(format!("更新失败，已保留原模型目录：{error}"))
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
        let english = self.app_settings.language == UiLanguage::English;
        let mut details = div().flex().flex_col().gap(px(6.0));
        if let Some(catalog) = &s.catalog {
            details = details.child(if catalog.models == 0 {
                if english {
                    "No model catalog yet; unknown models use defaults and show unknown costs."
                        .into()
                } else {
                    "尚无模型目录；未知模型使用默认参数，费用显示为未知。".into()
                }
            } else {
                if english {
                    format!(
                        "{} models · {} name aliases · {}",
                        catalog.models,
                        catalog.aliases,
                        if catalog.bundled {
                            "bundled"
                        } else {
                            "downloaded"
                        }
                    )
                } else {
                    format!(
                        "{} 个模型 · {} 个名称索引 · {}",
                        catalog.models,
                        catalog.aliases,
                        if catalog.bundled {
                            "应用内置"
                        } else {
                            "已下载"
                        }
                    )
                }
            });
            details = details.child(if english {
                format!("Updated {}", timestamp(catalog.generated_at))
            } else {
                format!("更新于 {}", timestamp(catalog.generated_at))
            });
            if !catalog.path.is_empty() {
                details = details.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(SharedString::from(catalog.path.clone())),
                );
            }
        } else {
            details = details.child(if s.loading {
                if english {
                    "Loading model catalog…"
                } else {
                    "正在读取模型目录…"
                }
            } else {
                if english {
                    "Waiting for connection"
                } else {
                    "等待连接"
                }
            });
        }
        let refreshing = s.refreshing;
        let diagnostics = s.diagnostics.clone();
        let diagnostics_loading = s.diagnostics_loading;
        let update = s.update.clone();
        let update_loading = s.update_loading;
        div().flex().flex_col().gap(px(20.0))
            .child(div().flex().items_center().gap(px(12.0))
                .child(div().text_size(px(24.0)).font_weight(FontWeight::BOLD).child("FastVibe"))
                .child(div().text_size(px(TEXT_SM)).muted(p)
                    .child(format!("v{}", env!("CARGO_PKG_VERSION")))))
            .child(div().text_size(px(TEXT_SM)).muted(p).child(if english {
                "A workspace for code, documents, and agent collaboration"
            } else {
                "代码、办公与智能体协作工作区"
            }))
            .child(card(p).p(px(16.0)).flex().items_center().justify_between()
                .child(div().flex().flex_col().gap(px(4.0))
                    .child(div().text_size(px(TEXT_SM)).child(if english { "App updates" } else { "应用更新" }))
                    .child(div().text_size(px(TEXT_XS)).muted(p).child(match update.as_ref().and_then(|u| u.latest_version.as_deref()) {
                        Some(version) if update.as_ref().is_some_and(|u| u.current_version != version) => {
                            if english { format!("New version v{version} available") } else { format!("发现新版本 v{version}") }
                        }
                        Some(_) => if english { "Already up to date".into() } else { "当前已是最新版本".into() },
                        None => if english { "Check the latest GitHub release".into() } else { "从 GitHub 检查最新发布版本".into() },
                    })))
                .child(outline_button("check-app-update", p)
                    .child(if update_loading { if english { "Checking…" } else { "检查中…" } } else if english { "Check for updates" } else { "检查更新" })
                    .when(!update_loading, |button| button.on_click(cx.listener(|this, _, _, cx| this.check_update(cx)))))
            .when_some(update.and_then(|u| u.release_url), |d, url| d.child(
                outline_button("open-release", p).child(if english { "Open release page" } else { "打开发布页" }).on_click(move |_, _, cx| cx.open_url(&url))
            )))
            .child(card(p).p(px(16.0)).flex().items_center().justify_between()
                .child(div().text_size(px(TEXT_SM)).child("tyuan511/fastvibe"))
                .child(outline_button("about-repository", p).child(if english { "Repository" } else { "开源仓库" })
                    .on_click(cx.listener(|_, _, _, cx| cx.open_url("https://github.com/tyuan511/fastvibe")))))
            .child(card(p).p(px(16.0)).flex().flex_col().gap(px(10.0))
                .child(div().flex().items_center().justify_between()
                    .child(div().text_size(px(TEXT_SM)).font_weight(FontWeight::MEDIUM).child(if english { "Diagnostics" } else { "诊断信息" }))
                    .child(outline_button("load-diagnostics", p)
                        .child(if diagnostics_loading { if english { "Loading…" } else { "读取中…" } } else if diagnostics.is_some() { if english { "Copy diagnostics" } else { "复制诊断" } } else if english { "Read and copy" } else { "读取并复制" })
                        .when(!diagnostics_loading, |button| button.on_click(cx.listener(|this, _, _, cx| this.copy_diagnostics(cx))))))
                .when_some(diagnostics, |d, diagnostics| {
                    d.child(div().text_size(px(TEXT_XS)).muted(p).child(diagnostics_text(&diagnostics)))
                }))
            .child(card(p).p(px(16.0)).flex().items_center().justify_between()
                .child(div().flex().flex_col().gap(px(4.0))
                    .child(div().text_size(px(TEXT_SM)).child(if english { "Preferences" } else { "偏好设置" }))
                    .child(div().text_size(px(TEXT_XS)).muted(p)
                        .child(if english { "Reset themes, sandbox, shortcuts, browser, and Agent instructions; providers and chats are kept." } else { "恢复主题、沙箱、快捷键、浏览器和 Agent 说明的默认值；供应商与对话不会删除。" })))
                .child(outline_button("reset-preferences", p).child(if english { "Reset" } else { "恢复默认" })
                    .on_click(cx.listener(|this, _, _, cx| this.reset_preferences(cx)))))
            .child(card(p).p(px(16.0)).flex().flex_col().gap(px(12.0))
                .child(div().flex().items_center().justify_between()
                    .child(div().text_size(px(TEXT_SM)).font_weight(FontWeight::MEDIUM).child(if english { "Model catalog" } else { "模型目录" }))
                    .child(outline_button("update-model-catalog", p)
                        .when(refreshing, |d| d.opacity(0.5))
                        .child(if refreshing { if english { "Updating…" } else { "正在更新…" } } else if english { "Update model catalog" } else { "更新模型目录" })
                        .on_click(cx.listener(|this, _, _, cx| this.update_catalog(cx)))))
                .child(details.text_size(px(TEXT_SM)))
                .child(div().text_size(px(TEXT_XS)).muted(p)
                    .child(if english { "Model parameters and reference prices come from models.dev and refresh hourly. Updates apply to later requests." } else { "模型参数和参考价格来自 models.dev，每小时自动刷新。更新适用于后续请求，保留正在生成的回复。" })))
            .when_some(s.notice.clone(), |d, notice| d.child(div().text_size(px(TEXT_XS)).muted(p)
                .child(SharedString::from(notice))))
            .when_some(s.error.clone(), |d, error| d.child(div().text_size(px(TEXT_XS))
                .text_color(p.c(Token::Destructive)).child(SharedString::from(error))))
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
