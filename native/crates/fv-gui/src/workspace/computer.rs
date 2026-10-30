//! 电脑操控 in the window: the switch, the one-time download, the daemon this application runs for
//! the driver, and the macOS permissions it needs.
//!
//! The reconciling rule is in [`Workspace::computer_sync`]: the daemon runs exactly while the
//! setting is on, the component is installed and — on macOS — Accessibility and Screen Recording
//! are granted to this application. Everything that can change one of those inputs (a settings
//! push, a server notification, a permission poll) calls it, so there is one place that decides.

use std::time::Duration;

use super::Workspace;
use super::gpui::prelude::*;
use super::gpui::{AnyElement, Context, FontWeight, SharedString, div, px};
use super::settings::{
    card, dialog_card, dialog_foot_with_cancel, dialog_head, modal, outline_button, setting_row,
    switch,
};
use crate::computer_host::{self, Host, Pane, Permissions};
use crate::ui::{Muted as _, TEXT_XS};
use fv_protocol::methods::{ComputerHost, ComputerInstall, ComputerStatusGet};
use fv_protocol::types::{
    AppSettingsPatch, ComputerHostParams, ComputerInstallProgress, ComputerStatus, Empty,
};
use fv_theme::Token;

/// The label the driver shows for who is controlling the desktop.
const BUNDLE_ID: &str = "dev.fastvibe.desktop";

#[derive(Default)]
pub(super) struct ComputerUi {
    status: Option<ComputerStatus>,
    progress: Option<ComputerInstallProgress>,
    /// The driver install/update confirmation and progress dialog is open.
    install_dialog: bool,
    host: Option<Host>,
    /// Starting or registering the daemon is in flight.
    busy: bool,
    permissions: Permissions,
    error: Option<String>,
    /// A loop is waiting for the user to grant the permissions.
    polling: bool,
}

impl Workspace {
    pub(super) fn computer_install_dialog_is_open(&self) -> bool {
        self.computer.install_dialog
    }

    pub(super) fn computer_close_install_dialog(&mut self, cx: &mut Context<Self>) {
        self.computer.install_dialog = false;
        cx.notify();
    }

    /// Dev capture: canned state for `--settings computer[-downloading|-off]`.
    pub(super) fn computer_fixture(&mut self, name: &str) {
        self.app_settings.computer_control = name != "computer-off";
        self.computer.status = Some(ComputerStatus {
            supported: true,
            installed: name == "computer",
            installing: name == "computer-downloading",
            version: (name == "computer").then(|| "0.28.2".into()),
            running: false,
            ..Default::default()
        });
        if name == "computer-downloading" {
            self.computer.install_dialog = true;
            self.computer.progress = Some(ComputerInstallProgress {
                received: 17_400_000,
                total: 43_629_843,
            });
        }
    }

    pub(super) fn computer_refresh(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let call = backend.call::<ComputerStatusGet>(Empty {});
        cx.spawn(async move |this, cx| {
            if let Ok(status) = call.await {
                this.update(cx, |this, cx| {
                    this.computer.status = Some(status);
                    this.computer_sync(cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    pub(super) fn computer_status_changed(
        &mut self,
        status: ComputerStatus,
        cx: &mut Context<Self>,
    ) {
        self.computer.status = Some(status);
        self.computer_sync(cx);
        cx.notify();
    }

    pub(super) fn computer_progress(
        &mut self,
        progress: ComputerInstallProgress,
        cx: &mut Context<Self>,
    ) {
        self.computer.progress = Some(progress);
        cx.notify();
    }

    /// Make the daemon match what is wanted.
    pub(super) fn computer_sync(&mut self, cx: &mut Context<Self>) {
        let Some(status) = self.computer.status.clone() else {
            return;
        };
        self.computer.permissions = computer_host::permissions();
        if self.computer.busy {
            return;
        }
        // A daemon that died on its own is forgotten, so it can be started again.
        if let Some(host) = &mut self.computer.host
            && !host.alive()
        {
            self.computer.host = None;
            self.computer.error = Some(trs!(self.english(), "computer.daemon_exited").to_string());
        }
        let wanted = self.app_settings.computer_control && status.supported && status.installed;
        let permitted = !computer_host::GATED || self.computer.permissions.ready();
        if wanted && permitted {
            match &self.computer.host {
                None => self.computer_start(status, cx),
                // The server forgot the daemon (it restarted): tell it again.
                Some(host) if !status.running => {
                    let endpoint = host.endpoint().to_string();
                    self.computer_register(endpoint, cx);
                }
                Some(_) => {}
            }
        } else if self.computer.host.is_some() {
            self.computer_stop(cx);
        }
        if wanted && !permitted {
            self.computer_poll_permissions(cx);
        }
    }

    fn computer_start(&mut self, status: ComputerStatus, cx: &mut Context<Self>) {
        let Some(binary) = status.binary.map(std::path::PathBuf::from) else {
            return;
        };
        self.computer.busy = true;
        self.computer.error = None;
        let endpoint = computer_host::endpoint();
        cx.spawn(async move |this, cx| {
            let started = cx
                .background_executor()
                .spawn(async move { Host::start(&binary, &endpoint, BUNDLE_ID) })
                .await;
            this.update(cx, |this, cx| {
                this.computer.busy = false;
                match started {
                    Ok(host) => {
                        let endpoint = host.endpoint().to_string();
                        this.computer.host = Some(host);
                        this.computer_register(endpoint, cx);
                    }
                    Err(error) => this.computer.error = Some(error),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn computer_register(&mut self, endpoint: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let call = backend.call::<ComputerHost>(ComputerHostParams {
            socket: Some(endpoint),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                if let Err(error) = result {
                    // A daemon the server will not use is only a process holding a screen grant.
                    this.computer.host = None;
                    this.computer.error = Some(error.to_string());
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn computer_stop(&mut self, cx: &mut Context<Self>) {
        let host = self.computer.host.take();
        if let Some(backend) = self.backend.clone() {
            let call = backend.call::<ComputerHost>(ComputerHostParams { socket: None });
            cx.spawn(async move |_, _| {
                let _ = call.await;
            })
            .detach();
        }
        // Stopping waits for the process to leave: not on this thread.
        cx.background_executor()
            .spawn(async move { drop(host) })
            .detach();
    }

    fn computer_poll_permissions(&mut self, cx: &mut Context<Self>) {
        if std::mem::replace(&mut self.computer.polling, true) {
            return;
        }
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let keep = this
                    .update(cx, |this, cx| {
                        let now = computer_host::permissions();
                        let changed = now != this.computer.permissions;
                        let wanted = this.app_settings.computer_control;
                        if !wanted || now.ready() {
                            this.computer.polling = false;
                        }
                        if changed || now.ready() {
                            this.computer_sync(cx);
                            cx.notify();
                        }
                        wanted && !now.ready()
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn computer_install(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        if self.computer.status.as_ref().is_some_and(|s| s.installing) {
            return;
        }
        self.computer.install_dialog = true;
        self.computer.error = None;
        self.computer.progress = None;
        if let Some(status) = &mut self.computer.status {
            status.installing = true;
        }
        let call = backend.call::<ComputerInstall>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                this.computer.progress = None;
                match result {
                    Ok(status) => {
                        this.computer.status = Some(status);
                        this.computer.install_dialog = false;
                        this.computer_sync(cx);
                    }
                    Err(error) => {
                        this.computer.error = Some(error.to_string());
                        this.computer_refresh(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn computer_toggle(&mut self, cx: &mut Context<Self>) {
        let enable = !self.app_settings.computer_control;
        // Electron keeps the master switch unavailable until the driver exists. If the
        // user asks to turn it on before that, show the same driver dialog instead of
        // starting a download and leaving progress in the settings card.
        if enable
            && self
                .computer
                .status
                .as_ref()
                .is_some_and(|s| s.supported && !s.installed)
        {
            self.computer.install_dialog = true;
            cx.notify();
            return;
        }
        self.patch_settings(
            AppSettingsPatch {
                computer_control: Some(enable),
                ..Default::default()
            },
            cx,
        );
        if enable {
            if computer_host::GATED && !computer_host::permissions().ready() {
                computer_host::request_permissions();
            }
        }
        self.computer_sync(cx);
        cx.notify();
    }

    pub(super) fn computer_pane_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let status = self.computer.status.clone().unwrap_or_default();
        let on = self.app_settings.computer_control;
        let supported = self.computer.status.is_none() || status.supported;
        let can_toggle = supported && status.installed;
        let toggle = switch(SharedString::from("computer-control"), on, p)
            .when(!can_toggle, |d| d.opacity(0.4).cursor_default())
            .on_click(cx.listener(move |this, _, _, cx| {
                if can_toggle {
                    this.computer_toggle(cx)
                }
            }));
        let heading = |text: String| {
            div()
                .text_size(px(16.0))
                .line_height(px(22.0))
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(text))
        };
        let mut body = div().flex().flex_col().gap(px(20.0));
        if supported {
            let driver_description = if status.installing {
                trs!(english, "computer.downloading").to_string()
            } else if let Some(error) = status.error.clone().or_else(|| self.computer.error.clone())
            {
                error
            } else if status.installed {
                status.version.clone().unwrap_or_default()
            } else {
                trs!(english, "computer.driver_missing").to_string()
            };
            let driver_control = if status.installing {
                outline_button("computer-installing", p)
                    .opacity(0.5)
                    .cursor_default()
                    .child(trs!(english, "computer.downloading"))
            } else if status.installed {
                outline_button("computer-check-update", p)
                    .child(trs!(english, "computer.check_update"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.computer.install_dialog = true;
                        cx.notify();
                    }))
            } else {
                outline_button("computer-install", p)
                    .child(trs!(english, "computer.download"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.computer.install_dialog = true;
                        cx.notify();
                    }))
            };
            body = body
                .child(heading(trs!(english, "computer.driver").to_string()))
                .child(card(p).child(setting_row(
                    trs!(english, "computer.driver_name"),
                    &driver_description,
                    false,
                    p,
                    driver_control,
                )));
        }
        let line = |text: String| {
            div()
                .px(px(16.0))
                .py(px(8.0))
                .border_t_1()
                .border_color(p.c(Token::Border))
                .text_size(px(TEXT_XS))
                .muted(p)
                .child(SharedString::from(text))
        };
        if !supported {
            body =
                body.child(line(status.unsupported_reason.clone().unwrap_or_else(
                    || trs!(english, "computer.unsupported").to_string(),
                )));
        }
        if on && supported && computer_host::GATED {
            let perms = computer_host::permissions();
            body = body.child(heading(trs!(english, "computer.permissions").to_string()));
            let mut permissions = card(p);
            for (id, label, granted, pane) in [
                (
                    "computer-accessibility",
                    trs!(english, "computer.accessibility"),
                    perms.accessibility,
                    Pane::Accessibility,
                ),
                (
                    "computer-screen",
                    trs!(english, "computer.screen_recording"),
                    perms.screen_recording,
                    Pane::ScreenRecording,
                ),
            ] {
                permissions = permissions.child(setting_row(
                    label,
                    if granted {
                        trs!(english, "computer.granted")
                    } else {
                        trs!(english, "computer.not_granted")
                    },
                    true,
                    p,
                    div().when(!granted, |d| {
                        d.child(
                            outline_button(id, p)
                                .child(trs!(english, "computer.open_settings"))
                                .on_click(move |_, _, _| {
                                    computer_host::request_permissions();
                                    computer_host::open_settings(pane);
                                }),
                        )
                    }),
                ));
            }
            body = body.child(permissions);
            if !perms.ready() {
                body = body.child(line(trs!(english, "computer.relaunch_note").to_string()));
            }
        }
        body = body
            .child(heading(trs!(english, "computer.control").to_string()))
            .child(card(p).child(setting_row(
                trs!(english, "computer.allow"),
                trs!(english, "computer.allow_description"),
                false,
                p,
                toggle,
            )));
        if let Some(error) = &self.computer.error {
            body = body.child(
                div()
                    .px(px(16.0))
                    .py(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .text_size(px(TEXT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(error.clone())),
            );
        }
        body.into_any_element()
    }

    /// The driver install/update flow mirrors Electron's modal: the settings card only
    /// exposes the driver action, while bytes and retry state stay in this dialog.
    pub(super) fn computer_install_dialog(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.computer.install_dialog {
            return None;
        }
        let p = &self.palette;
        let english = self.english();
        let status = self.computer.status.clone().unwrap_or_default();
        let installing = status.installing;
        let description = if installing {
            match &self.computer.progress {
                Some(progress) if progress.total > 0 => tr!(
                    english,
                    "computer.downloading_progress",
                    received = super::format_bytes(progress.received),
                    total = super::format_bytes(progress.total)
                ),
                _ => trs!(english, "computer.downloading").to_string(),
            }
        } else if let Some(error) = status.error.clone().or_else(|| self.computer.error.clone()) {
            error
        } else {
            trs!(english, "computer.driver_dialog_description").to_string()
        };
        let confirm = if installing {
            trs!(english, "computer.download")
        } else if status.installed {
            trs!(english, "computer.update")
        } else if status.error.is_some() || self.computer.error.is_some() {
            trs!(english, "computer.retry")
        } else {
            trs!(english, "computer.download")
        };
        let body = dialog_card(p, 400.0)
            .child(dialog_head(
                trs!(english, "computer.driver_dialog_title"),
                &description,
                p,
            ))
            .child(dialog_foot_with_cancel(
                p,
                cx,
                |this, cx| {
                    this.computer.install_dialog = false;
                    cx.notify();
                },
                trs!(english, "computer.close"),
                confirm,
                |this, _, cx| this.computer_install(cx),
                installing,
            ));
        Some(modal(body, p, cx, |this| {
            this.computer.install_dialog = false;
        }))
    }
}
