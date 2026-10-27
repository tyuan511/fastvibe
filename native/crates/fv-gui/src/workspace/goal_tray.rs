//! `/goal`, `/plan` and `/review`, and the strip above the composer that shows a goal or plan
//! mode while one is in force.
//!
//! The commands are typed into the composer like `/skill:`; they act on the conversation that is
//! open and never reach the model as text. The strip is the only place a goal can be paused,
//! resumed or cleared with the mouse.

use fv_protocol::methods::*;
use fv_protocol::types::{
    Goal, GoalSetParams, GoalStatus, ReviewTarget, ThreadIdParams, ThreadMode, ThreadModeParams,
    ThreadReviewParams,
};
use fv_theme::Token;
use gpui_kit::*;

use super::Workspace;
use crate::ui::{Muted as _, TEXT_XS, icon, truncate};

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

    fn strip_button(
        &self,
        id: &'static str,
        label: &'static str,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let p = &self.palette;
        let hover = p.c(Token::Accent);
        div()
            .id(id)
            .h(px(20.0))
            .px(px(8.0))
            .flex()
            .items_center()
            .rounded(px(6.0))
            .text_size(px(TEXT_XS))
            .muted(p)
            .cursor_pointer()
            .hover(move |d| d.bg(hover).text_color(p.c(Token::Foreground)))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
    }

    /// The goal and plan-mode strip above the composer; `None` when neither is in force.
    pub(super) fn goal_tray(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let view = self.selected.as_ref().and_then(|id| self.views.get(id))?;
        let goal: Option<Goal> = view.goal.clone();
        let plan = view.mode == ThreadMode::Plan;
        if goal.is_none() && !plan {
            return None;
        }
        let english = self.english();
        let p = &self.palette;
        let mut strip = div()
            .mb(px(8.0))
            .rounded(px(14.0))
            .border_1()
            .border_color(p.c(Token::Border))
            .bg(p.c(Token::Card))
            .overflow_hidden()
            .flex()
            .flex_col();
        if let Some(goal) = goal {
            let (state, tone) = match goal.status {
                GoalStatus::Running => (trs!(english, "goal.running"), Token::MutedForeground),
                GoalStatus::Paused => (trs!(english, "goal.paused"), Token::Warning),
                GoalStatus::Complete => (trs!(english, "goal.complete"), Token::MutedForeground),
            };
            let mut row = div()
                .h(px(32.0))
                .px(px(10.0))
                .flex()
                .items_center()
                .gap(px(8.0))
                .text_size(px(TEXT_XS))
                .child(icon("target01", 12.0, p.c(tone)))
                .child(
                    div()
                        .flex_none()
                        .text_color(p.c(tone))
                        .child(SharedString::from(format!(
                            "{} · {} · {}",
                            trs!(english, "goal.label"),
                            tr!(english, "goal.round", n = goal.round),
                            state
                        ))),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(truncate(goal.objective.clone())),
                );
            match goal.status {
                GoalStatus::Running => {
                    row = row.child(self.strip_button(
                        "goal-pause",
                        trs!(english, "goal.pause"),
                        cx,
                        |this, cx| this.goal_call(Some(false), cx),
                    ));
                }
                GoalStatus::Paused => {
                    row = row.child(self.strip_button(
                        "goal-resume",
                        trs!(english, "goal.resume"),
                        cx,
                        |this, cx| this.goal_call(Some(true), cx),
                    ));
                }
                GoalStatus::Complete => {}
            }
            row = row.child(self.strip_button(
                "goal-clear",
                trs!(english, "goal.clear"),
                cx,
                |this, cx| this.goal_call(None, cx),
            ));
            strip = strip.child(row);
        }
        if plan {
            strip = strip.child(
                div()
                    .h(px(32.0))
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(TEXT_XS))
                    .child(icon("list", 12.0, p.c(Token::MutedForeground)))
                    .child(div().flex_1().child(trs!(english, "goal.plan_mode")))
                    .child(self.strip_button(
                        "plan-leave",
                        trs!(english, "goal.leave_plan"),
                        cx,
                        |this, cx| this.leave_plan(cx),
                    )),
            );
        }
        Some(strip.into_any_element())
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
