//! Spike: a GPUI window painted from `fv-theme` tokens, to settle three questions before
//! the real UI is built on it — does the native blur work with a themed translucent page,
//! is the window shadow kept, and can a frame be captured off-screen for visual regression.
//!
//!   cargo run -p fv-gui --features capture -- [--theme ID] [--dark] [--no-glass] [--screenshot out.png]

use fv_theme::{ActiveTheme, Preferences, Token};
use gpui_kit::component::button::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

fn paint(c: fv_theme::Color) -> Rgba {
    Rgba {
        r: f32::from(c.r) / 255.0,
        g: f32::from(c.g) / 255.0,
        b: f32::from(c.b) / 255.0,
        a: c.a,
    }
}

struct Showcase {
    theme: ActiveTheme,
}

impl Showcase {
    fn c(&self, token: Token) -> Rgba {
        paint(self.theme.tokens.color(token))
    }

    fn maybe(&self, token: Token) -> Option<Rgba> {
        self.theme.tokens.get(token).map(paint)
    }
}

impl Render for Showcase {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let pane = self
            .maybe(Token::GlassPane)
            .unwrap_or_else(|| self.c(Token::Sidebar));
        let row = |label: &'static str, selected: bool| {
            div()
                .h(px(32.0))
                .px(px(12.0))
                .flex()
                .items_center()
                .rounded(px(8.0))
                .text_size(px(14.0))
                .text_color(self.c(Token::SidebarForeground))
                .when(selected, |d| d.bg(self.c(Token::SidebarAccent)))
                .child(label)
        };
        div()
            .size_full()
            .bg(self.c(Token::Background))
            .p(px(8.0))
            .flex()
            .gap(px(8.0))
            .child(
                div()
                    .w(px(260.0))
                    .h_full()
                    .rounded(px(16.0))
                    .bg(pane)
                    .border_1()
                    .border_color(self.c(Token::SidebarBorder))
                    .pt(px(44.0))
                    .px(px(8.0))
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(row("FastVibe", false))
                    .child(row("Refactor the importer", true))
                    .child(row("Fix flaky checkpoint test", false))
                    .child(row("Release notes for v0.22", false)),
            )
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .rounded(px(16.0))
                    .bg(self
                        .maybe(Token::GlassPane)
                        .unwrap_or_else(|| self.c(Token::Card)))
                    .border_1()
                    .border_color(self.c(Token::Border))
                    .p(px(24.0))
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    .child(
                        div()
                            .text_size(px(14.0))
                            .text_color(self.c(Token::Foreground))
                            .child(
                                "Native shell spike: themed translucent panes over the macOS blur.",
                            ),
                    )
                    .child(
                        div()
                            .rounded(px(10.0))
                            .p(px(12.0))
                            .bg(self.c(Token::CodeBg))
                            .text_size(px(13.0))
                            .text_color(self.c(Token::CodeKeyword))
                            .child("fn main() { println!(\"hello\"); }"),
                    )
                    .child(Button::new("go").primary().label("Send")),
            )
    }
}

struct Args {
    prefs: Preferences,
    prefers_dark: bool,
    screenshot: Option<String>,
}

fn parse_args() -> Args {
    let mut prefs = Preferences::default();
    let mut prefers_dark = false;
    let mut screenshot = None;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dark" => prefers_dark = true,
            "--no-glass" => prefs.glass = false,
            "--theme" => {
                let id = it.next().expect("--theme needs an id");
                match fv_theme::seed(&id).map(|s| s.kind) {
                    Some(fv_theme::ThemeKind::Dark) => prefs.dark_theme = id,
                    Some(fv_theme::ThemeKind::Light) => prefs.light_theme = id,
                    None => panic!("unknown theme {id}"),
                }
            }
            "--screenshot" => screenshot = it.next(),
            other => panic!("unknown argument {other}"),
        }
    }
    Args {
        prefs,
        prefers_dark,
        screenshot,
    }
}

fn main() {
    let args = parse_args();
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let theme = args
            .prefs
            .resolve(args.prefers_dark, cfg!(target_os = "macos"));
        let glass = theme.tokens.get(Token::GlassPane).is_some();
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(960.0), px(640.0)),
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
        let (handle, _) =
            gpui_kit::open_window(options, cx, |_, cx| cx.new(|_| Showcase { theme }))
                .expect("failed to open window");

        if let Some(path) = args.screenshot.clone() {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(800))
                    .await;
                #[cfg(feature = "capture")]
                {
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
        }
    });
}
