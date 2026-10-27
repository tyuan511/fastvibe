//! Per-model form. Live reads update clean forms; a changed model never overwrites a dirty draft.
use super::Workspace;
use super::composer::thinking_label_in;
use super::settings::{
    checkbox, dialog_card, dialog_foot, dialog_head, menu_item, modal, outline_button, popover,
    protocol_label,
};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};
use fv_protocol::methods::{ProviderModelGet, ProviderModelUpdate};
use fv_protocol::models::*;
use fv_protocol::types::{ApiProtocol, ModelInfo, ThinkingLevel};
use fv_theme::Token;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashSet;

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Form {
    name: String,
    context: String,
    output: String,
    protocol: Option<ApiProtocol>,
    reasoning: bool,
    web_search: bool,
    input: Vec<ModelInput>,
    levels: Vec<ThinkingLevel>,
}
impl Form {
    fn from_model(model: &ModelInfo) -> Self {
        let input = model.input.clone().unwrap_or_else(|| {
            if model.supports_images {
                vec![ModelInput::Text, ModelInput::Image]
            } else {
                vec![ModelInput::Text]
            }
        });
        let levels = model
            .thinking_levels
            .clone()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                vec![
                    ThinkingLevel::Low,
                    ThinkingLevel::Medium,
                    ThinkingLevel::High,
                ]
            });
        Self {
            name: model.name.clone().unwrap_or_else(|| model.id.clone()),
            context: model.context_window.unwrap_or(128_000).to_string(),
            output: model.max_output_tokens.unwrap_or(8_192).to_string(),
            protocol: model.protocol,
            reasoning: model.reasoning.unwrap_or(false),
            web_search: model.web_search,
            input,
            levels,
        }
    }
    fn toggle_input(&mut self, kind: ModelInput) {
        if self.input.contains(&kind) {
            self.input.retain(|v| *v != kind);
        } else {
            self.input.push(kind);
        }
        self.input.sort_by_key(|v| match v {
            ModelInput::Text => 0,
            ModelInput::Image => 1,
            ModelInput::Video => 2,
            ModelInput::File => 3,
        });
    }
    fn toggle_level(&mut self, level: ThinkingLevel) {
        if !self.reasoning {
            return;
        }
        if self.levels.contains(&level) {
            self.levels.retain(|v| *v != level);
        } else {
            self.levels.push(level);
            self.levels.sort();
        }
    }
    #[cfg(test)]
    fn model(&self, id: &str) -> Result<ModelInfo, String> {
        self.model_localized(id, false)
    }
    fn model_localized(&self, id: &str, english: bool) -> Result<ModelInfo, String> {
        let positive = |s: &str, label: &str| {
            s.trim()
                .parse::<u32>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    tr!(
                        english,
                        "model_detail.label_enter_a_valid_positive",
                        label = label
                    )
                })
        };
        let context = positive(&self.context, trs!(english, "model_detail.context_window"))?;
        let output = positive(&self.output, trs!(english, "model_detail.max_output"))?;
        if self.reasoning && self.levels.is_empty() {
            return Err(trs!(english, "model_detail.select_at_least_one_thinking").into());
        }
        Ok(ModelInfo {
            id: id.into(),
            name: Some(if self.name.trim().is_empty() {
                id.into()
            } else {
                self.name.trim().into()
            }),
            protocol: self.protocol,
            context_window: Some(context),
            max_output_tokens: Some(output),
            edited: true,
            reasoning: Some(self.reasoning),
            supports_images: self.input.contains(&ModelInput::Image),
            web_search: self.web_search,
            input: Some(self.input.clone()),
            thinking_levels: Some(if self.reasoning {
                self.levels.clone()
            } else {
                Vec::new()
            }),
        })
    }
}
struct PendingReset {
    model: ModelInfo,
    expected: Form,
}

#[derive(Default)]
struct ModelDraft {
    base: Option<ModelInfo>,
    detail: Option<ModelDetail>,
    reset_to: Option<PendingReset>,
    force_reload: Option<Form>,
}

pub struct ModelEditor {
    owner: u64,
    request: u64,
    provider_id: String,
    model_id: String,
    name: Entity<InputState>,
    context: Entity<InputState>,
    output: Entity<InputState>,
    form: Form,
    draft: ModelDraft,
    loading: bool,
    needs_read: bool,
    saving: Option<u64>,
    protocol_menu: bool,
    error: Option<String>,
    read_error: Option<String>,
    notice: Option<String>,
}
impl ModelEditor {
    pub(super) fn dismiss_menu(&mut self) -> bool {
        std::mem::take(&mut self.protocol_menu)
    }
    fn values(&self, cx: &App) -> Form {
        Form {
            name: self.name.read(cx).value().to_string(),
            context: self.context.read(cx).value().to_string(),
            output: self.output.read(cx).value().to_string(),
            ..self.form.clone()
        }
    }
}
impl ModelDraft {
    fn saved(&mut self, detail: ModelDetail, submitted: &Form, current: &Form) {
        self.reset_to = (current == submitted).then(|| PendingReset {
            model: detail.model.clone(),
            expected: current.clone(),
        });
        self.base = Some(detail.model.clone());
        self.detail = Some(detail);
    }
    fn take_reset(&mut self, current: &Form) -> Option<Form> {
        self.reset_to
            .take()
            .filter(|p| p.expected == *current)
            .map(|p| Form::from_model(&p.model))
    }
    fn observe(&mut self, detail: ModelDetail, current: &Form) {
        let clean = self
            .reset_to
            .as_ref()
            .is_some_and(|p| p.expected == *current)
            || self
                .base
                .as_ref()
                .is_none_or(|base| *current == Form::from_model(base));
        let forced = self
            .force_reload
            .take()
            .is_some_and(|form| form == *current);
        if clean || forced {
            self.base = Some(detail.model.clone());
            self.reset_to = Some(PendingReset {
                model: detail.model.clone(),
                expected: current.clone(),
            });
        }
        self.detail = Some(detail);
    }
    fn conflict(&self) -> bool {
        self.base
            .as_ref()
            .zip(self.detail.as_ref())
            .is_some_and(|(base, latest)| *base != latest.model)
    }
}
/// Sync refreshes unedited rows in place; a tuned row, including explicit protocol inheritance,
/// is authoritative. Unavailable selected ids retain their stored fallback metadata.
pub(super) fn merge_models(
    existing: &[ModelInfo],
    fetched: &[ModelInfo],
    chosen: &HashSet<String>,
) -> Vec<ModelInfo> {
    let mut result = existing
        .iter()
        .filter(|m| chosen.contains(&m.id))
        .map(|old| {
            if old.edited {
                old.clone()
            } else {
                fetched
                    .iter()
                    .find(|new| new.id == old.id)
                    .unwrap_or(old)
                    .clone()
            }
        })
        .collect::<Vec<_>>();
    for m in fetched {
        if chosen.contains(&m.id) && !result.iter().any(|old| old.id == m.id) {
            result.push(m.clone());
        }
    }
    result
}
impl Workspace {
    pub(super) fn open_model_detail(
        &mut self,
        provider_id: String,
        model_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut field = |cx: &mut Context<Self>| cx.new(|cx| InputState::new(window, cx));
        let name = field(cx);
        let context = field(cx);
        let output = field(cx);
        let Some(s) = self.settings.as_mut() else {
            return;
        };
        s.model_edit = Some(ModelEditor {
            owner: next_id(),
            request: 0,
            provider_id,
            model_id,
            name,
            context,
            output,
            form: Form::from_model(&ModelInfo::default()),
            draft: Default::default(),
            loading: false,
            needs_read: false,
            saving: None,
            protocol_menu: false,
            error: None,
            read_error: None,
            notice: None,
        });
        self.refresh_model_detail(cx);
        cx.notify();
    }
    pub(super) fn sync_model_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(e) = self.settings.as_mut().and_then(|s| s.model_edit.as_mut()) else {
            return;
        };
        let current = e.values(cx);
        let Some(form) = e.draft.take_reset(&current) else {
            return;
        };
        e.form = form;
        for (field, value) in [
            (&e.name, &e.form.name),
            (&e.context, &e.form.context),
            (&e.output, &e.form.output),
        ] {
            if field.read(cx).value().as_ref() != value {
                field.update(cx, |input, cx| input.set_value(value.clone(), window, cx));
            }
        }
    }

    pub(super) fn refresh_model_detail(&mut self, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let Some(e) = self.settings.as_mut().and_then(|s| s.model_edit.as_mut()) else {
            return;
        };
        if e.loading || e.saving.is_some() {
            e.needs_read = true;
            return;
        }
        e.loading = true;
        e.read_error = None;
        e.request = next_id();
        let (owner, request) = (e.owner, e.request);
        let call = b.call::<ProviderModelGet>(ProviderModelParams {
            provider_id: e.provider_id.clone(),
            model_id: e.model_id.clone(),
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let Some(e) = this
                    .settings
                    .as_mut()
                    .and_then(|s| s.model_edit.as_mut())
                    .filter(|e| e.owner == owner && e.request == request)
                else {
                    return;
                };
                e.loading = false;
                match result {
                    Ok(detail) => {
                        let current = e.values(cx);
                        e.draft.observe(detail, &current);
                    }
                    Err(error) => e.read_error = Some(format!("读取模型详情失败：{error}")),
                }
                let again = std::mem::take(&mut e.needs_read);
                if again {
                    this.refresh_model_detail(cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    fn save_model_detail(&mut self, restore: bool, cx: &mut Context<Self>) {
        let Some(b) = self.backend.clone() else {
            return;
        };
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let Some(e) = self.settings.as_mut().and_then(|s| s.model_edit.as_mut()) else {
            return;
        };
        if e.saving.is_some() {
            return;
        }
        let Some(base) = e.draft.base.clone() else {
            return;
        };
        let form = e.values(cx);
        let model = if restore {
            None
        } else {
            match form.model_localized(&e.model_id, english) {
                Ok(model) => Some(model),
                Err(error) => {
                    e.error = Some(error);
                    cx.notify();
                    return;
                }
            }
        };
        let request = next_id();
        e.saving = Some(request);
        e.draft.force_reload = None;
        e.error = None;
        e.notice = None;
        e.protocol_menu = false;
        let owner = e.owner;
        let call = b.call::<ProviderModelUpdate>(ProviderModelUpdateParams {
            provider_id: e.provider_id.clone(),
            model_id: e.model_id.clone(),
            expected: base,
            model,
        });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| {
                let Some(e) = this
                    .settings
                    .as_mut()
                    .and_then(|s| s.model_edit.as_mut())
                    .filter(|e| e.owner == owner && e.saving == Some(request))
                else {
                    return;
                };
                e.saving = None;
                match result {
                    Ok(detail) => {
                        let current = e.values(cx);
                        e.draft.saved(detail, &form, &current);
                        e.notice = Some(
                            if restore {
                                "已恢复目录参数"
                            } else {
                                "已保存"
                            }
                            .into(),
                        );
                    }
                    Err(error) => e.error = Some(format!("保存失败，草稿已保留：{error}")),
                }
                // Invalidate a pre-save read, then fetch the current row. A later write from
                // another window cannot be overwritten by this request's older response.
                e.request = next_id();
                e.loading = false;
                e.needs_read = false;
                this.refresh_model_detail(cx);
                this.refresh_providers(cx);
                this.refresh_models(cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
    pub(super) fn model_detail_dialog(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let e = self.settings.as_ref()?.model_edit.as_ref()?;
        let p = &self.palette;
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let mut content = div()
            .id("model-detail-scroll")
            .px(px(20.0))
            .pb(px(16.0))
            .max_h(px(500.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(14.0));
        if e.draft.base.is_some() {
            content = content
                .child(field(
                    trs!(english, "model_detail.display_name"),
                    Input::new(&e.name).into_any_element(),
                ))
                .child(field(
                    trs!(english, "model_detail.model_id"),
                    div()
                        .text_size(px(TEXT_XS))
                        .child(SharedString::from(e.model_id.clone()))
                        .into_any_element(),
                ));
            let label = e
                .form
                .protocol
                .map(protocol_label)
                .unwrap_or(trs!(english, "model_detail.inherit_provider_protocol"));
            let mut protocol = div().relative().child(
                outline_button("model-protocol", p)
                    .w_full()
                    .justify_between()
                    .child(label)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(e) = this.settings.as_mut().and_then(|s| s.model_edit.as_mut())
                        {
                            e.protocol_menu = !e.protocol_menu;
                        }
                        cx.notify();
                    })),
            );
            if e.protocol_menu {
                let mut menu = popover(p).absolute().top(px(34.0)).left_0().w_full();
                for proto in [
                    None,
                    Some(ApiProtocol::Chat),
                    Some(ApiProtocol::Responses),
                    Some(ApiProtocol::Anthropic),
                    Some(ApiProtocol::Google),
                ] {
                    menu = menu.child(
                        menu_item(
                            SharedString::from(format!("model-proto-{proto:?}")),
                            e.form.protocol == proto,
                            p.c(Token::Accent),
                        )
                        .child(
                            proto
                                .map(protocol_label)
                                .unwrap_or(trs!(english, "model_detail.inherit_provider_protocol")),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) =
                                this.settings.as_mut().and_then(|s| s.model_edit.as_mut())
                            {
                                e.form.protocol = proto;
                                e.protocol_menu = false;
                            }
                            cx.notify();
                        })),
                    );
                }
                protocol = protocol.child(deferred(menu.occlude()).with_priority(15));
            }
            content = content
                .child(field(
                    trs!(english, "model_detail.protocol"),
                    protocol.into_any_element(),
                ))
                .child(
                    div()
                        .flex()
                        .gap(px(12.0))
                        .child(
                            field(
                                trs!(english, "model_detail.context_window_tokens"),
                                Input::new(&e.context).into_any_element(),
                            )
                            .flex_1(),
                        )
                        .child(
                            field(
                                trs!(english, "model_detail.max_output_tokens"),
                                Input::new(&e.output).into_any_element(),
                            )
                            .flex_1(),
                        ),
                );
            let search_enabled = e.form.web_search;
            content = content.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .id("model-web-search")
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .cursor_pointer()
                            .child(checkbox(search_enabled, p))
                            .child(trs!(english, "model_detail.hosted_web_search"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(e) =
                                    this.settings.as_mut().and_then(|s| s.model_edit.as_mut())
                                {
                                    e.form.web_search = !e.form.web_search;
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(trs!(english, "model_detail.requires_a_custom_endpoint_and")),
                    ),
            );
            let mut traits = div().flex().flex_wrap().gap(px(12.0));
            for (kind, label) in [
                (None, trs!(english, "model_detail.reasoning")),
                (
                    Some(ModelInput::Image),
                    trs!(english, "model_detail.images"),
                ),
                (Some(ModelInput::Video), trs!(english, "model_detail.video")),
                (Some(ModelInput::File), trs!(english, "model_detail.files")),
            ] {
                let active = kind.map_or(e.form.reasoning, |k| e.form.input.contains(&k));
                traits = traits.child(
                    div()
                        .id(SharedString::from(format!("model-trait-{kind:?}")))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .cursor_pointer()
                        .child(checkbox(active, p))
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) =
                                this.settings.as_mut().and_then(|s| s.model_edit.as_mut())
                            {
                                if let Some(k) = kind {
                                    e.form.toggle_input(k);
                                } else {
                                    e.form.reasoning = !e.form.reasoning;
                                }
                            }
                            cx.notify();
                        })),
                );
            }
            content = content.child(field(
                trs!(english, "model_detail.capabilities_text_always_supported"),
                traits.text_size(px(TEXT_SM)).into_any_element(),
            ));
            let mut efforts = div().flex().flex_wrap().gap(px(12.0));
            for level in ThinkingLevel::ALL {
                let active = e.form.levels.contains(&level);
                let enabled = e.form.reasoning;
                efforts = efforts.child(
                    div()
                        .id(SharedString::from(format!("model-level-{level:?}")))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .when(!enabled, |d| d.opacity(0.45))
                        .when(enabled, |d| d.cursor_pointer())
                        .child(checkbox(active, p))
                        .child(thinking_label_in(level, english))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(e) =
                                this.settings.as_mut().and_then(|s| s.model_edit.as_mut())
                            {
                                e.form.toggle_level(level);
                            }
                            cx.notify();
                        })),
                );
            }
            content = content.child(field(
                trs!(english, "model_detail.thinking_effort"),
                efforts.text_size(px(TEXT_SM)).into_any_element(),
            ));
            if let Some(detail) = &e.draft.detail {
                let mut prices = div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .text_size(px(TEXT_XS))
                    .muted(p);
                if let Some(price) = detail.price {
                    prices =
                        prices.child(price_row(trs!(english, "model_detail.base_price"), price));
                    for tier in &detail.price_tiers {
                        prices = prices.child(price_row(
                            &tr!(english, "model_detail.over_arg1_tokens", arg1 = tier.over),
                            tier.price,
                        ));
                    }
                } else {
                    prices = prices.child(trs!(english, "model_detail.unknown"));
                }
                content = content.child(field(
                    trs!(english, "model_detail.reference_price_usd_million_tokens"),
                    prices.into_any_element(),
                ));
            }
            content = content.child(div().text_size(px(TEXT_XS)).muted(p).child(trs!(
                english,
                "model_detail.saved_model_parameters_are_kept"
            )));
        } else {
            content = content.child(if e.loading {
                trs!(english, "model_detail.loading_model_details")
            } else {
                trs!(english, "model_detail.unable_to_load_model_details")
            });
        }
        if e.draft.conflict() {
            content = content.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(trs!(
                        english,
                        "model_detail.this_model_changed_elsewhere_the"
                    )),
            );
        }
        for error in [&e.error, &e.read_error].into_iter().flatten() {
            content = content.child(
                div()
                    .text_size(px(TEXT_XS))
                    .text_color(p.c(Token::Destructive))
                    .child(SharedString::from(error.clone())),
            );
        }
        content = content.when_some(e.notice.clone(), |d, n| {
            d.child(
                div()
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(SharedString::from(n)),
            )
        });
        let busy = e.saving.is_some();
        let actions = div()
            .flex()
            .gap(px(8.0))
            .child(
                outline_button("reload-model", p)
                    .child(trs!(english, "model_detail.reload"))
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(e) = this.settings.as_mut().and_then(|s| s.model_edit.as_mut())
                            && e.saving.is_none()
                        {
                            e.draft.force_reload = Some(e.values(cx));
                            e.error = None;
                            e.notice = None;
                            this.refresh_model_detail(cx);
                        }
                    })),
            )
            .when(e.draft.base.as_ref().is_some_and(|m| m.edited), |d| {
                d.child(
                    outline_button("restore-model", p)
                        .when(busy, |d| d.opacity(0.5))
                        .child(trs!(english, "model_detail.restore_catalog_values"))
                        .on_click(cx.listener(|this, _, _, cx| this.save_model_detail(true, cx))),
                )
            });
        let body = dialog_card(p, 640.0)
            .child(dialog_head(
                trs!(english, "model_detail.model_details"),
                trs!(english, "model_detail.adjust_this_model_s_parameters"),
                p,
            ))
            .child(content)
            .child(div().px(px(20.0)).pb(px(12.0)).child(actions))
            .child(dialog_foot(
                p,
                cx,
                |this, cx| {
                    if let Some(s) = &mut this.settings {
                        s.model_edit = None;
                    }
                    cx.notify();
                },
                if busy {
                    trs!(english, "model_detail.saving")
                } else {
                    trs!(english, "model_detail.save")
                },
                |this, _, cx| this.save_model_detail(false, cx),
                busy || e.draft.base.is_none(),
                self.english(),
            ));
        Some(modal(body, p, cx, |this| {
            if let Some(s) = &mut this.settings {
                s.model_edit = None;
            }
        }))
    }
}
fn field(label: &str, control: AnyElement) -> Div {
    div()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(
            div()
                .text_size(px(TEXT_XS))
                .child(SharedString::from(label.to_owned())),
        )
        .child(control)
}
fn price_row(label: &str, p: ModelPrice) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(SharedString::from(label.to_owned()))
        .child(SharedString::from(format!(
            "输入 ${} · 输出 ${} · 缓存读 ${} · 缓存写 ${}",
            p.input, p.output, p.cache_read, p.cache_write
        )))
}

#[cfg(test)]
mod tests {
    use super::{Form, ModelDraft, merge_models};
    use fv_protocol::models::ModelInput;
    use fv_protocol::types::{ApiProtocol, ModelInfo, ThinkingLevel};
    use std::collections::HashSet;
    fn model(id: &str) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            name: Some(id.into()),
            context_window: Some(128_000),
            max_output_tokens: Some(8192),
            ..Default::default()
        }
    }
    #[test]
    fn sync_preserves_tuned_protocol_inheritance_and_refreshes_untuned_rows_in_order() {
        let tuned = ModelInfo {
            edited: true,
            protocol: None,
            name: Some("My model".into()),
            ..model("claude-x")
        };
        let normal = model("m");
        let missing = model("unavailable");
        let fetched = vec![
            ModelInfo {
                protocol: Some(ApiProtocol::Anthropic),
                ..model("claude-x")
            },
            ModelInfo {
                context_window: Some(64_000),
                ..model("m")
            },
            model("new"),
        ];
        let chosen = ["claude-x", "m", "new", "unavailable"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let merged = merge_models(&[tuned.clone(), normal, missing.clone()], &fetched, &chosen);
        assert_eq!(merged[0], tuned);
        assert_eq!(merged[1].context_window, Some(64_000));
        assert_eq!(merged[2], missing);
        assert_eq!(merged[3].id, "new");
        assert!(merge_models(&merged, &fetched, &HashSet::new()).is_empty());
    }
    #[test]
    fn form_rejects_bad_token_limits_and_missing_efforts_and_keeps_multimodal_choices() {
        let mut form = Form::from_model(&model("m"));
        for bad in ["0", "-1", "1.5", "100x", "4294967296", ""] {
            form.context = bad.into();
            assert!(form.model("m").is_err());
        }
        form.context = "64000".into();
        form.output = "1e3".into();
        assert!(form.model("m").is_err());
        form.output = "2048".into();
        form.reasoning = true;
        form.levels.clear();
        assert!(form.model("m").is_err());
        form.name = "  ".into();
        form.protocol = None;
        form.levels = vec![ThinkingLevel::High];
        form.input = vec![ModelInput::Text, ModelInput::File, ModelInput::Video];
        let model = form.model("m").unwrap();
        assert_eq!(model.name.as_deref(), Some("m"));
        assert!(!model.supports_images);
        assert_eq!(model.protocol, None);
        assert!(model.edited);
        assert_eq!(model.input, Some(form.input.clone()));
        form.reasoning = false;
        assert!(form.model("m").unwrap().thinking_levels.unwrap().is_empty());
    }
    fn detail(m: ModelInfo) -> fv_protocol::models::ModelDetail {
        fv_protocol::models::ModelDetail {
            model: m,
            provider_protocol: ApiProtocol::Chat,
            price: None,
            price_tiers: Vec::new(),
        }
    }
    #[test]
    fn catalog_reads_preserve_dirty_forms_and_reload_does_not_erase_later_typing() {
        let base = model("m");
        let initial = Form::from_model(&base);
        let mut draft = ModelDraft::default();
        draft.observe(detail(base.clone()), &initial);
        assert_eq!(draft.take_reset(&initial), Some(initial.clone()));
        let mut local = initial.clone();
        local.name = "local draft".into();
        let remote = ModelInfo {
            name: Some("remote name".into()),
            ..base.clone()
        };
        draft.observe(detail(remote.clone()), &local);
        assert!(draft.conflict());
        assert!(draft.take_reset(&local).is_none());
        draft.force_reload = Some(local.clone());
        let mut later = local.clone();
        later.output = "4096".into();
        draft.observe(detail(remote.clone()), &later);
        assert!(
            draft.take_reset(&later).is_none(),
            "typing after Reload belongs to the next edit"
        );
        draft.force_reload = Some(later.clone());
        draft.observe(detail(remote.clone()), &later);
        let mut newest = later.clone();
        newest.name = "typed before the next frame".into();
        assert!(
            draft.take_reset(&newest).is_none(),
            "deferred editor writes cannot erase newer input"
        );
        assert_eq!(draft.base, Some(remote));
    }
    #[test]
    fn save_results_keep_edits_made_in_flight_and_later_reads_detect_conflicts() {
        let base = model("m");
        let submitted = Form::from_model(&base);
        let saved = ModelInfo {
            edited: true,
            ..base.clone()
        };
        let mut draft = ModelDraft::default();
        let mut continued = submitted.clone();
        continued.context = "64000".into();
        draft.saved(detail(saved.clone()), &submitted, &continued);
        assert!(draft.take_reset(&continued).is_none());
        assert_eq!(draft.base, Some(saved.clone()));
        let remote = ModelInfo {
            name: Some("newer write".into()),
            ..saved
        };
        draft.observe(detail(remote), &continued);
        assert!(draft.conflict());
        assert!(draft.take_reset(&continued).is_none());
        // A normal save is rebased onto its server-normalized value, but only while untouched.
        draft.saved(detail(base.clone()), &submitted, &submitted);
        assert_eq!(draft.take_reset(&submitted), Some(Form::from_model(&base)));
    }
    #[test]
    fn toggling_again_before_a_redraw_uses_current_values_and_disabled_efforts_do_nothing() {
        let mut form = Form::from_model(&model("m"));
        let original = form.clone();
        form.toggle_input(ModelInput::Image);
        form.toggle_input(ModelInput::Image);
        assert_eq!(form, original);
        form.toggle_level(ThinkingLevel::Max);
        assert_eq!(form, original);
        form.reasoning = true;
        let before = form.clone();
        form.toggle_level(ThinkingLevel::Max);
        form.toggle_level(ThinkingLevel::Max);
        assert_eq!(form, before);
    }
}
