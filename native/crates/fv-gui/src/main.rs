//! FastVibe, the desktop app.
//!
//!   cargo run -p fv-gui -- [--data-dir DIR] [--server-bin PATH] [--theme ID] [--dark]
//!       [--glass] [--open THREAD_ID] [--fixture theme|new] [--screenshot out.png]

use std::path::PathBuf;

use fv_gui::theme::{self, Palette};
use fv_gui::workspace::Workspace;
use fv_theme::Preferences;
use gpui_kit::*;

struct Args {
    prefs: Preferences,
    prefers_dark: bool,
    data_dir: PathBuf,
    server_bin: Option<PathBuf>,
    open: Option<String>,
    fixture: Option<String>,
    /// Dev only: `NAME,URL,KEY` of a provider to add through 设置 (see `script_add`).
    script_add: Option<String>,
    /// Dev only: start with the composer's model list open.
    model_menu: bool,
    /// Dev only: open every fold and tool call.
    expand: bool,
    /// Dev only: start with the ⌘K search open.
    palette: bool,
    /// Dev only: type this into the composer and send it, then capture.
    script_send: Option<String>,
    /// Dev only: `name|folder|folder…`, created through the dialog.
    script_project: Option<String>,
    /// Open 设置 at this section: `providers`, `add-provider`.
    settings: Option<String>,
    screenshot: Option<String>,
}

fn parse_args() -> Args {
    let mut a = Args {
        // Solid by default: the translucent look is opt-in until it is tuned.
        prefs: Preferences {
            glass: false,
            ..Preferences::default()
        },
        prefers_dark: false,
        data_dir: fv_daemon::default_data_dir(),
        server_bin: None,
        open: None,
        fixture: None,
        settings: None,
        script_add: None,
        model_menu: false,
        expand: false,
        palette: false,
        script_send: None,
        script_project: None,
        screenshot: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dark" => a.prefers_dark = true,
            "--glass" => a.prefs.glass = true,
            "--no-glass" => a.prefs.glass = false,
            "--theme" => {
                let id = it.next().expect("--theme needs an id");
                match fv_theme::seed(&id).map(|s| s.kind) {
                    Some(fv_theme::ThemeKind::Dark) => a.prefs.dark_theme = id,
                    Some(fv_theme::ThemeKind::Light) => a.prefs.light_theme = id,
                    None => panic!("unknown theme {id}"),
                }
            }
            "--data-dir" => a.data_dir = it.next().expect("--data-dir needs a path").into(),
            "--server-bin" => a.server_bin = it.next().map(Into::into),
            "--open" => a.open = it.next(),
            "--fixture" => a.fixture = it.next(),
            "--settings" => a.settings = it.next(),
            "--model-menu" => a.model_menu = true,
            "--expand" => a.expand = true,
            "--palette" => a.palette = true,
            "--script-send" => a.script_send = it.next(),
            "--script-project" => a.script_project = it.next(),
            "--script-add" => a.script_add = it.next(),
            "--screenshot" => a.screenshot = it.next(),
            other => panic!("unknown argument {other}"),
        }
    }
    a
}

fn main() {
    let args = parse_args();
    gpui_kit::application()
        .with_assets(fv_gui::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            fv_gui::assets::load_fonts(cx);
            fv_gui::workspace::bind_keys(cx);
            let palette = Palette::new(
                args.prefs
                    .resolve(args.prefers_dark, cfg!(target_os = "macos")),
            );
            theme::apply(&palette, cx);
            let glass = palette.glass();
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1100.0), px(720.0)),
                    cx,
                ))),
                titlebar: Some(TitlebarOptions {
                    title: Some("FastVibe".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(24.0), px(24.0))),
                }),
                window_background: if glass {
                    WindowBackgroundAppearance::Blurred
                } else {
                    WindowBackgroundAppearance::Opaque
                },
                ..Default::default()
            };
            let data_dir = args.data_dir.clone();
            let server_bin = args.server_bin.clone();
            let open = args.open.clone();
            let fixture = args.fixture.clone();
            let settings = args.settings.clone();
            let model_menu = args.model_menu;
            let expand = args.expand;
            let palette_open = args.palette;
            let (handle, workspace) = gpui_kit::open_window(options, cx, move |window, cx| {
                let ws = cx.new(|cx| {
                    match fixture.as_deref() {
                        Some("theme") => {
                            return Workspace::fixture(
                                palette,
                                fv_gui::fixture::theme_conversation(),
                                window,
                                cx,
                            );
                        }
                        Some("new") => {
                            return Workspace::fixture(
                                palette,
                                fv_gui::fixture::new_chat(),
                                window,
                                cx,
                            );
                        }
                        Some(other) => panic!("unknown fixture {other} (theme, new)"),
                        None => {}
                    }
                    let mut ws = Workspace::new(palette, data_dir, server_bin, window, cx);
                    if let Some(id) = open {
                        ws.open(id, cx);
                    }
                    ws
                });
                if palette_open {
                    ws.update(cx, |ws, cx| ws.show_palette(window, cx));
                }
                if expand {
                    ws.update(cx, |ws, cx| ws.expand_all(cx));
                }
                if model_menu {
                    ws.update(cx, |ws, cx| ws.show_model_menu(cx));
                }
                if let Some(section) = settings.as_deref() {
                    ws.update(cx, |ws, cx| ws.show_settings_named(section, window, cx));
                }
                ws
            })
            .expect("failed to open window");

            #[cfg(feature = "capture")]
            if let Some(spec) = args.script_project.clone() {
                let path = args
                    .screenshot
                    .clone()
                    .unwrap_or_else(|| "project.png".into());
                cx.spawn(async move |cx| {
                    wait(cx, 1500).await;
                    let _ = cx.update_window(handle, |_, window, cx| {
                        workspace.update(cx, |ws, cx| ws.script_project(&spec, window, cx))
                    });
                    wait(cx, 400).await;
                    let stem = path.trim_end_matches(".png").to_string();
                    capture(handle, &format!("{stem}-1.png"), cx).await;
                    workspace.update(cx, |ws, cx| ws.script_save_project(cx));
                    wait(cx, 1500).await;
                    capture(handle, &format!("{stem}-2.png"), cx).await;
                    cx.update(|cx| cx.quit());
                })
                .detach();
                return;
            }
            #[cfg(feature = "capture")]
            if let Some(text) = args.script_send.clone() {
                let path = args.screenshot.clone().unwrap_or_else(|| "send.png".into());
                cx.spawn(async move |cx| {
                    wait(cx, 1500).await;
                    let _ = cx.update_window(handle, |_, window, cx| {
                        workspace.update(cx, |ws, cx| ws.script_send(&text, window, cx))
                    });
                    wait(cx, 2500).await;
                    capture(handle, &path, cx).await;
                    cx.update(|cx| cx.quit());
                })
                .detach();
                return;
            }
            #[cfg(feature = "capture")]
            if let Some(spec) = args.script_add.clone() {
                let path = args.screenshot.clone().unwrap_or_else(|| "script".into());
                cx.spawn(async move |cx| script_add(handle, workspace, spec, path, cx).await)
                    .detach();
                return;
            }
            if let Some(path) = args.screenshot.clone() {
                cx.spawn(async move |cx| {
                    wait(cx, 2500).await;
                    capture(handle, &path, cx).await;
                    cx.update(|cx| cx.quit());
                })
                .detach();
            } else {
                let _ = (handle, workspace);
            }
        });
}

async fn wait(cx: &mut AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(std::time::Duration::from_millis(ms))
        .await;
}

/// Draw the window's current state and save it. The offscreen capture returns the last frame,
/// so a few frames are drawn first: one to apply pending updates, more to settle layout.
#[allow(unused_variables)]
async fn capture(handle: AnyWindowHandle, path: &str, cx: &mut AsyncApp) {
    #[cfg(feature = "capture")]
    {
        for _ in 0..3 {
            let _ = cx.update_window(handle, |_, window, cx| {
                let needed = window.draw(cx);
                needed.clear(cx);
            });
            wait(cx, 300).await;
        }
        match cx.update_window(handle, |_, window, _| window.render_to_image()) {
            Ok(Ok(img)) => {
                img.save(path).expect("write png");
                println!("captured {}x{} -> {path}", img.width(), img.height());
            }
            Ok(Err(e)) | Err(e) => eprintln!("capture failed: {e:#}"),
        }
    }
    #[cfg(not(feature = "capture"))]
    eprintln!("built without the `capture` feature");
}

/// `--script-add NAME,URL,KEY`: add a custom provider the way a person would, capturing the
/// model list it offers (`PATH-1.png`) and the provider once saved (`PATH-2.png`).
#[cfg(feature = "capture")]
async fn script_add(
    handle: AnyWindowHandle,
    ws: Entity<Workspace>,
    spec: String,
    path: String,
    cx: &mut AsyncApp,
) {
    let mut parts = spec.splitn(3, ',');
    let (name, url, key) = (
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("").to_string(),
        parts.next().unwrap_or("").to_string(),
    );
    wait(cx, 1500).await;
    let _ = cx.update_window(handle, |_, window, cx| {
        ws.update(cx, |ws, cx| {
            ws.script_add_custom_provider(&name, &url, &key, window, cx)
        })
    });
    let stem = path.trim_end_matches(".png").to_string();
    let mut picked = false;
    for _ in 0..50 {
        wait(cx, 100).await;
        picked = ws.update(cx, |ws, cx| ws.script_pick_all(cx));
        if picked {
            break;
        }
    }
    capture(handle, &format!("{stem}-1.png"), cx).await;
    if picked {
        ws.update(cx, |ws, cx| ws.script_finish_add(cx));
        wait(cx, 1500).await;
        let _ = cx.update_window(handle, |_, window, cx| {
            ws.update(cx, |ws, cx| ws.script_expand_first_provider(window, cx))
        });
        wait(cx, 500).await;
        capture(handle, &format!("{stem}-2.png"), cx).await;
    } else {
        eprintln!("script: no models were offered");
    }
    cx.update(|cx| cx.quit());
}
