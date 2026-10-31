//! Account identity and official connectivity only; credentials and PKCE stay on the server.
use super::*;
use fv_protocol::account::AccountState;
use fv_protocol::official::{OfficialConfigureParams, OfficialState, OfficialStatus};
use std::time::Duration;

#[cfg(test)]
#[path = "settings_account_tests.rs"]
mod tests;

pub(super) struct AccountSettings {
    account: Option<AccountState>,
    official: Option<OfficialState>,
    name: Entity<InputState>,
    generation: u64,
    reading: bool,
    busy: bool,
    official_busy: bool,
    error: Option<String>,
    official_error: Option<String>,
    notice: Option<String>,
    authorize_url: Option<String>,
    poll: Option<Task<()>>,
}
impl AccountSettings {
    pub(super) fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            account: None,
            official: None,
            name: input(window, cx, "", false),
            generation: 0,
            reading: false,
            busy: false,
            official_busy: false,
            error: None,
            official_error: None,
            notice: None,
            authorize_url: None,
            poll: None,
        }
    }
    pub(super) fn pause(&mut self) {
        self.poll = None;
    }
    fn observe_official(&mut self, state: OfficialState, window: &mut Window, cx: &mut App) {
        let current = self.name.read(cx).value().to_string();
        if self.official.as_ref().is_none_or(|old| current == old.name) {
            self.name.update(cx, |input, cx| {
                input.set_value(state.name.clone(), window, cx)
            });
        }
        self.official = Some(state);
        self.official_error = None;
    }
    fn observe_account(&mut self, state: AccountState, english: bool) {
        if matches!(state, AccountState::SignedIn { .. }) {
            self.error = None;
        }
        let ended = matches!(self.account, Some(AccountState::SigningIn { .. }))
            && matches!(state, AccountState::SignedOut { .. });
        if !matches!(state, AccountState::SigningIn { .. }) {
            self.authorize_url = None;
        }
        if ended {
            self.error = Some(trs!(english, "account.login_ended").into());
        }
        if let AccountState::SignedOut {
            error: Some(error), ..
        } = &state
        {
            self.error = Some(error.clone());
        }
        self.account = Some(state);
    }
}

fn official_label(status: &OfficialStatus, english: bool) -> &'static str {
    match status {
        OfficialStatus::Off => trs!(english, "account.official_off"),
        OfficialStatus::SignedOut => trs!(english, "account.official_signed_out"),
        OfficialStatus::Connecting => trs!(english, "account.official_connecting"),
        OfficialStatus::Online => trs!(english, "account.official_online"),
        OfficialStatus::Error => trs!(english, "account.official_error"),
    }
}

impl Workspace {
    pub(in super::super) fn open_account_settings(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_settings(Section::Remote, window, cx);
    }

    pub(super) fn refresh_account_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let a = &mut s.account;
        if a.reading || a.busy || a.official_busy {
            return;
        }
        a.reading = true;
        let owner = s.search.entity_id();
        let generation = a.generation;
        let account = backend.call::<AccountStatus>(Empty {});
        let official = backend.call::<OfficialStatusGet>(Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let account = account.await;
            let official = official.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let english = this.english();
                let Some(s) = this.settings.as_mut().filter(|s| {
                    s.search.entity_id() == owner && s.account.generation == generation
                }) else {
                    return;
                };
                let a = &mut s.account;
                a.reading = false;
                match account {
                    Ok(state) => {
                        a.error = None;
                        a.observe_account(state, english);
                    }
                    Err(_) => a.error = Some(trs!(english, "account.unavailable").into()),
                }
                match official {
                    Ok(state) => a.observe_official(state, window, cx),
                    Err(_) => {
                        a.official_error =
                            Some(trs!(english, "account.official_unavailable").into())
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn start_account_status_poll(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.account.poll.is_some() {
            return;
        }
        let owner = s.search.entity_id();
        s.account.poll = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let keep = this
                    .update_in(cx, |this, window, cx| {
                        let visible = this.settings.as_ref().is_some_and(|s| {
                            s.search.entity_id() == owner && s.section == Section::Remote
                        });
                        if visible {
                            this.refresh_account_settings(window, cx);
                        }
                        visible
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        }));
    }

    fn begin_account_login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.account.busy {
            return;
        }
        s.account.generation = s.account.generation.wrapping_add(1);
        let generation = s.account.generation;
        let owner = s.search.entity_id();
        s.account.reading = false;
        s.account.busy = true;
        s.account.error = None;
        s.account.notice = None;
        let call = backend.call::<AccountLogin>(Empty {});
        cx.spawn_in(window, async move |this, cx| {
            let result = call.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let english = this.english();
                let Some(s) = this.settings.as_mut().filter(|s| {
                    s.search.entity_id() == owner && s.account.generation == generation
                }) else {
                    return;
                };
                s.account.busy = false;
                match result {
                    Ok(reply) => {
                        s.account.authorize_url = Some(reply.authorize_url.clone());
                        let origin = match &s.account.account {
                            Some(
                                AccountState::SignedOut { origin, .. }
                                | AccountState::SigningIn { origin }
                                | AccountState::SignedIn { origin, .. },
                            ) => origin.clone(),
                            None => String::new(),
                        };
                        s.account.account = Some(AccountState::SigningIn { origin });
                        cx.open_url(&reply.authorize_url);
                    }
                    Err(_) => s.account.error = Some(trs!(english, "account.login_ended").into()),
                }
                this.refresh_account_settings(window, cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn end_account_login(&mut self, logout: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        // Cancel may supersede an outstanding login request; its late URL is never opened.
        s.account.generation = s.account.generation.wrapping_add(1);
        let generation = s.account.generation;
        let owner = s.search.entity_id();
        s.account.busy = true;
        s.account.official_busy = false;
        s.account.reading = false;
        s.account.authorize_url = None;
        s.account.error = None;
        cx.spawn_in(window, async move |this, cx| {
            let result = if logout {
                backend.call::<AccountLogout>(Empty {}).await
            } else {
                backend.call::<AccountCancelLogin>(Empty {}).await
            };
            let _ = this.update_in(cx, |this, window, cx| {
                let english = this.english();
                let Some(s) = this.settings.as_mut().filter(|s| {
                    s.search.entity_id() == owner && s.account.generation == generation
                }) else {
                    return;
                };
                s.account.busy = false;
                match result {
                    Ok(state) => {
                        s.account.account = Some(state);
                        s.account.error = None;
                    }
                    Err(_) => s.account.error = Some(trs!(english, "account.unavailable").into()),
                }
                this.refresh_account_settings(window, cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn configure_official_settings(
        &mut self,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.account.official_busy || s.account.busy {
            return;
        }
        let name = value(&s.account.name, cx);
        let name = if name.is_empty() {
            s.account
                .official
                .as_ref()
                .map(|s| s.name.clone())
                .unwrap_or_default()
        } else {
            name
        };
        s.account.generation = s.account.generation.wrapping_add(1);
        let generation = s.account.generation;
        let owner = s.search.entity_id();
        s.account.reading = false;
        s.account.official_busy = true;
        s.account.official_error = None;
        s.account.notice = None;
        let call = backend.call::<OfficialConfigure>(OfficialConfigureParams { enabled, name });
        cx.spawn_in(window, async move |this, cx| {
            let result = call.await;
            let _ = this.update_in(cx, |this, window, cx| {
                let english = this.english();
                let Some(s) = this.settings.as_mut().filter(|s| {
                    s.search.entity_id() == owner && s.account.generation == generation
                }) else {
                    return;
                };
                s.account.official_busy = false;
                match result {
                    Ok(state) => {
                        s.account.official = Some(state);
                        s.account.notice = Some(trs!(english, "account.saved").into());
                    }
                    Err(_) => {
                        s.account.official_error =
                            Some(trs!(english, "account.official_error").into())
                    }
                }
                this.refresh_account_settings(window, cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn account_settings_cards(
        &self,
        s: &SettingsState,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let english = self.english();
        let p = &self.palette;
        let a = &s.account;
        let mut account = card(p)
            .p(px(16.))
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "account.title")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "account.description")),
            );
        match &a.account {
            Some(AccountState::SignedIn { user, origin }) => {
                account =
                    account
                        .child(div().text_size(px(TEXT_SM)).child(user.login.clone()))
                        .child(div().text_size(px(TEXT_XS)).muted(p).child(origin.clone()))
                        .child(
                            outline_button("account-logout", p)
                                .when(a.busy, |d| d.opacity(0.5))
                                .child(if a.busy {
                                    trs!(english, "account.working")
                                } else {
                                    trs!(english, "account.sign_out")
                                })
                                .on_click(cx.listener(|this, _, window, cx| {
                                    if this.settings.as_ref().is_some_and(|s| {
                                        !s.account.busy && !s.account.official_busy
                                    }) {
                                        this.end_account_login(true, window, cx);
                                    }
                                })),
                        );
            }
            Some(AccountState::SigningIn { .. }) => {
                account = account.child(
                    div()
                        .text_size(px(TEXT_SM))
                        .child(trs!(english, "account.signing_in")),
                );
                if let Some(url) = &a.authorize_url {
                    let url = url.clone();
                    account = account.child(
                        outline_button("account-reopen", p)
                            .child(trs!(english, "account.reopen"))
                            .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url))),
                    );
                }
                account = account.child(
                    outline_button("account-cancel", p)
                        .child(trs!(english, "account.cancel"))
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.end_account_login(false, window, cx)
                        })),
                );
            }
            state => {
                account = account
                    .child(div().text_size(px(TEXT_SM)).muted(p).child(
                        if state.is_none() && a.reading {
                            trs!(english, "account.loading")
                        } else {
                            trs!(english, "account.signed_out")
                        },
                    ))
                    .child(
                        outline_button("account-login", p)
                            .when(a.busy || a.account.is_none(), |d| d.opacity(0.5))
                            .child(if a.busy {
                                trs!(english, "account.working")
                            } else {
                                trs!(english, "account.sign_in")
                            })
                            .on_click(cx.listener(|this, _, window, cx| {
                                if this.settings.as_ref().is_some_and(|s| {
                                    s.account.account.is_some()
                                        && !s.account.busy
                                        && !s.account.official_busy
                                }) {
                                    this.begin_account_login(window, cx);
                                }
                            })),
                    );
            }
        }
        if let Some(error) = &a.error {
            account = account.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(error.clone()),
            );
        }
        account = account.child(
            outline_button("account-refresh", p)
                .child(trs!(english, "account.refresh"))
                .on_click(
                    cx.listener(|this, _, window, cx| this.refresh_account_settings(window, cx)),
                ),
        );
        let mut official = card(p)
            .p(px(16.))
            .gap(px(8.))
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(trs!(english, "account.official_title")),
            )
            .child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(trs!(english, "account.official_description")),
            );
        if let Some(state) = &a.official {
            let enabled = state.enabled;
            let disabled = a.busy || a.official_busy;
            official = official
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .child(official_label(&state.status, english)),
                        )
                        .child(
                            switch("official-enabled".into(), enabled, p)
                                .when(disabled, |d| d.opacity(0.5))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if !disabled {
                                        this.configure_official_settings(!enabled, window, cx);
                                    }
                                })),
                        ),
                )
                .child(
                    div()
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(trs!(english, "account.computer_name")),
                )
                .child(crate::ui::input(&a.name))
                .child(
                    outline_button("official-save-name", p)
                        .when(disabled, |d| d.opacity(0.5))
                        .child(if a.official_busy {
                            trs!(english, "account.working")
                        } else {
                            trs!(english, "account.save")
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if !disabled {
                                this.configure_official_settings(enabled, window, cx);
                            }
                        })),
                );
            if state.error.is_some() {
                official = official.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .text_color(p.c(Token::Destructive))
                        .child(trs!(english, "account.official_error")),
                );
            }
            if !state.peers.is_empty() {
                official = official.child(
                    div()
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(trs!(english, "account.connected_devices")),
                );
                for peer in &state.peers {
                    official =
                        official.child(div().text_size(px(TEXT_SM)).child(peer.name.clone()));
                }
            }
            if state.status == OfficialStatus::Error {
                official = official.child(
                    outline_button("official-retry", p)
                        .child(trs!(english, "account.retry"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if !disabled {
                                this.configure_official_settings(enabled, window, cx);
                            }
                        })),
                );
            }
        } else {
            official = official.child(div().text_size(px(TEXT_XS)).muted(p).child(if a.reading {
                trs!(english, "account.loading")
            } else {
                trs!(english, "account.official_unavailable")
            }));
        }
        if let Some(error) = &a.official_error {
            official = official.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(error.clone()),
            );
        }
        if let Some(notice) = &a.notice {
            official = official.child(div().text_size(px(TEXT_XS)).muted(p).child(notice.clone()));
        }
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(account)
            .child(official)
            .into_any_element()
    }
}
