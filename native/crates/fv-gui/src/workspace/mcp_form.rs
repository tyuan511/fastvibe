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

fn pair(key: &str, value: &str, window: &mut Window, cx: &mut App) -> Pair {
    Pair {
        key: input(key, "名称", false, window, cx),
        value: input(value, "值", true, window, cx),
    }
}

fn value(input: &Entity<InputState>, cx: &App) -> String {
    input.read(cx).value().to_string()
}

fn pairs(rows: &[Pair], cx: &App) -> Result<BTreeMap<String, String>, String> {
    let mut map = BTreeMap::new();
    for row in rows {
        let key = value(&row.key, cx).trim().to_string();
        let value = value(&row.value, cx);
        if key.is_empty() {
            return Err("请填写环境变量或请求头的名称，或删除空白行".into());
        }
        if map.insert(key, value).is_some() {
            return Err("环境变量或请求头的名称不能重复".into());
        }
    }
    Ok(map)
}

impl Form {
    fn new(config: Option<McpServerConfig>, window: &mut Window, cx: &mut App) -> Self {
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
                    .map(|v| input(v, "参数", false, window, cx))
                    .collect()
            })
            .unwrap_or_default();
        let env = config
            .as_ref()
            .map(|c| c.env.iter().map(|(k, v)| pair(k, v, window, cx)).collect())
            .unwrap_or_default();
        let headers = config
            .as_ref()
            .map(|c| {
                c.headers
                    .iter()
                    .map(|(k, v)| pair(k, v, window, cx))
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
                "服务器名称",
                false,
                window,
                cx,
            ),
            command: input(
                config
                    .as_ref()
                    .and_then(|c| c.command.as_deref())
                    .unwrap_or(""),
                "例如 npx 或可执行文件路径",
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
                pairs(&self.env, cx)?
            } else {
                Default::default()
            },
            url: (!local).then(|| value(&self.url, cx).trim().into()),
            headers: if local {
                Default::default()
            } else {
                pairs(&self.headers, cx)?
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
        s.mcp.form = Some(Form::new(config, window, cx));
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
                .map_err(|e| format!("无法保存 MCP：{e}"));
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
        let label = |name: &'static str| div().text_size(px(TEXT_SM)).child(name);
        let mut body = card(p)
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(if form.original.is_some() {
                "编辑服务器"
            } else {
                "添加服务器"
            })
            .child(div().child(label("名称")).child(Input::new(&form.name)));
        let mut transports = div().flex().gap(px(8.0));
        for (transport, title) in [
            (McpTransport::Stdio, "本地进程"),
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
                        .child(label("启动命令"))
                        .child(Input::new(&form.command)),
                )
                .child(label("参数（每行一个，按原样传给进程）"));
            for (i, arg) in form.args.iter().enumerate() {
                body = body.child(
                    div()
                        .flex()
                        .gap(px(8.0))
                        .child(div().flex_1().child(Input::new(arg)))
                        .child(
                            outline_button(SharedString::from(format!("mcp-remove-arg-{i}")), p)
                                .child("删除")
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
            body = body.child(outline_button("mcp-add-arg", p).child("添加参数").on_click(
                cx.listener(|this, _, window, cx| {
                    if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                        && let Some(form) = &mut s.mcp.form
                    {
                        form.args.push(input("", "参数", false, window, cx));
                    }
                    cx.notify();
                }),
            ));
        } else {
            body = body.child(
                div()
                    .child(label("服务器地址"))
                    .child(Input::new(&form.url)),
            );
        }
        let local = form.transport == McpTransport::Stdio;
        let rows = if local { &form.env } else { &form.headers };
        body = body.child(label(if local { "环境变量" } else { "请求头" }));
        for (i, row) in rows.iter().enumerate() {
            body = body.child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(div().flex_1().child(Input::new(&row.key)))
                    .child(div().flex_1().child(Input::new(&row.value).mask_toggle()))
                    .child(
                        outline_button(SharedString::from(format!("mcp-remove-pair-{i}")), p)
                            .child("删除")
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
                    "添加环境变量"
                } else {
                    "添加请求头"
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
                        rows.push(pair("", "", window, cx));
                    }
                    cx.notify();
                })),
        );
        for (deferred, active, label) in [
            (false, form.enabled, "启用服务器"),
            (true, form.deferred, "按需搜索并加载工具"),
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
                            "正在保存…"
                        } else {
                            "保存服务器"
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.save_mcp_form(cx))),
                )
                .child(
                    outline_button("mcp-cancel-form", p)
                        .child("取消")
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
