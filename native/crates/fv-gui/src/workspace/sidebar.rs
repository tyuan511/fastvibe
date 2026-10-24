//! The sidebar, after `components/layout/sidebar.tsx` and `sidebar-rows.tsx`: the traffic-light
//! row, the brand row, three navigation rows, then 项目 and 聊天, and 设置 at the foot.

use fv_protocol::types::Thread;
use fv_protocol::types::ThreadUpdateParams;
use fv_theme::Token;
use gpui_kit::component::input::Input;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{Workspace, text};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button, icon_button_xs};

/// The column's resting width, the transparent 8px inset included.
pub const SIDEBAR_WIDTH: f32 = 264.0;
/// The floating panes sit this far from the window edge.
pub const INSET: f32 = 8.0;

impl Workspace {
    pub(super) fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        div()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex_none()
            .p(px(INSET))
            .child(
                div()
                    .relative()
                    .size_full()
                    .rounded(px(16.0))
                    .bg(p.pane())
                    .text_color(p.c(Token::SidebarForeground))
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .child(self.traffic_light_row())
                    .child(self.brand_and_nav(cx))
                    .child(self.lists(cx))
                    .child(self.footer(cx))
                    // The hairline is drawn over the pane, not around its content, so it
                    // takes no room: the rows sit where the Electron pane puts them.
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded(px(16.0))
                            .border_1()
                            .border_color(p.c(Token::SidebarBorder)),
                    ),
            )
    }

    /// macOS draws its window buttons at the start of this row; the panel controls follow.
    fn traffic_light_row(&self) -> impl IntoElement {
        let p = &self.palette;
        div()
            .h(px(44.0))
            .flex_none()
            .pl(px(88.0))
            .flex()
            .items_center()
            .gap(px(2.0))
            .child(icon_button("collapse-sidebar", "panel-left-close", p))
            .child(icon_button("back", "arrow-left01", p).opacity(0.5))
            .child(icon_button("forward", "arrow-right01", p).opacity(0.5))
    }

    fn brand_and_nav(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let nav = |id: &'static str, glyph: &'static str, label: &'static str| {
            nav_row(id, glyph, label, p)
        };
        div()
            .flex_none()
            .px(px(8.0))
            .child(
                div()
                    .h(px(32.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .px(px(8.0))
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(img("app-icon.png").size(px(20.0)).rounded(px(6.0)))
                            .child(
                                div()
                                    .text_size(px(TEXT_SM))
                                    .line_height(px(20.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("FastVibe"),
                            ),
                    )
                    .child(icon_button("search", "search01", p)),
            )
            .child(
                div()
                    .mt(px(4.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        nav("new-chat", "message-square-plus", text::NEW_CHAT).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.selected = None;
                                cx.notify();
                            }),
                        ),
                    )
                    .child(nav("plugins", "puzzle", text::PLUGINS))
                    .child(nav("tasks", "clock01", text::TASKS)),
            )
    }

    fn lists(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let all_visible: Vec<&Thread> = self.threads.iter().filter(|t| !t.archived).collect();
        let pinned: Vec<&Thread> = all_visible.iter().copied().filter(|t| t.pinned).collect();
        let visible: Vec<&Thread> = all_visible.iter().copied().filter(|t| !t.pinned).collect();

        // Projects in the order their most recent chat was touched; each lists its chats.
        // A project is a listed folder, empty or not; a chat from one that was removed from the
        // list is shown with the plain chats.
        let in_list = |t: &Thread| {
            t.project
                .as_ref()
                .is_some_and(|p| self.projects.iter().any(|x| &x.path == p))
        };
        let projects: Vec<(String, Vec<&Thread>)> = self
            .projects
            .iter()
            .map(|proj| {
                (
                    proj.path.clone(),
                    visible
                        .iter()
                        .copied()
                        .filter(|t| t.project.as_ref() == Some(&proj.path))
                        .collect(),
                )
            })
            .collect();
        let chats: Vec<&Thread> = visible.iter().copied().filter(|t| !in_list(t)).collect();

        let mut body = div()
            .px(px(8.0))
            .pt(px(12.0))
            .pb(px(12.0))
            .flex()
            .flex_col();
        if !pinned.is_empty() {
            let mut list = div().flex().flex_col().gap(px(2.0));
            for t in &pinned {
                list = list.child(self.session_row(t, false, cx));
            }
            body = body
                .child(
                    div()
                        .pl(px(8.0))
                        .py(px(4.0))
                        .mb(px(0.0))
                        .text_size(px(TEXT_XS))
                        .font_weight(FontWeight::MEDIUM)
                        .muted(p)
                        .child("置顶"),
                )
                .child(list);
        }
        body = body.child(section_label(
            text::PROJECTS,
            pinned.is_empty(),
            icon_button_xs("new-project", "add01", p)
                .on_click(cx.listener(|this, _, _, cx| this.add_project(cx))),
            p,
        ));
        if projects.is_empty() {
            body = body.child(
                div()
                    .px(px(8.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(text::NO_PROJECTS),
            );
        } else {
            // Projects are 2px apart; a project's chats follow its row directly.
            let mut list = div().flex().flex_col().gap(px(2.0));
            for (project, threads) in &projects {
                let open = !self.closed_projects.contains(project);
                let mut group = div()
                    .flex()
                    .flex_col()
                    .child(self.project_row(project, open, cx));
                if open {
                    let mut sessions = div().flex().flex_col().gap(px(2.0));
                    for t in threads {
                        sessions = sessions.child(self.session_row(t, true, cx));
                    }
                    group = group.child(sessions);
                }
                list = list.child(group);
            }
            body = body.child(list);
        }
        body = body.child(section_label(
            text::CHATS,
            false,
            icon_button_xs("new-session", "pencil-edit02", p),
            p,
        ));
        if chats.is_empty() {
            body = body.child(
                div()
                    .px(px(8.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_XS))
                    .muted(p)
                    .child(text::EMPTY_CHATS),
            );
        } else {
            let mut list = div().flex().flex_col().gap(px(2.0));
            for t in &chats {
                list = list.child(self.session_row(t, false, cx));
            }
            body = body.child(list);
        }
        div()
            .id("sidebar-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(body)
    }

    fn project_row(&self, project: &str, open: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let name = project
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(project)
            .to_string();
        let key = project.to_string();
        let (more_key, new_key) = (key.clone(), key.clone());
        let group = SharedString::from(format!("project-{project}"));
        let hover = ui::half(p.c(Token::SidebarAccent));
        div()
            .id(SharedString::from(format!("project-row-{project}")))
            .group(group.clone())
            .h(px(32.0))
            .pl(px(8.0))
            .pr(px(4.0))
            .flex()
            .items_center()
            .gap(px(2.0))
            .rounded(px(8.0))
            .cursor_pointer()
            .hover(move |d| d.bg(hover))
            .on_click(cx.listener(move |this, _, _, cx| {
                if !this.closed_projects.remove(&key) {
                    this.closed_projects.insert(key.clone());
                }
                cx.notify();
            }))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .text_size(px(TEXT_SM))
                    .child(icon(
                        if open { "folder02" } else { "folder01" },
                        14.0,
                        p.c(Token::MutedForeground),
                    ))
                    .child(ui::truncate(name)),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .invisible()
                    .group_hover(group, |s| s.visible())
                    .child(
                        icon_button_xs(
                            SharedString::from(format!("project-more-{project}")),
                            "more-horizontal",
                            p,
                        )
                        .on_click(cx.listener(
                            move |this, e: &ClickEvent, _, cx| {
                                cx.stop_propagation();
                                this.project_row_menu = Some((more_key.clone(), e.position()));
                                cx.notify();
                            },
                        )),
                    )
                    .child(
                        icon_button_xs(
                            SharedString::from(format!("project-new-{project}")),
                            "pencil-edit02",
                            p,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.selected = None;
                            this.draft_project = Some(new_key.clone());
                            cx.notify();
                        })),
                    ),
            )
    }

    fn session_row(&self, t: &Thread, lead_slot: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let id = t.id.clone();
        let active = self.selected.as_ref() == Some(&t.id);
        let title = if t.title.trim().is_empty() {
            text::UNTITLED.to_string()
        } else {
            t.title.clone()
        };
        let running = self.views.get(&t.id).is_some_and(|v| v.running);
        let hover = ui::half(p.c(Token::SidebarAccent));
        let group = SharedString::from(format!("session-{}", t.id));
        let renaming = self
            .rename
            .as_ref()
            .filter(|(rid, _)| rid == &t.id)
            .map(|(_, input)| input.clone());
        let (menu_id, pin_id, archive_id) = (t.id.clone(), t.id.clone(), t.id.clone());
        let pinned = t.pinned;

        // The busy mark stands where the actions are; hovering swaps one for the other.
        let marker = if running {
            Some(icon("loading03", 14.0, p.c(Token::MutedForeground)).into_any_element())
        } else if t.unread && !active {
            Some(
                div()
                    .size(px(8.0))
                    .rounded_full()
                    .bg(p.c(Token::Primary))
                    .into_any_element(),
            )
        } else {
            None
        };
        let actions = div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_end()
            .gap(px(2.0))
            .invisible()
            .group_hover(group.clone(), |s| s.visible())
            .child(
                icon_button_xs(SharedString::from(format!("pin-{}", t.id)), "pin", p).on_click(
                    cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.update_thread(
                            ThreadUpdateParams {
                                thread_id: pin_id.clone(),
                                title: None,
                                archived: None,
                                pinned: Some(!pinned),
                            },
                            cx,
                        )
                    }),
                ),
            )
            .child(
                icon_button_xs(
                    SharedString::from(format!("archive-{}", t.id)),
                    "archive04",
                    p,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.update_thread(
                        ThreadUpdateParams {
                            thread_id: archive_id.clone(),
                            title: None,
                            archived: Some(true),
                            pinned: None,
                        },
                        cx,
                    )
                })),
            );

        div()
            .id(SharedString::from(format!("thread-{}", t.id)))
            .group(group.clone())
            .h(px(32.0))
            .pl(px(8.0))
            .pr(px(4.0))
            .flex()
            .items_center()
            .gap(px(10.0))
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(TEXT_SM))
            .map(|d| {
                if active {
                    d.bg(p.c(Token::SidebarAccent))
                        .text_color(p.c(Token::SidebarAccentForeground))
                } else {
                    d.hover(move |d| d.bg(hover))
                }
            })
            .when(lead_slot, |d| d.child(div().size(px(14.0)).flex_none()))
            .map(|d| match renaming {
                Some(input) => d.child(div().flex_1().min_w_0().child(Input::new(&input))),
                None => d.child(ui::truncate(title).flex_1()),
            })
            .child(
                div()
                    .relative()
                    .w(px(50.0))
                    .h(px(24.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_end()
                    .pr(px(8.0))
                    .child(div().group_hover(group, |s| s.invisible()).children(marker))
                    .child(actions),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    this.thread_menu = Some((menu_id.clone(), e.position));
                    cx.notify();
                }),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
    }

    fn footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        div()
            .flex_none()
            .p(px(8.0))
            .flex()
            .items_center()
            .gap(px(4.0))
            .child(
                nav_row("settings", "settings01", text::SETTINGS, p)
                    .flex_1()
                    .min_w_0()
                    .on_click(cx.listener(|this, _, window, cx| {
                        // Nothing works before a model is connected, so that is where an
                        // install with none is taken.
                        let section = if this.models.is_empty() {
                            super::settings::Section::Providers
                        } else {
                            super::settings::Section::General
                        };
                        this.open_settings(section, window, cx)
                    })),
            )
            .child(
                div()
                    .id("account")
                    .size(px(28.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .child(icon("user02", 14.0, p.c(Token::MutedForeground))),
            )
    }
}

/// A 32px navigation row: a 14px muted glyph, then the label.
fn nav_row(
    id: &'static str,
    glyph: &'static str,
    label: &'static str,
    p: &crate::theme::Palette,
) -> Stateful<Div> {
    let hover = ui::half(p.c(Token::SidebarAccent));
    div()
        .id(id)
        .h(px(32.0))
        .px(px(8.0))
        .flex()
        .items_center()
        .gap(px(10.0))
        .rounded(px(8.0))
        .cursor_pointer()
        .text_size(px(TEXT_SM))
        .hover(move |d| d.bg(hover))
        .child(icon(glyph, 14.0, p.c(Token::MutedForeground)))
        .child(label)
}

/// `SectionLabel`: a 12px medium muted heading, its action revealed on hover.
fn section_label(
    label: &'static str,
    first: bool,
    action: Stateful<Div>,
    p: &crate::theme::Palette,
) -> impl IntoElement {
    let group = SharedString::from(format!("section-{label}"));
    div()
        .group(group.clone())
        .when(!first, |d| d.mt(px(12.0)))
        .pl(px(8.0))
        .pr(px(4.0))
        .flex()
        .items_center()
        .justify_between()
        .text_size(px(TEXT_XS))
        .font_weight(FontWeight::MEDIUM)
        .muted(p)
        .child(div().py(px(4.0)).line_height(px(16.0)).child(label))
        .child(action.invisible().group_hover(group, |s| s.visible()))
}
