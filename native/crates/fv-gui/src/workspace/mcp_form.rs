//! Per-server MCP editor. Argument boundaries and empty values are preserved; secrets stay
//! masked unless explicitly revealed, and saves compare the original config on the server.

use std::collections::BTreeMap;

use crate::ui::px;
use fv_protocol::methods::McpUpdate;
use fv_protocol::types::*;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::*;

use super::super::Workspace;
use super::super::personalization::{
    field_label, ghost_icon, outline_sm, primary_button, select_trigger,
};
use super::super::settings::{
    dialog_card, dialog_head, menu_item, outline_button, popover, switch,
};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon};
use fv_theme::Token;
use gpui_kit::component::input::Textarea;
use gpui_kit::prelude::FluentBuilder as _;

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
    /// The open select: 0 transport, 1 how tools are provided.
    menu: Option<u8>,
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
            menu: None,
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
        // No busy guard: a new server's form needs nothing from the list still
        // loading, and an edit cannot be asked for before its row exists.
        // Saving stays guarded by `busy` of its own.
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
        s.mcp.json_view = false;
        s.mcp.json_full = false;
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
        let english = self.english();
        let hover = p.c(Token::Muted);
        let busy = s.mcp.busy;
        let json = s.mcp.json_view;
        let hint = |text: SharedString| div().text_size(px(TEXT_XS)).muted(p).child(text);
        let field = |label: SharedString| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(field_label(label))
        };

        // `TabsList`: a muted track with the chosen view raised on it.
        let tab = |id: &'static str, text: SharedString, active: bool, to_json: bool| {
            div()
                .id(id)
                .flex_1()
                .h(px(26.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .cursor_pointer()
                .text_size(px(TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .when(active, |d| d.bg(p.c(Token::Background)).shadow_sm())
                .when(!active, |d| d.muted(p))
                .child(text)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy) {
                        s.mcp.json_view = to_json;
                        if let Some(form) = &mut s.mcp.form {
                            form.menu = None;
                        }
                    }
                    cx.notify();
                }))
        };
        let tabs = div()
            .h(px(32.0))
            .p(px(3.0))
            .flex()
            .rounded(px(8.0))
            .bg(p.c(Token::Muted))
            .child(tab(
                "mcp-view-form",
                trs!(english, "mcp_form.view_form").into(),
                !json,
                false,
            ))
            .child(tab("mcp-view-json", "JSON".into(), json, true));

        let mut body = div()
            .px(px(20.0))
            .pb(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(tabs);
        if json {
            body = body
                .child(
                    div().max_h(px(320.0)).child(
                        Textarea::new(&s.mcp.editor)
                            .font_family("monospace")
                            .text_size(px(TEXT_XS)),
                    ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .child(hint(
                            if s.mcp.json_full {
                                trs!(english, "mcp_form.json_full_hint")
                            } else {
                                trs!(english, "mcp_form.json_merge_hint")
                            }
                            .into(),
                        ))
                        .child(
                            outline_sm("edit-mcp-configs", p)
                                .child(trs!(english, "mcp_form.load_full"))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.edit_mcp(window, cx);
                                    if let Some(s) = this.settings.as_mut() {
                                        s.mcp.json_full = true;
                                    }
                                    cx.notify();
                                })),
                        ),
                );
        } else {
            let transport_label: SharedString = match form.transport {
                McpTransport::Stdio => trs!(english, "mcp_form.local_process").into(),
                McpTransport::Http => "HTTP（Streamable HTTP）".into(),
            };
            let mut transport = div().relative().child(
                select_trigger("mcp-transport", transport_label, 0.0, p)
                    .w_full()
                    .h(px(36.0))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                            && let Some(form) = &mut s.mcp.form
                        {
                            form.menu = if form.menu == Some(0) { None } else { Some(0) };
                        }
                        cx.notify();
                    })),
            );
            if form.menu == Some(0) {
                let mut menu = popover(p)
                    .absolute()
                    .top(px(40.0))
                    .left(px(0.0))
                    .right(px(0.0));
                for (value, text) in [
                    (
                        McpTransport::Stdio,
                        SharedString::from(trs!(english, "mcp_form.local_process")),
                    ),
                    (
                        McpTransport::Http,
                        SharedString::from("HTTP（Streamable HTTP）"),
                    ),
                ] {
                    let active = form.transport == value;
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("mcp-transport-{value:?}")),
                            active,
                            hover,
                        )
                        .justify_between()
                        .child(text)
                        .when(active, |d| {
                            d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                && let Some(form) = &mut s.mcp.form
                            {
                                form.transport = value;
                                form.menu = None;
                            }
                            cx.notify();
                        })),
                    );
                }
                transport = transport.child(crate::ui::float(menu));
            }
            body = body.child(
                div()
                    .flex()
                    .gap(px(12.0))
                    .child(
                        field(trs!(english, "mcp_form.name").into())
                            .flex_1()
                            .child(Input::new(&form.name)),
                    )
                    .child(
                        field(trs!(english, "mcp_form.transport").into())
                            .flex_1()
                            .child(transport),
                    ),
            );
            let remove_glyph = |id: SharedString| {
                ghost_icon(id, "cancel01", 28.0, 14.0, p.c(Token::MutedForeground), p)
            };
            if form.transport == McpTransport::Stdio {
                body = body.child(
                    field(trs!(english, "mcp_form.launch_command").into())
                        .child(Input::new(&form.command)),
                );
                let mut args = field(trs!(english, "mcp_form.arguments").into());
                for (i, arg) in form.args.iter().enumerate() {
                    args = args.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(div().flex_1().child(Input::new(arg)))
                            .child(
                                remove_glyph(SharedString::from(format!("mcp-remove-arg-{i}")))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if let Some(s) =
                                            this.settings.as_mut().filter(|s| !s.mcp.busy)
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
                args = args.child(
                    div().child(
                        outline_sm("mcp-add-arg", p)
                            .gap(px(4.0))
                            .child(icon("add01", 14.0, p.c(Token::Foreground)))
                            .child(trs!(english, "mcp_form.add_argument"))
                            .on_click(cx.listener(|this, _, window, cx| {
                                if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                    && let Some(form) = &mut s.mcp.form
                                {
                                    let placeholder = trs!(form.english, "mcp_form.argument");
                                    form.args.push(input("", placeholder, false, window, cx));
                                }
                                cx.notify();
                            })),
                    ),
                );
                body = body.child(args);
            } else {
                body = body.child(field("URL".into()).child(Input::new(&form.url)));
            }
            let local = form.transport == McpTransport::Stdio;
            let rows = if local { &form.env } else { &form.headers };
            let mut pairs_field = field(
                if local {
                    trs!(english, "mcp_form.environment_variables")
                } else {
                    trs!(english, "mcp_form.request_headers")
                }
                .into(),
            );
            for (i, row) in rows.iter().enumerate() {
                pairs_field = pairs_field.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(div().flex_1().child(Input::new(&row.key)))
                        .child(div().flex_1().child(Input::new(&row.value).mask_toggle()))
                        .child(
                            remove_glyph(SharedString::from(format!("mcp-remove-pair-{i}")))
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
            pairs_field = pairs_field
                .child(
                    div().child(
                        outline_sm("mcp-add-pair", p)
                            .gap(px(4.0))
                            .child(icon("add01", 14.0, p.c(Token::Foreground)))
                            .child(if local {
                                trs!(english, "mcp_form.add_environment_variable")
                            } else {
                                trs!(english, "mcp_form.add_request_header")
                            })
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                    && let Some(form) = &mut s.mcp.form
                                {
                                    let english = form.english;
                                    let rows = if local {
                                        &mut form.env
                                    } else {
                                        &mut form.headers
                                    };
                                    rows.push(pair("", "", english, window, cx));
                                }
                                cx.notify();
                            })),
                    ),
                )
                .child(hint(
                    if local {
                        trs!(english, "mcp_form.env_hint")
                    } else {
                        trs!(english, "mcp_form.headers_hint")
                    }
                    .into(),
                ));
            body = body.child(pairs_field);

            // 工具提供方式: a select, as Electron's; this host knows direct and on-demand.
            let exposure_text = |deferred: bool| -> SharedString {
                if deferred {
                    trs!(english, "mcp_form.exposure_deferred")
                } else {
                    trs!(english, "mcp_form.exposure_direct")
                }
                .into()
            };
            let mut exposure = div().relative().child(
                select_trigger("mcp-exposure", exposure_text(form.deferred), 0.0, p)
                    .w_full()
                    .h(px(36.0))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                            && let Some(form) = &mut s.mcp.form
                        {
                            form.menu = if form.menu == Some(1) { None } else { Some(1) };
                        }
                        cx.notify();
                    })),
            );
            if form.menu == Some(1) {
                let mut menu = popover(p)
                    .absolute()
                    .top(px(40.0))
                    .left(px(0.0))
                    .right(px(0.0));
                for value in [false, true] {
                    let active = form.deferred == value;
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("mcp-exposure-{value}")),
                            active,
                            hover,
                        )
                        .justify_between()
                        .child(exposure_text(value))
                        .when(active, |d| {
                            d.child(icon("tick02", 14.0, p.c(Token::Foreground)))
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                && let Some(form) = &mut s.mcp.form
                            {
                                form.deferred = value;
                                form.menu = None;
                            }
                            cx.notify();
                        })),
                    );
                }
                exposure = exposure.child(crate::ui::float(menu));
            }
            body = body.child(
                field(trs!(english, "mcp_form.exposure").into())
                    .child(exposure)
                    .child(hint(
                        if form.deferred {
                            trs!(english, "mcp_form.exposure_deferred_hint")
                        } else {
                            trs!(english, "mcp_form.exposure_direct_hint")
                        }
                        .into(),
                    )),
            );
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_XS))
                    .child(switch("mcp-form-enabled".into(), form.enabled, p).on_click(
                        cx.listener(|this, _, _, cx| {
                            if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy)
                                && let Some(form) = &mut s.mcp.form
                            {
                                form.enabled = !form.enabled;
                            }
                            cx.notify();
                        }),
                    ))
                    .child(if form.original.is_some() {
                        trs!(english, "mcp_form.enabled")
                    } else {
                        trs!(english, "mcp_form.enable_after")
                    }),
            );
        }
        let editing = form.original.is_some();
        dialog_card(p, 576.0)
            .id("mcp-form-scroll")
            .max_h(px(640.0))
            .overflow_y_scroll()
            .child(dialog_head(
                if editing {
                    trs!(english, "mcp_form.edit_server")
                } else {
                    trs!(english, "mcp_form.add_server")
                },
                if json {
                    trs!(english, "mcp_form.json_hint")
                } else {
                    trs!(english, "mcp_form.dialog_desc")
                },
                p,
            ))
            .child(body)
            .child(
                div()
                    .px(px(16.0))
                    .py(px(12.0))
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .border_t_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Muted).opacity(0.5))
                    .child(
                        outline_button("mcp-cancel-form", p)
                            .child(trs!(english, "mcp_form.cancel"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut().filter(|s| !s.mcp.busy) {
                                    s.mcp.form = None;
                                    s.mcp.json_view = false;
                                    s.mcp.json_full = false;
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        primary_button("mcp-save-form", p)
                            .h(px(32.0))
                            .when(busy, |d| d.opacity(0.5))
                            .when(busy, |d| {
                                d.child(crate::ui::spinner(
                                    "mcp-saving",
                                    14.0,
                                    p.c(Token::PrimaryForeground),
                                ))
                            })
                            .child(if json && s.mcp.json_full {
                                trs!(english, "mcp_form.save_all")
                            } else if editing && !json {
                                trs!(english, "mcp_form.save_connect")
                            } else {
                                trs!(english, "mcp_form.add_connect")
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if json {
                                    let full =
                                        this.settings.as_ref().is_some_and(|s| s.mcp.json_full);
                                    this.save_mcp_editor(full, cx)
                                } else {
                                    this.save_mcp_form(cx)
                                }
                            })),
                    ),
            )
            .into_any_element()
    }
}
