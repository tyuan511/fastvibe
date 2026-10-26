//! Stateful sidebar operations. All durable state goes through the app protocol.
use super::{GoBack, GoForward, ToggleSidebar, Workspace, settings};
use crate::{sidebar_state, ui};
use fv_protocol::types::*;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

#[derive(Clone)]
pub(super) struct SidebarDrag {
    pub section: String,
    pub id: String,
    pub title: String,
}
impl Render for SidebarDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .px(px(12.0))
            .py(px(6.0))
            .rounded(px(8.0))
            .bg(rgb(0x333333))
            .text_color(rgb(0xffffff))
            .text_size(px(14.0))
            .child(self.title.clone())
    }
}

impl Workspace {
    pub(super) fn draggable_sidebar_row(
        &self,
        row: Stateful<Div>,
        drag: SidebarDrag,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let (section, target) = (drag.section.clone(), drag.id.clone());
        let (move_section, move_target) = (section.clone(), target.clone());
        let (drop_section, drop_target) = (section.clone(), target.clone());
        let indicator = self
            .sidebar_drop
            .as_ref()
            .filter(|(s, id, _)| s == &section && id == &target);
        let color = self.palette.c(Token::Primary);
        let entity = cx.entity();
        let bounds = std::rc::Rc::new(std::cell::Cell::new(Bounds::<Pixels>::default()));
        let measured = bounds.clone();
        row.relative()
            .child(
                canvas(move |bounds, _, _| measured.set(bounds), |_, _, _, _| {})
                    .absolute()
                    .inset_0(),
            )
            .when_some(indicator, |row, (_, _, after)| {
                row.child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .h(px(2.0))
                        .bg(color)
                        .map(|line| {
                            if *after {
                                line.bottom_0()
                            } else {
                                line.top_0()
                            }
                        }),
                )
            })
            .when(self.rename.is_none(), |row| {
                row.on_drag(drag, move |drag, _, _, cx| {
                    entity.update(cx, |this, cx| {
                        this.sidebar_drop = None;
                        this.close_menus(cx);
                    });
                    cx.new(|_| drag.clone())
                })
            })
            .can_drop(move |value, _, _| {
                value
                    .downcast_ref::<SidebarDrag>()
                    .is_some_and(|d| d.section == section && d.id != target)
            })
            .on_drag_move(
                cx.listener(move |this, e: &DragMoveEvent<SidebarDrag>, _, cx| {
                    let drag = e.drag(cx);
                    if drag.section == move_section
                        && drag.id != move_target
                        && e.bounds.contains(&e.event.position)
                    {
                        let after =
                            e.event.position.y > e.bounds.origin.y + e.bounds.size.height / 2.0;
                        let next = Some((move_section.clone(), move_target.clone(), after));
                        if this.sidebar_drop != next {
                            this.sidebar_drop = next;
                            cx.notify();
                        }
                    }
                }),
            )
            .on_drop(cx.listener(move |this, drag: &SidebarDrag, window, cx| {
                let after = window.mouse_position().y > bounds.get().center().y;
                this.drop_sidebar(drag, &drop_target, &drop_section, after, cx)
            }))
    }
    pub(super) fn scroll_sidebar_drag(
        &mut self,
        e: &DragMoveEvent<SidebarDrag>,
        cx: &mut Context<Self>,
    ) {
        let pos = e.event.position;
        self.sidebar_scroll_direction = if !e.bounds.contains(&pos) {
            0
        } else if pos.y < e.bounds.top() + px(32.0) {
            1
        } else if pos.y > e.bounds.bottom() - px(32.0) {
            -1
        } else {
            0
        };
        if self.sidebar_scroll_direction == 0 || self.sidebar_scroll_task.is_some() {
            return;
        }
        self.sidebar_scroll_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(16))
                    .await;
                let keep = this
                    .update(cx, |this, cx| {
                        if !cx.has_active_drag() || this.sidebar_scroll_direction == 0 {
                            this.sidebar_scroll_task = None;
                            return false;
                        }
                        let mut offset = this.sidebar_scroll.offset();
                        offset.y = (offset.y + px(f32::from(this.sidebar_scroll_direction) * 8.0))
                            .clamp(-this.sidebar_scroll.max_offset().y, px(0.0));
                        this.sidebar_scroll.set_offset(offset);
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        }));
    }

    pub(super) fn patch_sidebar(&mut self, sidebar: SidebarSettingsPatch, cx: &mut Context<Self>) {
        self.patch_settings(
            AppSettingsPatch {
                sidebar: Some(sidebar),
                ..Default::default()
            },
            cx,
        );
    }
    pub(super) fn on_toggle_sidebar(
        &mut self,
        _: &ToggleSidebar,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.patch_sidebar(
            SidebarSettingsPatch {
                collapsed: Some(!self.app_settings.sidebar.collapsed),
                ..Default::default()
            },
            cx,
        );
    }
    pub(super) fn new_chat(&mut self, project: Option<String>, cx: &mut Context<Self>) {
        self.navigation.visit(self.selected.clone(), None);
        self.selected = None;
        self.draft_project = project;
        self.search_target = None;
        self.search_jump_pending = false;
        self.close_menus(cx);
        cx.notify();
    }
    pub(super) fn navigate(&mut self, forward: bool, cx: &mut Context<Self>) {
        let threads = &self.threads;
        if let Some(id) = self.navigation.step(forward, |id| {
            threads.iter().any(|t| t.id == id && !t.archived)
        }) {
            self.selected = id.clone();
            self.search_target = None;
            self.search_jump_pending = false;
            self.close_menus(cx);
            if let Some(id) = id {
                self.load_view(id, cx);
            }
            cx.notify();
        }
    }
    pub(super) fn on_go_back(&mut self, _: &GoBack, _: &mut Window, cx: &mut Context<Self>) {
        self.navigate(false, cx);
    }
    pub(super) fn on_go_forward(&mut self, _: &GoForward, _: &mut Window, cx: &mut Context<Self>) {
        self.navigate(true, cx);
    }
    pub(super) fn toggle_project(&mut self, path: &str, cx: &mut Context<Self>) {
        let mut closed = self.app_settings.sidebar.closed_projects.clone();
        if closed.iter().any(|p| p == path) {
            closed.retain(|p| p != path);
        } else {
            closed.push(path.into());
        }
        self.patch_sidebar(
            SidebarSettingsPatch {
                closed_projects: Some(closed),
                ..Default::default()
            },
            cx,
        );
    }
    pub(super) fn finish_sidebar_resize(&mut self, cx: &mut Context<Self>) {
        let Some(width) = self.sidebar_resize.take() else {
            return;
        };
        if width == self.app_settings.sidebar.width && !self.app_settings.sidebar.collapsed {
            return;
        }
        self.patch_sidebar(
            SidebarSettingsPatch {
                width: (width >= 100.0).then_some(width),
                collapsed: Some(width < 100.0),
                ..Default::default()
            },
            cx,
        );
    }
    pub(super) fn sidebar_section(&self, t: &Thread) -> String {
        sidebar_state::section(
            t,
            &self
                .projects
                .iter()
                .map(|p| p.path.clone())
                .collect::<Vec<_>>(),
        )
    }
    pub(super) fn drop_sidebar(
        &mut self,
        drag: &SidebarDrag,
        target: &str,
        section: &str,
        after: bool,
        cx: &mut Context<Self>,
    ) {
        if drag.section != section {
            return;
        }
        self.sidebar_drop = None;
        let prefs = &self.app_settings.sidebar;
        let ids = if section == "projects" {
            let mut ids: Vec<_> = self.projects.iter().map(|p| p.path.clone()).collect();
            ids.sort_by_key(|id| {
                prefs
                    .project_order
                    .iter()
                    .position(|p| p == id)
                    .unwrap_or(usize::MAX)
            });
            ids
        } else {
            sidebar_state::ordered(
                self.threads
                    .iter()
                    .filter(|t| !t.archived && self.sidebar_section(t) == section)
                    .collect(),
                section,
                prefs,
            )
            .into_iter()
            .map(|t| t.id.clone())
            .collect()
        };
        if let Some(ids) = sidebar_state::reordered(&ids, &drag.id, target, after) {
            let patch = if section == "projects" {
                SidebarSettingsPatch {
                    project_order: Some(ids),
                    ..Default::default()
                }
            } else {
                SidebarSettingsPatch {
                    order: Some([(section.into(), ids)].into()),
                    sort: Some(SidebarSort::Manual),
                    ..Default::default()
                }
            };
            self.patch_sidebar(patch, cx);
        }
    }

    pub(super) fn sidebar_menu_view(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let at = popup_origin(self.sidebar_menu?, 190.0, 240.0, window);
        let p = &self.palette;
        let mut menu = settings::popover(p)
            .absolute()
            .left(at.x)
            .top(at.y)
            .w(px(190.0));
        for (i, (label, sort)) in [
            ("手动排序", SidebarSort::Manual),
            ("最近更新", SidebarSort::Updated),
            ("创建时间", SidebarSort::Created),
            ("名称", SidebarSort::Title),
        ]
        .into_iter()
        .enumerate()
        {
            menu = menu.child(
                settings::menu_item(
                    SharedString::from(format!("sidebar-sort-{i}")),
                    self.app_settings.sidebar.sort == sort,
                    p.c(Token::Accent),
                )
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.close_menus(cx);
                    this.patch_sidebar(
                        SidebarSettingsPatch {
                            sort: Some(sort),
                            ..Default::default()
                        },
                        cx,
                    );
                })),
            );
        }
        menu = menu
            .child(
                settings::menu_item("expand-projects".into(), false, p.c(Token::Accent))
                    .child("展开全部项目")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.close_menus(cx);
                        this.patch_sidebar(
                            SidebarSettingsPatch {
                                closed_projects: Some(vec![]),
                                ..Default::default()
                            },
                            cx,
                        );
                    })),
            )
            .child(
                settings::menu_item("collapse-projects".into(), false, p.c(Token::Accent))
                    .child("折叠全部项目")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.close_menus(cx);
                        this.patch_sidebar(
                            SidebarSettingsPatch {
                                closed_projects: Some(
                                    this.projects.iter().map(|p| p.path.clone()).collect(),
                                ),
                                ..Default::default()
                            },
                            cx,
                        );
                    })),
            )
            .child(
                settings::menu_item("archived-chats".into(), false, p.c(Token::Accent))
                    .child("归档对话")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.close_menus(cx);
                        this.open_settings(settings::Section::Archived, window, cx);
                    })),
            );
        Some(ui::float(menu).into_any_element())
    }

    pub(super) fn sidebar_notice_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let notice = self.sidebar_notice.clone()?;
        let p = &self.palette;
        Some(settings::modal(
            settings::dialog_card(p, 400.0)
                .child(settings::dialog_head("FastVibe", &notice, p))
                .child(settings::dialog_foot(
                    p,
                    cx,
                    |this, cx| {
                        this.sidebar_notice = None;
                        cx.notify();
                    },
                    "知道了",
                    |this, _, cx| {
                        this.sidebar_notice = None;
                        cx.notify();
                    },
                    false,
                )),
            p,
            cx,
            |this| this.sidebar_notice = None,
        ))
    }

    pub(super) fn fork_thread(&mut self, id: String, cx: &mut Context<Self>) {
        self.close_menus(cx);
        let Some(b) = self.backend.clone() else {
            return;
        };
        let call = b.call::<fv_protocol::methods::ThreadFork>(ThreadIdParams { thread_id: id });
        cx.spawn(async move |this, cx| {
            let result = call.await;
            this.update(cx, |this, cx| match result {
                Ok(result) => {
                    this.threads.push(result.thread.clone());
                    this.select(result.thread.id, cx);
                    this.refresh_threads(cx);
                }
                Err(e) => {
                    this.sidebar_notice = Some(format!("无法创建分支：{e}"));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    pub(super) fn confirm_remove_project(
        &mut self,
        path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_menus(cx);
        let answer = window.prompt(
            PromptLevel::Warning,
            &format!("移除项目「{}」？", self.project_label(&path)),
            Some("对话会保留在聊天列表中，磁盘上的文件不会删除。"),
            &[PromptButton::cancel("取消"), PromptButton::ok("移除")],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await == Ok(1) {
                this.update(cx, |this, cx| this.remove_project(path, cx))
                    .ok();
            }
        })
        .detach();
    }
    pub(super) fn confirm_delete_thread(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_menus(cx);
        let answer = window.prompt(
            PromptLevel::Warning,
            "删除这个对话？",
            Some("会话记录将永久删除，正在运行的任务也会停止。此操作无法恢复。"),
            &[PromptButton::cancel("取消"), PromptButton::ok("删除")],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await == Ok(1) {
                this.update(cx, |this, cx| this.delete_thread(id, cx)).ok();
            }
        })
        .detach();
    }
}

/// Keep menus reachable even when the final visible row is against the window edge.
pub(super) fn popup_origin(
    at: Point<Pixels>,
    width: f32,
    height: f32,
    window: &Window,
) -> Point<Pixels> {
    point(
        at.x.clamp(
            px(8.0),
            (window.viewport_size().width - px(width + 8.0)).max(px(8.0)),
        ),
        at.y.clamp(
            px(8.0),
            (window.viewport_size().height - px(height + 8.0)).max(px(8.0)),
        ),
    )
}

/// GPUI also emits ClickEvent after a manual pointer resize. A second drag in the
/// system's double-click interval must commit its width instead of resetting it.
pub(super) fn is_width_reset(event: &ClickEvent) -> bool {
    event.click_count() == 2
        && matches!(event, ClickEvent::Mouse(mouse)
        if (mouse.up.position - mouse.down.position).magnitude() <= 2.0)
}

#[cfg(test)]
mod resize_tests {
    use super::is_width_reset;
    use gpui_kit::{ClickEvent, MouseClickEvent, MouseDownEvent, MouseUpEvent, point, px};
    #[test]
    fn a_second_drag_is_not_a_double_click_reset() {
        let event = |from: f32, to: f32, clicks| {
            ClickEvent::Mouse(MouseClickEvent {
                down: MouseDownEvent {
                    position: point(px(from), px(200.0)),
                    ..Default::default()
                },
                up: MouseUpEvent {
                    position: point(px(to), px(200.0)),
                    click_count: clicks,
                    ..Default::default()
                },
            })
        };
        assert!(is_width_reset(&event(310.0, 310.0, 2)));
        assert!(
            !is_width_reset(&event(310.0, 410.0, 2)),
            "a fast repeated drag keeps its final width"
        );
        assert!(!is_width_reset(&event(310.0, 310.0, 1)));
    }
}
