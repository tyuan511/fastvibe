//! MCP settings: status and actions use the shared server catalog. JSON edits are explicit and
//! never refreshed underneath a draft; a status notification carries no configuration secrets.

use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::{Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, card, outline_button};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};

#[path = "mcp_form.rs"]
mod form;

#[path = "mcp_login.rs"]
mod login;

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

pub struct McpSettings {
    session: u64,
    request: u64,
    servers: Option<Vec<McpServerStatus>>,
    editor: Entity<TextareaState>,
    busy: bool,
    notice: Option<String>,
    remove: Option<String>,
    resources: Option<String>,
    diagnostics: Option<String>,
    form: Option<form::Form>,
    login_form: Option<login::Form>,
    login: Option<login::Login>,
}

impl McpSettings {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            session: next_id(),
            request: 0,
            servers: None,
            editor: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(6, 20)
                    .placeholder("粘贴 mcpServers / servers JSON，或编辑完整配置数组")
            }),
            busy: false,
            notice: None,
            remove: None,
            resources: None,
            diagnostics: None,
            form: None,
            login_form: None,
            login: None,
        }
    }
}

impl Workspace {
    pub(super) fn refresh_mcp(&mut self, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_mut().filter(|s| s.section == Section::Mcp) else {
            return;
        };
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let request = next_id();
        s.mcp.request = request;
        let call = backend.call::<McpList>(Empty {});
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let english = this.app_settings.language == UiLanguage::English;
                if let Some(s) = this.settings.as_mut().filter(|s| s.mcp.request == request) {
                    match result {
                        Ok(r) => s.mcp.servers = Some(r.servers),
                        Err(e) => {
                            s.mcp.notice = Some(if english {
                                format!("Could not read MCP: {e}")
                            } else {
                                format!("无法读取 MCP：{e}")
                            })
                        }
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    fn finish_mcp(
        &mut self,
        session: u64,
        result: Result<McpListResponse, String>,
        cx: &mut Context<Self>,
    ) {
        let english = self.app_settings.language == UiLanguage::English;
        if let Some(s) = self.settings.as_mut().filter(|s| s.mcp.session == session) {
            s.mcp.busy = false;
            match result {
                Ok(r) => {
                    s.mcp.servers = Some(r.servers);
                    s.mcp.notice = Some(
                        if english {
                            "Configuration updated"
                        } else {
                            "配置已更新"
                        }
                        .into(),
                    );
                }
                Err(e) => s.mcp.notice = Some(e),
            }
        }
        self.refresh_mcp(cx);
        cx.notify();
    }

    fn save_mcp_editor(&mut self, replace: bool, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.busy {
            return;
        }
        let text = s.mcp.editor.read(cx).value().to_string();
        let session = s.mcp.session;
        let configs = if replace {
            match serde_json::from_str::<Vec<McpServerConfig>>(&text) {
                Ok(configs) => Some(configs),
                Err(e) => {
                    s.mcp.notice = Some(format!("完整配置需要数组：{e}"));
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        s.mcp.busy = true;
        s.mcp.notice = None;
        cx.spawn(async move |this, cx| {
            let result = match configs {
                Some(servers) => backend.call::<McpSet>(McpSetParams { servers }).await,
                None => {
                    backend
                        .call::<McpImport>(McpImportParams { json: text })
                        .await
                }
            }
            .map_err(|e| format!("无法保存 MCP：{e}"));
            this.update(cx, |this, cx| this.finish_mcp(session, result, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn edit_mcp(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let Some(servers) = &s.mcp.servers else {
            return;
        };
        let configs: Vec<_> = servers.iter().map(|s| &s.config).collect();
        let text = serde_json::to_string_pretty(&configs).unwrap_or_default();
        s.mcp
            .editor
            .update(cx, |state, cx| state.set_value(text, window, cx));
        cx.notify();
    }

    fn change_mcp(&mut self, id: &str, remove: bool, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.busy {
            return;
        }
        let Some(servers) = &s.mcp.servers else {
            return;
        };
        let Some(original) = servers
            .iter()
            .find(|server| server.config.id == id)
            .map(|server| server.config.clone())
        else {
            return;
        };
        let config = if remove {
            None
        } else {
            let mut config = original.clone();
            config.enabled = !config.enabled;
            Some(config)
        };
        let params = McpUpdateParams {
            server_id: id.into(),
            expected: Some(original),
            config,
        };
        let session = s.mcp.session;
        s.mcp.busy = true;
        s.mcp.remove = None;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<McpUpdate>(params)
                .await
                .map_err(|e| e.to_string());
            this.update(cx, |this, cx| this.finish_mcp(session, result, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn reconnect_mcp(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.busy {
            return;
        }
        let session = s.mcp.session;
        s.mcp.busy = true;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<McpReconnect>(McpServerParams { server_id: id })
                .await
                .map_err(|e| e.to_string());
            this.update(cx, |this, cx| this.finish_mcp(session, result, cx))
                .ok();
        })
        .detach();
        cx.notify();
    }

    fn show_mcp_resources(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        let session = s.mcp.session;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<McpResources>(McpResourceListParams {
                    server_id: Some(id),
                    cursor: None,
                })
                .await;
            this.update(cx, |this, cx| {
                if let Some(s) = this.settings.as_mut().filter(|s| s.mcp.session == session) {
                    match result {
                        Ok(r) => {
                            s.mcp.resources = Some(
                                serde_json::to_string_pretty(&r.data)
                                    .unwrap_or_default()
                                    .chars()
                                    .take(64000)
                                    .collect(),
                            )
                        }
                        Err(e) => s.mcp.notice = Some(format!("无法读取资源：{e}")),
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn mcp_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let s = &settings.mcp;
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let mut pane = div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .child(
                outline_button("add-mcp-form", p)
                    .child(if english {
                        "Add server"
                    } else {
                        "添加服务器"
                    })
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_mcp_form(None, window, cx)),
                    ),
            )
            .child(div().text_size(px(TEXT_SM)).muted(p).child(if english {
                "Connect local or remote MCP servers to add tools and resources to chats."
            } else {
                "连接本地或远程 MCP 服务器，为对话添加工具和资源。"
            }))
            .child(
                outline_button("refresh-mcp", p)
                    .child(if english {
                        "Refresh status"
                    } else {
                        "刷新状态"
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_mcp(cx))),
            );
        if let Some(notice) = &s.notice {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_SM))
                    .child(SharedString::from(notice.clone())),
            );
        }
        if let Some(servers) = &s.servers {
            if servers.is_empty() {
                pane = pane.child(card(p).p(px(16.0)).child(if english {
                    "No MCP servers yet. Add a server or import a configuration."
                } else {
                    "还没有 MCP 服务器，点击添加服务器或导入配置。"
                }));
            }
            for server in servers {
                let id = server.config.id.clone();
                let toggle = id.clone();
                let reconnect = id.clone();
                let remove = id.clone();
                let resources = id.clone();
                let diagnostics = id.clone();
                let edit = id.clone();
                let authorize = id.clone();
                let forget = id.clone();
                let state = if !server.config.enabled {
                    if english { "Disabled" } else { "已停用" }
                } else if server.connected {
                    if english { "Connected" } else { "已连接" }
                } else if server.connecting {
                    if english {
                        "Connecting…"
                    } else {
                        "正在连接…"
                    }
                } else {
                    if english { "Disconnected" } else { "未连接" }
                };
                let mut row = card(p)
                    .p(px(16.0))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child(SharedString::from(format!(
                                "{} · {state}",
                                server.config.name
                            ))),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(if english {
                                format!("{} tools · {}", server.tools.len(), id)
                            } else {
                                format!("{} 个工具 · {}", server.tools.len(), id)
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.0))
                            .child(
                                outline_button(SharedString::from(format!("edit-mcp-{id}")), p)
                                    .child(if english { "Edit" } else { "编辑" })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.open_mcp_form(Some(&edit), window, cx)
                                    })),
                            )
                            .child(
                                outline_button(SharedString::from(format!("toggle-mcp-{id}")), p)
                                    .child(if server.config.enabled {
                                        if english { "Disable" } else { "停用" }
                                    } else {
                                        if english { "Enable" } else { "启用" }
                                    })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.change_mcp(&toggle, false, cx)
                                    })),
                            )
                            .child(
                                outline_button(
                                    SharedString::from(format!("reconnect-mcp-{id}")),
                                    p,
                                )
                                .child(if english { "Reconnect" } else { "重新连接" })
                                .on_click(cx.listener(
                                    move |this, _, _, cx| this.reconnect_mcp(reconnect.clone(), cx),
                                )),
                            )
                            .child(
                                outline_button(
                                    SharedString::from(format!("resources-mcp-{id}")),
                                    p,
                                )
                                .child(if english { "Resources" } else { "资源" })
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.show_mcp_resources(resources.clone(), cx)
                                    },
                                )),
                            )
                            .child(
                                outline_button(
                                    SharedString::from(format!("diagnostics-mcp-{id}")),
                                    p,
                                )
                                .child(if english { "Diagnostics" } else { "诊断" })
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        if let Some(s) = this.settings.as_mut() {
                                            s.mcp.diagnostics = if s.mcp.diagnostics.as_ref()
                                                == Some(&diagnostics)
                                            {
                                                None
                                            } else {
                                                Some(diagnostics.clone())
                                            };
                                        }
                                        this.refresh_mcp(cx);
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                outline_button(SharedString::from(format!("remove-mcp-{id}")), p)
                                    .child(if english { "Delete" } else { "删除" })
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Some(s) = this.settings.as_mut() {
                                            s.mcp.remove = Some(remove.clone());
                                        }
                                        cx.notify();
                                    })),
                            ),
                    );
                if let Some(error) = &server.error {
                    row = row.child(
                        div()
                            .text_size(px(TEXT_XS))
                            .text_color(p.c(Token::Warning))
                            .child(SharedString::from(error.clone())),
                    );
                }
                if s.diagnostics.as_deref() == Some(&id) {
                    row = row.child(
                        div().text_size(px(TEXT_XS)).child(SharedString::from(
                            server
                                .diagnostics
                                .clone()
                                .unwrap_or_else(|| "暂无进程诊断输出".into()),
                        )),
                    );
                }
                if server.config.transport == McpTransport::Http {
                    row = row.child(
                        div()
                            .flex()
                            .gap(px(8.0))
                            .child(
                                outline_button(
                                    SharedString::from(format!("authorize-mcp-{id}")),
                                    p,
                                )
                                .child(if server.oauth_credentials {
                                    if english {
                                        "Reauthorize OAuth"
                                    } else {
                                        "重新登录 OAuth"
                                    }
                                } else {
                                    if english {
                                        "OAuth login"
                                    } else {
                                        "OAuth 登录"
                                    }
                                })
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        this.open_mcp_login(authorize.clone(), window, cx)
                                    },
                                )),
                            )
                            .when(server.oauth_credentials, |row| {
                                row.child(
                                    outline_button(
                                        SharedString::from(format!("forget-mcp-{id}")),
                                        p,
                                    )
                                    .child(if english { "Log out" } else { "退出登录" })
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.forget_mcp_login(forget.clone(), cx)
                                        },
                                    )),
                                )
                            }),
                    );
                }
                pane = pane.child(row);
            }
        } else {
            pane = pane.child(if english {
                "Loading MCP configuration…"
            } else {
                "正在读取 MCP 配置…"
            });
        }
        if let Some(id) = &s.remove {
            let id = id.clone();
            pane = pane.child(
                card(p)
                    .p(px(12.0))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(if english {
                        "Delete this MCP server configuration?"
                    } else {
                        "删除这个 MCP 服务器配置？"
                    })
                    .child(
                        outline_button("confirm-remove-mcp", p)
                            .child(if english {
                                "Confirm delete"
                            } else {
                                "确认删除"
                            })
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.change_mcp(&id, true, cx)),
                            ),
                    )
                    .child(
                        outline_button("cancel-remove-mcp", p)
                            .child(if english { "Cancel" } else { "取消" })
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.mcp.remove = None;
                                }
                                cx.notify();
                            })),
                    ),
            );
        }
        if let Some(resources) = &s.resources {
            pane = pane.child(
                card(p)
                    .p(px(12.0))
                    .text_size(px(TEXT_XS))
                    .child(SharedString::from(resources.clone())),
            );
        }
        if s.form.is_some() {
            pane = pane.child(self.mcp_form(cx));
        }
        if s.login_form.is_some() {
            pane = pane.child(self.mcp_login_form(cx));
        }
        pane.child(
            card(p)
                .p(px(16.0))
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(if english {
                    "Add or edit configuration"
                } else {
                    "添加或编辑配置"
                })
                .child(
                    outline_button("edit-mcp-configs", p)
                        .child(if english {
                            "Edit current configuration"
                        } else {
                            "编辑现有配置"
                        })
                        .on_click(cx.listener(|this, _, window, cx| this.edit_mcp(window, cx))),
                )
                .child(Textarea::new(&s.editor))
                .child(
                    div()
                        .flex()
                        .gap(px(8.0))
                        .child(
                            outline_button("import-mcp-configs", p)
                                .child(if english {
                                    "Import or update"
                                } else {
                                    "导入或更新"
                                })
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.save_mcp_editor(false, cx)),
                                ),
                        )
                        .child(
                            outline_button("save-mcp-configs", p)
                                .child(if s.busy {
                                    if english {
                                        "Saving…"
                                    } else {
                                        "正在保存…"
                                    }
                                } else {
                                    if english {
                                        "Save full configuration"
                                    } else {
                                        "保存完整配置"
                                    }
                                })
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.save_mcp_editor(true, cx)),
                                ),
                        ),
                ),
        )
        .into_any_element()
    }
}
