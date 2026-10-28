//! 系统通知: a run finished or failed, or a chat waits for an answer, while nobody is looking.
//!
//! `NSUserNotification` rather than `UNUserNotificationCenter`: it needs no authorization
//! round trip and no blocks, and a click brings the app forward. Without a bundle (a dev
//! binary) macOS simply shows nothing. Other platforms do nothing yet.

/// Post one notification.
pub fn post(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    mac::post(title, body);
    #[cfg(not(target_os = "macos"))]
    let _ = (title, body);
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod mac {
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe fn string(value: &str) -> *mut Object {
        let object: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![object, initWithBytes: value.as_ptr() length: value.len() encoding: 4usize]
    }

    pub fn post(title: &str, body: &str) {
        let (Some(note_class), Some(center_class)) = (
            Class::get("NSUserNotification"),
            Class::get("NSUserNotificationCenter"),
        ) else {
            return;
        };
        unsafe {
            let center: *mut Object = msg_send![center_class, defaultUserNotificationCenter];
            if center.is_null() {
                return;
            }
            let note: *mut Object = msg_send![note_class, new];
            let (title, body) = (string(title), string(body));
            let _: () = msg_send![note, setTitle: title];
            let _: () = msg_send![note, setInformativeText: body];
            let _: () = msg_send![center, deliverNotification: note];
            let _: () = msg_send![title, release];
            let _: () = msg_send![body, release];
            let _: () = msg_send![note, release];
        }
    }
}
