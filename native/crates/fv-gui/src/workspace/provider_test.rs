//! Per-settings-instance checks and expiring notices. Epochs suppress results from an old
//! endpoint, provider pane, backend connection or closed/reopened settings form.
use super::Workspace;
use super::settings::{Section, outline_button};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS};
use fv_protocol::methods::ProviderModelTest;
use fv_protocol::provider_test::*;
use fv_protocol::types::ApiProtocol;
use fv_theme::Token;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::BTreeMap;
use std::time::Duration;
fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}
#[derive(Clone)]
struct Ticket {
    epoch: u64,
    id: u64,
    provider: String,
    model: String,
}
struct CheckNotice {
    id: u64,
    provider: String,
    model: String,
    name: String,
    result: ProviderTestResult,
    overloaded: bool,
}
pub struct ModelChecks {
    epoch: u64,
    running: BTreeMap<(String, String), u64>,
    notice: Option<CheckNotice>,
}
impl Default for ModelChecks {
    fn default() -> Self {
        Self {
            epoch: next_id(),
            running: BTreeMap::new(),
            notice: None,
        }
    }
}
impl ModelChecks {
    fn begin(&mut self, provider: &str, model: &str) -> Option<Ticket> {
        let key = (provider.into(), model.into());
        if self.running.contains_key(&key) {
            return None;
        }
        let id = next_id();
        self.running.insert(key, id);
        Some(Ticket {
            epoch: self.epoch,
            id,
            provider: provider.into(),
            model: model.into(),
        })
    }
    fn finish(&mut self, t: &Ticket) -> bool {
        let key = (t.provider.clone(), t.model.clone());
        if self.epoch != t.epoch || self.running.get(&key) != Some(&t.id) {
            return false;
        }
        self.running.remove(&key);
        true
    }
    pub(super) fn invalidate(&mut self) {
        self.epoch = next_id();
        self.running.clear();
        self.notice = None;
    }
    fn dismiss(&mut self, id: u64) {
        if self.notice.as_ref().is_some_and(|n| n.id == id) {
            self.notice = None;
        }
    }
    fn running(&self, provider: &str, model: &str) -> bool {
        self.running.contains_key(&(provider.into(), model.into()))
    }
}
impl Workspace {
    pub(super) fn invalidate_provider_checks(&mut self) {
        if let Some(s) = &mut self.settings {
            s.model_checks.invalidate();
        }
    }
    fn check_provider_model(&mut self, provider: String, model: String, cx: &mut Context<Self>) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(s) = self.settings.as_mut().filter(|s| {
            s.section == Section::Providers && s.edit.as_ref().is_some_and(|p| p.id == provider)
        }) else {
            return;
        };
        let Some((name, api)) = s
            .providers
            .as_ref()
            .and_then(|v| v.iter().find(|p| p.id == provider))
            .and_then(|p| {
                p.models.iter().find(|m| m.id == model).map(|m| {
                    (
                        m.name.clone().unwrap_or_else(|| m.id.clone()),
                        m.protocol.unwrap_or(p.protocol),
                    )
                })
            })
        else {
            return;
        };
        let Some(ticket) = s.model_checks.begin(&provider, &model) else {
            return;
        };
        let call = backend.call::<ProviderModelTest>(ProviderTestParams {
            provider_id: provider,
            model_id: model,
        });
        cx.spawn(async move|this,cx|{
            let result=call.await;
            let shown=this.update(cx,|this,cx|{
                let s = this.settings.as_mut()?;
                if !s.model_checks.finish(&ticket){return None;}
                if s.section!=Section::Providers || !s.edit.as_ref().is_some_and(|p|p.id==ticket.provider){return None;}
                let overloaded=matches!(&result,Err(fv_client::ClientError::Rpc(e)) if e.code==fv_protocol::jsonrpc::code::OVERLOADED);
                let result=result.unwrap_or_else(|_|ProviderTestResult{model:ticket.model.clone(),api:Some(api),status:ProviderTestStatus::Failed,
                    tools:ProviderTestTools::NotTested,first_token_ms:None,elapsed_ms:0,error_code:Some(ProviderTestError::Network)});
                let ttl=if result.status==ProviderTestStatus::Passed{4}else{7};
                let id=next_id();s.model_checks.notice=Some(CheckNotice{id,provider:ticket.provider,model:ticket.model,name,result,overloaded});
                cx.notify();Some((id,ttl))
            }).ok().flatten();
            if let Some((id,ttl))=shown {
                cx.background_executor().timer(Duration::from_secs(ttl)).await;
                this.update(cx,|this,cx|{if let Some(s)=this.settings.as_mut(){s.model_checks.dismiss(id);}cx.notify();}).ok();
            }
        }).detach();
        cx.notify();
    }
    pub(super) fn provider_check_button(
        &self,
        provider: &str,
        model: &str,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let p = &self.palette;
        let disabled = disabled || self.backend.is_none();
        let running = self
            .settings
            .as_ref()
            .is_some_and(|s| s.model_checks.running(provider, model));
        let provider = provider.to_owned();
        let model = model.to_owned();
        let busy_id = SharedString::from(format!("model-check-spin-{provider}-{model}"));
        let color = p.c(Token::MutedForeground);
        div()
            .id(SharedString::from(format!(
                "model-check-{provider}-{model}"
            )))
            .size(px(24.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.0))
            .role(Role::Button)
            .when(disabled || running, |d| d.opacity(0.5))
            .when(!disabled && !running, |d| {
                d.cursor_pointer().hover(|d| d.bg(p.c(Token::Accent)))
            })
            .child(if running {
                ui::spinner(busy_id, 14.0, color).into_any_element()
            } else {
                ui::icon("activity02", 14.0, color).into_any_element()
            })
            .tooltip(move |window, cx| {
                Tooltip::new(if running {
                    "正在自检…"
                } else {
                    "自检模型"
                })
                .build(window, cx)
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                if !disabled && !running {
                    this.check_provider_model(provider.clone(), model.clone(), cx);
                }
            }))
    }
    pub(super) fn provider_check_notice(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let s = self
            .settings
            .as_ref()
            .filter(|s| s.section == Section::Providers)?;
        let n = s.model_checks.notice.as_ref()?;
        let p = &self.palette;
        let id = n.id;
        let (title, token) = match n.result.status {
            ProviderTestStatus::Passed => ("回答与工具调用均正常", Token::Success),
            ProviderTestStatus::Partial => ("回答正常，工具调用尚未确认", Token::Warning),
            ProviderTestStatus::Failed => ("自检未通过", Token::Destructive),
        };
        let advice = if n.overloaded {
            "自检任务已满，请稍后重试"
        } else {
            advice(&n.result)
        };
        let facts = match (n.result.api, n.result.first_token_ms) {
            (Some(api), Some(ms)) => format!("{} · 首字 {} ms", api_label(api), ms),
            (Some(api), None) => api_label(api).into(),
            _ => String::new(),
        };
        let provider = n.provider.clone();
        let model = n.model.clone();
        Some(
            div()
                .id("provider-check-notice")
                .absolute()
                .right(px(20.0))
                .bottom(px(24.0))
                .w(px(380.0))
                .p(px(14.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .bg(p.overlay())
                .shadow_lg()
                .occlude()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(ui::icon(
                            if n.result.status == ProviderTestStatus::Passed {
                                "tick02"
                            } else {
                                "alert02"
                            },
                            16.0,
                            p.c(token),
                        ))
                        .child(
                            ui::truncate(format!("{} · {title}", n.name))
                                .text_size(px(TEXT_SM))
                                .flex_1(),
                        )
                        .child(
                            ui::icon_button_xs("close-provider-check", "cancel01", p).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    if let Some(s) = this.settings.as_mut() {
                                        s.model_checks.dismiss(id);
                                    }
                                    cx.notify();
                                }),
                            ),
                        ),
                )
                .when(!facts.is_empty(), |d| {
                    d.child(
                        div()
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from(facts)),
                    )
                })
                .when(!advice.is_empty(), |d| {
                    d.child(div().text_size(px(TEXT_XS)).muted(p).child(advice))
                })
                .when(n.result.status != ProviderTestStatus::Passed, |d| {
                    d.child(
                        outline_button("edit-checked-model", p)
                            .child("编辑模型")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                if this.settings.as_ref().is_some_and(|s| {
                                    s.model_checks.notice.as_ref().is_some_and(|n| n.id == id)
                                }) {
                                    if let Some(s) = this.settings.as_mut() {
                                        s.model_checks.dismiss(id);
                                    }
                                    this.open_model_detail(
                                        provider.clone(),
                                        model.clone(),
                                        window,
                                        cx,
                                    );
                                }
                            })),
                    )
                })
                .into_any_element(),
        )
    }
}
fn api_label(api: ApiProtocol) -> &'static str {
    match api {
        ApiProtocol::Chat => "Chat Completions",
        ApiProtocol::Responses => "Responses",
        ApiProtocol::Anthropic => "Anthropic Messages",
        ApiProtocol::Google => "Google Generative AI",
    }
}
fn advice(result: &ProviderTestResult) -> &'static str {
    match result.error_code {
        Some(ProviderTestError::Auth) => "鉴权失败，请检查已保存的密钥或登录状态",
        Some(ProviderTestError::Protocol) => "接口或参数不兼容，请检查模型协议与参数",
        Some(ProviderTestError::RateLimit) => "请求过于频繁，请稍后重试",
        Some(ProviderTestError::Network) => "无法连接提供方，请检查网络与地址",
        Some(ProviderTestError::Timeout) => "提供方未在时限内完成响应",
        Some(ProviderTestError::Model) => "模型不可用或配置已变化，请刷新后重新自检",
        Some(ProviderTestError::Unknown) => "提供方未能完成自检，请稍后重试或检查模型配置",
        None if result.tools == ProviderTestTools::Unconfirmed => {
            "普通回复正常，但未返回指定的测试工具调用"
        }
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::{CheckNotice, ModelChecks, Ticket, advice};
    use fv_protocol::provider_test::*;
    fn notice(id: u64) -> CheckNotice {
        CheckNotice {
            id,
            provider: "p".into(),
            model: "m".into(),
            name: "M".into(),
            overloaded: false,
            result: ProviderTestResult {
                model: "m".into(),
                api: None,
                status: ProviderTestStatus::Partial,
                tools: ProviderTestTools::Unconfirmed,
                first_token_ms: None,
                elapsed_ms: 0,
                error_code: None,
            },
        }
    }
    #[test]
    fn each_model_has_one_ticket_and_other_models_are_independent() {
        let mut s = ModelChecks::default();
        let a = s.begin("p", "a").unwrap();
        let b = s.begin("p", "b").unwrap();
        assert!(s.begin("p", "a").is_none());
        assert!(s.running("p", "a"));
        assert!(s.finish(&a));
        assert!(!s.finish(&a));
        assert!(s.running("p", "b"));
        assert!(s.finish(&b));
        assert!(s.begin("p", "a").is_some());
    }
    #[test]
    fn config_or_pane_changes_and_reopened_settings_reject_old_callbacks() {
        let mut s = ModelChecks::default();
        let old = s.begin("p", "m").unwrap();
        s.invalidate();
        let current = s.begin("p", "m").unwrap();
        assert!(!s.finish(&old));
        assert!(s.running("p", "m"));
        assert!(s.finish(&current));
        let mut reopened = ModelChecks::default();
        let new = reopened.begin("p", "m").unwrap();
        assert!(!reopened.finish(&Ticket {
            epoch: old.epoch,
            id: new.id,
            ..old
        }));
        assert!(reopened.finish(&new));
    }
    #[test]
    fn an_old_expiry_cannot_remove_a_new_notice_and_unconfirmed_tools_have_advice() {
        let mut s = ModelChecks {
            notice: Some(notice(2)),
            ..Default::default()
        };
        s.dismiss(1);
        assert_eq!(s.notice.as_ref().unwrap().id, 2);
        assert!(!advice(&s.notice.as_ref().unwrap().result).is_empty());
        s.dismiss(2);
        assert!(s.notice.is_none());
    }
}
