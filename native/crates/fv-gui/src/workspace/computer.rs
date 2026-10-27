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
use super::settings::{card, outline_button, setting_row, switch};
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
    host: Option<Host>,
    /// Starting or registering the daemon is in flight.
    busy: bool,
    permissions: Permissions,
    error: Option<String>,
    /// A loop is waiting for the user to grant the permissions.
    polling: bool,
}

impl Workspace {
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
            if self
                .computer
                .status
                .as_ref()
                .is_some_and(|s| s.supported && !s.installed)
            {
                self.computer_install(cx);
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
        let toggle = switch(SharedString::from("computer-control"), on, p)
            .when(!supported, |d| d.opacity(0.4))
            .on_click(cx.listener(move |this, _, _, cx| {
                if supported {
                    this.computer_toggle(cx)
                }
            }));
        let mut body = card(p).child(setting_row(
            trs!(english, "computer.allow"),
            trs!(english, "computer.allow_description"),
            false,
            p,
            toggle,
        ));
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
        } else if status.installing {
            let text = match &self.computer.progress {
                Some(p) if p.total > 0 => tr!(
                    english,
                    "computer.downloading_progress",
                    received = super::format_bytes(p.received),
                    total = super::format_bytes(p.total)
                ),
                _ => trs!(english, "computer.downloading").to_string(),
            };
            body = body.child(line(text));
        } else if status.installed {
            let version = status.version.clone().unwrap_or_default();
            let running = self.computer.host.is_some() && status.running;
            body = body.child(line(tr!(
                english,
                "computer.installed",
                version = version,
                state = if running {
                    trs!(english, "computer.running")
                } else if on {
                    trs!(english, "computer.waiting")
                } else {
                    trs!(english, "computer.stopped")
                }
            )));
        } else if on {
            body = body.child(
                div()
                    .px(px(16.0))
                    .py(px(10.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .child(
                        outline_button("computer-install", p)
                            .child(trs!(english, "computer.download"))
                            .on_click(cx.listener(|this, _, _, cx| this.computer_install(cx))),
                    ),
            );
        }
        if on && supported && computer_host::GATED {
            let perms = computer_host::permissions();
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
                body = body.child(setting_row(
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
            if !perms.ready() {
                body = body.child(line(trs!(english, "computer.relaunch_note").to_string()));
            }
        }
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
}
