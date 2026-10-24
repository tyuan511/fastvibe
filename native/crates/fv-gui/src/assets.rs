//! The app's own fonts and icons, with the component library's assets behind them.

use std::borrow::Cow;

use gpui_kit::{App, AssetSource, Result, SharedString};

mod table {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        if let Some((_, bytes)) = table::FILES.iter().find(|(p, _)| *p == path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        gpui_kit::assets::Assets.load(path)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut all: Vec<SharedString> = table::FILES
            .iter()
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| SharedString::from(*p))
            .collect();
        all.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(all)
    }
}

/// The interface font, as the Electron app names it.
pub const UI_FONT: &str = "Instrument Sans";

/// The code font. The Electron app asks for `"SF Mono", ui-monospace, Menlo`; macOS keeps SF
/// Mono inside Terminal.app rather than registering it, so it is loaded from there.
pub const MONO_FONT: &str = "SF Mono";

const SYSTEM_MONO_DIR: &str =
    "/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts";

/// Register the bundled fonts. Chinese is not in Instrument Sans and falls through to the
/// system's (PingFang on macOS), as it does in the Electron app.
pub fn load_fonts(cx: &mut App) {
    let mut fonts: Vec<Cow<'static, [u8]>> = table::FILES
        .iter()
        .filter(|(p, _)| p.starts_with("fonts/") && p.ends_with(".ttf"))
        .map(|(_, b)| Cow::Borrowed(*b))
        .collect();
    for weight in ["Regular", "Medium", "Semibold", "Bold"] {
        if let Ok(bytes) = std::fs::read(format!("{SYSTEM_MONO_DIR}/SF-Mono-{weight}.otf")) {
            fonts.push(Cow::Owned(bytes));
        }
    }
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        eprintln!("could not load the bundled fonts: {e:#}");
    }
}

/// The path of a Hugeicons glyph, by the kebab-case name `export-icons.mjs` gave it.
pub fn icon(name: &str) -> SharedString {
    SharedString::from(format!("icons/{name}.svg"))
}
