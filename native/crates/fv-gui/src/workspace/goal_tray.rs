//! `/goal`, `/plan` and `/review`, and the strip above the composer that shows a goal or plan
//! mode while one is in force.
//!
//! The commands are typed into the composer like `/skill:`; they act on the conversation that is
//! open and never reach the model as text. The strip is the only place a goal can be paused,
//! resumed or cleared with the mouse.

use crate::ui::px;
use fv_protocol::methods::*;
use fv_protocol::types::{
    Goal, GoalSetParams, GoalStatus, ReviewTarget, ThreadIdParams, ThreadMode, ThreadModeParams,
    ThreadReviewParams,
};
use fv_theme::Token;
use gpui_kit::*;

use super::Workspace;
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS, icon, truncate};

/// What a typed line asks for, parsed apart from the window so it can be tested.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Command {
    GoalShow,
    GoalSet(String),
    GoalPause,
    GoalResume,
    GoalClear,
    Plan(Option<bool>),
    Review(ReviewTarget),
}

pub(super) fn parse(line: &str) -> Option<Command> {
    let line = line.trim();
    let (word, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    let rest = rest.trim();
    match word {
        "/goal" => Some(match rest {
            "" => Command::GoalShow,
            "pause" => Command::GoalPause,
            "resume" => Command::GoalResume,
            "clear" | "off" | "reset" => Command::GoalClear,
            objective => Command::GoalSet(objective.to_string()),
        }),
        "/plan" => Some(Command::Plan(match rest {
            "on" => Some(true),
            "off" => Some(false),
            _ => None,
        })),
        "/review" => Some(Command::Review(
            match rest.split_once(char::is_whitespace) {
                _ if rest.is_empty() => ReviewTarget::Uncommitted,
                Some(("base", base)) if !base.trim().is_empty() => ReviewTarget::Base {
                    base: base.trim().to_string(),
                },
                Some(("commit", sha)) if !sha.trim().is_empty() => ReviewTarget::Commit {
                    sha: sha.trim().to_string(),
                },
                _ => ReviewTarget::Custom {
                    instructions: rest.to_string(),
                },
            },
        )),
        _ => None,
    }
}

impl Workspace {
    /// Run a typed `/goal`, `/plan` or `/review`. `false` means the line is not one of them and
    /// is an ordinary message.
    pub(super) fn run_command(
        &mut self,
        line: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(command) = parse(line) else {
            return false;
        };
        let english = self.english();
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            self.fail(trs!(english, "goal.need_chat"), cx);
            return true;
        };
        if matches!(command, Command::GoalShow) {
            return true;
        }
        self.input
            .update(cx, |state, cx| state.set_value("", window, cx));
        cx.spawn(async move |this, cx| {
            let thread_id = id.clone();
            let result: Result<(), fv_client::ClientError> = match &command {
                Command::GoalShow => Ok(()),
                Command::GoalSet(objective) => b
                    .call::<ThreadGoalSet>(GoalSetParams {
                        thread_id: id.clone(),
                        objective: objective.clone(),
                    })
                    .await
                    .map(|_| ()),
                Command::GoalPause => b
                    .call::<ThreadGoalPause>(ThreadIdParams { thread_id: id })
                    .await
                    .map(|_| ()),
                Command::GoalResume => b
                    .call::<ThreadGoalResume>(ThreadIdParams { thread_id: id })
                    .await
                    .map(|_| ()),
                Command::GoalClear => b
                    .call::<ThreadGoalClear>(ThreadIdParams { thread_id: id })
                    .await
                    .map(|_| ()),
                Command::Plan(wanted) => {
                    let on = this
                        .update(cx, |this, _| {
                            wanted.unwrap_or_else(|| {
                                this.views
                                    .get(&thread_id)
                                    .is_none_or(|v| v.mode != ThreadMode::Plan)
                            })
                        })
                        .unwrap_or(false);
                    let mode = if on {
                        ThreadMode::Plan
                    } else {
                        ThreadMode::Default
                    };
                    let done = b
                        .call::<ThreadModeSet>(ThreadModeParams {
                            thread_id: id,
                            mode,
                        })
                        .await
                        .map(|_| ());
                    if done.is_ok() {
                        this.update(cx, |this, cx| {
                            if let Some(view) = this.views.get_mut(&thread_id) {
                                view.mode = mode;
                            }
                            let english = this.english();
                            this.done(
                                if on {
                                    trs!(english, "goal.plan_on")
                                } else {
                                    trs!(english, "goal.plan_off")
                                },
                                cx,
                            );
                        })
                        .ok();
                    }
                    done
                }
                Command::Review(target) => {
                    let done = b
                        .call::<ThreadReviewStart>(ThreadReviewParams {
                            thread_id: id,
                            target: target.clone(),
                        })
                        .await
                        .map(|_| ());
                    if done.is_ok() {
                        this.update(cx, |this, cx| {
                            let english = this.english();
                            this.done(trs!(english, "goal.review_started"), cx);
                        })
                        .ok();
                    }
                    done
                }
            };
            if let Err(e) = result {
                this.update(cx, |this, cx| {
                    let english = this.english();
                    this.fail(tr!(english, "goal.failed", e = e), cx);
                })
                .ok();
            }
        })
        .detach();
        true
    }

    fn goal_call(&mut self, resume: Option<bool>, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        cx.spawn(async move |_, _| {
            let thread_id = id;
            let _ = match resume {
                Some(true) => b
                    .call::<ThreadGoalResume>(ThreadIdParams { thread_id })
                    .await
                    .map(|_| ()),
                Some(false) => b
                    .call::<ThreadGoalPause>(ThreadIdParams { thread_id })
                    .await
                    .map(|_| ()),
                None => b
                    .call::<ThreadGoalClear>(ThreadIdParams { thread_id })
                    .await
                    .map(|_| ()),
            };
        })
        .detach();
    }

    fn leave_plan(&mut self, cx: &mut Context<Self>) {
        let (Some(b), Some(id)) = (self.backend.clone(), self.selected.clone()) else {
            return;
        };
        if let Some(view) = self.views.get_mut(&id) {
            view.mode = ThreadMode::Default;
        }
        cx.notify();
        cx.spawn(async move |_, _| {
            let _ = b
                .call::<ThreadModeSet>(ThreadModeParams {
                    thread_id: id,
                    mode: ThreadMode::Default,
                })
                .await;
        })
        .detach();
    }

    /// `IconButton size="icon-xs" variant="ghost"` with a tooltip-sized label.
    fn strip_button(
        &self,
        id: &'static str,
        glyph: &'static str,
        label: &'static str,
        color: Hsla,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let hover = self.palette.c(Token::Muted);
        div()
            .id(id)
            .size(px(24.0))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.0))
            .cursor_pointer()
            .hover(move |d| d.bg(hover))
            .child(icon(glyph, 14.0, color))
            .aria_label(label)
            .tooltip(move |window, cx| {
                gpui_kit::component::tooltip::Tooltip::new(label).build(window, cx)
            })
            .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
    }

    /// `GoalPanel`: one bordered row above the composer — the target glyph, a status badge,
    /// the round, the objective, and its controls as icons.
    pub(super) fn goal_tray(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let view = self.selected.as_ref().and_then(|id| self.views.get(id))?;
        let goal: Option<Goal> = view.goal.clone();
        let plan = view.mode == ThreadMode::Plan;
        if goal.is_none() && !plan {
            return None;
        }
        let english = self.english();
        let p = &self.palette;
        let row = || {
            div()
                .mb(px(8.0))
                .px(px(12.0))
                .py(px(6.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .rounded(px(12.0))
                .border_1()
                .border_color(p.c(Token::Border))
                .bg(p.c(Token::Card))
        };
        let badge = |label: &'static str, tone: Token| {
            div()
                .h(px(20.0))
                .px(px(8.0))
                .flex()
                .flex_none()
                .items_center()
                .rounded_full()
                .bg(p.c(Token::Secondary))
                .text_color(p.c(tone))
                .text_size(px(TEXT_XS))
                .font_weight(FontWeight::MEDIUM)
                .child(label)
        };
        let mut strip = div().flex().flex_col();
        if let Some(goal) = goal {
            let (state, tone) = match goal.status {
                GoalStatus::Running => (trs!(english, "goal.running"), Token::Primary),
                GoalStatus::Paused => (trs!(english, "goal.paused"), Token::Warning),
                GoalStatus::Complete => (trs!(english, "goal.complete"), Token::Success),
            };
            let mut line = row()
                .child(icon("target01", 16.0, p.c(Token::Primary)))
                .child(badge(state, tone))
                .child(div().flex_none().text_size(px(TEXT_XS)).muted(p).child(tr!(
                    english,
                    "goal.round",
                    n = goal.round.max(1)
                )))
                .child(
                    truncate(goal.objective.clone())
                        .flex_1()
                        .text_size(px(TEXT_SM))
                        .muted(p),
                );
            let ink = p.c(Token::Foreground);
            match goal.status {
                GoalStatus::Running => {
                    line = line.child(self.strip_button(
                        "goal-pause",
                        "pause",
                        trs!(english, "goal.pause"),
                        ink,
                        cx,
                        |this, cx| this.goal_call(Some(false), cx),
                    ));
                }
                GoalStatus::Paused => {
                    line = line.child(self.strip_button(
                        "goal-resume",
                        "play",
                        trs!(english, "goal.resume"),
                        ink,
                        cx,
                        |this, cx| this.goal_call(Some(true), cx),
                    ));
                }
                GoalStatus::Complete => {}
            }
            line = line.child(self.strip_button(
                "goal-clear",
                "delete02",
                trs!(english, "goal.clear"),
                p.c(Token::Destructive),
                cx,
                |this, cx| this.goal_call(None, cx),
            ));
            strip = strip.child(line);
        }
        if plan {
            // Native-only: plan mode, drawn as the same row.
            strip = strip.child(
                row()
                    .child(icon("list", 16.0, p.c(Token::Primary)))
                    .child(
                        truncate(trs!(english, "goal.plan_mode"))
                            .flex_1()
                            .text_size(px(TEXT_SM))
                            .muted(p),
                    )
                    .child(self.strip_button(
                        "plan-leave",
                        "cancel01",
                        trs!(english, "goal.leave_plan"),
                        p.c(Token::Foreground),
                        cx,
                        |this, cx| this.leave_plan(cx),
                    )),
            );
        }
        Some(strip.into_any_element())
    }
}

impl Workspace {
    /// Dev only (`--fixture goal`): a running goal on the chat on screen, as `?goal=1` shows it.
    pub fn show_goal_fixture(&mut self, cx: &mut Context<Self>) {
        if let Some(view) = self.selected.as_ref().and_then(|id| self.views.get_mut(id)) {
            view.goal = Some(Goal {
                objective: "分析下作为一个智能体客户端还有哪些比较重要的需求没做的，并把它们拆成本周可以完成的任务".into(),
                status: GoalStatus::Running,
                round: 3,
            });
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{Command, parse};
    use fv_protocol::types::ReviewTarget;

    #[test]
    fn commands_are_told_apart_from_prose() {
        assert_eq!(
            parse("/goal ship v2"),
            Some(Command::GoalSet("ship v2".into()))
        );
        assert_eq!(parse("/goal"), Some(Command::GoalShow));
        assert_eq!(parse("/goal pause"), Some(Command::GoalPause));
        assert_eq!(parse("/goal clear"), Some(Command::GoalClear));
        assert_eq!(parse("/plan"), Some(Command::Plan(None)));
        assert_eq!(parse("/plan off"), Some(Command::Plan(Some(false))));
        assert_eq!(
            parse("/review"),
            Some(Command::Review(ReviewTarget::Uncommitted))
        );
        assert_eq!(
            parse("/review base main"),
            Some(Command::Review(ReviewTarget::Base {
                base: "main".into()
            }))
        );
        assert_eq!(
            parse("/review commit abc123"),
            Some(Command::Review(ReviewTarget::Commit {
                sha: "abc123".into()
            }))
        );
        assert_eq!(
            parse("/review look at the auth code"),
            Some(Command::Review(ReviewTarget::Custom {
                instructions: "look at the auth code".into()
            }))
        );
        // A path, a URL or prose that merely begins with a slash is a message.
        assert_eq!(parse("/usr/bin/env is where?"), None);
        assert_eq!(parse("/goalpost"), None);
        assert_eq!(parse("/skill:office hi"), None);
    }
}
