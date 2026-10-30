//! A navigation-delegate proxy keeps Wry's navigation policy and owns WKDownload lifecycle.
//! Wry exposes start/finish only (and returns no path on macOS), so progress and pause/resume
//! have to stay with the native download objects rather than being inferred from filenames.
#![allow(unexpected_cfgs)]
use crate::{pane_layout::Download, webview::WebEvent};
use objc::{
    class,
    declare::ClassDecl,
    msg_send,
    runtime::{Class, Object, Sel},
    sel, sel_impl,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::mpsc::UnboundedSender;

struct Record {
    download: *mut Object,
    resume: *mut Object,
    row: Download,
    cancelled: bool,
}
impl Drop for Record {
    fn drop(&mut self) {
        unsafe {
            let _: () = msg_send![self.download, release];
            if !self.resume.is_null() {
                let _: () = msg_send![self.resume, release];
            }
        }
    }
}
struct State {
    view: *mut Object,
    delegate: *mut Object,
    dir: Arc<Mutex<PathBuf>>,
    events: UnboundedSender<WebEvent>,
    records: HashMap<String, Record>,
}
impl State {
    fn publish(&self, id: &str) {
        if let Some(record) = self.records.get(id) {
            let _ = self
                .events
                .send(WebEvent::DownloadChanged(record.row.clone()));
        }
    }
    fn id_for(&self, download: *mut Object) -> Option<String> {
        self.records
            .iter()
            .find(|(_, r)| r.download == download)
            .map(|(id, _)| id.clone())
    }
}
pub struct Downloads {
    proxy: *mut Object,
    delegate: *mut Object,
    state: Rc<RefCell<State>>,
    boxed: *mut Rc<RefCell<State>>,
}
fn classes() -> (&'static Class, &'static Class) {
    static CLASSES: OnceLock<(usize, usize)> = OnceLock::new();
    let &(nav, download) = CLASSES.get_or_init(|| {
        let mut nav = ClassDecl::new("FVBrowserNavigationProxy", class!(NSObject)).unwrap();
        if let Some(protocol) = objc::runtime::Protocol::get("WKNavigationDelegate") {
            nav.add_protocol(protocol);
        }
        nav.add_ivar::<*mut Object>("original");
        nav.add_ivar::<*mut Object>("downloads");
        unsafe {
            nav.add_method(
                sel!(respondsToSelector:),
                responds as extern "C" fn(&Object, Sel, Sel) -> bool,
            );
            nav.add_method(
                sel!(forwardingTargetForSelector:),
                forward as extern "C" fn(&Object, Sel, Sel) -> *mut Object,
            );
            nav.add_method(
                sel!(webView:navigationAction:didBecomeDownload:),
                became as extern "C" fn(&Object, Sel, *mut Object, *mut Object, *mut Object),
            );
            nav.add_method(
                sel!(webView:navigationResponse:didBecomeDownload:),
                became as extern "C" fn(&Object, Sel, *mut Object, *mut Object, *mut Object),
            );
        }
        let mut download = ClassDecl::new("FVBrowserDownloadDelegate", class!(NSObject)).unwrap();
        if let Some(protocol) = objc::runtime::Protocol::get("WKDownloadDelegate") {
            download.add_protocol(protocol);
        }
        download.add_ivar::<*mut std::ffi::c_void>("state");
        unsafe {
            download.add_method(
                sel!(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:),
                destination
                    as extern "C" fn(
                        &Object,
                        Sel,
                        *mut Object,
                        *mut Object,
                        *mut Object,
                        *mut Object,
                    ),
            );
            download.add_method(
                sel!(downloadDidFinish:),
                finished as extern "C" fn(&Object, Sel, *mut Object),
            );
            download.add_method(
                sel!(download:didFailWithError:resumeData:),
                failed as extern "C" fn(&Object, Sel, *mut Object, *mut Object, *mut Object),
            );
        }
        (
            nav.register() as *const _ as usize,
            download.register() as *const _ as usize,
        )
    });
    unsafe { (&*(nav as *const Class), &*(download as *const Class)) }
}
extern "C" fn responds(this: &Object, _: Sel, selector: Sel) -> bool {
    if [
        sel!(webView:navigationAction:didBecomeDownload:),
        sel!(webView:navigationResponse:didBecomeDownload:),
    ]
    .contains(&selector)
    {
        return true;
    }
    unsafe {
        let original: *mut Object = *this.get_ivar("original");
        msg_send![original,respondsToSelector:selector]
    }
}
extern "C" fn forward(this: &Object, _: Sel, _: Sel) -> *mut Object {
    unsafe { *this.get_ivar("original") }
}
extern "C" fn became(this: &Object, _: Sel, _: *mut Object, _: *mut Object, download: *mut Object) {
    unsafe {
        let delegate: *mut Object = *this.get_ivar("downloads");
        let _: () = msg_send![download,setDelegate:delegate];
    }
}
unsafe fn state(this: &Object) -> Rc<RefCell<State>> {
    unsafe {
        let ptr: *mut std::ffi::c_void = *this.get_ivar("state");
        (*(ptr as *mut Rc<RefCell<State>>)).clone()
    }
}
unsafe fn string(object: *mut Object) -> String {
    unsafe {
        if object.is_null() {
            return String::new();
        }
        let ptr: *const std::ffi::c_char = msg_send![object, UTF8String];
        if ptr.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}
unsafe fn ns_string(text: &str) -> *mut Object {
    unsafe {
        let s: *mut Object = msg_send![class!(NSString), alloc];
        msg_send![s,initWithBytes:text.as_ptr() length:text.len() encoding:4usize]
    }
}
extern "C" fn destination(
    this: &Object,
    _: Sel,
    download: *mut Object,
    _: *mut Object,
    name: *mut Object,
    done: *mut Object,
) {
    unsafe {
        let done = &*(done as *const block::Block<(*mut Object,), ()>);
        let state = state(this);
        let mut s = state.borrow_mut();
        let id = s
            .id_for(download)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let existing = s.records.get(&id).map(|r| r.row.path.clone());
        let dir = s.dir.lock().unwrap().clone();
        if std::fs::create_dir_all(&dir).is_err() {
            drop(s);
            done.call((std::ptr::null_mut(),));
            return;
        }
        let path = existing.unwrap_or_else(|| {
            // Reserve across tabs too: WebKit writes a temporary file until completion.
            static RESERVED: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
            let mut reserved = RESERVED.get_or_init(Default::default).lock().unwrap();
            let path = unique_path(&dir, &string(name), reserved.iter().map(PathBuf::as_path));
            reserved.push(path.clone());
            path
        });
        if !s.records.contains_key(&id) {
            let request: *mut Object = msg_send![download, originalRequest];
            let url: *mut Object = msg_send![request, URL];
            let url: *mut Object = msg_send![url, absoluteString];
            let _: () = msg_send![download, retain];
            s.records.insert(
                id.clone(),
                Record {
                    download,
                    resume: std::ptr::null_mut(),
                    cancelled: false,
                    row: Download {
                        id: id.clone(),
                        url: string(url),
                        path: path.clone(),
                        complete: None,
                        received: 0,
                        total: None,
                        paused: false,
                        can_resume: false,
                    },
                },
            );
        }
        s.publish(&id);
        // Calling the completion can synchronously enter a delegate callback.
        drop(s);
        let path = ns_string(&path.to_string_lossy());
        let url: *mut Object = msg_send![class!(NSURL),fileURLWithPath:path];
        done.call((url,));
        let _: () = msg_send![path, release];
    }
}
extern "C" fn finished(this: &Object, _: Sel, download: *mut Object) {
    unsafe {
        let state = state(this);
        let mut s = state.borrow_mut();
        if let Some(id) = s.id_for(download) {
            let r = s.records.get_mut(&id).unwrap();
            r.row.complete = Some(true);
            r.row.paused = false;
            r.row.can_resume = false;
            if let Ok(meta) = std::fs::metadata(&r.row.path) {
                r.row.received = meta.len();
                r.row.total = Some(meta.len());
            }
            s.publish(&id);
        }
    }
}
extern "C" fn failed(
    this: &Object,
    _: Sel,
    download: *mut Object,
    _: *mut Object,
    resume: *mut Object,
) {
    unsafe {
        let state = state(this);
        let mut s = state.borrow_mut();
        if let Some(id) = s.id_for(download) {
            let r = s.records.get_mut(&id).unwrap();
            if !resume.is_null() && !r.cancelled {
                let _: () = msg_send![resume, retain];
                if !r.resume.is_null() {
                    let _: () = msg_send![r.resume, release];
                }
                r.resume = resume;
                r.row.can_resume = true;
            }
            if !r.row.paused {
                r.row.complete = Some(false);
            }
            s.publish(&id);
        }
    }
}
impl Downloads {
    pub unsafe fn attach(
        view: *mut Object,
        dir: Arc<Mutex<PathBuf>>,
        events: UnboundedSender<WebEvent>,
    ) -> Self {
        unsafe {
            let (nav_class, download_class) = classes();
            let proxy: *mut Object = msg_send![nav_class, new];
            let delegate: *mut Object = msg_send![download_class, new];
            let original: *mut Object = msg_send![view, navigationDelegate];
            let _: () = msg_send![original, retain];
            (*proxy).set_ivar("original", original);
            (*proxy).set_ivar("downloads", delegate);
            let state = Rc::new(RefCell::new(State {
                view,
                delegate,
                dir,
                events,
                records: HashMap::new(),
            }));
            let boxed = Box::into_raw(Box::new(state.clone()));
            (*delegate).set_ivar("state", boxed.cast::<std::ffi::c_void>());
            let _: () = msg_send![view,setNavigationDelegate:proxy];
            Self {
                proxy,
                delegate,
                state,
                boxed,
            }
        }
    }
    pub fn poll(&self) -> bool {
        let mut s = self.state.borrow_mut();
        let mut active = false;
        let mut changed = vec![];
        for (id, record) in &mut s.records {
            if record.row.complete.is_some() || record.row.paused {
                continue;
            }
            active = true;
            unsafe {
                let progress: *mut Object = msg_send![record.download, progress];
                let received: i64 = msg_send![progress, completedUnitCount];
                let total: i64 = msg_send![progress, totalUnitCount];
                record.row.received = received.max(0) as u64;
                record.row.total = (total > 0).then_some(total as u64);
            }
            changed.push(id.clone());
        }
        for id in changed {
            s.publish(&id);
        }
        active
    }
    pub fn action(&self, id: &str, action: &str) -> Result<(), String> {
        let state = self.state.clone();
        let (download, resume, view, delegate) = {
            let s = state.borrow();
            let r = s.records.get(id).ok_or("Download no longer exists")?;
            (r.download, r.resume, s.view, s.delegate)
        };
        unsafe {
            match action {
                "pause" | "cancel" => {
                    let paused = action == "pause";
                    {
                        let mut s = state.borrow_mut();
                        let r = s.records.get_mut(id).unwrap();
                        r.cancelled = !paused;
                        r.row.paused = paused;
                        r.row.complete = if paused { None } else { Some(false) };
                        s.publish(id);
                    }
                    let id = id.to_string();
                    let state = state.clone();
                    let callback = block::ConcreteBlock::new(move |resume: *mut Object| {
                        let mut s = state.borrow_mut();
                        let Some(r) = s.records.get_mut(&id) else {
                            return;
                        };
                        if paused && !resume.is_null() {
                            let _: () = msg_send![resume, retain];
                            if !r.resume.is_null() {
                                let _: () = msg_send![r.resume, release];
                            }
                            r.resume = resume;
                            r.row.can_resume = true;
                        } else {
                            r.row.paused = false;
                            r.row.can_resume = false;
                            r.row.complete = Some(false);
                        }
                        s.publish(&id);
                    })
                    .copy();
                    let _: () = msg_send![download,cancel:&*callback];
                }
                "resume" => {
                    if resume.is_null() {
                        return Err("This download cannot be resumed".into());
                    }
                    let id = id.to_string();
                    let state = state.clone();
                    let callback = block::ConcreteBlock::new(move |next: *mut Object| {
                        let mut s = state.borrow_mut();
                        let Some(r) = s.records.get_mut(&id) else {
                            return;
                        };
                        if next.is_null() {
                            r.row.complete = Some(false);
                            r.row.paused = false;
                        } else {
                            let _: () = msg_send![next, retain];
                            let _: () = msg_send![r.download, release];
                            r.download = next;
                            r.cancelled = false;
                            r.row.complete = None;
                            r.row.paused = false;
                            r.row.can_resume = false;
                            let _: () = msg_send![next,setDelegate:delegate];
                        }
                        s.publish(&id);
                    })
                    .copy();
                    let _: () = msg_send![view,resumeDownloadFromResumeData:resume completionHandler:&*callback];
                }
                _ => return Err("Unknown download action".into()),
            }
        }
        Ok(())
    }
}
impl Drop for Downloads {
    fn drop(&mut self) {
        unsafe {
            // Cancel while the delegate and its state are still alive, then detach every callback.
            for record in self.state.borrow().records.values() {
                let _: () = msg_send![record.download,setDelegate:std::ptr::null_mut::<Object>()];
                if record.row.complete.is_none() && !record.row.paused {
                    let done = block::ConcreteBlock::new(|_: *mut Object| {}).copy();
                    let _: () = msg_send![record.download,cancel:&*done];
                }
            }
            let view = self.state.borrow().view;
            let original: *mut Object = *(*self.proxy).get_ivar("original");
            let _: () = msg_send![view,setNavigationDelegate:original];
            let _: () = msg_send![original, release];
            let _: () = msg_send![self.proxy, release];
            let _: () = msg_send![self.delegate, release];
            drop(Box::from_raw(self.boxed));
        }
    }
}
fn unique_path<'a>(
    dir: &std::path::Path,
    name: &str,
    reserved: impl Iterator<Item = &'a std::path::Path>,
) -> PathBuf {
    let name = std::path::Path::new(name)
        .file_name()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| std::ffi::OsStr::new("download"));
    let reserved: Vec<_> = reserved.collect();
    let mut path = dir.join(name);
    let base = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let mut index = 1;
    while path.exists() || reserved.contains(&path.as_path()) {
        path = dir.join(format!("{base} ({index}){ext}"));
        index += 1;
    }
    path
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_confined_and_existing_files_are_preserved() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("report.csv"), "existing").unwrap();
        assert_eq!(
            unique_path(d.path(), "../../report.csv", std::iter::empty()),
            d.path().join("report (1).csv")
        );
        assert_eq!(
            unique_path(
                d.path(),
                "other.csv",
                [d.path().join("other.csv").as_path()].into_iter()
            ),
            d.path().join("other (1).csv")
        );
    }
}
