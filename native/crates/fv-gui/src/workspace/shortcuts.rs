//! Window-local shortcut dispatch runs before editor keymaps. Editing remains native;
//! terminal control keys and input-method character events retain their own owner.

use std::collections::HashSet;

use fv_protocol::shortcuts::{CATALOG, Chord, ShortcutEdit, ShortcutId, resolve};
use fv_protocol::types::AppSettingsPatch;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::*;

use super::Workspace;
use super::settings::{Section, card, outline_button, switch};
use crate::ui::{Muted as _, TEXT_SM, TEXT_XS};

pub struct ShortcutSettings {
    query: Entity<InputState>,
    recording: Option<ShortcutId>,
    focus: FocusHandle,
    error: Option<String>,
}

impl ShortcutSettings {
    pub fn new(window: &mut Window, cx: &mut App) -> Self {
        Self {
            query: cx.new(|cx| InputState::new(window, cx).placeholder("搜索快捷键")),
            recording: None,
            focus: cx.focus_handle(),
            error: None,
        }
    }
    pub fn cancel(&mut self) {
        self.recording = None;
        self.error = None;
    }
}

pub(super) struct Runtime {
    _listeners: Vec<Subscription>,
    held: HashSet<String>,
    submit_on_enter: bool,
}

impl Runtime {
    pub fn new(window: &mut Window, cx: &mut Context<Workspace>) -> Self {
        let owner = window.window_handle();
        let weak = cx.weak_entity();
        let interceptor = cx.intercept_keystrokes(move |event, window, cx| {
            if window.window_handle() == owner {
                let _ = weak.update(cx, |this, cx| this.shortcut_key(event, window, cx));
            }
        });
        let activation =
            cx.observe_window_activation(window, |this, _, _| this.shortcuts.held.clear());
        Self {
            _listeners: vec![interceptor, activation],
            held: HashSet::new(),
            submit_on_enter: true,
        }
    }
    pub fn release(&mut self, key: &str) {
        self.held.remove(key);
    }
}

fn chord(key: &Keystroke, mac: bool) -> Chord {
    Chord {
        key: fv_protocol::shortcuts::normalize_key(&key.key),
        primary: key.modifiers.platform || (!mac && key.modifiers.control),
        control: mac && key.modifiers.control,
        alt: key.modifiers.alt,
        shift: key.modifiers.shift,
    }
}

fn terminal_owns(key: &Keystroke, terminal: bool, mac: bool) -> bool {
    terminal && key.modifiers.control && (!mac || !key.modifiers.platform)
}

fn matched(
    key: &Chord,
    bindings: &fv_protocol::shortcuts::ShortcutOverrides,
    mac: bool,
) -> Option<ShortcutId> {
    CATALOG.iter().find_map(|&(id, ..)| {
        resolve(id, bindings)
            .and_then(|s| Chord::parse(s).ok())
            .filter(|c| c.matches(key, mac))
            .map(|_| id)
    })
}

fn cycle_target(
    threads: &[fv_protocol::types::Thread],
    selected: Option<&str>,
    delta: isize,
) -> Option<String> {
    let mut chats: Vec<_> = threads.iter().filter(|t| !t.archived).collect();
    chats.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    if chats.is_empty() {
        return None;
    }
    let index = chats
        .iter()
        .position(|t| Some(t.id.as_str()) == selected)
        .map_or(-1, |i| i as isize);
    let target = chats[(index + delta).rem_euclid(chats.len() as isize) as usize]
        .id
        .clone();
    (Some(target.as_str()) != selected).then_some(target)
}

impl Workspace {
    pub(super) fn subscribe_shortcuts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let query = self.settings.as_ref().unwrap().shortcuts.query.clone();
        cx.subscribe_in(&query, window, |this, _, event: &InputEvent, _, cx| {
            if matches!(event, InputEvent::Focus)
                && let Some(s) = this.settings.as_mut()
            {
                s.shortcuts.cancel();
                cx.notify();
            }
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        })
        .detach();
    }

    pub(super) fn sync_shortcut_input(&mut self, cx: &mut Context<Self>) {
        if self.shortcuts.submit_on_enter != self.app_settings.send_on_enter {
            self.shortcuts.submit_on_enter = self.app_settings.send_on_enter;
            self.input.update(cx, |input, cx| {
                input.set_submit_on_enter(self.app_settings.send_on_enter, cx)
            });
        }
    }

    fn recording(&self, window: &Window) -> Option<ShortcutId> {
        self.settings
            .as_ref()
            .filter(|s| s.section == Section::Shortcuts && s.shortcuts.focus.is_focused(window))
            .and_then(|s| s.shortcuts.recording)
    }

    fn shortcut_key(
        &mut self,
        event: &KeystrokeEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        let mac = cfg!(target_os = "macos");
        // Each workspace owns exactly one window; subscriptions are dropped with that entity.
        // CharacterInput includes AltGr and native text input. Never turn it into an app action.
        if event.input_preference == InputPreference::CharacterInput
            && self.recording(window).is_none()
        {
            return;
        }
        if self.shortcuts.held.contains(&key.key) {
            cx.stop_propagation();
            return;
        }
        let chord = chord(key, mac);
        if let Some(id) = self.recording(window) {
            if ["shift", "control", "ctrl", "alt", "platform", "cmd", "fn"]
                .contains(&chord.key.as_str())
            {
                return;
            }
            self.shortcuts.held.insert(key.key.clone());
            cx.stop_propagation();
            match chord.key.as_str() {
                "escape" => self.settings.as_mut().unwrap().shortcuts.cancel(),
                "backspace" | "delete" => {
                    self.settings.as_mut().unwrap().shortcuts.cancel();
                    self.patch_settings(
                        AppSettingsPatch {
                            shortcut: Some(ShortcutEdit::Disable { id }),
                            ..Default::default()
                        },
                        cx,
                    );
                }
                _ => match Chord::parse(&chord.serialize()) {
                    Ok(binding) => {
                        self.settings.as_mut().unwrap().shortcuts.cancel();
                        self.patch_settings(
                            AppSettingsPatch {
                                shortcut: Some(ShortcutEdit::Set {
                                    id,
                                    binding: binding.serialize(),
                                }),
                                ..Default::default()
                            },
                            cx,
                        );
                    }
                    Err(e) => self.settings.as_mut().unwrap().shortcuts.error = Some(e.into()),
                },
            }
            cx.notify();
            return;
        }
        let terminal = self.terminal_focus.is_focused(window);
        if terminal_owns(key, terminal, mac) || (terminal && chord.key == "escape") {
            return;
        }
        let composer = self.input.read(cx).focus_handle(cx).is_focused(window);
        // Let the input method finish a marked composition before acting on its confirmation key.
        if composer
            && self.input.update(cx, |input, cx| {
                EntityInputHandler::marked_text_range(input, window, cx).is_some()
            })
        {
            return;
        }
        if composer
            && chord.key == "enter"
            && !chord.primary
            && !chord.control
            && !chord.alt
            && !chord.shift
            && (self.skill_picker.open() || self.mention.is_some())
            && (self.accept_skill(window, cx) || self.accept_mention(window, cx))
        {
            self.shortcuts.held.insert(key.key.clone());
            cx.stop_propagation();
            return;
        }
        let Some(id) = matched(&chord, &self.app_settings.shortcuts, mac) else {
            return;
        };
        let input = event.context_stack.iter().any(|c| c.contains("Input"));
        let handled = match id {
            ShortcutId::CommandPalette => {
                if self.search_box.is_some() {
                    self.close_palette(window, cx);
                } else {
                    self.on_open_search(&super::OpenSearch, window, cx);
                }
                true
            }
            ShortcutId::Settings => {
                if self.settings.is_none() {
                    self.on_open_settings(&super::OpenSettings, window, cx);
                }
                true
            }
            ShortcutId::NewChat => {
                self.on_new_chat(&super::NewChat, window, cx);
                self.input.update(cx, |s, cx| s.focus(window, cx));
                true
            }
            ShortcutId::OpenFolder => {
                self.settings = None;
                self.search_box = None;
                self.open_project_dialog(None, window, cx);
                self.pick_folders(cx);
                true
            }
            ShortcutId::FocusComposer => {
                self.settings = None;
                self.search_box = None;
                self.input.update(cx, |s, cx| s.focus(window, cx));
                cx.notify();
                true
            }
            ShortcutId::Send => {
                if self.settings.is_some()
                    || self.search_box.is_some()
                    || self.project_dialog.is_some()
                    || self.entry_dialog.is_some()
                    || (input && !composer)
                    || terminal
                    || self.palette_blocked()
                {
                    false
                } else {
                    if self.input.read(cx).value().trim().is_empty() {
                        self.interrupt(cx);
                    } else {
                        self.send(window, cx);
                    }
                    true
                }
            }
            ShortcutId::Stop => {
                if self.settings.is_some()
                    || self.search_box.is_some()
                    || self.project_dialog.is_some()
                    || self.entry_dialog.is_some()
                    || self.any_menu_open()
                    || self.editing()
                    || self.rename.is_some()
                    || self.sidebar_notice.is_some()
                    || self.skill_picker.open()
                    || self.mention.is_some()
                    || self.palette_blocked()
                {
                    false
                } else if self
                    .selected
                    .as_ref()
                    .and_then(|id| self.views.get(id))
                    .is_some_and(|v| v.running)
                {
                    self.interrupt(cx);
                    true
                } else {
                    false
                }
            }
            ShortcutId::PrevChat | ShortcutId::NextChat => {
                self.cycle_shortcut_chat(if id == ShortcutId::PrevChat { -1 } else { 1 }, cx)
            }
            ShortcutId::ToggleSidebar => {
                self.on_toggle_sidebar(&super::ToggleSidebar, window, cx);
                true
            }
            ShortcutId::ToggleSidePane => {
                self.toggle_side_pane(cx);
                true
            }
        };
        if handled {
            self.shortcuts.held.insert(key.key.clone());
            cx.stop_propagation();
        }
    }

    fn cycle_shortcut_chat(&mut self, delta: isize, cx: &mut Context<Self>) -> bool {
        let Some(target) = cycle_target(&self.threads, self.selected.as_deref(), delta) else {
            return false;
        };
        self.settings = None;
        self.search_box = None;
        self.select(target, cx);
        true
    }

    pub(super) fn shortcuts_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(settings) = &self.settings else {
            return div().into_any_element();
        };
        let state = &settings.shortcuts;
        let p = &self.palette;
        let query = state.query.read(cx).value().trim().to_lowercase();
        let mut pane = div().track_focus(&state.focus).flex().flex_col().gap(px(16.0))
            .child(Input::new(&state.query))
            .child(card(p).p(px(16.0)).flex_row().items_center().justify_between()
                .child(div().flex().flex_col().gap(px(4.0)).child("回车发送").child(div().text_size(px(TEXT_XS)).muted(p).child("开启后 Enter 发送、Shift+Enter 换行；关闭后 Enter 换行，使用发送快捷键。")))
                .child(switch("send-on-enter".into(), self.app_settings.send_on_enter, p).on_click(cx.listener(|this, _, _, cx| {
                    this.patch_settings(AppSettingsPatch { send_on_enter: Some(!this.app_settings.send_on_enter), ..Default::default() }, cx);
                }))));
        let mut count = 0;
        for group in ["通用", "对话", "视图"] {
            let mut rows = card(p).p(px(12.0)).gap(px(10.0));
            let mut group_count = 0;
            for &(id, section, label, fallback) in CATALOG {
                if group != section
                    || (!query.is_empty()
                        && !format!("{label} {id:?}").to_lowercase().contains(&query))
                {
                    continue;
                }
                group_count += 1;
                let binding = resolve(id, &self.app_settings.shortcuts);
                let recording = state.recording == Some(id);
                let display = binding
                    .and_then(|s| Chord::parse(s).ok())
                    .map(|c| c.label(cfg!(target_os = "macos")))
                    .unwrap_or_else(|| "未设置".into());
                let mut buttons = div().flex().gap(px(8.0));
                if binding != Some(fallback) {
                    buttons = buttons.child(
                        outline_button(SharedString::from(format!("restore-{id:?}")), p)
                            .child("恢复默认")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(s) = this.settings.as_mut() {
                                    s.shortcuts.cancel();
                                }
                                this.patch_settings(
                                    AppSettingsPatch {
                                        shortcut: Some(ShortcutEdit::Restore { id }),
                                        ..Default::default()
                                    },
                                    cx,
                                );
                            })),
                    );
                }
                buttons = buttons.child(
                    outline_button(SharedString::from(format!("record-{id:?}")), p)
                        .child(SharedString::from(if recording {
                            "请按组合键…".into()
                        } else {
                            display
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(s) = this.settings.as_mut() {
                                let state = &mut s.shortcuts;
                                state.error = None;
                                state.recording = if state.recording == Some(id) {
                                    None
                                } else {
                                    Some(id)
                                };
                                window.focus(&state.focus, cx);
                            }
                            cx.notify();
                        })),
                );
                rows = rows.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(16.0))
                        .child(div().text_size(px(TEXT_SM)).child(label))
                        .child(buttons),
                );
            }
            if group_count > 0 {
                count += group_count;
                pane = pane
                    .child(div().text_size(px(TEXT_SM)).child(group))
                    .child(rows);
            }
        }
        if count == 0 {
            pane = pane.child("未找到快捷键");
        }
        if let Some(error) = &state.error {
            pane = pane.child(
                div()
                    .text_size(px(TEXT_XS))
                    .child(SharedString::from(error.clone())),
            );
        }
        if state.recording.is_some() {
            pane =
                pane.child(div().text_size(px(TEXT_XS)).muted(p).child(
                    "Esc 取消；Backspace 或 Delete 清除。设置重复组合键会取消原操作的绑定。",
                ));
        }
        pane.child(
            outline_button("reset-all-shortcuts", p)
                .child("恢复全部默认快捷键")
                .on_click(cx.listener(|this, _, _, cx| {
                    if let Some(s) = this.settings.as_mut() {
                        s.shortcuts.cancel();
                    }
                    this.patch_settings(
                        AppSettingsPatch {
                            shortcuts: Some(Default::default()),
                            ..Default::default()
                        },
                        cx,
                    );
                })),
        )
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{chord, cycle_target, matched, terminal_owns};
    use fv_protocol::shortcuts::{
        CATALOG, Chord, ShortcutEdit, ShortcutId::*, ShortcutOverrides, apply_edit,
    };
    use gpui_kit::{Keystroke, Modifiers};

    fn native(key: &str, platform: bool, control: bool, shift: bool, alt: bool) -> Keystroke {
        Keystroke {
            key: key.into(),
            key_char: None,
            modifiers: Modifiers {
                platform,
                control,
                shift,
                alt,
                ..Default::default()
            },
        }
    }

    #[test]
    fn all_commands_match_native_modifiers_and_the_old_binding_stops_matching_after_an_edit() {
        for mac in [true, false] {
            let overrides = ShortcutOverrides::new();
            for &(id, _, _, binding) in CATALOG {
                let c = Chord::parse(binding).unwrap();
                let key = native(
                    &c.key,
                    mac && c.primary,
                    c.control || (!mac && c.primary),
                    c.shift,
                    c.alt,
                );
                assert_eq!(matched(&chord(&key, mac), &overrides, mac), Some(id));
            }
        }
        let mut overrides = ShortcutOverrides::new();
        apply_edit(
            &mut overrides,
            ShortcutEdit::Set {
                id: NewChat,
                binding: "mod+k".into(),
            },
        );
        assert_eq!(
            matched(
                &chord(&native("k", true, false, false, false), true),
                &overrides,
                true
            ),
            Some(NewChat)
        );
        assert_eq!(
            matched(
                &chord(&native("n", true, false, false, false), true),
                &overrides,
                true
            ),
            None
        );
        apply_edit(&mut overrides, ShortcutEdit::Disable { id: NewChat });
        assert_eq!(
            matched(
                &chord(&native("k", true, false, false, false), true),
                &overrides,
                true
            ),
            None
        );
    }

    #[test]
    fn terminal_control_input_keeps_its_owner_and_arrow_key_aliases_match() {
        let control = native("c", false, true, false, false);
        assert!(terminal_owns(&control, true, true));
        assert!(terminal_owns(&control, true, false));
        assert!(!terminal_owns(&control, false, true));
        let command_control = native("k", true, true, false, false);
        assert!(!terminal_owns(&command_control, true, true));
        assert!(terminal_owns(&command_control, true, false));
        let arrow = chord(&native("up", false, false, false, true), true);
        assert!(Chord::parse("alt+arrowup").unwrap().matches(&arrow, true));
        assert!(
            !Chord::parse("alt+shift+arrowup")
                .unwrap()
                .matches(&arrow, true)
        );
    }

    #[test]
    fn chat_cycle_uses_created_order_skips_archives_and_wraps_in_both_directions() {
        let thread = |id: &str, created: i64, archived: bool| {
            serde_json::from_value(serde_json::json!({
            "id":id,"title":id,"cwd":null,"project":null,"createdAt":created,"updatedAt":created,"archived":archived,"unread":false
        })).unwrap()
        };
        let threads = [
            thread("old", 1, false),
            thread("new", 5, false),
            thread("archive", 6, true),
        ];
        assert_eq!(cycle_target(&threads, None, 1).as_deref(), Some("new"));
        assert_eq!(
            cycle_target(&threads, Some("new"), 1).as_deref(),
            Some("old")
        );
        assert_eq!(
            cycle_target(&threads, Some("old"), 1).as_deref(),
            Some("new")
        );
        assert_eq!(
            cycle_target(&threads, Some("new"), -1).as_deref(),
            Some("old")
        );
        assert!(cycle_target(&[], None, 1).is_none());
        assert!(cycle_target(&threads[..1], Some("old"), 1).is_none());
    }
}
