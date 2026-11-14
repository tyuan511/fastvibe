mod ui;

use gpui_kit::*;

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
            cx.new(|cx| ui::App::new(window, cx))
        })
        .expect("failed to open FastVibe window");
        cx.activate(true);
    });
}
