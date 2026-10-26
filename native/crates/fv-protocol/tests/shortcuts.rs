use fv_protocol::shortcuts::{
    self, CATALOG, Chord, ShortcutEdit, ShortcutId::*, ShortcutOverrides,
};
use fv_protocol::types::{AppSettings, AppSettingsPatch};
use serde_json::json;

#[test]
fn old_settings_keep_enter_send_and_the_complete_catalog_has_unique_usable_defaults() {
    let settings: AppSettings = serde_json::from_value(json!({"themeMode":"system","lightTheme":"github-light","darkTheme":"github-dark","glass":false})).unwrap();
    assert!(settings.send_on_enter && settings.shortcuts.is_empty());
    let mut seen = std::collections::HashSet::new();
    for &(id, _, _, binding) in CATALOG {
        assert!(seen.insert(binding));
        assert_eq!(shortcuts::resolve(id, &settings.shortcuts), Some(binding));
        assert_eq!(Chord::parse(binding).unwrap().serialize(), binding);
    }
    assert_eq!(seen.len(), 11);
}

#[test]
fn normalized_keys_cover_aliases_punctuation_and_platform_modifier_matching() {
    let key = Chord::parse(" Command + SHIFT + Return ").unwrap();
    assert_eq!(key.serialize(), "shift+mod+enter");
    assert_eq!(key.label(true), "⇧⌘↩");
    assert_eq!(key.label(false), "Ctrl+Shift+↩");
    let control = Chord::parse("Ctrl+K").unwrap();
    let primary = Chord::parse("mod+k").unwrap();
    assert!(!control.matches(&primary, true));
    assert!(control.matches(&primary, false));
    assert_eq!(Chord::parse("mod+plus").unwrap().serialize(), "mod+plus");
    assert_eq!(Chord::parse("Alt+ArrowUp").unwrap().key, "arrowup");
    assert!(Chord::parse("F12").is_ok());
}

#[test]
fn ordinary_text_multiple_keys_and_system_editing_keys_are_rejected() {
    for key in [
        "",
        "a",
        "shift+a",
        "enter",
        "mod+k+l",
        "mod++",
        "meta",
        "mod+Unknown",
        "mod+c",
        "ctrl+z",
        "cmd+shift+z",
        "mod+q",
        "alt+tab",
        "ctrl+tab",
        "mod+\n",
    ] {
        assert!(Chord::parse(key).is_err(), "accepted {key:?}");
    }
}

#[test]
fn single_row_edits_disable_conflicts_and_can_restore_or_explicitly_disable_defaults() {
    let mut overrides = ShortcutOverrides::new();
    shortcuts::apply_edit(
        &mut overrides,
        ShortcutEdit::Set {
            id: NewChat,
            binding: "mod+k".into(),
        },
    );
    assert_eq!(shortcuts::resolve(NewChat, &overrides), Some("mod+k"));
    assert_eq!(shortcuts::resolve(CommandPalette, &overrides), None);
    shortcuts::apply_edit(&mut overrides, ShortcutEdit::Restore { id: CommandPalette });
    assert_eq!(
        shortcuts::resolve(CommandPalette, &overrides),
        Some("mod+k")
    );
    assert_eq!(shortcuts::resolve(NewChat, &overrides), None);
    shortcuts::apply_edit(&mut overrides, ShortcutEdit::Disable { id: Send });
    assert!(shortcuts::resolve(Send, &overrides).is_none());
    shortcuts::apply_edit(&mut overrides, ShortcutEdit::Restore { id: Send });
    assert_eq!(shortcuts::resolve(Send, &overrides), Some("mod+enter"));
}

#[test]
fn whole_map_validation_is_deterministic_and_patches_keep_unrelated_preferences() {
    let overrides = ShortcutOverrides::from([(NewChat, Some("cmd+K".into()))]);
    let normalized = shortcuts::normalize(&overrides).unwrap();
    assert_eq!(normalized[&NewChat].as_deref(), Some("mod+k"));
    assert_eq!(normalized[&CommandPalette], None);
    assert!(
        shortcuts::normalize(&ShortcutOverrides::from([
            (NewChat, Some("mod+k".into())),
            (Settings, Some("cmd+k".into()))
        ]))
        .is_err()
    );
    let mut settings = AppSettings {
        custom_system_prompt: "user instructions".into(),
        glass: true,
        ..Default::default()
    };
    settings.apply(AppSettingsPatch {
        send_on_enter: Some(false),
        shortcuts: Some(normalized),
        ..Default::default()
    });
    settings.apply(AppSettingsPatch {
        shortcut: Some(ShortcutEdit::Disable { id: Stop }),
        ..Default::default()
    });
    assert!(!settings.send_on_enter && settings.glass);
    assert_eq!(settings.custom_system_prompt, "user instructions");
    assert_eq!(
        shortcuts::resolve(NewChat, &settings.shortcuts),
        Some("mod+k")
    );
    assert!(shortcuts::resolve(Stop, &settings.shortcuts).is_none());
    let restored: AppSettings =
        serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
    assert_eq!(settings, restored);
    settings.apply(AppSettingsPatch {
        shortcuts: Some(Default::default()),
        ..Default::default()
    });
    assert_eq!(
        shortcuts::resolve(NewChat, &settings.shortcuts),
        Some("mod+n")
    );
    assert!(
        !settings.send_on_enter,
        "restoring shortcuts must not reset the sending preference"
    );
}
