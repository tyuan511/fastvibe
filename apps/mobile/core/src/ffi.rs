use crate::runtime::CoreHandle;
use crate::support::lock;
use std::ffi::{CStr, CString, c_char};
use std::sync::OnceLock;

static HANDLE: OnceLock<CoreHandle> = OnceLock::new();

fn handle() -> &'static CoreHandle {
    HANDLE.get_or_init(CoreHandle::new)
}

fn string_result(value: serde_json::Value) -> *mut c_char {
    CString::new(value.to_string())
        .unwrap_or_else(|_| CString::new("{\"ok\":false,\"error\":\"invalid output\"}").unwrap())
        .into_raw()
}

#[unsafe(no_mangle)]
pub extern "C" fn fv_mobile_core_version() -> *mut c_char {
    CString::new("fastvibe-mobile-core/0.1.0")
        .unwrap()
        .into_raw()
}

/// Create an independent, opaque runtime. The caller owns the returned handle.
#[unsafe(no_mangle)]
pub extern "C" fn fv_mobile_core_create() -> *mut CoreHandle {
    Box::into_raw(Box::new(CoreHandle::new()))
}

/// Destroy a runtime handle. Null is accepted.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_destroy(handle: *mut CoreHandle) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle) });
    }
}

/// Alias retained for hosts that use `free` naming for opaque handles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_free(handle: *mut CoreHandle) {
    unsafe { fv_mobile_core_destroy(handle) };
}

/// Execute one JSON command against an independent runtime.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_command_json(
    handle: *mut CoreHandle,
    input: *const c_char,
) -> *mut c_char {
    if handle.is_null() || input.is_null() {
        return std::ptr::null_mut();
    }
    let raw = match unsafe { CStr::from_ptr(input) }.to_str() {
        Ok(value) => value,
        Err(_) => return std::ptr::null_mut(),
    };
    let value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            return string_result(
                serde_json::json!({"ok":false,"error":{"message":error.to_string()}}),
            );
        }
    };
    string_result(unsafe { &*handle }.command(value))
}

/// Alias retained for simple platform bindings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_command(
    handle: *mut CoreHandle,
    input: *const c_char,
) -> *mut c_char {
    unsafe { fv_mobile_core_command_json(handle, input) }
}

/// Poll and remove up to 64 inbound events from an independent runtime.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_poll_json(handle: *mut CoreHandle) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    string_result(unsafe { &*handle }.poll_result(None))
}

/// Alias retained for simple platform bindings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_poll(handle: *mut CoreHandle) -> *mut c_char {
    unsafe { fv_mobile_core_poll_json(handle) }
}

/// Apply a snapshot or engine event and return the bounded JSON state. The caller owns the string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_apply_json(input: *const c_char) -> *mut c_char {
    if input.is_null() {
        return std::ptr::null_mut();
    }
    let raw = match unsafe { CStr::from_ptr(input) }.to_str() {
        Ok(value) => value,
        Err(_) => return std::ptr::null_mut(),
    };
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return std::ptr::null_mut(),
    };
    let core = handle();
    if core.apply_value(&value).is_err() {
        return std::ptr::null_mut();
    }
    string_result(serde_json::json!({
        "snapshot": core.shared.snapshot(),
        "wireCursors": lock(&core.shared.wire_cursors).clone(),
        "loadingHistory": false,
        "connection": "ready"
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn fv_mobile_core_free_string(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}
