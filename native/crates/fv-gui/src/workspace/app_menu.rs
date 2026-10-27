//! The macOS menu bar. Electron's default menu had no Settings row and no ⌘,; this one has the
//! app menu a Mac user expects, and every label follows the interface language (it is rebuilt
//! when the language changes, see `Workspace::sync_app_menu`).

use super::gpui::{App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, actions};
use super::{BrowserAddress, BrowserReload, NewChat, OpenSearch, OpenSettings, Quit};

actions!(
    fastvibe,
    [
        OpenAbout,
        HideApp,
        HideOthers,
        ShowAll,
        MinimizeWindow,
        ZoomWindow,
        OpenWebsite
    ]
);

const WEBSITE: &str = "https://fastvibe.dev";

/// Key bindings for the menu's own commands (⌘, is the configurable Settings shortcut, which the
/// window dispatches itself), and the app-level handlers that need no window.
pub fn bind(cx: &mut App) {
    cx.bind_keys([
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-h", HideApp, None),
        #[cfg(target_os = "macos")]
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        #[cfg(target_os = "macos")]
        KeyBinding::new("cmd-m", MinimizeWindow, None),
    ]);
    cx.on_action(|_: &HideApp, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &OpenWebsite, cx| cx.open_url(WEBSITE));
}

/// Replace the menu bar with one in the given language.
pub fn install(cx: &mut App, english: bool) {
    let t = |key: &'static str| trs!(english, key);
    let app = Menu {
        name: "FastVibe".into(),
        items: vec![
            MenuItem::action(t("app_menu.about"), OpenAbout),
            MenuItem::separator(),
            MenuItem::action(t("app_menu.settings"), OpenSettings),
            MenuItem::separator(),
            MenuItem::os_submenu(t("app_menu.services"), SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(t("app_menu.hide"), HideApp),
            MenuItem::action(t("app_menu.hide_others"), HideOthers),
            MenuItem::action(t("app_menu.show_all"), ShowAll),
            MenuItem::separator(),
            MenuItem::action(t("app_menu.quit"), Quit),
        ],
        disabled: false,
    };
    let file = Menu {
        name: t("app_menu.file").into(),
        items: vec![
            MenuItem::action(t("app_menu.new_chat"), NewChat),
            MenuItem::action(t("app_menu.search"), OpenSearch),
        ],
        disabled: false,
    };
    let edit = Menu {
        name: t("app_menu.edit").into(),
        items: vec![
            MenuItem::os_action(
                t("app_menu.undo"),
                gpui_kit::component::input::Undo,
                OsAction::Undo,
            ),
            MenuItem::os_action(
                t("app_menu.redo"),
                gpui_kit::component::input::Redo,
                OsAction::Redo,
            ),
            MenuItem::separator(),
            MenuItem::os_action(
                t("app_menu.cut"),
                gpui_kit::component::input::Cut,
                OsAction::Cut,
            ),
            MenuItem::os_action(
                t("app_menu.copy"),
                gpui_kit::component::input::Copy,
                OsAction::Copy,
            ),
            MenuItem::os_action(
                t("app_menu.paste"),
                gpui_kit::component::input::Paste,
                OsAction::Paste,
            ),
            MenuItem::os_action(
                t("app_menu.select_all"),
                gpui_kit::component::input::SelectAll,
                OsAction::SelectAll,
            ),
        ],
        disabled: false,
    };
    let view = Menu {
        name: t("app_menu.view").into(),
        items: vec![
            MenuItem::action(t("app_menu.address_bar"), BrowserAddress),
            MenuItem::action(t("app_menu.reload"), BrowserReload),
        ],
        disabled: false,
    };
    let window = Menu {
        name: t("app_menu.window").into(),
        items: vec![
            MenuItem::action(t("app_menu.minimize"), MinimizeWindow),
            MenuItem::action(t("app_menu.zoom"), ZoomWindow),
        ],
        disabled: false,
    };
    let help = Menu {
        name: t("app_menu.help").into(),
        items: vec![MenuItem::action(t("app_menu.website"), OpenWebsite)],
        disabled: false,
    };
    cx.set_menus(vec![app, file, edit, view, window, help]);
}
