//! Static snapshots arrive independently of live startup; only a loaded live
//! document replaces the snapshot. Every completion is scoped to its tab and lease.
use super::{Workspace, text};
use crate::{
    ui::{Muted as _, TEXT_XS, icon_button_xs},
    workspace::pane_web,
};
use fv_protocol::{methods::*, office::*, types::OfficeFormat};
use gpui_kit::*;
use std::time::Duration;
pub(super) struct OfficeView {
    path: String,
    owner: String,
    pub lease: String,
    html: Option<std::sync::Arc<String>>,
    html_revision: u64,
    render_error: Option<String>,
    pub watch_error: Option<String>,
    pub url: Option<String>,
    pub live_ready: bool,
    selection_pending: bool,
}
impl Workspace {
    pub(super) fn close_office(&mut self, tab: &str, cx: &mut Context<Self>) {
        if let Some(view) = self.office_views.remove(tab)
            && let Some(backend) = self.backend.clone()
        {
            cx.spawn(async move |_, _| {
                let _ = backend
                    .call::<OfficeWatchStop>(OfficeLeaseParams {
                        lease_id: view.lease,
                    })
                    .await;
            })
            .detach();
        }
        self.web_views.remove(&pane_web::live_key(tab));
    }
    fn start_office(&mut self, tab: &str, path: &str, cx: &mut Context<Self>) {
        self.close_office(tab, cx);
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let lease = uuid::Uuid::new_v4().to_string();
        self.office_views.insert(
            tab.into(),
            OfficeView {
                path: path.into(),
                owner: self.selected.clone().unwrap_or_else(|| "__draft__".into()),
                lease: lease.clone(),
                html: None,
                html_revision: 0,
                render_error: None,
                watch_error: None,
                url: None,
                live_ready: false,
                selection_pending: false,
            },
        );
        self.office_snapshot(tab, path, &lease, cx);
        let (tab, path) = (tab.to_string(), path.to_string());
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<OfficeWatchStart>(OfficeWatchParams {
                    path,
                    cwd: None,
                    lease_id: lease.clone(),
                })
                .await;
            let polling = this
                .update(cx, |this, cx| {
                    let Some(view) = this.office_views.get_mut(&tab).filter(|v| v.lease == lease)
                    else {
                        return false;
                    };
                    match result {
                        Ok(state) => view.url = state.url,
                        Err(error) => view.watch_error = Some(error.to_string()),
                    }
                    cx.notify();
                    view.url.is_some()
                })
                .unwrap_or(false);
            if !polling {
                return;
            }
            loop {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                let current = this
                    .update(cx, |this, _| {
                        this.office_views
                            .get(&tab)
                            .is_some_and(|v| v.lease == lease)
                    })
                    .unwrap_or(false);
                if !current {
                    break;
                }
                let result = backend
                    .call::<OfficeWatchStateGet>(OfficeLeaseParams {
                        lease_id: lease.clone(),
                    })
                    .await;
                let alive = this
                    .update(cx, |this, cx| {
                        let Some(view) =
                            this.office_views.get_mut(&tab).filter(|v| v.lease == lease)
                        else {
                            return false;
                        };
                        let error = match result {
                            Ok(state) if state.phase == OfficeWatchPhase::Ready => return true,
                            Ok(state) => state.message.unwrap_or_else(|| "实时预览已停止".into()),
                            Err(error) => error.to_string(),
                        };
                        view.watch_error = Some(error);
                        view.live_ready = false;
                        view.url = None;
                        let (path, lease) = (view.path.clone(), view.lease.clone());
                        this.web_views.remove(&pane_web::live_key(&tab));
                        this.office_snapshot(&tab, &path, &lease, cx);
                        cx.notify();
                        false
                    })
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            }
        })
        .detach();
    }
    fn office_snapshot(&self, tab: &str, path: &str, lease: &str, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let (tab, path, lease) = (tab.to_string(), path.to_string(), lease.to_string());
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<OfficeRender>(OfficeWatchParams {
                    path,
                    cwd: None,
                    lease_id: lease.clone(),
                })
                .await;
            let result = match result {
                Ok(snapshot) => {
                    cx.background_executor()
                        .spawn(async move {
                            use std::io::Read;
                            let mut text = String::new();
                            std::fs::File::open(&snapshot.path)
                                .and_then(|f| {
                                    f.take(16 * 1024 * 1024 + 1).read_to_string(&mut text)
                                })
                                .map_err(|e| format!("无法读取文档快照：{e}"))?;
                            if text.len() > 16 * 1024 * 1024 {
                                return Err("文档快照过大".into());
                            }
                            Ok(text)
                        })
                        .await
                }
                Err(error) => Err(error.to_string()),
            };
            this.update(cx, |this, cx| {
                if let Some(view) = this.office_views.get_mut(&tab).filter(|v| v.lease == lease) {
                    match result {
                        Ok(html) => {
                            view.html = Some(std::sync::Arc::new(html));
                            view.html_revision = view.html_revision.wrapping_add(1);
                            view.render_error = None;
                        }
                        Err(error) => view.render_error = Some(error),
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
    pub(super) fn office_body(
        &mut self,
        path: &str,
        name: &str,
        format: OfficeFormat,
        back: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(tab) = self
            .panes
            .get(self.selected.as_deref().unwrap_or("__draft__"))
            .and_then(|p| p.active.clone())
        else {
            return div().into_any_element();
        };
        if self.office_views.get(&tab).is_none_or(|v| v.path != path) {
            self.start_office(&tab, path, cx);
        }
        let Some(view) = self.office_views.get(&tab) else {
            return div()
                .p(px(12.))
                .child(
                    if self.app_settings.language == fv_protocol::types::UiLanguage::English {
                        "Document service is not connected"
                    } else {
                        "尚未连接文档服务"
                    },
                )
                .into_any_element();
        };
        let (html, url, ready, render_error, watch_error, lease, selection_pending) = (
            view.html.clone(),
            view.url.clone(),
            view.live_ready,
            view.render_error.clone(),
            view.watch_error.clone(),
            view.lease.clone(),
            view.selection_pending,
        );
        let revision = format!("{}:{}", view.lease, view.html_revision);
        let p = self.palette.clone();
        let lang = self.app_settings.language;
        let mut head = div()
            .h(px(36.))
            .px(px(8.))
            .flex_none()
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(TEXT_XS))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .text_ellipsis()
                    .child(name.to_string()),
            );
        if back {
            head = head.child(
                icon_button_xs("office-back", "arrow-left01", &p)
                    .aria_label(text::tr(lang, "office.back"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(pane) =
                            this.selected.as_ref().and_then(|id| this.panes.get_mut(id))
                        {
                            pane.show_preview = false;
                        }
                        cx.notify();
                    })),
            );
        }
        if let Ok(url) = url::Url::from_file_path(path) {
            head = head.child(
                icon_button_xs("office-open-external", "link-square02", &p)
                    .aria_label(text::tr(lang, "office.open_external"))
                    .on_click(move |_, _, cx| cx.open_url(url.as_str())),
            );
        }
        let (retry_tab, retry_path) = (tab.clone(), path.to_string());
        head = head.child(
            icon_button_xs("office-refresh", "refresh", &p)
                .aria_label(text::tr(lang, "office.refresh"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.start_office(&retry_tab, &retry_path, cx)
                })),
        );
        if format != OfficeFormat::Xlsx && ready {
            let (select_tab, select_lease) = (tab.clone(), lease.clone());
            head = head.child(
                div()
                    .id("office-selection")
                    .cursor_pointer()
                    .child(text::tr(
                        lang,
                        if selection_pending {
                            "office.reading_selection"
                        } else {
                            "office.quote_selection"
                        },
                    ))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.office_selection(&select_tab, &select_lease, window, cx)
                    })),
            );
        }
        let had_snapshot = html.is_some();
        let mut body = div().relative().size_full();
        if !ready {
            let snapshot = if let Some(html) = html {
                self.document_body(path, Some(html.as_str()), None, Some(&revision), cx)
            } else {
                let message = if render_error.is_some() && watch_error.is_some() {
                    render_error.clone().unwrap()
                } else {
                    text::tr(lang, "office.preparing")
                };
                div()
                    .p(px(12.))
                    .text_size(px(TEXT_XS))
                    .child(message)
                    .into_any_element()
            };
            body = body.child(div().absolute().inset_0().child(snapshot));
        }
        if let Some(url) = url {
            body = body.child(
                div()
                    .absolute()
                    .inset_0()
                    .child(self.live_document_body(&tab, &url, ready, cx)),
            );
        }
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(head)
            .children((!ready).then_some(watch_error).flatten().map(|_| {
                div()
                    .px(px(8.))
                    .py(px(4.))
                    .text_size(px(TEXT_XS))
                    .muted(&p)
                    .child(text::tr(lang, "office.live_unavailable"))
            }))
            .children(
                render_error
                    .filter(|_| had_snapshot && !ready)
                    .map(|error| {
                        div()
                            .px(px(8.))
                            .py(px(4.))
                            .text_size(px(TEXT_XS))
                            .child(rust_i18n::t!(
                                "office.snapshot_failed",
                                locale = text::locale(lang),
                                error = error
                            ))
                    }),
            )
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }
    fn office_selection(
        &mut self,
        tab: &str,
        lease: &str,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(view) = self
            .office_views
            .get_mut(tab)
            .filter(|v| v.lease == lease && !v.selection_pending && v.live_ready)
        else {
            return;
        };
        view.selection_pending = true;
        let (owner, tab, lease, handle) = (
            view.owner.clone(),
            tab.to_string(),
            lease.to_string(),
            window.window_handle(),
        );
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<OfficeSelectionGet>(OfficeLeaseParams {
                    lease_id: lease.clone(),
                })
                .await;
            let _ = cx.update_window(handle, |_, window, cx| {
                this.update(cx, |this, cx| {
                    let Some(view) = this.office_views.get_mut(&tab).filter(|v| v.lease == lease)
                    else {
                        return;
                    };
                    view.selection_pending = false;
                    if this.selected.as_deref() != Some(&owner) {
                        return;
                    }
                    match result {
                        Ok(selection) => {
                            let old = this.input.read(cx).value().to_string();
                            let text = if old.trim().is_empty() {
                                selection.text
                            } else {
                                format!("{old}\n\n{}", selection.text)
                            };
                            this.input.update(cx, |input, cx| {
                                input.set_value(crate::skill_draft::content(text), window, cx)
                            });
                        }
                        Err(error) => this.notice = Some(super::Notice::Failed(error.to_string())),
                    }
                    cx.notify();
                })
                .ok();
            });
        })
        .detach();
        cx.notify();
    }
}
