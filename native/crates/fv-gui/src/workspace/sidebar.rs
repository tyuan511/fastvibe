//! The sidebar, after `components/layout/sidebar.tsx` and `sidebar-rows.tsx`: the traffic-light
//! row, the brand row, three navigation rows, then 项目 and 聊天, and 设置 at the foot.

use super::sidebar_actions::SidebarDrag;
use crate::sidebar_state;
use fv_protocol::types::ThreadUpdateParams;
use fv_protocol::types::{SidebarSettingsPatch, Thread};
use fv_theme::Token;
use gpui_kit::component::input::Input;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{Workspace, text};
use crate::ui::{self, Muted as _, TEXT_SM, TEXT_XS, icon, icon_button, icon_button_xs, spinner};

/// The column's resting width, the transparent 8px inset included.
pub const SIDEBAR_WIDTH: f32 = 288.0;
/// The floating panes sit this far from the window edge.
pub const INSET: f32 = 8.0;

impl Workspace {
    pub(super) fn sidebar(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = &self.palette;
        let width = self.sidebar_resting_width(f32::from(window.viewport_size().width));
        let visible = self.sidebar_motion.width;
        if visible <= 0.0 {
            return div().w(px(0.0)).flex_none().into_any_element();
        }
        let frame = div()
            .relative()
            .w(px(width))
            .h_full()
            .flex_none()
            .p(px(INSET))
            .child(
                div()
                    // Each width needs fresh cached clipping/hover bounds in GPUI, especially
                    // for a translucent pane. The ScrollHandle and inputs live on Workspace.
                    .id(("sidebar-pane", width.to_bits() as usize))
                    .relative()
                    .size_full()
                    .rounded(px(16.0))
                    .bg(p.pane())
                    .text_color(p.c(Token::SidebarForeground))
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .child(self.traffic_light_row(cx))
                    .child(self.brand_and_nav(cx))
                    .child(self.lists(cx))
                    .child(self.footer(cx))
                    .child(crate::ui::glass_surface(16.0, p))
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
            );
        div()
            .relative()
            .w(px(visible))
            .h_full()
            .flex_none()
            .overflow_hidden()
            .child(frame)
            .when(!self.app_settings.sidebar.collapsed, |d| {
                d.child(
                    div()
                        .id("sidebar-resizer")
                        .group("sidebar-resizer")
                        .child(ui::panel_grip(
                            "sidebar-resizer",
                            self.sidebar_resize.is_some(),
                            p,
                        ))
                        .absolute()
                        .right(px(4.0))
                        .top(px(24.0))
                        .bottom(px(24.0))
                        .w(px(8.0))
                        .cursor_col_resize()
                        .role(Role::Splitter)
                        .aria_label("调整侧栏宽度")
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event: &MouseDownEvent, window, cx| {
                                this.sidebar_drag_offset =
                                    f32::from(event.position.x) - this.sidebar_motion.width;
                                this.sidebar_resize = Some(this.sidebar_motion.width);
                                window.prevent_default();
                                cx.stop_propagation();
                                cx.notify();
                            }),
                        )
                        .on_click(cx.listener(|this, e: &ClickEvent, _, cx| {
                            if super::sidebar_actions::is_width_reset(e) {
                                this.patch_sidebar(
                                    SidebarSettingsPatch {
                                        width: Some(SIDEBAR_WIDTH),
                                        ..Default::default()
                                    },
                                    cx,
                                );
                            }
                        })),
                )
            })
            .into_any_element()
    }

    pub(super) fn sidebar_resting_width(&self, viewport: f32) -> f32 {
        self.sidebar_resize
            .unwrap_or(self.app_settings.sidebar.width)
            .clamp(200.0, (viewport * 0.4).clamp(200.0, 480.0))
    }

    /// macOS draws its window buttons at the start of this row; the panel controls follow.
    fn traffic_light_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        div()
            .h(px(44.0))
            .flex_none()
            .pl(px(88.0))
            .flex()
            .items_center()
            .gap(px(2.0))
            .child(
                icon_button("collapse-sidebar", "panel-left-close", p).on_click(cx.listener(
                    |this, _, window, cx| this.on_toggle_sidebar(&super::ToggleSidebar, window, cx),
                )),
            )
            .child(
                icon_button("back", "arrow-left01", p)
                    .opacity(if self.navigation.can_back() {
                        1.0
                    } else {
                        0.35
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.navigate(false, cx))),
            )
            .child(
                icon_button("forward", "arrow-right01", p)
                    .opacity(if self.navigation.can_forward() {
                        1.0
                    } else {
                        0.35
                    })
                    .on_click(cx.listener(|this, _, _, cx| this.navigate(true, cx))),
            )
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
                    .child(
                        div()
                            .flex()
                            .child(
                                icon_button("sidebar-options", "more-horizontal", p).on_click(
                                    cx.listener(|this, e: &ClickEvent, _, cx| {
                                        this.close_menus(cx);
                                        this.sidebar_menu = Some(e.position());
                                        cx.notify();
                                    }),
                                ),
                            )
                            .child(icon_button("search", "search01", p).on_click(
                                cx.listener(|this, _, window, cx| this.open_palette(window, cx)),
                            )),
                    ),
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
                                this.new_chat(None, cx);
                            }),
                        ),
                    )
                    .child(nav("tasks", "clock01", text::TASKS).on_click(
                        cx.listener(|this, _, window, cx| this.open_schedules(window, cx)),
                    )),
            )
    }

    fn lists(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let all_visible: Vec<&Thread> = self.threads.iter().filter(|t| !t.archived).collect();
        let prefs = &self.app_settings.sidebar;
        let pinned = sidebar_state::ordered(
            all_visible.iter().copied().filter(|t| t.pinned).collect(),
            "pinned",
            prefs,
        );
        let visible: Vec<&Thread> = all_visible.iter().copied().filter(|t| !t.pinned).collect();

        // Projects in the order their most recent chat was touched; each lists its chats.
        // A project is a listed folder, empty or not; a chat from one that was removed from the
        // list is shown with the plain chats.
        let in_list = |t: &Thread| {
            t.project
                .as_ref()
                .is_some_and(|p| self.projects.iter().any(|x| &x.path == p))
        };
        let mut projects: Vec<(String, Vec<&Thread>)> = self
            .projects
            .iter()
            .map(|proj| {
                (
                    proj.path.clone(),
                    sidebar_state::ordered(
                        visible
                            .iter()
                            .copied()
                            .filter(|t| t.project.as_ref() == Some(&proj.path))
                            .collect(),
                        &format!("project:{}", proj.path),
                        prefs,
                    ),
                )
            })
            .collect();
        projects.sort_by_key(|(path, _)| {
            prefs
                .project_order
                .iter()
                .position(|p| p == path)
                .unwrap_or(usize::MAX)
        });
        let chats = sidebar_state::ordered(
            visible.iter().copied().filter(|t| !in_list(t)).collect(),
            "chats",
            prefs,
        );

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
            icon_button_xs("new-project", "add01", p).on_click(
                cx.listener(|this, _, window, cx| this.open_project_dialog(None, window, cx)),
            ),
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
                let open = !prefs.closed_projects.contains(project);
                let mut group = div()
                    .flex()
                    .flex_col()
                    .child(self.project_row(project, open, cx));
                if open {
                    let mut sessions = div().flex().flex_col().gap(px(2.0));
                    let expanded = prefs.expanded_projects.contains(project);
                    for t in threads.iter().take(if expanded { usize::MAX } else { 5 }) {
                        sessions = sessions.child(self.session_row(t, true, cx));
                    }
                    if threads.is_empty() {
                        sessions = sessions.child(
                            div()
                                .pl(px(32.0))
                                .py(px(6.0))
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(text::EMPTY_CHATS),
                        );
                    }
                    if threads.len() > 5 {
                        let path = project.clone();
                        sessions = sessions.child(
                            div()
                                .id(SharedString::from(format!("more-{path}")))
                                .pl(px(32.0))
                                .py(px(6.0))
                                .cursor_pointer()
                                .text_size(px(TEXT_XS))
                                .muted(p)
                                .child(if expanded {
                                    "收起".to_string()
                                } else {
                                    format!("展开更多（{}）", threads.len() - 5)
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let mut paths =
                                        this.app_settings.sidebar.expanded_projects.clone();
                                    if paths.contains(&path) {
                                        paths.retain(|p| p != &path);
                                    } else {
                                        paths.push(path.clone());
                                    }
                                    this.patch_sidebar(
                                        SidebarSettingsPatch {
                                            expanded_projects: Some(paths),
                                            ..Default::default()
                                        },
                                        cx,
                                    );
                                })),
                        );
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
            icon_button_xs("new-session", "pencil-edit02", p)
                .on_click(cx.listener(|this, _, _, cx| this.new_chat(None, cx))),
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
            .track_scroll(&self.sidebar_scroll)
            .on_drag_move(cx.listener(|this, e: &DragMoveEvent<SidebarDrag>, _, cx| {
                this.scroll_sidebar_drag(e, cx)
            }))
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(body)
    }

    fn project_row(&self, project: &str, open: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.palette;
        let name = self.project_label(project);
        let key = project.to_string();
        let (more_key, new_key, right_key) = (key.clone(), key.clone(), key.clone());
        let group = SharedString::from(format!("project-{project}"));
        let hover = ui::half(p.c(Token::SidebarAccent));
        self.draggable_sidebar_row(
            div().id(SharedString::from(format!("project-row-{project}"))),
            SidebarDrag {
                section: "projects".into(),
                id: project.into(),
                title: name.clone(),
            },
            cx,
        )
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
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                this.close_menus(cx);
                this.project_row_menu = Some((right_key.clone(), e.position));
                cx.notify();
            }),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.toggle_project(&key, cx);
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
                        this.new_chat(Some(new_key.clone()), cx);
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
        let view = self.views.get(&t.id);
        let waiting = view.is_some_and(|v| !v.questions.is_empty() || !v.approvals.is_empty());
        let failed = view.is_some_and(|v| {
            v.turns.last().is_some_and(|t| {
                t.items
                    .iter()
                    .any(|item| matches!(item, fv_protocol::types::Item::Error { .. }))
            })
        });
        let marker = if waiting {
            Some(icon("help-circle", 14.0, p.c(Token::Primary)).into_any_element())
        } else if failed && !active && !running {
            Some(icon("alert-circle", 14.0, p.c(Token::Destructive)).into_any_element())
        } else if running {
            Some(
                spinner(
                    SharedString::from(format!("sidebar-spin-{}", t.id)),
                    14.0,
                    p.c(Token::MutedForeground),
                )
                .into_any_element(),
            )
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
                icon_button_xs(SharedString::from(format!("pin-{}", t.id)), "pin", p)
                    .tooltip(move |window, cx| {
                        Tooltip::new(if pinned { "取消置顶" } else { "置顶" }).build(window, cx)
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
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
                    })),
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

        self.draggable_sidebar_row(
            div().id(SharedString::from(format!("thread-{}", t.id))),
            SidebarDrag {
                section: self.sidebar_section(t),
                id: t.id.clone(),
                title: title.clone(),
            },
            cx,
        )
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
                this.close_menus(cx);
                this.thread_menu = Some((menu_id.clone(), e.position));
                cx.notify();
            }),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            if this.rename.as_ref().is_none_or(|(rid, _)| rid != &id) {
                this.select(id.clone(), cx);
            }
        }))
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
                    .tooltip(|window, cx| Tooltip::new("账号").build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.sidebar_notice = Some("此版本暂不支持 FastVibe 账号登录。".into());
                        cx.notify();
                    }))
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
        .role(Role::Button)
        .aria_label(label)
        .focusable()
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
