//! FastVibe, the desktop app.
//!
//!   cargo run -p fv-gui -- [--data-dir DIR] [--server-bin PATH] [--theme ID] [--dark]
//!       [--no-glass] [--open THREAD_ID] [--screenshot out.png]

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
    screenshot: Option<String>,
}

fn parse_args() -> Args {
    let mut a = Args {
        prefs: Preferences::default(),
        prefers_dark: false,
        data_dir: fv_daemon::default_data_dir(),
        server_bin: None,
        open: None,
        screenshot: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dark" => a.prefers_dark = true,
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
            "--screenshot" => a.screenshot = it.next(),
            other => panic!("unknown argument {other}"),
        }
    }
    a
}

fn main() {
    let args = parse_args();
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
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
        let (handle, _) = gpui_kit::open_window(options, cx, move |window, cx| {
            cx.new(|cx| {
                let mut ws = Workspace::new(palette, data_dir, server_bin, window, cx);
                if let Some(id) = open {
                    ws.open(id, cx);
                }
                ws
            })
        })
        .expect("failed to open window");

        if let Some(path) = args.screenshot.clone() {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(2500))
                    .await;
                #[cfg(feature = "capture")]
                {
                    let _ = cx.update_window(handle, |_, window, cx| {
                        let needed = window.draw(cx);
                        needed.clear(cx);
                    });
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(300))
                        .await;
                    let _ = cx.update_window(handle, |_, window, cx| {
                        let needed = window.draw(cx);
                        needed.clear(cx);
                    });
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(300))
                        .await;
                    let _ = cx.update_window(handle, |_, window, cx| {
                        let needed = window.draw(cx);
                        needed.clear(cx);
                    });
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(300))
                        .await;
                    let image = cx.update_window(handle, |_, window, _| window.render_to_image());
                    match image {
                        Ok(Ok(img)) => {
                            img.save(&path).expect("write png");
                            println!("captured {}x{} -> {path}", img.width(), img.height());
                        }
                        Ok(Err(e)) | Err(e) => eprintln!("capture failed: {e:#}"),
                    }
                }
                #[cfg(not(feature = "capture"))]
                {
                    let _ = (&handle, &path);
                    eprintln!("built without the `capture` feature");
                }
                cx.update(|cx| cx.quit());
            })
            .detach();
        } else {
            let _ = handle;
        }
    });
}
