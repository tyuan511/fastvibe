//! Native child WebViews. All construction, placement and teardown stay on GPUI's
//! main thread. A document view has no application bridge or browser profile access.
use crate::web_content::{Document, DocumentServer};
use gpui_kit::{Bounds, Pixels, Window};
use std::path::PathBuf;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone, Debug)]
pub enum WebEvent {
    Location(String),
    Title(String),
    Loading(bool),
    DocumentReady,
    Popup(String),
    External(String),
    Notice(String),
    Crashed,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Navigation {
    Browser,
    Document(String),
}
impl Navigation {
    pub fn allows(&self, value: &str) -> bool {
        match self {
            Self::Browser => value == "about:blank" || fv_core::safe_web_url(value).is_some(),
            Self::Document(expected) => value.split('#').next() == Some(expected.as_str()),
        }
    }
}
pub fn address(value: &str) -> Result<String, String> {
    address_with_search(value, "https://www.google.com/search?q={query}")
}

pub fn address_with_search(value: &str, search_engine: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value == "about:blank" {
        return Ok("about:blank".into());
    }
    if let Some(url) = fv_core::safe_web_url(value) {
        return Ok(url);
    }
    if value.contains("://")
        || value.starts_with("javascript:")
        || value.starts_with("data:")
        || value.starts_with("file:")
        || value.starts_with("about:")
    {
        return Err("请输入 HTTP 或 HTTPS 网页地址".into());
    }
    if !value.chars().any(char::is_whitespace)
        && (value.contains('.')
            || value.starts_with("localhost")
            || value.starts_with("127.")
            || value.starts_with('['))
    {
        let scheme = if value.starts_with("localhost")
            || value.starts_with("127.")
            || value.starts_with("[::1]")
        {
            "http"
        } else {
            "https"
        };
        return fv_core::safe_web_url(&format!("{scheme}://{value}"))
            .ok_or_else(|| "网页地址无效".into());
    }
    if !search_engine.contains("{query}") {
        return Err("搜索引擎地址必须包含 {query}".into());
    }
    let encoded = url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    let target = search_engine.replace("{query}", &encoded);
    fv_core::safe_web_url(&target).ok_or_else(|| "搜索引擎地址无效".into())
}

pub fn download_directory(configured: &str) -> PathBuf {
    if !configured.trim().is_empty() {
        return PathBuf::from(configured.trim());
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Downloads"))
        .unwrap_or_else(|| PathBuf::from("Downloads"))
}
/// Native child views cannot be painted underneath a GPUI overlay. Hide instead of
/// cropping/reflowing the page when an animated pane or an ancestor clips its viewport.
pub fn fully_visible(bounds: Bounds<Pixels>, clip: Bounds<Pixels>) -> bool {
    let values = [
        bounds.left(),
        bounds.top(),
        bounds.right(),
        bounds.bottom(),
        clip.left(),
        clip.top(),
        clip.right(),
        clip.bottom(),
    ];
    values.iter().all(|v| f32::from(*v).is_finite())
        && f32::from(bounds.size.width) > 1.0
        && f32::from(bounds.size.height) > 1.0
        && f32::from(bounds.left() - clip.left()) >= -0.5
        && f32::from(bounds.top() - clip.top()) >= -0.5
        && f32::from(bounds.right() - clip.right()) <= 0.5
        && f32::from(bounds.bottom() - clip.bottom()) <= 0.5
}

pub struct Surface {
    pub error: Option<String>,
    url: String,
    navigation: Navigation,
    events: UnboundedSender<WebEvent>,
    // Retaining the server keeps its exact file grant alive only as long as this view.
    _document: Option<DocumentServer>,
    download_dir: Option<PathBuf>,
    #[cfg(target_os = "macos")]
    native: Option<wry::WebView>,
    visible: bool,
    bounds: Option<Bounds<Pixels>>,
}
impl Surface {
    pub fn browser(url: String, events: UnboundedSender<WebEvent>, download_dir: PathBuf) -> Self {
        Self {
            error: None,
            url,
            navigation: Navigation::Browser,
            events,
            _document: None,
            download_dir: Some(download_dir),
            #[cfg(target_os = "macos")]
            native: None,
            visible: false,
            bounds: None,
        }
    }
    pub fn document(document: Document, events: UnboundedSender<WebEvent>) -> Result<Self, String> {
        let server =
            DocumentServer::start(document).map_err(|e| format!("无法准备文档预览：{e}"))?;
        Ok(Self {
            error: None,
            url: server.url.clone(),
            navigation: Navigation::Document(server.url.clone()),
            events,
            _document: Some(server),
            download_dir: None,
            #[cfg(target_os = "macos")]
            native: None,
            visible: false,
            bounds: None,
        })
    }
    pub fn live(url: String, events: UnboundedSender<WebEvent>) -> Result<Self, String> {
        let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
        if parsed.scheme() != "http"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.port().is_none()
            || parsed.path() != "/"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("无效的本地文档地址".into());
        }
        Ok(Self {
            error: None,
            navigation: Navigation::Document(url.clone()),
            url,
            events,
            _document: None,
            download_dir: None,
            #[cfg(target_os = "macos")]
            native: None,
            visible: false,
            bounds: None,
        })
    }
    pub fn hide(&mut self) {
        if !self.visible {
            return;
        }
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            let _ = native.set_visible(false);
            let _ = native.focus_parent();
        }
        self.visible = false;
    }
    pub fn place(&mut self, bounds: Bounds<Pixels>, clip: Bounds<Pixels>, window: &Window) {
        self.place_inner(bounds, clip, window, true);
    }
    pub fn preload(&mut self, bounds: Bounds<Pixels>, clip: Bounds<Pixels>, window: &Window) {
        self.place_inner(bounds, clip, window, false);
    }
    fn place_inner(
        &mut self,
        bounds: Bounds<Pixels>,
        clip: Bounds<Pixels>,
        window: &Window,
        show: bool,
    ) {
        if !fully_visible(bounds, clip) {
            self.hide();
            return;
        }
        if self.error.is_some() {
            return;
        }
        #[cfg(target_os = "macos")]
        {
            if self.native.is_none()
                && let Err(e) = self.mount(window)
            {
                self.error = Some(format!("无法创建网页视图：{e}"));
                return;
            }
            if let Some(native) = &self.native {
                if self.bounds != Some(bounds) {
                    let rect = wry::Rect {
                        position: wry::dpi::LogicalPosition::new(
                            f64::from(f32::from(bounds.left())),
                            f64::from(f32::from(bounds.top())),
                        )
                        .into(),
                        size: wry::dpi::LogicalSize::new(
                            f64::from(f32::from(bounds.size.width)),
                            f64::from(f32::from(bounds.size.height)),
                        )
                        .into(),
                    };
                    if let Err(e) = native.set_bounds(rect) {
                        let error = e.to_string();
                        self.hide();
                        self.error = Some(error);
                        return;
                    }
                    self.bounds = Some(bounds);
                }
                if !self.visible && show {
                    if let Err(error) = native.set_visible(true) {
                        self.error = Some(error.to_string());
                        return;
                    }
                    self.visible = true;
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (bounds, window);
            self.error = Some("此平台的原生网页视图尚未接通".into());
        }
    }
    /// Whether the native view exists yet; it is made when the pane is first painted.
    pub fn is_mounted(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            self.native.is_some()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    }

    /// Run a script on the page; `done` receives the script's value as JSON text.
    pub fn eval(&self, script: &str, done: impl Fn(String) + Send + 'static) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            return native
                .evaluate_script_with_callback(script, done)
                .map_err(|e| e.to_string());
        }
        let _ = (script, done);
        Err("the browser pane is not showing".into())
    }

    pub fn remember_location(&mut self, url: &str) {
        if self.navigation.allows(url) {
            self.url = url.into();
        }
    }
    pub fn navigate(&mut self, url: &str) -> Result<(), String> {
        if !self.navigation.allows(url) {
            return Err("不支持这个网页地址".into());
        }
        self.url = url.into();
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            native.load_url(url).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn command(&self, command: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if let Some(native) = &self.native {
            let result = match command {
                "focus_parent" => native.focus_parent(),
                "back" => native.go_back(),
                "forward" => {
                    use wry::WebViewExtMacOS as _;
                    // The toolbar acts on WebKit, even if a page overrides history.forward.
                    unsafe {
                        native.webview().goForward();
                    }
                    Ok(())
                }
                "reload" => native.reload(),
                "stop" => {
                    use wry::WebViewExtMacOS as _;
                    unsafe {
                        native.webview().stopLoading();
                    }
                    Ok(())
                }
                _ => return Err("未知网页操作".into()),
            };
            return result.map_err(|e| e.to_string());
        }
        let _ = command;
        Ok(())
    }
    pub fn retry(&mut self) {
        self.error = None;
        #[cfg(target_os = "macos")]
        {
            self.native = None;
        }
        self.visible = false;
        self.bounds = None;
    }
    #[cfg(target_os = "macos")]
    fn mount(&mut self, window: &Window) -> wry::Result<()> {
        use wry::WebViewBuilderExtDarwin as _;
        let crashed_events = self.events.clone();
        let nav = self.navigation.clone();
        let nav_events = self.events.clone();
        let popup_events = self.events.clone();
        let title_events = self.events.clone();
        let page_events = self.events.clone();
        let page_navigation = self.navigation.clone();
        let download_events = self.events.clone();
        let download_dir = self.download_dir.clone();
        let browser = matches!(self.navigation, Navigation::Browser);
        let mut builder = wry::WebViewBuilder::new()
            .with_url(&self.url)
            .with_visible(false)
            .with_focused(false)
            .with_incognito(!browser)
            .with_navigation_handler(move |url| {
                let allowed = nav.allows(&url);
                if allowed {
                    if browser {
                        let _ = nav_events.send(WebEvent::Location(url));
                    }
                } else if fv_core::safe_web_url(&url).is_some() {
                    let _ = nav_events.send(WebEvent::External(url));
                }
                allowed
            })
            .with_new_window_req_handler(move |url, _| {
                if let Some(url) = fv_core::safe_web_url(&url) {
                    let _ = popup_events.send(if browser {
                        WebEvent::Popup(url)
                    } else {
                        WebEvent::External(url)
                    });
                }
                wry::NewWindowResponse::Deny
            })
            .with_document_title_changed_handler(move |title| {
                let _ = title_events.send(WebEvent::Title(title.chars().take(256).collect()));
            })
            .with_on_page_load_handler(move |event, url| {
                if !browser
                    && matches!(event, wry::PageLoadEvent::Finished)
                    && page_navigation.allows(&url)
                {
                    let _ = page_events.send(WebEvent::DocumentReady);
                }
                if browser {
                    let _ = page_events.send(WebEvent::Location(url));
                }
                let _ = page_events.send(WebEvent::Loading(matches!(
                    event,
                    wry::PageLoadEvent::Started
                )));
            })
            .with_download_started_handler(move |_, path| {
                let Some(dir) = download_dir.as_ref() else {
                    return false;
                };
                if std::fs::create_dir_all(dir).is_err() {
                    let _ = download_events.send(WebEvent::Notice("无法创建下载目录".into()));
                    return false;
                }
                let name = path
                    .file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new("download"));
                *path = dir.join(name);
                let _ = download_events
                    .send(WebEvent::Notice(format!("已开始下载：{}", path.display())));
                true
            })
            .with_permission_handler(|_| wry::PermissionResponse::Deny)
            .with_on_web_content_process_terminate_handler(move || {
                let _ = crashed_events.send(WebEvent::Crashed);
            });
        if !browser {
            builder = builder.with_initialization_script(
                "window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;",
            );
        }
        self.native = Some(builder.build_as_child(window)?);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::{point, px, size};
    #[test]
    fn addresses_preserve_custom_ports_and_queries_without_allowing_local_file_or_script_schemes() {
        assert_eq!(
            address("localhost:5173/a?q=中文").unwrap(),
            "http://localhost:5173/a?q=%E4%B8%AD%E6%96%87"
        );
        assert_eq!(address("example.com/a").unwrap(), "https://example.com/a");
        assert!(
            address("native app docs")
                .unwrap()
                .contains("q=native+app+docs")
        );
        assert_eq!(
            address_with_search("native app docs", "https://search.example/?q={query}").unwrap(),
            "https://search.example/?q=native+app+docs"
        );
        assert!(address_with_search("docs", "https://example.com/search").is_err());
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "https://user:secret@example.com",
        ] {
            assert!(address(url).is_err());
        }
    }
    #[test]
    fn document_navigation_cannot_turn_into_a_browser_or_an_arbitrary_loopback_request() {
        let nav = Navigation::Document("http://127.0.0.1:1234/token/".into());
        assert!(nav.allows("http://127.0.0.1:1234/token/#section"));
        for bad in [
            "http://127.0.0.1:1234/other/",
            "http://localhost:1234/token/",
            "https://example.com",
            "file:///tmp/a",
        ] {
            assert!(!nav.allows(bad));
        }
        assert!(!Navigation::Browser.allows("file:///tmp/a"));
    }
    #[test]
    fn clipped_or_nonfinite_native_views_are_hidden_instead_of_covering_the_app() {
        let clip = Bounds::new(point(px(10.), px(20.)), size(px(300.), px(200.)));
        assert!(fully_visible(clip, clip));
        assert!(!fully_visible(
            Bounds::new(point(px(9.), px(20.)), clip.size),
            clip
        ));
        assert!(!fully_visible(
            Bounds::new(clip.origin, size(px(f32::NAN), px(100.))),
            clip
        ));
    }
}
