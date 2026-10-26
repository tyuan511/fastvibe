//! Portable shortcut names and chords, shared by editors and settings validation.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutId {
    CommandPalette,
    Settings,
    NewChat,
    OpenFolder,
    FocusComposer,
    Send,
    Stop,
    PrevChat,
    NextChat,
    ToggleSidebar,
    ToggleSidePane,
}

pub const CATALOG: &[(ShortcutId, &str, &str, &str)] = &[
    (ShortcutId::CommandPalette, "通用", "搜索与命令", "mod+k"),
    (ShortcutId::Settings, "通用", "打开设置", "mod+,"),
    (ShortcutId::NewChat, "对话", "新建对话", "mod+n"),
    (ShortcutId::OpenFolder, "对话", "打开文件夹", "mod+o"),
    (ShortcutId::FocusComposer, "对话", "聚焦输入框", "mod+l"),
    (ShortcutId::Send, "对话", "发送消息", "mod+enter"),
    (ShortcutId::Stop, "对话", "停止回复", "escape"),
    (ShortcutId::PrevChat, "对话", "上一个对话", "mod+["),
    (ShortcutId::NextChat, "对话", "下一个对话", "mod+]"),
    (ShortcutId::ToggleSidebar, "视图", "切换侧边栏", "mod+b"),
    (ShortcutId::ToggleSidePane, "视图", "切换侧面板", "mod+j"),
];

pub type ShortcutOverrides = BTreeMap<ShortcutId, Option<String>>;

/// A single-row edit is merged under the server's settings lock, so two windows editing
/// different commands cannot replace one another's entire override map.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ShortcutEdit {
    Set { id: ShortcutId, binding: String },
    Disable { id: ShortcutId },
    Restore { id: ShortcutId },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Chord {
    pub key: String,
    pub primary: bool,
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
}

pub fn normalize_key(key: &str) -> String {
    match key.to_lowercase().as_str() {
        "return" => "enter",
        "esc" => "escape",
        "comma" => ",",
        "period" => ".",
        "plus" => "+",
        "minus" => "-",
        " " | "spacebar" => "space",
        "up" => "arrowup",
        "down" => "arrowdown",
        "left" => "arrowleft",
        "right" => "arrowright",
        other => return other.to_string(),
    }
    .into()
}

impl Chord {
    pub fn parse(raw: &str) -> Result<Self, &'static str> {
        let mut chord = Self::default();
        for part in raw.trim().split('+').map(str::trim) {
            match part.to_lowercase().as_str() {
                "mod" | "cmd" | "command" | "meta" | "super" => chord.primary = true,
                "ctrl" | "control" => chord.control = true,
                "alt" | "option" => chord.alt = true,
                "shift" => chord.shift = true,
                "" => return Err("组合键格式无效；加号键请使用 plus"),
                key if chord.key.is_empty() => chord.key = normalize_key(key),
                _ => return Err("一次只能设置一个按键组合"),
            }
        }
        let key = &chord.key;
        let named = [
            "enter",
            "escape",
            "tab",
            "space",
            "backspace",
            "delete",
            "insert",
            "home",
            "end",
            "pageup",
            "pagedown",
            "arrowup",
            "arrowdown",
            "arrowleft",
            "arrowright",
        ];
        let function = key
            .strip_prefix('f')
            .and_then(|v| v.parse::<u8>().ok())
            .is_some_and(|v| (1..=24).contains(&v));
        if !(key.chars().count() == 1 && !key.chars().any(char::is_control)
            || named.contains(&key.as_str())
            || function)
        {
            return Err("请选择一个有效按键");
        }
        if !chord.primary && !chord.control && !chord.alt && key != "escape" && !function {
            return Err("请同时按住 Command、Ctrl 或 Alt，避免影响文字输入");
        }
        let reserved = [
            "mod+c",
            "mod+v",
            "mod+x",
            "mod+a",
            "mod+z",
            "shift+mod+z",
            "mod+q",
            "mod+w",
            "mod+m",
            "mod+h",
            "mod+tab",
            "alt+tab",
        ];
        // Ctrl is the primary modifier on Windows/Linux. Reserve its editing/system keys too.
        let mut portable = chord.clone();
        portable.primary |= portable.control;
        portable.control = false;
        if reserved.contains(&portable.serialize().as_str()) {
            return Err("这个组合键由系统或文本编辑使用");
        }
        Ok(chord)
    }

    pub fn serialize(&self) -> String {
        let mut parts = Vec::new();
        if self.control {
            parts.push("ctrl");
        }
        if self.alt {
            parts.push("alt");
        }
        if self.shift {
            parts.push("shift");
        }
        if self.primary {
            parts.push("mod");
        }
        parts.push(if self.key == "+" { "plus" } else { &self.key });
        parts.join("+")
    }

    pub fn matches(&self, other: &Self, mac: bool) -> bool {
        self.key == other.key
            && self.alt == other.alt
            && self.shift == other.shift
            && if mac {
                self.primary == other.primary && self.control == other.control
            } else {
                (self.primary || self.control) == (other.primary || other.control)
            }
    }

    pub fn label(&self, mac: bool) -> String {
        let key = match self.key.as_str() {
            "enter" => "↩".into(),
            "escape" => "Esc".into(),
            "space" => "Space".into(),
            "arrowup" => "↑".into(),
            "arrowdown" => "↓".into(),
            "arrowleft" => "←".into(),
            "arrowright" => "→".into(),
            other => other.to_uppercase(),
        };
        if mac {
            format!(
                "{}{}{}{}{key}",
                if self.control { "⌃" } else { "" },
                if self.alt { "⌥" } else { "" },
                if self.shift { "⇧" } else { "" },
                if self.primary { "⌘" } else { "" }
            )
        } else {
            format!(
                "{}{}{}{key}",
                if self.primary || self.control {
                    "Ctrl+"
                } else {
                    ""
                },
                if self.alt { "Alt+" } else { "" },
                if self.shift { "Shift+" } else { "" }
            )
        }
    }
}

pub fn default_binding(id: ShortcutId) -> &'static str {
    CATALOG.iter().find(|row| row.0 == id).unwrap().3
}

pub fn resolve(id: ShortcutId, overrides: &ShortcutOverrides) -> Option<&str> {
    overrides
        .get(&id)
        .map_or_else(|| Some(default_binding(id)), |v| v.as_deref())
}

pub fn apply_edit(overrides: &mut ShortcutOverrides, edit: ShortcutEdit) {
    let (id, binding) = match edit {
        ShortcutEdit::Set { id, binding } => (id, Some(binding)),
        ShortcutEdit::Disable { id } => {
            overrides.insert(id, None);
            return;
        }
        ShortcutEdit::Restore { id } => (id, Some(default_binding(id).into())),
    };
    if let Some(binding) = &binding {
        for &(other, ..) in CATALOG {
            if other != id && resolve(other, overrides) == Some(binding.as_str()) {
                overrides.insert(other, None);
            }
        }
    }
    if binding.as_deref() == Some(default_binding(id)) {
        overrides.remove(&id);
    } else {
        overrides.insert(id, binding);
    }
}

/// Full replacement (including reset-all) still honors explicit rows over conflicting defaults.
pub fn normalize(overrides: &ShortcutOverrides) -> Result<ShortcutOverrides, &'static str> {
    let mut normalized = ShortcutOverrides::new();
    for (&id, binding) in overrides {
        normalized.insert(
            id,
            binding
                .as_deref()
                .map(Chord::parse)
                .transpose()?
                .map(|c| c.serialize()),
        );
    }
    let mut used = BTreeMap::new();
    for (&id, binding) in &normalized {
        if let Some(binding) = binding
            && used.insert(binding.clone(), id).is_some()
        {
            return Err("多个操作不能使用同一个组合键");
        }
    }
    for (binding, owner) in used {
        for &(id, ..) in CATALOG {
            if id != owner && resolve(id, &normalized) == Some(binding.as_str()) {
                normalized.insert(id, None);
            }
        }
    }
    Ok(normalized)
}
