//! LAN connection settings. Credentials stay in a masked draft and are only sent to the server.
use super::*;
use fv_protocol::remote::*;
#[path = "remote_qr.rs"]
mod qr;

pub(super) struct RemoteSettings {
    status: Option<RemoteStatus>,
    loading: bool,
    saving: bool,
    notice: Option<String>,
    password: Entity<InputState>,
    port: Entity<InputState>,
    name: Entity<InputState>,
}
impl RemoteSettings {
    pub(super) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            status: None,
            loading: false,
            saving: false,
            notice: None,
            password: input(window, cx, "", true),
            port: input(window, cx, "7777", false),
            name: input(window, cx, "", false),
        }
    }
}
impl Workspace {
    pub(super) fn refresh_remote_settings(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.remote.loading || s.remote.saving {
            return;
        }
        s.remote.loading = true;
        s.remote.notice = None;
        let owner = s.search.entity_id();
        let call = b.call::<RemoteStatusGet>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.remote.loading = false;
                    match result {
                        Ok(status) => s.remote.status = Some(status),
                        Err(e) => s.remote.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn configure_remote(&mut self, enabled: bool, cx: &mut Context<Self>) {
        let english = self.english();
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.remote.saving {
            return;
        }
        let port_text = value(&s.remote.port, cx);
        let port = if port_text.is_empty() {
            s.remote.status.as_ref().map_or(7777, |s| s.port)
        } else {
            match port_text.parse::<u16>().ok().filter(|p| *p > 0) {
                Some(p) => p,
                None => {
                    s.remote.notice = Some(trs!(english, "settings.proxy_invalid_port").into());
                    cx.notify();
                    return;
                }
            }
        };
        s.remote.saving = true;
        s.remote.notice = None;
        let owner = s.search.entity_id();
        let name = value(&s.remote.name, cx);
        let name = (!name.trim().is_empty()).then_some(name);
        let call = b.call::<RemoteConfigure>(RemoteConfigureParams {
            enabled,
            port,
            name,
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.remote.saving = false;
                    match result {
                        Ok(status) => {
                            s.remote.status = Some(status);
                            s.remote.notice = Some(trs!(english, "settings.saved").into());
                        }
                        Err(e) => s.remote.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn save_remote_password(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.remote.saving {
            return;
        }
        let password = s.remote.password.read(cx).value().to_string();
        if password.is_empty() {
            return;
        }
        // Clear before dispatch, so no completed request leaves credentials in the UI draft.
        s.remote
            .password
            .update(cx, |st, cx| st.set_value("", window, cx));
        s.remote.saving = true;
        s.remote.notice = None;
        let owner = s.search.entity_id();
        let call = b.call::<RemoteSetPassword>(RemotePasswordParams { password });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                let english = this.english();
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.remote.saving = false;
                    match result {
                        Ok(status) => {
                            s.remote.status = Some(status);
                            s.remote.notice = Some(trs!(english, "settings.saved").into());
                        }
                        Err(e) => s.remote.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    fn revoke_remote_device(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.remote.saving {
            return;
        }
        s.remote.saving = true;
        let owner = s.search.entity_id();
        let call = b.call::<RemoteRevoke>(RemoteRevokeParams { device_id: id });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(s) = this
                    .settings
                    .as_mut()
                    .filter(|s| s.search.entity_id() == owner)
                {
                    s.remote.saving = false;
                    match result {
                        Ok(status) => s.remote.status = Some(status),
                        Err(e) => s.remote.notice = Some(e.to_string()),
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn remote_settings_pane(
        &self,
        s: &SettingsState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let r = &s.remote;
        let busy = r.loading || r.saving;
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(self.account_settings_cards(s, cx));
        if let Some(status) = &r.status {
            let enabled = status.enabled;
            body = body
                .child(
                    card(p).child(setting_row(
                        trs!(english, "settings.remote_enabled"),
                        if status.listening {
                            trs!(english, "settings.remote_listening")
                        } else {
                            trs!(english, "settings.remote_stopped")
                        },
                        false,
                        p,
                        switch("native-remote-enabled".into(), enabled, p)
                            .when(busy, |d| d.opacity(0.5))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !busy {
                                    this.configure_remote(!enabled, cx);
                                }
                            })),
                    )),
                )
                .child(
                    card(p)
                        .p(px(16.))
                        .gap(px(8.))
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(tr!(
                            english,
                            "settings.remote_port",
                            port = status.port
                        )))
                        .child(crate::ui::input(&r.port))
                        .child(
                            outline_button("remote-save-port", p)
                                .when(busy, |d| d.opacity(0.5))
                                .child(trs!(english, "settings.save"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if !busy {
                                        this.configure_remote(enabled, cx);
                                    }
                                })),
                        )
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(
                            if status.password_configured {
                                trs!(english, "settings.remote_password_saved")
                            } else {
                                trs!(english, "settings.remote_password_needed")
                            },
                        ))
                        .child(crate::ui::input(&r.password).mask_toggle())
                        .child(
                            outline_button("remote-password", p)
                                .when(busy, |d| d.opacity(0.5))
                                .child(trs!(english, "settings.remote_save_password"))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if !busy {
                                        this.save_remote_password(window, cx);
                                    }
                                })),
                        ),
                );
            body = body.child(
                card(p)
                    .p(px(16.))
                    .gap(px(8.))
                    .child(div().text_size(px(TEXT_SM)).child(status.name.clone()))
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "settings.remote_device_name")),
                    )
                    .child(crate::ui::input(&r.name))
                    .child(
                        outline_button("remote-save-name", p)
                            .when(busy, |d| d.opacity(0.5))
                            .child(trs!(english, "settings.save"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !busy {
                                    this.configure_remote(enabled, cx);
                                }
                            })),
                    ),
            );
            if status.listening && status.password_configured {
                for address in &status.addresses {
                    let mut row = card(p)
                        .p(px(16.))
                        .gap(px(8.))
                        .child(div().text_size(px(TEXT_SM)).child(address.clone()));
                    if let Some(image) = qr::image(address, &status.name, &status.install_id) {
                        row = row.child(img(image).w(px(224.)).h(px(224.)));
                    }
                    body = body.child(row);
                }
            }
            for device in &status.devices {
                let id = device.id.clone();
                body = body.child(setting_row(
                    &device.label,
                    "",
                    false,
                    p,
                    outline_button(SharedString::from(format!("remote-revoke-{id}")), p)
                        .child(trs!(english, "settings.remote_revoke"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !busy {
                                this.revoke_remote_device(id.clone(), cx);
                            }
                        })),
                ));
            }
        } else {
            body = body.child(onboarding::unavailable_pane(
                p,
                self.app_settings.language,
                trs!(english, "settings.remote_preview_title"),
                trs!(english, "settings.remote_preview_desc"),
            ));
        }
        if let Some(notice) = &r.notice {
            body = body.child(div().text_size(px(TEXT_XS)).child(notice.clone()));
        }
        body.child(
            outline_button("remote-refresh", p)
                .when(busy, |d| d.opacity(0.5))
                .child(if busy {
                    trs!(english, "settings.loading")
                } else {
                    trs!(english, "settings.refresh")
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !busy {
                        this.refresh_remote_settings(cx);
                    }
                })),
        )
        .into_any_element()
    }
}
