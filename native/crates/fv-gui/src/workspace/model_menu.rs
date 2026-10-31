//! The two-level model menu.
//!
//! Electron renders every model choice in the app with one component
//! (`components/model-thinking-select.tsx`): a row per provider, and that provider's models in a
//! submenu beside it. Native needs the same thing on five surfaces — the composer's chip, the
//! 默认模型 menu in 设置, and the inline lists of the role, memory and schedule editors — and they
//! cannot share a widget: the first two are floats whose place is decided by their host, and the
//! last three are not floats at all. So this shares what *is* the same: how a roster folds into
//! providers, what a row of it looks like, and which rows an inline list should draw at all.

use crate::ui::px;
use fv_protocol::types::ModelEntry;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::settings::{menu_item, outline_button};
use crate::theme::Palette;
use crate::ui::icon;

/// The same hover intent is used by the composer and Settings. Leaving a crossed row or
/// entering its flyout cancels the pending switch, so diagonal travel cannot replace the menu.
#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum SubmenuTarget {
    ComposerProvider(String),
    ComposerThinking,
}

#[cfg(test)]
impl super::Workspace {
    pub(super) fn hover_submenu(
        &mut self,
        target: SubmenuTarget,
        hovered: bool,
        cx: &mut Context<Self>,
    ) {
        if !hovered {
            if self
                .submenu_hover
                .as_ref()
                .is_some_and(|(pending, _)| *pending == target)
            {
                self.submenu_hover = None;
            }
            return;
        }
        self.submenu_hover = None;
        let already_open = match &target {
            SubmenuTarget::ComposerProvider(id) => self.model_submenu.as_ref() == Some(id),
            SubmenuTarget::ComposerThinking => self.thinking_menu,
        };
        if already_open {
            return;
        }
        let switching = self.model_submenu.is_some()
            || self.thinking_menu
            || self
                .settings
                .as_ref()
                .is_some_and(|s| s.default_provider_menu.is_some() || s.default_thinking_menu);
        let delay = std::time::Duration::from_millis(if switching { 300 } else { 100 });
        let timer = cx.background_executor().timer(delay);
        let next = target.clone();
        let task = cx.spawn(async move |this, cx| {
            timer.await;
            let _ = this.update(cx, |this, cx| {
                this.open_submenu(next, cx);
            });
        });
        self.submenu_hover = Some((target, task));
    }

    pub(super) fn open_submenu(&mut self, target: SubmenuTarget, cx: &mut Context<Self>) {
        self.submenu_hover = None;
        match target {
            SubmenuTarget::ComposerProvider(id) if self.model_menu => {
                self.model_submenu = Some(id);
                self.thinking_menu = false;
            }
            SubmenuTarget::ComposerThinking if self.model_menu => {
                self.model_submenu = None;
                self.thinking_menu = true;
            }
            _ => {}
        }
        cx.notify();
    }
}

/// Attach to the actual row, including its scroll offset. The deferred child escapes the
/// parent's clipping; its position is resolved in prepaint, after this frame's row is measured.
/// Electron's submenu uses sideOffset=0 and alignOffset=-3. The row is inset from the card,
/// so placing at its edge naturally overlaps the card's padding and leaves no dead strip.
#[cfg(test)]
pub(super) fn with_submenu(row: Stateful<Div>, menu: Option<Stateful<Div>>) -> Stateful<Div> {
    let Some(menu) = menu else {
        return row;
    };
    let bounds = std::rc::Rc::new(std::cell::Cell::new(Bounds::default()));
    let recorded = bounds.clone();
    row.relative()
        .child(
            canvas(move |b, _, _| recorded.set(b), |_, _, _, _| {})
                .absolute()
                .inset_0(),
        )
        .child(
            deferred(RowSubmenu {
                row: bounds,
                child: menu
                    .occlude()
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .into_any_element(),
            })
            .with_priority(11),
        )
}

#[cfg(test)]
struct RowSubmenu {
    row: std::rc::Rc<std::cell::Cell<Bounds<Pixels>>>,
    child: AnyElement,
}

/// Prefer the right edge, flip to the left if needed, then shift vertically into the viewport.
#[cfg(test)]
fn submenu_origin(
    row: Bounds<Pixels>,
    menu: Size<Pixels>,
    viewport: Size<Pixels>,
) -> Point<Pixels> {
    let margin = gpui_kit::px(4.0);
    let right = row.right();
    let left = row.left() - menu.width;
    let x = if right + menu.width <= viewport.width - margin {
        right
    } else {
        left
    };
    let max_x = (viewport.width - menu.width - margin).max(margin);
    let max_y = (viewport.height - menu.height - margin).max(margin);
    point(
        x.clamp(margin, max_x),
        (row.top() - gpui_kit::px(3.0)).clamp(margin, max_y),
    )
}

#[cfg(test)]
impl Element for RowSubmenu {
    type RequestLayoutState = LayoutId;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, LayoutId) {
        let child = self.child.request_layout(window, cx);
        let layout = window.request_layout(
            Style {
                position: Position::Absolute,
                ..Style::default()
            },
            [child],
            cx,
        );
        (layout, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut LayoutId,
        window: &mut Window,
        cx: &mut App,
    ) {
        let bounds = window.layout_bounds(*child);
        let origin = submenu_origin(self.row.get(), bounds.size, window.viewport_size());
        window.with_element_offset(origin - bounds.origin, |window| {
            self.child.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut LayoutId,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.child.paint(window, cx);
    }
}

#[cfg(test)]
impl IntoElement for RowSubmenu {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

/// One provider's models, as a menu shows them: a row that opens them, not a stretch of the list.
pub struct ProviderGroup<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub models: Vec<&'a ModelEntry>,
}

/// The models grouped by provider, in the order the providers first appear — what Electron's
/// `ModelThinkingSelect` builds in its `groups` memo. The engine already hands the list over in
/// provider order, so this only folds; a provider that came twice would draw two rows.
pub fn provider_groups(models: &[ModelEntry]) -> Vec<ProviderGroup<'_>> {
    let mut groups: Vec<ProviderGroup<'_>> = Vec::new();
    for entry in models {
        match groups
            .iter_mut()
            .find(|group| group.id == entry.provider_id)
        {
            Some(group) => group.models.push(entry),
            None => groups.push(ProviderGroup {
                id: &entry.provider_id,
                name: &entry.provider_name,
                models: vec![entry],
            }),
        }
    }
    groups
}

/// The model's own name. A menu row already says which provider it hangs off, so repeating the
/// provider here is noise — and this is what Electron shows: `item.name || item.id`.
pub fn model_display_name(entry: &ModelEntry) -> &str {
    entry.model.name.as_deref().unwrap_or(&entry.model.id)
}

/// Whether the model in use is one of this provider's — the tick on its row, which stays lit while
/// the flyout is open: the row it sits on is highlighted, not emptied.
pub fn group_holds_current(group: &ProviderGroup<'_>, current: Option<&str>) -> bool {
    group
        .models
        .iter()
        .any(|m| Some(m.label.as_str()) == current)
}

/// A provider's row in a floating menu: glyph, name, the tick, and the chevron that promises the
/// models. The caller adds the id and what tapping it does.
pub fn provider_row(
    id: SharedString,
    provider: &str,
    name: &str,
    holds_current: bool,
    open: bool,
    p: &Palette,
) -> Stateful<Div> {
    menu_item(id, open, p.c(Token::Accent))
        .min_h(px(28.0))
        .h(px(28.0))
        .px(px(6.0))
        .gap(px(6.0))
        .child(if provider == "fastvibe" {
            img("app-icon.png")
                .size(px(14.0))
                .rounded(px(3.0))
                .into_any_element()
        } else {
            icon("cpu", 14.0, p.c(Token::MutedForeground)).into_any_element()
        })
        .child(crate::ui::truncate(name.to_string()).flex_1())
        .child(div().size(px(16.0)).flex_none().when(holds_current, |d| {
            d.child(icon("tick02", 16.0, p.c(Token::PopoverForeground)))
        }))
        .child(icon("arrow-right01", 16.0, p.c(Token::PopoverForeground)))
}

/// A model's row in the flyout beside its provider. Same shape without the glyph and with the
/// chevron traded for the tick, because this is the end of the path.
pub fn model_row(id: SharedString, name: &str, current: bool, p: &Palette) -> Stateful<Div> {
    menu_item(id, false, p.c(Token::Accent))
        .min_h(px(28.0))
        .h(px(28.0))
        .px(px(6.0))
        .justify_between()
        .gap(px(8.0))
        .child(crate::ui::truncate(name.to_string()).flex_1())
        .child(div().size(px(16.0)).flex_none().when(current, |d| {
            d.child(icon("tick02", 16.0, p.c(Token::PopoverForeground)))
        }))
}

/// One row of an inline picker — the role, memory and schedule editors draw their choices in the
/// form itself, so the second level opens *under* its provider rather than beside it.
#[derive(Debug)]
pub enum PickerRow {
    Provider {
        id: String,
        name: String,
        open: bool,
        holds_current: bool,
    },
    Model {
        label: String,
        name: String,
        current: bool,
    },
}

/// The rows an inline list should draw: every provider, and the models of the open one beneath it.
/// A fold with no open provider is a list of providers — which is the whole point: a role editor
/// with thirty models in one column is a list nobody reads.
pub fn picker_rows(
    groups: &[ProviderGroup<'_>],
    open: Option<&str>,
    current: Option<&str>,
) -> Vec<PickerRow> {
    let mut rows = Vec::new();
    for group in groups {
        let is_open = open == Some(group.id);
        rows.push(PickerRow::Provider {
            id: group.id.to_string(),
            name: group.name.to_string(),
            open: is_open,
            holds_current: group_holds_current(group, current),
        });
        if !is_open {
            continue;
        }
        for model in &group.models {
            rows.push(PickerRow::Model {
                label: model.label.clone(),
                name: model_display_name(model).to_string(),
                current: Some(model.label.as_str()) == current,
            });
        }
    }
    rows
}

/// An inline picker's row, drawn the way the editor forms draw their choices: a provider with a
/// chevron, or one of its models indented under the provider that opened it. The caller adds what
/// a tap does, because each host picks a different thing — a role's model, a memory model, a
/// schedule's.
pub fn picker_row_view(prefix: &str, row: &PickerRow, p: &Palette) -> Stateful<Div> {
    match row {
        PickerRow::Provider {
            id,
            name,
            open,
            holds_current,
        } => outline_button(SharedString::from(format!("{prefix}-p-{id}")), p)
            .child(icon(
                if *open {
                    "arrow-down01"
                } else {
                    "arrow-right01"
                },
                12.0,
                p.c(Token::MutedForeground),
            ))
            .child(SharedString::from(name.clone()))
            .when(*holds_current, |d| {
                d.child(icon("tick02", 12.0, p.c(Token::Primary)))
            }),
        PickerRow::Model {
            label,
            name,
            current,
        } => outline_button(SharedString::from(format!("{prefix}-m-{label}")), p)
            .pl(px(20.0))
            .child(SharedString::from(name.clone()))
            .when(*current, |d| {
                d.child(icon("tick02", 12.0, p.c(Token::Primary)))
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::{group_holds_current, model_display_name, picker_rows, provider_groups};
    use fv_protocol::types::ModelEntry;

    fn entry(provider_id: &str, provider_name: &str, id: &str) -> ModelEntry {
        ModelEntry {
            provider_id: provider_id.into(),
            provider_name: provider_name.into(),
            model: serde_json::from_value(serde_json::json!({ "id": id })).expect("model"),
            label: format!("{provider_id}/{id}"),
        }
    }

    #[test]
    fn an_inline_list_shows_only_the_open_provider_s_models() {
        let models = vec![
            entry("fastvibe", "FastVibe", "a"),
            entry("fastvibe", "FastVibe", "b"),
            entry("packy", "Packy", "c"),
        ];
        let groups = provider_groups(&models);
        let rows = picker_rows(&groups, Some("fastvibe"), Some("packy/c"));
        assert_eq!(rows.len(), 4);
        // Provider, its two models, then the provider whose models stayed folded away.
        let keys: Vec<String> = rows
            .iter()
            .map(|row| match row {
                super::PickerRow::Provider { id, open, .. } => format!("p:{id}:{open}"),
                super::PickerRow::Model { label, current, .. } => format!("m:{label}:{current}"),
            })
            .collect();
        assert_eq!(
            keys.join(" "),
            "p:fastvibe:true m:fastvibe/a:false m:fastvibe/b:false p:packy:false"
        );
        match &rows[3] {
            super::PickerRow::Provider { holds_current, .. } => assert!(holds_current),
            other => panic!("expected a provider row, got {other:?}"),
        }
    }

    #[test]
    fn models_group_by_provider_in_the_order_the_providers_appear() {
        let models = vec![
            entry("fastvibe", "FastVibe", "deepseek-v4.1-flash"),
            entry("packy", "Packy", "grok-4.7"),
            entry("fastvibe", "FastVibe", "qwen3-coder"),
        ];
        let groups = provider_groups(&models);
        // A provider listed twice still gets one row, and the fold keeps the first-seen order:
        // two rows for the same provider would read as two providers with different models.
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].id, "fastvibe");
        assert_eq!(groups[0].name, "FastVibe");
        assert_eq!(groups[1].id, "packy");
        assert_eq!(groups[0].models.len(), 2);
        assert_eq!(groups[1].models.len(), 1);
        assert_eq!(groups[0].models[1].label, "fastvibe/qwen3-coder");
        // The tick belongs to the provider that holds the model in use, not to the open one.
        assert!(group_holds_current(&groups[1], Some("packy/grok-4.7")));
        assert!(!group_holds_current(&groups[0], Some("packy/grok-4.7")));
    }

    #[test]
    fn a_model_row_names_the_model_not_the_pair() {
        let mut named = entry("packy", "Packy", "claude-opus-5-5");
        named.model.name = Some("Claude Opus 5.5".into());
        assert_eq!(model_display_name(&named), "Claude Opus 5.5");
        // A relay that lists no display name still has to be pickable by its own id.
        let bare = entry("packy", "Packy", "claude-opus-5-5");
        assert_eq!(model_display_name(&bare), "claude-opus-5-5");
    }
}

#[cfg(test)]
mod submenu_layout_tests {
    use super::with_submenu;
    use gpui_kit::gpui;
    use gpui_kit::{
        AnyWindowHandle, AppContext, Bounds, Context, InteractiveElement, IntoElement, MouseButton,
        MouseDownEvent, MouseUpEvent, ParentElement, Pixels, PlatformInput, Render, ScrollHandle,
        StatefulInteractiveElement, Styled, TestAppContext, Window, canvas, deferred, div, point,
        px,
    };
    use std::cell::Cell;
    use std::rc::Rc;

    struct Fixture {
        left: bool,
        scroll: ScrollHandle,
        row: Rc<Cell<Bounds<Pixels>>>,
        menu: Rc<Cell<Bounds<Pixels>>>,
        selected: Rc<Cell<u32>>,
        parent_clicks: Rc<Cell<u32>>,
    }

    impl Render for Fixture {
        fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let row_bounds = self.row.clone();
            let menu_bounds = self.menu.clone();
            let selected = self.selected.clone();
            let parent_clicks = self.parent_clicks.clone();
            let row = div()
                .id("provider-row")
                .relative()
                .h(px(28.))
                .w_full()
                .on_click(move |_, _, _| parent_clicks.set(parent_clicks.get() + 1))
                .child(
                    canvas(move |b, _, _| row_bounds.set(b), |_, _, _, _| {})
                        .absolute()
                        .inset_0(),
                );
            let menu = div()
                .id("models")
                .relative()
                .w(px(208.))
                .h(px(120.))
                .on_mouse_down(MouseButton::Left, move |_, _, _| {
                    selected.set(selected.get() + 1)
                })
                .child(
                    canvas(move |b, _, _| menu_bounds.set(b), |_, _, _, _| {})
                        .absolute()
                        .inset_0(),
                );
            let x = if self.left {
                window.viewport_size().width - px(220.)
            } else {
                px(100.)
            };
            div().size_full().child(
                deferred(
                    div()
                        .id("providers")
                        .absolute()
                        .left(x)
                        .top(px(80.))
                        .w(px(208.))
                        .h(px(100.))
                        .p(px(4.))
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .child(div().h(px(112.)).w_full())
                        .child(with_submenu(row, Some(menu)))
                        .child(div().h(px(100.)).w_full()),
                )
                .with_priority(10),
            )
        }
    }

    fn fixture(cx: &mut TestAppContext, left: bool) -> (AnyWindowHandle, Fixture) {
        let fixture = Fixture {
            left,
            scroll: ScrollHandle::new(),
            row: Rc::default(),
            menu: Rc::default(),
            selected: Rc::default(),
            parent_clicks: Rc::default(),
        };
        let view = Fixture {
            left,
            scroll: fixture.scroll.clone(),
            row: fixture.row.clone(),
            menu: fixture.menu.clone(),
            selected: fixture.selected.clone(),
            parent_clicks: fixture.parent_clicks.clone(),
        };
        let window: AnyWindowHandle = cx.add_window(move |_, _| view).into();
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        fixture.scroll.set_offset(point(px(0.), px(-96.)));
        cx.update_window(window, |_, window, cx| window.draw(cx).clear(cx))
            .unwrap();
        (window, fixture)
    }

    #[gpui::test]
    fn submenu_touches_its_scrolled_trigger_and_clicks_do_not_reopen_the_parent(
        cx: &mut TestAppContext,
    ) {
        let (window, fixture) = fixture(cx, false);
        let row = fixture.row.get();
        let menu = fixture.menu.get();
        assert_eq!(
            menu.left(),
            row.right(),
            "no gap between trigger and submenu"
        );
        assert_eq!(
            menu.top(),
            row.top() - px(3.),
            "align to the live scrolled row"
        );
        assert_eq!(
            menu.size.height,
            px(120.),
            "parent scroller must not shrink the submenu"
        );
        cx.update_window(window, |_, window, cx| {
            let position = menu.center();
            window.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    button: MouseButton::Left,
                    position,
                    click_count: 1,
                    ..Default::default()
                }),
                cx,
            );
            window.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    button: MouseButton::Left,
                    position,
                    click_count: 1,
                    ..Default::default()
                }),
                cx,
            );
        })
        .unwrap();
        assert_eq!(
            fixture.selected.get(),
            1,
            "submenu outside the parent's clip is clickable"
        );
        assert_eq!(
            fixture.parent_clicks.get(),
            0,
            "selection cannot bubble into the provider trigger"
        );
    }

    #[gpui::test]
    fn submenu_flips_left_without_a_gap_at_the_right_window_edge(cx: &mut TestAppContext) {
        let (_, fixture) = fixture(cx, true);
        assert_eq!(fixture.menu.get().right(), fixture.row.get().left());
        assert_eq!(fixture.menu.get().top(), fixture.row.get().top() - px(3.));
    }
}

#[cfg(test)]
mod submenu_hover_tests {
    use super::SubmenuTarget;
    use crate::theme::Palette;
    use crate::workspace::Workspace;
    use gpui_kit::gpui;
    use gpui_kit::{AppContext, Context, Render, TestAppContext, Window, div};
    use std::time::Duration;

    struct Host;
    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui_kit::IntoElement {
            div()
        }
    }

    #[gpui::test]
    fn crossing_another_trigger_keeps_the_current_submenu_and_click_cancels_pending_switch(
        cx: &mut TestAppContext,
    ) {
        cx.update(gpui_kit::init);
        let host = cx.add_window(|_, _| Host);
        let workspace = host
            .update(cx, |_, window, cx| {
                cx.new(|cx| {
                    Workspace::base(
                        Palette::new(fv_theme::Preferences::default().resolve(false, false)),
                        window,
                        cx,
                    )
                })
            })
            .unwrap();
        let a = SubmenuTarget::ComposerProvider("a".into());
        let b = SubmenuTarget::ComposerProvider("b".into());
        workspace.update(cx, |this, cx| {
            this.model_menu = true;
            this.hover_submenu(a.clone(), true, cx);
        });
        cx.executor().advance_clock(Duration::from_millis(100));
        cx.run_until_parked();
        workspace.update(cx, |this, cx| {
            assert_eq!(this.model_submenu.as_deref(), Some("a"));
            this.hover_submenu(b.clone(), true, cx);
            // A diagonal move briefly crosses B and leaves for A's submenu.
            this.hover_submenu(b.clone(), false, cx);
        });
        cx.executor().advance_clock(Duration::from_millis(350));
        cx.run_until_parked();
        workspace.update(cx, |this, cx| {
            assert_eq!(this.model_submenu.as_deref(), Some("a"));
            this.hover_submenu(b.clone(), true, cx);
            this.open_submenu(a.clone(), cx);
        });
        cx.executor().advance_clock(Duration::from_millis(350));
        cx.run_until_parked();
        workspace.update(cx, |this, cx| {
            assert_eq!(this.model_submenu.as_deref(), Some("a"));
            this.hover_submenu(SubmenuTarget::ComposerThinking, true, cx);
        });
        cx.executor().advance_clock(Duration::from_millis(300));
        cx.run_until_parked();
        workspace.update(cx, |this, cx| {
            assert!(
                this.thinking_menu,
                "a deliberate hover still switches the submenu"
            );
            assert!(this.model_submenu.is_none());
            this.hover_submenu(b, true, cx);
            this.close_menus(cx);
        });
        cx.executor().advance_clock(Duration::from_millis(350));
        cx.run_until_parked();
        workspace.update(cx, |this, _| {
            assert!(!this.model_menu);
            assert!(!this.thinking_menu);
            assert!(
                this.model_submenu.is_none(),
                "closing cannot be undone by a stale timer"
            );
        });
    }
}
