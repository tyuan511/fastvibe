//! Per-server MCP editor. Argument boundaries and empty values are preserved; secrets stay
//! masked unless explicitly revealed, and saves compare the original config on the server.

use std::collections::BTreeMap;

use fv_protocol::methods::McpUpdate;
use fv_protocol::types::*;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::*;

use super::super::Workspace;
use super::super::settings::{card, outline_button};
use crate::ui::TEXT_SM;

pub(super) struct Form {
    original: Option<McpServerConfig>,
    id: String,
    name: Entity<InputState>,
    transport: McpTransport,
    command: Entity<InputState>,
    url: Entity<InputState>,
    args: Vec<Entity<InputState>>,
    env: Vec<Pair>,
    headers: Vec<Pair>,
    enabled: bool,
    deferred: bool,
    english: bool,
}

struct Pair {
    key: Entity<InputState>,
    value: Entity<InputState>,
}

fn input(
    value: &str,
    placeholder: &str,
    masked: bool,
    window: &mut Window,
    cx: &mut App,
) -> Entity<InputState> {
    cx.new(|cx| {
        let mut state = InputState::new(window, cx)
            .placeholder(SharedString::from(placeholder.to_owned()))
            .masked(masked);
        state.set_value(value.to_owned(), window, cx);
        state
    })
}

fn pair(key: &str, value: &str, english: bool, window: &mut Window, cx: &mut App) -> Pair {
    Pair {
        key: input(key, trs!(english, "mcp_form.name"), false, window, cx),
        value: input(value, trs!(english, "mcp_form.value"), true, window, cx),
    }
}

fn value(input: &Entity<InputState>, cx: &App) -> String {
    input.read(cx).value().to_string()
}

fn pairs(rows: &[Pair], english: bool, cx: &App) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    for row in rows {
        let key = value(&row.key, cx).trim().to_string();
        let value = value(&row.value, cx);
        if key.is_empty() {
            return Err(trs!(english, "mcp_form.enter_a_name_for_each").into());
        }
        if map.insert(key, value).is_some() {
            return Err(trs!(english, "mcp_form.environment_variable_or_header_names").into());
        }
    }
    Ok(map)
}

impl Form {
    fn new(
        config: Option<McpServerConfig>,
        english: bool,
        window: &mut Window,
        cx: &mut App,
    ) -> Self {
        let id = config.as_ref().map(|c| c.id.clone()).unwrap_or_else(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            format!("mcp-{}-{nanos}-{}", std::process::id(), super::next_id())
        });
        let args = config
            .as_ref()
            .map(|c| {
                c.args
                    .iter()
                    .map(|v| input(v, trs!(english, "mcp_form.argument"), false, window, cx))
                    .collect()
            })
            .unwrap_or_default();
        let env = config
            .as_ref()
            .map(|c| {
                c.env
                    .iter()
                    .map(|(k, v)| pair(k, v, english, window, cx))
                    .collect()
            })
            .unwrap_or_default();
        let headers = config
            .as_ref()
            .map(|c| {
                c.headers
                    .iter()
                    .map(|(k, v)| pair(k, v, english, window, cx))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            id,
            args,
            env,
            headers,
            name: input(
                config.as_ref().map(|c| c.name.as_str()).unwrap_or(""),
                trs!(english, "mcp_form.server_name"),
                false,
                window,
                cx,
            ),
            command: input(
                config
                    .as_ref()
                    .and_then(|c| c.command.as_deref())
                    .unwrap_or(""),
                trs!(english, "mcp_form.e_g_npx_or_an"),
                false,
                window,
                cx,
            ),
            url: input(
                config.as_ref().and_then(|c| c.url.as_deref()).unwrap_or(""),
                "https://…/mcp",
                false,
                window,
                cx,
            ),
            transport: config
                .as_ref()
                .map(|c| c.transport)
                .unwrap_or(McpTransport::Stdio),
            enabled: config.as_ref().is_none_or(|c| c.enabled),
            deferred: config.as_ref().is_none_or(|c| c.deferred),
            original: config,
            english,
        }
    }

    fn config(&self, cx: &App) -> Result<McpServerConfig, String> {
        let local = self.transport == McpTransport::Stdio;
        Ok(McpServerConfig {
            id: self.id.clone(),
            name: value(&self.name, cx).trim().into(),
            transport: self.transport,
            enabled: self.enabled,
            deferred: self.deferred,
            command: local.then(|| value(&self.command, cx).trim().into()),
            args: if local {
                self.args.iter().map(|v| value(v, cx)).collect()
            } else {
                vec![]
            },
            env: if local {
                pairs(&self.env, self.english, cx)?
            } else {
                Default::default()
            },
            url: (!local).then(|| value(&self.url, cx).trim().into()),
            headers: if local {
                Default::default()
            } else {
                pairs(&self.headers, self.english, cx)?
            },
        })
    }
}

impl Workspace {
    pub(in super::super) fn open_mcp_form(
        &mut self,
        id: Option<&str>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.busy {
            return;
        }
        let config = id.and_then(|id| {
            s.mcp
                .servers
                .as_ref()?
                .iter()
                .find(|s| s.config.id == id)
                .map(|s| s.config.clone())
        });
        if id.is_some() && config.is_none() {
            return;
        }
        let english = self.app_settings.language == UiLanguage::English;
        s.mcp.form = Some(Form::new(config, english, window, cx));
        s.mcp.notice = None;
        cx.notify();
    }

    fn save_mcp_form(&mut self, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        if s.mcp.busy {
            return;
        }
        let Some(form) = &s.mcp.form else {
            return;
        };
        let config = match form.config(cx) {
            Ok(c) => c,
            Err(e) => {
                s.mcp.notice = Some(e);
                cx.notify();
                return;
            }
        };
        let english = form.english;
        let params = McpUpdateParams {
            server_id: form.id.clone(),
            expected: form.original.clone(),
            config: Some(config),
        };
        let session = s.mcp.session;
        s.mcp.busy = true;
        s.mcp.notice = None;
        cx.spawn(async move |this, cx| {
            let result = backend
                .call::<McpUpdate>(params)
                .await
                .map_err(|e| tr!(english, "mcp_form.could_not_save_mcp_e", e = e));
            this.update(cx, |this, cx| {
                if result.is_ok()
                    && let Some(s) = this.settings.as_mut().filter(|s| s.mcp.session == session)
                {
                    s.mcp.form = None;
                }
                this.finish_mcp(session, result, cx);
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    pub(in super::super) fn mcp_form(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(s) = &self.settings else {
            return div().into_any_element();
        };
        let Some(form) = &s.mcp.form else {
            return div().into_any_element();
        };
        let p = &self.palette;
        let english = self.app_settings.language == UiLanguage::English;
        let label = |key: &'static str| div().text_size(px(TEXT_SM)).child(trs!(english, key));
        let mut body = card(p)
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(if form.original.is_some() {
                trs!(english, "mcp_form.edit_server")
            } else {
                trs!(english, "mcp_form.add_server")
            })
            .child(
                div()
                    .child(label("mcp_form.name"))
                    .child(Input::new(&form.name)),
            );
        let mut transports = div().flex().gap(px(8.0));
        for (transport, title) in [
            (McpTransport::Stdio, trs!(english, "mcp_form.local_process")),
            (McpTransport::Http, "Streamable HTTP"),
        ] {
            transports = transports.child(
                outline_button(
                    SharedString::from(format!("mcp-transport-{transport:?}")),
                    p,
                )
                .child(SharedString::from(format!(
                    "{}{title}",
                    if form.transport == transport {
                        "✓ "
                    } else {
                        ""
                    }
                )))
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                        && let Some(form) = &mut s.mcp.form
                    {
                        form.transport = transport;
                    }
                    cx.notify();
                })),
            );
        }
        body = body.child(transports);
        if form.transport == McpTransport::Stdio {
            body = body
                .child(
                    div()
                        .child(label("mcp_form.launch_command"))
                        .child(Input::new(&form.command)),
                )
                .child(label("mcp_form.arguments"));
            for (i, arg) in form.args.iter().enumerate() {
                body = body.child(
                    div()
                        .flex()
                        .gap(px(8.0))
                        .child(div().flex_1().child(Input::new(arg)))
                        .child(
                            outline_button(SharedString::from(format!("mcp-remove-arg-{i}")), p)
                                .child(trs!(english, "mcp_form.remove"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                        && let Some(form) = &mut s.mcp.form
                                        && i < form.args.len()
                                    {
                                        form.args.remove(i);
                                    }
                                    cx.notify();
                                })),
                        ),
                );
            }
            body = body.child(
                outline_button("mcp-add-arg", p)
                    .child(trs!(english, "mcp_form.add_argument"))
                    .on_click(cx.listener(|this, _, window, cx| {
                        if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                            && let Some(form) = &mut s.mcp.form
                        {
                            form.args.push(input(
                                "",
                                if form.english { "Argument" } else { "参数" },
                                false,
                                window,
                                cx,
                            ));
                        }
                        cx.notify();
                    })),
            );
        } else {
            body = body.child(
                div()
                    .child(label("mcp_form.server_url"))
                    .child(Input::new(&form.url)),
            );
        }
        let local = form.transport == McpTransport::Stdio;
        let rows = if local { &form.env } else { &form.headers };
        body = body.child(label(if local {
            "mcp_form.environment_variables"
        } else {
            "mcp_form.request_headers"
        }));
        for (i, row) in rows.iter().enumerate() {
            body = body.child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(div().flex_1().child(Input::new(&row.key)))
                    .child(div().flex_1().child(Input::new(&row.value).mask_toggle()))
                    .child(
                        outline_button(SharedString::from(format!("mcp-remove-pair-{i}")), p)
                            .child(trs!(english, "mcp_form.remove"))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                    && let Some(form) = &mut s.mcp.form
                                {
                                    let rows = if local {
                                        &mut form.env
                                    } else {
                                        &mut form.headers
                                    };
                                    if i < rows.len() {
                                        rows.remove(i);
                                    }
                                }
                                cx.notify();
                            })),
                    ),
            );
        }
        body = body.child(
            outline_button("mcp-add-pair", p)
                .child(if local {
                    trs!(english, "mcp_form.add_environment_variable")
                } else {
                    trs!(english, "mcp_form.add_request_header")
                })
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                        && let Some(form) = &mut s.mcp.form
                    {
                        let rows = if local {
                            &mut form.env
                        } else {
                            &mut form.headers
                        };
                        rows.push(pair("", "", form.english, window, cx));
                    }
                    cx.notify();
                })),
        );
        for (deferred, active, label) in [
            (false, form.enabled, trs!(english, "mcp_form.enable_server")),
            (
                true,
                form.deferred,
                trs!(english, "mcp_form.search_and_load_tools_on"),
            ),
        ] {
            body = body.child(
                outline_button(SharedString::from(format!("mcp-form-toggle-{deferred}")), p)
                    .child(SharedString::from(format!(
                        "{} {label}",
                        if active { "✓" } else { "○" }
                    )))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                            && let Some(form) = &mut s.mcp.form
                        {
                            if deferred {
                                form.deferred = !form.deferred;
                            } else {
                                form.enabled = !form.enabled;
                            }
                        }
                        cx.notify();
                    })),
            );
        }
        body.child(
            div()
                .flex()
                .gap(px(8.0))
                .child(
                    outline_button("mcp-save-form", p)
                        .child(if s.mcp.busy {
                            trs!(english, "mcp_form.saving")
                        } else {
                            trs!(english, "mcp_form.save_server")
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.save_mcp_form(cx))),
                )
                .child(
                    outline_button("mcp-cancel-form", p)
                        .child(trs!(english, "mcp_form.cancel"))
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy) {
                                s.mcp.form = None;
                            }
                            cx.notify();
                        })),
                ),
        )
        .into_any_element()
    }
}
