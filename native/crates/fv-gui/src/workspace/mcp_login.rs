//! MCP OAuth controls. The browser callback listener runs in the client's backend runtime.

use fv_protocol::methods::McpAuthForget;
use fv_protocol::types::*;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::*;

use super::super::Workspace;
use super::super::settings::{card, outline_button};
use crate::backend::OAuthCancellation;

pub(super) struct Form {
    server: String,
    client_id: Entity<InputState>,
    client_secret: Entity<InputState>,
    scopes: Entity<InputState>,
}

pub(super) struct Login {
    job: u64,
    server: String,
    url: Option<String>,
    _cancel: OAuthCancellation,
}

fn input(
    placeholder: &'static str,
    secret: bool,
    window: &mut Window,
    cx: &mut App,
) -> Entity<InputState> {
    cx.new(|cx| {
        InputState::new(window, cx)
            .placeholder(placeholder)
            .masked(secret)
    })
}

impl Workspace {
    pub(in super::super) fn open_mcp_login(
        &mut self,
        server: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.login.is_some() {
            return;
        }
        let english = self.app_settings.language == UiLanguage::English;
        s.mcp.login_form = Some(Form {
            server,
            client_id: input(
                if english {
                    "Client ID (optional; leave blank to register automatically)"
                } else {
                    "Client ID（可选，留空自动注册）"
                },
                false,
                window,
                cx,
            ),
            client_secret: input(
                if english {
                    "Client Secret (optional)"
                } else {
                    "Client Secret（可选）"
                },
                true,
                window,
                cx,
            ),
            scopes: input(
                if english {
                    "Scopes (optional, space separated)"
                } else {
                    "权限范围（可选，以空格分隔）"
                },
                false,
                window,
                cx,
            ),
        });
        s.mcp.notice = None;
        cx.notify();
    }

    fn start_mcp_login(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.login.is_some() {
            return;
        }
        let Some(form) = &s.mcp.login_form else {
            return;
        };
        let id = form.client_id.read(cx).value().trim().to_string();
        let secret = form.client_secret.read(cx).value().to_string();
        let scopes = form
            .scopes
            .read(cx)
            .value()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let server = form.server.clone();
        let (cancel, url, completion) = backend.start_mcp_oauth(
            server.clone(),
            (!id.is_empty()).then_some(id),
            (!secret.is_empty()).then_some(secret),
            scopes,
        );
        let job = super::next_id();
        let session = s.mcp.session;
        s.mcp.login = Some(Login {
            job,
            server,
            url: None,
            _cancel: cancel,
        });
        s.mcp.notice = None;
        cx.spawn(async move |this, cx| {
            if let Ok(url) = url.await {
                this.update(cx, |this, cx| {
                    if let Some(s) = this.settings.as_mut().filter(|s| s.mcp.session == session)
                        && let Some(login) = s.mcp.login.as_mut().filter(|login| login.job == job)
                    {
                        login.url = Some(url.clone());
                        cx.open_url(&url);
                        cx.notify();
                    }
                })
                .ok();
            }
            let result = completion.await;
            this.update(cx, |this, cx| {
                if let Some(s) = this.settings.as_mut().filter(|s| {
                    s.mcp.session == session
                        && s.mcp.login.as_ref().is_some_and(|login| login.job == job)
                }) {
                    s.mcp.login = None;
                    match result {
                        Ok(response) => {
                            s.mcp.servers = Some(response.servers);
                            s.mcp.notice = Some(
                                if this.app_settings.language == UiLanguage::English {
                                    "Signed in; reconnecting MCP"
                                } else {
                                    "已登录，正在重新连接 MCP"
                                }
                                .into(),
                            );
                            s.mcp.login_form = None;
                        }
                        Err(error) => {
                            s.mcp.notice =
                                Some(if this.app_settings.language == UiLanguage::English {
                                    format!("Sign-in did not finish: {error}")
                                } else {
                                    format!("登录未完成：{error}")
                                })
                        }
                    }
                }
                this.refresh_mcp(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(in super::super) fn forget_mcp_login(&mut self, server: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.busy {
            return;
        }
        if s.mcp
            .login
            .as_ref()
            .is_some_and(|login| login.server == server)
        {
            s.mcp.login = None;
        }
        let session = s.mcp.session;
        s.mcp.busy = true;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<McpAuthForget>(McpServerParams { server_id: server })
                .await
                .map_err(|e| e.to_string());
            let success = result.is_ok();
            this.update(cx, |this, cx| {
                this.finish_mcp(session, result, cx);
                if success
                    && let Some(s) = this.settings.as_mut().filter(|s| s.mcp.session == session)
                {
                    s.mcp.notice = Some(
                        if this.app_settings.language == UiLanguage::English {
                            "Signed out of MCP"
                        } else {
                            "已退出 MCP 登录"
                        }
                        .into(),
                    );
                }
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(in super::super) fn mcp_login_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(s) = &self.settings else {
            return div().into_any_element();
        };
        let Some(form) = &s.mcp.login_form else {
            return div().into_any_element();
        };
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut body = card(p)
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(if english {
                "OAuth sign-in"
            } else {
                "OAuth 登录"
            })
            .child(Input::new(&form.client_id))
            .child(Input::new(&form.client_secret).mask_toggle())
            .child(Input::new(&form.scopes));
        if let Some(login) = &s.mcp.login {
            body = body.child(if login.url.is_some() {
                if english {
                    "Complete authorization in your browser."
                } else {
                    "请在浏览器中完成授权。"
                }
            } else {
                if english {
                    "Preparing sign-in…"
                } else {
                    "正在准备登录…"
                }
            });
            if let Some(url) = &login.url {
                let url = url.clone();
                body = body.child(
                    outline_button("mcp-reopen-oauth", p)
                        .child(if english {
                            "Reopen authorization page"
                        } else {
                            "重新打开授权页"
                        })
                        .on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url))),
                );
            }
        } else {
            body = body.child(
                outline_button("mcp-start-oauth", p)
                    .child(if english {
                        "Open authorization page"
                    } else {
                        "打开授权页"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.start_mcp_login(cx))),
            );
        }
        body.child(
            outline_button("mcp-cancel-oauth", p)
                .child(if english { "Cancel" } else { "取消" })
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut() {
                        s.mcp.login = None;
                        s.mcp.login_form = None;
                    }
                    cx.notify();
                })),
        )
        .into_any_element()
    }
}
