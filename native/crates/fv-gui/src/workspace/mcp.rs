//! MCP settings: status and actions use the shared server catalog. JSON edits are explicit and
//! never refreshed underneath a draft; a status notification carries no configuration secrets.

use crate::ui::px;
use fv_protocol::methods::*;
use fv_protocol::types::Empty;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::component::input::TextareaState;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use super::personalization::{
    BadgeKind, badge, empty_box, field_label, ghost_icon, item_card, item_tile, outline_sm,
    primary_button,
};
use super::settings::{Section, card, menu_item, popover, switch};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, truncate};

#[path = "mcp_form.rs"]
mod form;

#[path = "mcp_login.rs"]
mod login;

const JSON_PLACEHOLDER: &str = r#"{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "env": { "API_KEY": "…" }
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}"#;

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
    /// The server whose ⋯ menu is open.
    menu: Option<String>,
    /// Whether the open form shows its JSON view, and whether that JSON is the whole list.
    json_view: bool,
    json_full: bool,
}

impl McpSettings {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            session: next_id(),
            request: 0,
            servers: None,
            editor: cx.new(|cx| {
                TextareaState::new(window, cx)
                    .auto_grow(12, 20)
                    .placeholder(JSON_PLACEHOLDER)
            }),
            busy: false,
            notice: None,
            remove: None,
            resources: None,
            diagnostics: None,
            form: None,
            login_form: None,
            login: None,
            menu: None,
            json_view: false,
            json_full: false,
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
                            s.mcp.notice = Some(tr!(english, "mcp.could_not_read_mcp_e", e = e))
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
                    s.mcp.notice = Some(trs!(english, "mcp.configuration_updated").into());
                }
                Err(e) => s.mcp.notice = Some(e),
            }
        }
        self.refresh_mcp(cx);
        cx.notify();
    }

    fn save_mcp_editor(&mut self, replace: bool, cx: &mut Context<Self>) {
        let english = self.english();
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
                    s.mcp.notice = Some(tr!(english, "mcp.the_full_configuration_must_be", e = e));
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
            .map_err(|e| tr!(english, "mcp.could_not_save_mcp_e", e = e));
            this.update(cx, |this, cx| {
                if result.is_ok()
                    && let Some(s) = this.settings.as_mut().filter(|s| s.mcp.session == session)
                {
                    s.mcp.form = None;
                    s.mcp.json_view = false;
                    s.mcp.json_full = false;
                }
                this.finish_mcp(session, result, cx)
            })
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
                let english = this.english();
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
                        Err(e) => {
                            s.mcp.notice =
                                Some(tr!(english, "mcp.could_not_read_the_resource", e = e))
                        }
                    }
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Whether the server form is open; `settings_dialogs` draws it over the pane.
    pub(super) fn mcp_form_open(&self) -> bool {
        self.settings.as_ref().is_some_and(|s| s.mcp.form.is_some())
    }

    pub(super) fn close_mcp_form(&mut self) {
        if let Some(s) = &mut self.settings {
            s.mcp.form = None;
        }
    }

    pub(super) fn mcp_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let s = &settings.mcp;
        let p = &self.palette;
        let english = self.english();
        let mut pane = div().flex().flex_col().gap(px(16.0)).child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .child(
                    div()
                        .text_size(px(TEXT_SM))
                        .font_weight(FontWeight::MEDIUM)
                        .child(trs!(english, "mcp.configured")),
                )
                .child(
                    primary_button("add-mcp-form", p)
                        .when(s.busy, |d| d.opacity(0.5))
                        .child(icon("add01", 14.0, p.c(Token::PrimaryForeground)))
                        .child(trs!(english, "mcp.add_server"))
                        .on_click(
                            cx.listener(|this, _, window, cx| this.open_mcp_form(None, window, cx)),
                        ),
                ),
        );
        if let Some(notice) = &s.notice {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(SharedString::from(notice.clone())),
            );
        }
        if s.login_form.is_some() {
            pane = pane.child(self.mcp_login_form(cx));
        }
        let fixture;
        let servers = match &s.servers {
            Some(servers) => Some(servers),
            None if cfg!(feature = "capture") && self.backend.is_none() => {
                fixture = capture_servers();
                Some(&fixture)
            }
            None => None,
        };
        match servers {
            None => {
                pane = pane.child(
                    div()
                        .text_size(px(TEXT_SM))
                        .muted(p)
                        .child(trs!(english, "mcp.loading_mcp_configuration")),
                );
            }
            Some(servers) if servers.is_empty() => {
                pane = pane.child(empty_box(
                    "plug01",
                    trs!(english, "mcp.empty"),
                    trs!(english, "mcp.empty_hint"),
                    p,
                ));
            }
            Some(servers) => {
                let mut list = div().flex().flex_col().gap(px(10.0));
                for server in servers {
                    list = list.child(self.mcp_row(server, cx));
                }
                pane = pane.child(list);
            }
        }
        if let Some(resources) = &s.resources {
            pane = pane.child(
                card(p)
                    .p(px(12.0))
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(field_label(trs!(english, "mcp.resources")))
                            .child(
                                ghost_icon(
                                    "close-mcp-resources",
                                    "cancel01",
                                    24.0,
                                    12.0,
                                    p.c(Token::MutedForeground),
                                    p,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        if let Some(s) = this.settings.as_mut() {
                                            s.mcp.resources = None;
                                        }
                                        cx.notify();
                                    },
                                )),
                            ),
                    )
                    .child(
                        div()
                            .font_family("monospace")
                            .text_size(px(TEXT_XS))
                            .child(SharedString::from(resources.clone())),
                    ),
            );
        }
        pane.into_any_element()
    }

    /// One server as Electron's `ServerRow`: plug tile, name and status badge, the command or
    /// URL, then switch / reconnect / edit / delete. OAuth, resources and diagnostics are this
    /// client's own and live behind ⋯.
    fn mcp_row(&self, server: &McpServerStatus, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let english = self.english();
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let s = &settings.mcp;
        let id = server.config.id.clone();
        let muted = p.c(Token::MutedForeground);
        let fg = p.c(Token::Foreground);
        let status = if server.connected {
            badge(
                BadgeKind::Secondary,
                Some("checkmark-circle02"),
                tr!(english, "mcp.tools_count", count = server.tools.len()),
                p,
            )
        } else if server.connecting {
            badge(
                BadgeKind::Outline,
                Some("loading03"),
                trs!(english, "mcp.connecting"),
                p,
            )
        } else if server.error.is_some() {
            badge(
                BadgeKind::Destructive,
                Some("alert-circle"),
                trs!(english, "mcp.connect_failed"),
                p,
            )
        } else {
            badge(
                BadgeKind::Outline,
                Some("alert-circle"),
                trs!(english, "mcp.disconnected"),
                p,
            )
        };
        let description = server
            .error
            .clone()
            .unwrap_or_else(|| match server.config.transport {
                McpTransport::Stdio => format!(
                    "{} {}",
                    server.config.command.as_deref().unwrap_or(""),
                    server.config.args.join(" ")
                ),
                McpTransport::Http => server.config.url.clone().unwrap_or_default(),
            });
        let toggle = id.clone();
        let reconnect = id.clone();
        let edit = id.clone();
        let remove = id.clone();
        let menu_id = id.clone();
        let confirm = s.remove.as_deref() == Some(&id);
        let busy = s.busy;
        let mut actions = div()
            .flex_none()
            .self_center()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                switch(
                    SharedString::from(format!("toggle-mcp-{id}")),
                    server.config.enabled,
                    p,
                )
                .when(busy, |d| d.opacity(0.5))
                .on_click(cx.listener(move |this, _, _, cx| this.change_mcp(&toggle, false, cx))),
            )
            .child(
                ghost_icon(
                    SharedString::from(format!("reconnect-mcp-{id}")),
                    "refresh01",
                    24.0,
                    12.0,
                    fg,
                    p,
                )
                .when(busy || !server.config.enabled, |d| d.opacity(0.5))
                .on_click(
                    cx.listener(move |this, _, _, cx| this.reconnect_mcp(reconnect.clone(), cx)),
                ),
            )
            .child(
                ghost_icon(
                    SharedString::from(format!("edit-mcp-{id}")),
                    "edit02",
                    24.0,
                    12.0,
                    fg,
                    p,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_mcp_form(Some(&edit), window, cx)
                })),
            );
        actions = if confirm {
            let cancel = id.clone();
            actions
                .child(
                    outline_sm(SharedString::from(format!("confirm-remove-mcp-{id}")), p)
                        .text_color(p.c(Token::Destructive))
                        .child(trs!(english, "mcp.confirm_delete"))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.change_mcp(&remove, true, cx)),
                        ),
                )
                .child(
                    ghost_icon(
                        SharedString::from(format!("cancel-remove-mcp-{cancel}")),
                        "cancel01",
                        24.0,
                        12.0,
                        muted,
                        p,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut() {
                            s.mcp.remove = None;
                        }
                        cx.notify();
                    })),
                )
        } else {
            actions.child(
                ghost_icon(
                    SharedString::from(format!("remove-mcp-{id}")),
                    "delete02",
                    24.0,
                    12.0,
                    fg,
                    p,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut() {
                        s.mcp.remove = Some(remove.clone());
                    }
                    cx.notify();
                })),
            )
        };
        let menu_open = s.menu.as_deref() == Some(&id);
        let mut more = div().relative().child(
            ghost_icon(
                SharedString::from(format!("more-mcp-{id}")),
                "more-horizontal",
                24.0,
                14.0,
                fg,
                p,
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(s) = this.settings.as_mut() {
                    s.mcp.menu = if s.mcp.menu.as_deref() == Some(menu_id.as_str()) {
                        None
                    } else {
                        Some(menu_id.clone())
                    };
                }
                cx.notify();
            })),
        );
        if menu_open {
            more = more.child(crate::ui::float(self.mcp_row_menu(server, cx)));
        }
        actions = actions.child(more);
        let mut card = item_card(p)
            .child(div().mt(px(2.0)).child(item_tile("plug01", 16.0, p)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .min_w_0()
                                    .text_size(px(16.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(truncate(server.config.name.clone())),
                            )
                            .child(status),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_SM))
                            .muted(p)
                            .child(truncate(description)),
                    ),
            );
        card = card.child(actions);
        if s.diagnostics.as_deref() == Some(&id) {
            return div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(card)
                .child(
                    div()
                        .px(px(12.0))
                        .font_family("monospace")
                        .text_size(px(TEXT_XS))
                        .muted(p)
                        .child(SharedString::from(
                            server
                                .diagnostics
                                .clone()
                                .unwrap_or_else(|| trs!(english, "mcp.no_diagnostics").into()),
                        )),
                )
                .into_any_element();
        }
        card.into_any_element()
    }

    /// The ⋯ menu: this client's extra actions on one server.
    fn mcp_row_menu(&self, server: &McpServerStatus, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let english = self.english();
        let hover = p.c(Token::Muted);
        let id = server.config.id.clone();
        let close = |this: &mut Workspace| {
            if let Some(s) = this.settings.as_mut() {
                s.mcp.menu = None;
            }
        };
        let resources = id.clone();
        let diagnostics = id.clone();
        let mut menu = popover(p)
            .absolute()
            .top(px(28.0))
            .right(px(0.0))
            .w(px(176.0))
            .child(
                menu_item(
                    SharedString::from(format!("resources-mcp-{id}")),
                    false,
                    hover,
                )
                .child(trs!(english, "mcp.resources"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    close(this);
                    this.show_mcp_resources(resources.clone(), cx);
                    cx.notify();
                })),
            )
            .child(
                menu_item(
                    SharedString::from(format!("diagnostics-mcp-{id}")),
                    false,
                    hover,
                )
                .child(trs!(english, "mcp.diagnostics"))
                .on_click(cx.listener(move |this, _, _, cx| {
                    close(this);
                    if let Some(s) = this.settings.as_mut() {
                        s.mcp.diagnostics = if s.mcp.diagnostics.as_ref() == Some(&diagnostics) {
                            None
                        } else {
                            Some(diagnostics.clone())
                        };
                    }
                    this.refresh_mcp(cx);
                    cx.notify();
                })),
            );
        if server.config.transport == McpTransport::Http {
            let authorize = id.clone();
            menu = menu.child(
                menu_item(
                    SharedString::from(format!("authorize-mcp-{id}")),
                    false,
                    hover,
                )
                .child(if server.oauth_credentials {
                    trs!(english, "mcp.reauthorize_oauth")
                } else {
                    trs!(english, "mcp.oauth_login")
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    close(this);
                    this.open_mcp_login(authorize.clone(), window, cx)
                })),
            );
            if server.oauth_credentials {
                let forget = id.clone();
                menu = menu.child(
                    menu_item(SharedString::from(format!("forget-mcp-{id}")), false, hover)
                        .child(trs!(english, "mcp.log_out"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            close(this);
                            this.forget_mcp_login(forget.clone(), cx)
                        })),
                );
            }
        }
        menu
    }
}

/// What the capture harness draws without a host: the three servers the Electron mock lists.
fn capture_servers() -> Vec<McpServerStatus> {
    let server = |id: &str, transport, command: Option<&str>, args: &[&str], url: Option<&str>| {
        McpServerConfig {
            id: id.into(),
            name: id.into(),
            transport,
            enabled: true,
            command: command.map(Into::into),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Default::default(),
            url: url.map(Into::into),
            headers: Default::default(),
            deferred: false,
        }
    };
    let status = |config, connected, tools: usize, error: Option<&str>| McpServerStatus {
        config,
        connected,
        connecting: false,
        tools: (0..tools).map(|i| format!("tool{i}")).collect(),
        error: error.map(Into::into),
        diagnostics: None,
        oauth_credentials: false,
    };
    let mut postgres = server(
        "postgres",
        McpTransport::Stdio,
        Some("npx"),
        &["-y", "pg"],
        None,
    );
    postgres.enabled = false;
    vec![
        status(
            server(
                "filesystem",
                McpTransport::Stdio,
                Some("npx"),
                &[
                    "-y",
                    "@modelcontextprotocol/server-filesystem",
                    "/Users/dev/code/fastvibe",
                ],
                None,
            ),
            true,
            4,
            None,
        ),
        status(
            server(
                "docs",
                McpTransport::Http,
                None,
                &[],
                Some("https://example.com/mcp"),
            ),
            true,
            1,
            None,
        ),
        status(postgres, false, 0, Some("not started")),
    ]
}
