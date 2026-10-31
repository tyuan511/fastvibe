//! The window's material, the way Electron asks for it (`vibrancy: "under-window"`,
//! `visualEffectState: "active"`): an `NSVisualEffectView` behind the web content, with the
//! system's own tint and saturation left in.
//!
//! GPUI has a `Blurred` background of its own, but it strips exactly those two (it keeps only
//! the blur), which is why panes over it read greyer and flatter than the Electron app's.
//! So the window is `Transparent` as far as GPUI is concerned and this view supplies the
//! material.

use crate::theme::Palette;
use gpui_kit::*;

/// Match the material to the resolved app theme, independently of the OS appearance.
/// Keep the override on the effect view: overriding NSApplication/NSWindow would also
/// change `window.appearance()`, which we observe to implement “follow system”.
fn appearance_name(palette: &Palette) -> Option<&'static str> {
    palette.glass().then_some(if palette.is_dark() {
        "NSAppearanceNameDarkAqua"
    } else {
        "NSAppearanceNameAqua"
    })
}

/// Show the theme's material behind the window, or take it away when glass is off.
pub fn set(window: &Window, palette: &Palette) {
    let appearance = appearance_name(palette);
    #[cfg(target_os = "macos")]
    mac::set(window, appearance);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, appearance);
}

/// What GPUI is asked for: it never blurs, it only has to be see-through.
pub fn background(glass: bool) -> WindowBackgroundAppearance {
    if glass && cfg!(target_os = "macos") {
        WindowBackgroundAppearance::Transparent
    } else if glass {
        WindowBackgroundAppearance::Blurred
    } else {
        WindowBackgroundAppearance::Opaque
    }
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod mac {
    use objc::runtime::Object;
    use objc::{Encode, Encoding, class, msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use super::Window;

    const IDENTIFIER: &str = "fastvibe-vibrancy";
    const UNDER_WINDOW_BACKGROUND: isize = 21;
    const BEHIND_WINDOW: isize = 0;
    const ACTIVE: isize = 1;
    /// `NSViewWidthSizable | NSViewHeightSizable`.
    const WIDTH_AND_HEIGHT_SIZABLE: usize = 2 | 16;
    /// `NSWindowBelow`.
    const WINDOW_BELOW: isize = -1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    unsafe impl Encode for Point {
        fn encode() -> Encoding {
            unsafe { Encoding::from_str("{CGPoint=dd}") }
        }
    }
    unsafe impl Encode for Size {
        fn encode() -> Encoding {
            unsafe { Encoding::from_str("{CGSize=dd}") }
        }
    }
    unsafe impl Encode for Rect {
        fn encode() -> Encoding {
            unsafe { Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
        }
    }

    unsafe fn ns_string(s: &str) -> *mut Object {
        unsafe { ns_string_inner(s) }
    }

    unsafe fn ns_string_inner(s: &str) -> *mut Object {
        let class = class!(NSString);
        let bytes = s.as_ptr();
        let string: *mut Object = msg_send![class, alloc];
        msg_send![string, initWithBytes: bytes length: s.len() encoding: 4usize]
    }

    /// Our view among the content view's subviews, told apart by its identifier.
    unsafe fn find(content: *mut Object) -> *mut Object {
        unsafe { find_inner(content) }
    }

    unsafe fn find_inner(content: *mut Object) -> *mut Object {
        let subviews: *mut Object = msg_send![content, subviews];
        let count: usize = msg_send![subviews, count];
        let wanted = unsafe { ns_string(IDENTIFIER) };
        let mut found = std::ptr::null_mut();
        for i in 0..count {
            let view: *mut Object = msg_send![subviews, objectAtIndex: i];
            let id: *mut Object = msg_send![view, identifier];
            if !id.is_null() {
                let same: bool = msg_send![id, isEqualToString: wanted];
                if same {
                    found = view;
                    break;
                }
            }
        }
        let _: () = msg_send![wanted, release];
        found
    }

    pub fn set(window: &Window, appearance: Option<&str>) {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
            return;
        };
        let RawWindowHandle::AppKit(h) = handle.as_raw() else {
            return;
        };
        unsafe {
            let ns_view = h.ns_view.as_ptr() as *mut Object;
            let ns_window: *mut Object = msg_send![ns_view, window];
            if ns_window.is_null() {
                return;
            }
            let content: *mut Object = msg_send![ns_window, contentView];
            if content.is_null() {
                return;
            }
            let existing = find(content);
            let Some(appearance) = appearance else {
                if !existing.is_null() {
                    let _: () = msg_send![existing, removeFromSuperview];
                }
                return;
            };
            let name = ns_string(appearance);
            let appearance: *mut Object = msg_send![class!(NSAppearance), appearanceNamed: name];
            let _: () = msg_send![name, release];
            if !existing.is_null() {
                // Theme changes reuse the view; its material must change with the tokens.
                let _: () = msg_send![existing, setAppearance: appearance];
                return;
            }
            let bounds: Rect = msg_send![content, bounds];
            let view: *mut Object = msg_send![class!(NSVisualEffectView), alloc];
            let view: *mut Object = msg_send![view, initWithFrame: bounds];
            let _: () = msg_send![view, setAppearance: appearance];
            let _: () = msg_send![view, setMaterial: UNDER_WINDOW_BACKGROUND];
            let _: () = msg_send![view, setBlendingMode: BEHIND_WINDOW];
            let _: () = msg_send![view, setState: ACTIVE];
            let _: () = msg_send![view, setAutoresizingMask: WIDTH_AND_HEIGHT_SIZABLE];
            let id = ns_string(IDENTIFIER);
            let _: () = msg_send![view, setIdentifier: id];
            let _: () = msg_send![id, release];
            let _: () = msg_send![content, addSubview: view positioned: WINDOW_BELOW relativeTo: std::ptr::null_mut::<Object>()];
            // The content view holds it now.
            let _: () = msg_send![view, release];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Palette, appearance_name};
    use fv_theme::{Preferences, ThemeKind, ThemeMode};

    #[test]
    fn material_follows_the_selected_theme_even_when_the_system_disagrees() {
        for id in fv_theme::all_ids() {
            let dark = fv_theme::seed(id).unwrap().kind == ThemeKind::Dark;
            let prefs = Preferences {
                mode: if dark {
                    ThemeMode::Dark
                } else {
                    ThemeMode::Light
                },
                light_theme: id.into(),
                dark_theme: id.into(),
                glass: true,
            };
            for system_dark in [false, true] {
                let palette = Palette::new(prefs.resolve(system_dark, true));
                assert_eq!(
                    appearance_name(&palette),
                    Some(if dark {
                        "NSAppearanceNameDarkAqua"
                    } else {
                        "NSAppearanceNameAqua"
                    }),
                    "{id}, system_dark={system_dark}",
                );
            }
        }
    }

    #[test]
    fn system_mode_and_disabling_glass_update_the_material() {
        for system_dark in [false, true] {
            let mut prefs = Preferences::default();
            let palette = Palette::new(prefs.resolve(system_dark, true));
            assert_eq!(
                appearance_name(&palette),
                Some(if system_dark {
                    "NSAppearanceNameDarkAqua"
                } else {
                    "NSAppearanceNameAqua"
                }),
            );
            assert_eq!(
                appearance_name(&Palette::new(prefs.resolve(system_dark, false))),
                None
            );
            prefs.glass = false;
            assert_eq!(
                appearance_name(&Palette::new(prefs.resolve(system_dark, true))),
                None
            );
        }
    }
}
