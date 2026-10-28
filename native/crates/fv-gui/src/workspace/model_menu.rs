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
    name: &str,
    holds_current: bool,
    open: bool,
    p: &Palette,
) -> Stateful<Div> {
    menu_item(id, open, p.c(Token::Accent))
        .h(px(32.0))
        .child(icon("boxes", 14.0, p.c(Token::MutedForeground)))
        .child(crate::ui::truncate(name.to_string()).flex_1())
        .when(holds_current, |d| {
            d.child(icon("tick02", 14.0, p.c(Token::Primary)))
        })
        .child(icon("arrow-right01", 12.0, p.c(Token::MutedForeground)))
}

/// A model's row in the flyout beside its provider. Same shape without the glyph and with the
/// chevron traded for the tick, because this is the end of the path.
pub fn model_row(id: SharedString, name: &str, current: bool, p: &Palette) -> Stateful<Div> {
    menu_item(id, false, p.c(Token::Accent))
        .h(px(32.0))
        .justify_between()
        .gap(px(8.0))
        .child(crate::ui::truncate(name.to_string()).flex_1())
        .when(current, |d| {
            d.child(icon("tick02", 14.0, p.c(Token::Primary)))
        })
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
