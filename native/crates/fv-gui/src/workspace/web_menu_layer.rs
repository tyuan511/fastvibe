//! A GPUI popup is a separate native child window, so its pixels and hit targets sit above
//! WKWebView. Raising a GPUI element's paint priority inside the host window cannot do that.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct HostedMenu {
    popup: AnyWindowHandle,
    pub(super) host: AnyWindowHandle,
}

struct MenuLayer {
    workspace: WeakEntity<Workspace>,
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    pub(super) fn sync_web_menu_layer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.browser_menu.is_none() {
            if let Some(layer) = self.web_menu_layer.take() {
                let _ = layer
                    .popup
                    .update(cx, |_, window, _| window.remove_window());
            }
            return;
        }
        if self.web_menu_layer.is_some() {
            return;
        }
        let workspace = cx.entity();
        let parent: AnyWindowHandle = window.window_handle();
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(window.bounds())),
            titlebar: None,
            kind: WindowKind::PopUp,
            focus: false,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        };
        match cx.open_window(options, |popup, cx| {
            mac::attach(window, popup);
            cx.new(|cx| {
                let changed =
                    cx.observe_in(&workspace, popup, |_: &mut MenuLayer, _, _, cx| cx.notify());
                let moved = cx.observe_window_bounds(window, |layer, _, cx| {
                    let _ = layer.workspace.update(cx, |this, cx| this.close_menus(cx));
                });
                let activation = cx.observe_window_activation(window, |layer, host, cx| {
                    if !host.is_window_active() {
                        let _ = layer.workspace.update(cx, |this, cx| this.close_menus(cx));
                    }
                });
                let released = cx.observe_release_in(&workspace, popup, |_, _, window, _| {
                    window.remove_window();
                });
                MenuLayer {
                    workspace: workspace.downgrade(),
                    _subscriptions: vec![changed, released, moved, activation],
                }
            })
        }) {
            Ok(layer) => {
                self.web_menu_layer = Some(HostedMenu {
                    popup: layer.into(),
                    host: parent,
                });
            }
            Err(error) => {
                eprintln!("browser menu layer: {error}");
                // Keep the page visible on failure rather than falling back to blanking it.
                self.browser_menu = None;
            }
        }
    }

    pub(super) fn open_browser_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Menu callbacks run in the popup window. Settings inputs/subscriptions belong to the host.
        if let Some(layer) = self.web_menu_layer {
            let workspace = cx.weak_entity();
            cx.defer(move |cx| {
                let _ = layer.host.update(cx, |_, window, cx| {
                    let _ = workspace.update(cx, |this, cx| {
                        this.open_settings(settings::Section::Browser, window, cx);
                    });
                });
            });
        } else {
            self.open_settings(settings::Section::Browser, window, cx);
        }
    }
}

impl Render for MenuLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.workspace
            .update(cx, |workspace, cx| {
                let catcher = deferred(
                    div()
                        .id("browser-menu-layer-catcher")
                        .absolute()
                        .inset_0()
                        .occlude()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| this.close_menus(cx)),
                        )
                        .on_mouse_down(
                            MouseButton::Right,
                            cx.listener(|this, _, _, cx| this.close_menus(cx)),
                        ),
                )
                .with_priority(5);
                div()
                    .size_full()
                    .font_family(crate::assets::UI_FONT)
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                        if event.keystroke.key == "escape" {
                            this.close_menus(cx);
                            cx.stop_propagation();
                        }
                    }))
                    .children(workspace.browser_menu_view(window, cx))
                    .child(catcher)
                    .into_any_element()
            })
            .unwrap_or_else(|_| div().into_any_element())
    }
}

#[allow(unexpected_cfgs)]
mod mac {
    use gpui_kit::Window;
    use objc::{msg_send, runtime::Object, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    pub(super) fn attach(host: &Window, popup: &Window) {
        let ns_window = |window: &Window| -> Option<*mut Object> {
            let handle = HasWindowHandle::window_handle(window).ok()?;
            let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
                return None;
            };
            let view = handle.ns_view.as_ptr() as *mut Object;
            Some(unsafe { msg_send![view, window] })
        };
        let (Some(host), Some(popup)) = (ns_window(host), ns_window(popup)) else {
            return;
        };
        unsafe {
            // Child windows follow the host through Spaces/fullscreen and cannot slip behind WKWebView.
            let level: isize = msg_send![host, level];
            let _: () = msg_send![popup, setLevel: level];
            let _: () = msg_send![popup, setHasShadow: false];
            let _: () = msg_send![host, addChildWindow: popup ordered: 1isize];
        }
    }
}
