/// Update the macOS Dock tile badge. Other platforms intentionally do nothing.
pub fn set(count: u32) {
    #[cfg(target_os = "macos")]
    mac::set(count);
    #[cfg(not(target_os = "macos"))]
    let _ = count;
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod mac {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe fn string(value: &str) -> *mut Object {
        let cls = class!(NSString);
        let bytes = value.as_ptr();
        let object: *mut Object = msg_send![cls, alloc];
        msg_send![object, initWithBytes: bytes length: value.len() encoding: 4usize]
    }

    pub fn set(count: u32) {
        unsafe {
            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return;
            }
            let tile: *mut Object = msg_send![app, dockTile];
            if tile.is_null() {
                return;
            }
            if count == 0 {
                let _: () = msg_send![tile, setBadgeLabel: std::ptr::null_mut::<Object>()];
            } else {
                let label = string(&count.to_string());
                let _: () = msg_send![tile, setBadgeLabel: label];
                let _: () = msg_send![label, release];
            }
        }
    }
}
