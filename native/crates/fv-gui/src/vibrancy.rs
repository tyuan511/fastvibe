//! The window's material, the way Electron asks for it (`vibrancy: "under-window"`,
//! `visualEffectState: "active"`): an `NSVisualEffectView` behind the web content, with the
//! system's own tint and saturation left in.
//!
//! GPUI has a `Blurred` background of its own, but it strips exactly those two (it keeps only
//! the blur), which is why panes over it read greyer and flatter than the Electron app's.
//! So the window is `Transparent` as far as GPUI is concerned and this view supplies the
//! material.

use gpui_kit::*;

/// Show the material behind the window (`on`), or take it away.
pub fn set(window: &Window, on: bool) {
    #[cfg(target_os = "macos")]
    mac::set(window, on);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, on);
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

    pub fn set(window: &Window, on: bool) {
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
            if !on {
                if !existing.is_null() {
                    let _: () = msg_send![existing, removeFromSuperview];
                }
                return;
            }
            if !existing.is_null() {
                return;
            }
            let bounds: Rect = msg_send![content, bounds];
            let view: *mut Object = msg_send![class!(NSVisualEffectView), alloc];
            let view: *mut Object = msg_send![view, initWithFrame: bounds];
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
