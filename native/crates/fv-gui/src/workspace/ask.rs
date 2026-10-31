//! What the agent puts to the user while it works, after codex's composer: a question stands
//! above the composer with numbered answers to pick (or words of one's own), and a request to
//! run something outside the sandbox covers the composer until it is answered. The composer's
//! permission button says how much the agent may do without asking.

use std::collections::BTreeMap;

use crate::ui::px;
use fv_protocol::RequestId;
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon};

actions!(fastvibe_ask, [ApproveOnce]);

/// How far through a request's questions the user is, and what they have said so far.
#[derive(Default)]
pub struct AskProgress {
    pub index: usize,
    pub answers: BTreeMap<String, UserInputAnswer>,
}

/// What is waiting for the user in the open conversation.
pub enum Pending<'a> {
    Approval(&'a RequestId, &'a ApprovalRequestParams),
    Question(&'a RequestId, &'a UserInputRequest),
}

/// How much the agent may do without asking: the three settings codex offers, and "custom" for
/// a combination that is none of them (reachable from 设置).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Edits outside the project and the network always ask.
    Ask,
    /// The sandbox decides, and asks only when it got in the way.
    Auto,
    /// No sandbox, nothing asked.
    Full,
    Custom,
}

impl Access {
    pub fn of(settings: &AppSettings) -> Self {
        match (settings.sandbox_mode, settings.approval_policy) {
            (SandboxMode::DangerFullAccess, _) => Access::Full,
            (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnRequest) => Access::Ask,
            (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnFailure) => Access::Auto,
            _ => Access::Custom,
        }
    }

    fn patch(self) -> AppSettingsPatch {
        let (mode, policy) = match self {
            Access::Ask | Access::Custom => {
                (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnRequest)
            }
            Access::Auto => (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnFailure),
            Access::Full => (SandboxMode::DangerFullAccess, ApprovalPolicy::OnRequest),
        };
        AppSettingsPatch {
            sandbox_mode: Some(mode),
            approval_policy: Some(policy),
            ..Default::default()
        }
    }
}

impl Workspace {
    /// The request the open conversation is waiting on: a command to allow before a question,
    /// since it holds a tool call.
    pub(super) fn pending(&self) -> Option<Pending<'_>> {
        if self.schedules_ui.open {
            return None;
        }
        let view = self.selected.as_ref().and_then(|id| self.views.get(id))?;
        view.approvals
            .first()
            .map(|(id, a)| Pending::Approval(id, a))
            .or_else(|| {
                view.questions
                    .first()
                    .map(|(id, q)| Pending::Question(id, q))
            })
    }

    // ---- answering

    /// Record the answer to the question being shown; the last one sends them all.
    pub(super) fn pick_answer(
        &mut self,
        request: RequestId,
        answer: String,
        cx: &mut Context<Self>,
    ) {
        let Some(total) = self
            .views
            .values()
            .flat_map(|v| v.questions.iter())
            .find(|(id, _)| *id == request)
            .map(|(_, q)| q.questions.len())
        else {
            return;
        };
        let progress = self.ask.entry(request.clone()).or_default();
        let Some(question) = self
            .views
            .values()
            .flat_map(|v| v.questions.iter())
            .find(|(id, _)| *id == request)
            .and_then(|(_, q)| q.questions.get(progress.index).map(|q| q.id.clone()))
        else {
            return;
        };
        progress.answers.insert(
            question,
            UserInputAnswer {
                answers: vec![answer],
            },
        );
        progress.index += 1;
        if progress.index >= total {
            let answers = std::mem::take(&mut progress.answers);
            self.ask.remove(&request);
            if let Some(b) = self.backend.clone() {
                let value = serde_json::to_value(UserInputResponse { answers }).unwrap_or_default();
                b.respond(request.clone(), value);
            }
            for view in self.views.values_mut() {
                view.questions.retain(|(id, _)| *id != request);
            }
        }
        cx.notify();
    }

    /// 跳过 / ×: decline the questions; the agent is told nobody answered.
    pub(super) fn skip_question(&mut self, request: RequestId, cx: &mut Context<Self>) {
        self.ask.remove(&request);
        if let Some(b) = self.backend.clone() {
            b.decline(request.clone(), "the user skipped the questions");
        }
        for view in self.views.values_mut() {
            view.questions.retain(|(id, _)| *id != request);
        }
        cx.notify();
    }

    /// 发送: the words typed in the box are the answer.
    pub(super) fn submit_free(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Pending::Question(id, _)) = self.pending() else {
            return;
        };
        self.submit_free_for(id.clone(), window, cx);
    }

    /// Submit the free-form answer for a question in any loaded thread, including a child
    /// displayed in the auxiliary side pane.
    pub(super) fn submit_free_for(
        &mut self,
        request: RequestId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = self.ask_input.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.ask_input
            .update(cx, |st, cx| st.set_value("", window, cx));
        self.pick_answer(request, text, cx);
    }

    /// Enter on an approval: allow it this once.
    pub(super) fn on_approve_once(
        &mut self,
        _: &ApproveOnce,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(Pending::Approval(id, _)) = self.pending() {
            let id = id.clone();
            self.decide(id, ApprovalDecision::Approved, cx);
        }
    }

    /// Esc: refuse what is asked, or skip the questions.
    pub(super) fn dismiss_pending(&mut self, cx: &mut Context<Self>) -> bool {
        match self.pending() {
            Some(Pending::Approval(id, _)) => {
                let id = id.clone();
                self.decide(id, ApprovalDecision::Denied, cx);
                true
            }
            Some(Pending::Question(id, _)) => {
                let id = id.clone();
                self.skip_question(id, cx);
                true
            }
            None => false,
        }
    }

    /// Put the keyboard where the panel is, once per request.
    pub(super) fn focus_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = match self.pending() {
            Some(Pending::Approval(id, _)) | Some(Pending::Question(id, _)) => Some(id.clone()),
            None => None,
        };
        if key == self.focused_for {
            return;
        }
        self.focused_for = key;
        match self.pending() {
            Some(Pending::Approval(..)) => self.panel_focus.focus(window, cx),
            Some(Pending::Question(..)) => {
                let input = self.ask_input.clone();
                input.update(cx, |st, cx| st.focus(window, cx));
            }
            None => {
                let input = self.input.clone();
                input.update(cx, |st, cx| st.focus(window, cx));
            }
        }
    }

    // ---- drawing

    /// A question above the composer: numbered answers, or the user's own words.
    pub(super) fn question_panel(
        &self,
        id: &RequestId,
        q: &UserInputRequest,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let index = self.ask.get(id).map(|a| a.index).unwrap_or(0);
        let total = q.questions.len();
        let Some(question) = q.questions.get(index.min(total.saturating_sub(1))) else {
            return div().into_any_element();
        };
        let hover = p.c(Token::Muted);
        let typed = !self.ask_input.read(cx).value().trim().is_empty();

        let mut options = div().flex().flex_col().gap(px(2.0));
        for (i, opt) in question.options.iter().enumerate() {
            let (request, label) = (id.clone(), opt.label.clone());
            let group = SharedString::from(format!("option-{i}"));
            options = options.child(
                div()
                    .id(SharedString::from(format!("answer-{i}")))
                    .group(group.clone())
                    .h(px(40.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .rounded(px(12.0))
                    .cursor_pointer()
                    .when(i == 0, move |d| d.bg(hover))
                    .hover(move |d| d.bg(hover))
                    .child(
                        div()
                            .size(px(24.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(p.c(Token::Border))
                            .bg(p.c(Token::Background).opacity(0.7))
                            .text_size(px(TEXT_XS))
                            .muted(p)
                            .child(SharedString::from((i + 1).to_string())),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .child(SharedString::from(opt.label.clone())),
                            )
                            .when(!opt.description.is_empty(), |d| {
                                d.child(
                                    ui::truncate(opt.description.clone())
                                        .text_size(px(TEXT_XS))
                                        .muted(p),
                                )
                            }),
                    )
                    .child(
                        div()
                            .when(i != 0, |d| {
                                d.invisible().group_hover(group, |s| s.visible())
                            })
                            .child(icon("arrow-right02", 16.0, p.c(Token::MutedForeground))),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.pick_answer(request.clone(), label.clone(), cx)
                    })),
            );
        }

        let (skip_id, send_id) = (id.clone(), id.clone());
        let skip = div()
            .id("ask-skip")
            .h(px(32.0))
            .px(px(14.0))
            .flex()
            .items_center()
            .rounded_full()
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Background))
            .cursor_pointer()
            .text_size(px(12.8))
            .font_weight(FontWeight::MEDIUM)
            .child(trs!(english, "ask.skip"))
            .on_click(cx.listener(move |this, _, _, cx| this.skip_question(skip_id.clone(), cx)));
        let send = div()
            .id("ask-send")
            .h(px(32.0))
            .px(px(14.0))
            .flex()
            .items_center()
            .rounded_full()
            .text_size(px(12.8))
            .font_weight(FontWeight::MEDIUM)
            .when(typed, |d| {
                d.bg(p.c(Token::Primary))
                    .text_color(p.c(Token::PrimaryForeground))
                    .cursor_pointer()
            })
            .when(!typed, |d| {
                d.bg(p.c(Token::Muted))
                    .text_color(p.c(Token::MutedForeground))
            })
            .child(trs!(english, "ask.send"))
            .on_click(cx.listener(move |this, _, window, cx| {
                let _ = &send_id;
                this.submit_free_for(send_id.clone(), window, cx)
            }));

        div()
            .id("question-panel")
            .rounded(px(22.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .shadow_sm()
            .p(px(16.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(icon("help-circle", 16.0, p.c(Token::MutedForeground)))
                    .child(div().flex_1().text_size(px(TEXT_SM)).muted(p).child(
                        SharedString::from(if total > 1 {
                            format!("问题 {}/{}", index + 1, total)
                        } else {
                            trs!(english, "ask.question").to_string()
                        }),
                    ))
                    .child(
                        ui::icon_button_xs("ask-close", "cancel01", p).on_click(cx.listener({
                            let id = id.clone();
                            move |this, _, _, cx| this.skip_question(id.clone(), cx)
                        })),
                    ),
            )
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(SharedString::from(question.question.clone())),
            )
            .child(options)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .child(icon("pencil-edit02", 16.0, p.c(Token::MutedForeground)))
                    .child(
                        div().flex_1().child(
                            crate::ui::input(&self.ask_input)
                                .h_5()
                                .px_0()
                                .py_0()
                                .appearance(false)
                                .bordered(false),
                        ),
                    )
                    .child(skip)
                    .child(send),
            )
            .into_any_element()
    }

    /// A command or patch waiting for the user: it takes the composer's place until answered.
    pub(super) fn approval_panel(
        &self,
        id: &RequestId,
        a: &ApprovalRequestParams,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = &self.palette;
        let english = self.app_settings.language == fv_protocol::types::UiLanguage::English;
        let (glyph, kind, detail) = match &a.kind {
            ApprovalKind::Command { command, .. } => (
                "command-line",
                trs!(english, "ask.terminal"),
                command.clone(),
            ),
            ApprovalKind::Patch { files } => {
                ("edit02", trs!(english, "ask.files"), files.join("\n"))
            }
        };
        let question = a.reason.clone().unwrap_or_else(|| match &a.kind {
            ApprovalKind::Command { .. } => {
                trs!(english, "ask.allow_this_command_to_run").to_string()
            }
            ApprovalKind::Patch { .. } => trs!(english, "ask.allow_these_files_to_be").to_string(),
        });
        let kbd = |label: &'static str, on_dark: bool| {
            div()
                .h(px(20.0))
                .min_w(px(20.0))
                .px(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.0))
                .text_size(px(TEXT_XS))
                .when(on_dark, |d| {
                    d.bg(p.c(Token::PrimaryForeground).opacity(0.18))
                        .text_color(p.c(Token::PrimaryForeground))
                })
                .when(!on_dark, |d| d.bg(p.c(Token::Muted)).muted(p))
                .child(label)
        };
        let (deny_id, once_id, session_id) = (id.clone(), id.clone(), id.clone());
        let deny = div()
            .id("approval-deny")
            .h(px(36.0))
            .px(px(14.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded_full()
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Background))
            .cursor_pointer()
            .text_size(px(TEXT_SM))
            .child(trs!(english, "ask.deny"))
            .child(kbd("Esc", false))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.decide(deny_id.clone(), ApprovalDecision::Denied, cx)
            }));
        let once = div()
            .id("approval-once")
            .h(px(36.0))
            .pl(px(16.0))
            .pr(px(10.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .rounded_l_full()
            .bg(p.c(Token::Primary))
            .text_color(p.c(Token::PrimaryForeground))
            .cursor_pointer()
            .text_size(px(TEXT_SM))
            .child(trs!(english, "ask.allow_once"))
            .child(kbd("↵", true))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.decide(once_id.clone(), ApprovalDecision::Approved, cx)
            }));
        let more = div()
            .id("approval-more")
            .h(px(36.0))
            .w(px(36.0))
            .ml(px(1.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded_r_full()
            .bg(p.c(Token::Primary))
            .cursor_pointer()
            .child(icon("arrow-down01", 16.0, p.c(Token::PrimaryForeground)))
            .on_click(cx.listener(|this, _, _, cx| {
                this.approval_menu = !this.approval_menu;
                cx.notify();
            }));
        let menu = self.approval_menu.then(|| {
            ui::float(
                super::settings::popover(p)
                    .absolute()
                    .right(px(0.0))
                    .bottom(px(44.0))
                    .w(px(220.0))
                    .child(
                        super::settings::menu_item(
                            SharedString::from("approval-session"),
                            false,
                            p.c(Token::Accent),
                        )
                        .child(trs!(english, "ask.allow_for_this_chat"))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.approval_menu = false;
                            this.decide(
                                session_id.clone(),
                                ApprovalDecision::ApprovedForSession,
                                cx,
                            )
                        })),
                    ),
            )
        });

        div()
            .id("approval-panel")
            .key_context("ApprovalPanel")
            .track_focus(&self.panel_focus)
            .on_action(cx.listener(Self::on_approve_once))
            .relative()
            .rounded(px(22.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .shadow_sm()
            .px(px(20.0))
            .pt(px(18.0))
            .pb(px(16.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .child(icon(glyph, 18.0, p.c(Token::MutedForeground)))
                    .child(div().text_size(px(TEXT_SM)).muted(p).child(kind)),
            )
            .child(
                div()
                    .text_size(px(TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .child(SharedString::from(question)),
            )
            .child(
                div()
                    .id("approval-detail")
                    .max_h(px(120.0))
                    .overflow_y_scroll()
                    .pt(px(6.0))
                    .font_family(crate::assets::MONO_FONT)
                    .text_size(px(13.0))
                    .line_height(px(22.0))
                    .muted(p)
                    .children(
                        detail
                            .lines()
                            .map(|l| div().child(SharedString::from(l.to_string()))),
                    ),
            )
            .child(
                div()
                    .relative()
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(8.0))
                    .child(deny)
                    .child(div().flex().child(once).child(more))
                    .children(menu),
            )
            .into_any_element()
    }

    // ---- the permission button

    /// The composer's permission button and its list: how much the agent may do unasked.
    pub(super) fn access_menu_view(&self, cx: &mut Context<Self>) -> Div {
        let p = &self.palette;
        let current = Access::of(&self.app_settings);
        let hover = p.c(Token::Accent);
        let item =
            |access: Access, glyph: &'static str, title: &'static str, text: &'static str| {
                let danger = access == Access::Full;
                let tone = if danger {
                    p.c(Token::Warning)
                } else {
                    p.c(Token::Foreground)
                };
                super::settings::menu_item(
                    SharedString::from(format!("access-{access:?}")),
                    false,
                    hover,
                )
                .min_h(px(56.0))
                .py(px(8.0))
                .items_start()
                .gap(px(10.0))
                .child(div().pt(px(2.0)).child(icon(
                    glyph,
                    18.0,
                    if danger {
                        tone
                    } else {
                        p.c(Token::MutedForeground)
                    },
                )))
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_size(px(TEXT_SM))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(tone)
                                .child(title),
                        )
                        .child(
                            div()
                                .text_size(px(TEXT_XS))
                                .text_color(if danger {
                                    tone
                                } else {
                                    p.c(Token::MutedForeground)
                                })
                                .child(text),
                        ),
                )
                .when(current == access, |d| {
                    d.child(div().pt(px(2.0)).child(icon("tick02", 16.0, tone)))
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.access_menu = false;
                    this.patch_settings(access.patch(), cx)
                }))
            };
        super::settings::popover(p)
            .absolute()
            .left(px(10.0))
            .bottom(px(48.0))
            .w(px(340.0))
            .p(px(8.0))
            .child(
                div()
                    .px(px(8.0))
                    .pb(px(6.0))
                    .text_size(px(TEXT_SM))
                    .muted(p)
                    .child(trs!(self.english(), "ask.how_should_fastvibe_s_actions")),
            )
            .child(item(
                Access::Ask,
                "hand",
                trs!(self.english(), "ask.ask_for_approval"),
                trs!(self.english(), "ask.always_ask_before_editing_files"),
            ))
            .child(item(
                Access::Auto,
                "security-check",
                trs!(self.english(), "ask.run_in_the_sandbox"),
                trs!(self.english(), "ask.commands_run_in_the_sandbox"),
            ))
            .child(item(
                Access::Full,
                "shield-alert",
                trs!(self.english(), "ask.full_access"),
                trs!(self.english(), "ask.unrestricted_access_to_the_network"),
            ))
    }

    /// The button itself: an orange pill while access is full, else a quiet glyph.
    pub(super) fn access_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let p = &self.palette;
        let access = Access::of(&self.app_settings);
        let hover = p.c(Token::Muted);
        let base = div()
            .id("access-button")
            .h(px(28.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .rounded_full()
            .cursor_pointer()
            .hover(move |d| d.bg(hover))
            .on_click(cx.listener(|this, _, _, cx| {
                this.access_menu = !this.access_menu;
                this.model_menu = false;
                cx.notify();
            }));
        match access {
            Access::Full => base
                .px(px(10.0))
                .bg(p.c(Token::Warning).opacity(0.1))
                .text_size(px(12.8))
                .text_color(p.c(Token::Warning))
                .child(icon("shield-alert", 16.0, p.c(Token::Warning)))
                .child(trs!(self.english(), "ask.full_access_2")),
            Access::Auto => base.w(px(28.0)).justify_center().child(icon(
                "security-check",
                16.0,
                p.c(Token::MutedForeground),
            )),
            _ => base.w(px(28.0)).justify_center().child(icon(
                "hand",
                16.0,
                p.c(Token::MutedForeground),
            )),
        }
    }
}
