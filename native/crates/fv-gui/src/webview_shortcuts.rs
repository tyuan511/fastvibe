//! WKWebView holds AppKit's first responder, so its key events never reach GPUI bindings.
#![allow(unexpected_cfgs)]
use crate::webview::WebEvent;
use objc::{class, msg_send, runtime::Object, sel, sel_impl};
use tokio::sync::mpsc::UnboundedSender;

pub struct Shortcuts(*mut Object);
impl Shortcuts {
    pub unsafe fn install(view: *mut Object, events: UnboundedSender<WebEvent>) -> Self {
        let handler = block::ConcreteBlock::new(move |event: *mut Object| -> *mut Object {
            unsafe {
                let window: *mut Object = msg_send![view, window];
                let event_window: *mut Object = msg_send![event, window];
                if window.is_null() || window != event_window {
                    return event;
                }
                let responder: *mut Object = msg_send![window, firstResponder];
                let is_view: bool = msg_send![responder, isKindOfClass: class!(NSView)];
                if !is_view {
                    return event;
                }
                let descendant: bool = msg_send![responder, isDescendantOf: view];
                if responder != view && !descendant {
                    return event;
                }
                let modifiers: usize = msg_send![event, modifierFlags];
                let chars: *mut Object = msg_send![event, charactersIgnoringModifiers];
                let chars: *const std::ffi::c_char = msg_send![chars, UTF8String];
                if chars.is_null() {
                    return event;
                }
                let key = std::ffi::CStr::from_ptr(chars)
                    .to_string_lossy()
                    .to_lowercase();
                let command = shortcut(
                    &key,
                    modifiers & (1 << 20) != 0,
                    modifiers & (1 << 19) != 0,
                    modifiers & (1 << 17) != 0,
                );
                if let Some(command) = command {
                    let _ = events.send(WebEvent::Shortcut(command.into()));
                    return std::ptr::null_mut();
                }
                event
            }
        })
        .copy();
        Self(unsafe {
            msg_send![class!(NSEvent), addLocalMonitorForEventsMatchingMask: (1usize<<10) handler:&*handler]
        })
    }
}
impl Drop for Shortcuts {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _: () = msg_send![class!(NSEvent), removeMonitor:self.0];
            }
        }
    }
}
fn shortcut(key: &str, command: bool, alt: bool, shift: bool) -> Option<&'static str> {
    if !command && !alt && key == "\u{1b}" {
        return Some("escape");
    }
    if command && !alt {
        return match key {
            "l" => Some("address"),
            "r" => Some("reload"),
            "f" => Some("find"),
            "p" => Some("print"),
            "=" | "+" => Some("zoom_in"),
            "-" => Some("zoom_out"),
            "0" => Some("zoom_reset"),
            "[" => Some("back"),
            "]" => Some("forward"),
            _ => None,
        };
    }
    if alt && !command && !shift {
        return match key {
            "\u{f702}" => Some("back"),
            "\u{f703}" => Some("forward"),
            _ => None,
        };
    }
    None
}
#[cfg(test)]
mod tests {
    use super::shortcut;
    #[test]
    fn browser_shortcuts_leave_typing_and_unrelated_commands_alone() {
        assert_eq!(shortcut("f", true, false, false), Some("find"));
        assert_eq!(shortcut("+", true, false, true), Some("zoom_in"));
        assert_eq!(shortcut("f", false, false, false), None);
        assert_eq!(shortcut("w", true, false, false), None);
        assert_eq!(shortcut("\u{1b}", false, false, false), Some("escape"));
    }
}
