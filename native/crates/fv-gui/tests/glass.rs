//! Actual Metal compositing, including the component root. Requires a WindowServer.
#![cfg(all(target_os = "macos", feature = "capture"))]

use fv_theme::{Preferences, Token};

#[test]
#[ignore = "opens a macOS window; run with --features capture --test glass -- --ignored"]
fn translucent_layers_use_source_over_without_an_opaque_root_or_inner_shadow() {
    let path = std::env::temp_dir().join(format!("fastvibe-glass-{}.png", std::process::id()));
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_fastvibe"))
        .args(["--fixture", "theme", "--glass", "--screenshot"])
        .arg(&path)
        .output()
        .expect("start native glass fixture");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let image = image::open(&path)
        .expect("read captured Metal frame")
        .to_rgba8();
    let _ = std::fs::remove_file(path);
    let tokens = Preferences::default().resolve(false, true).tokens;
    let page = tokens.color(Token::Background).a;
    let over = |top: Token| {
        let a = tokens.color(top).a;
        a + page * (1.0 - a)
    };
    for (label, x, y, expected) in [
        ("page", 0.98, 0.50, page),
        ("sidebar", 0.07, 0.85, over(Token::GlassPane)),
        ("composer", 0.80, 0.89, over(Token::Card)),
    ] {
        let pixel = image.get_pixel(
            (image.width() as f32 * x) as u32,
            (image.height() as f32 * y) as u32,
        );
        let actual = f32::from(pixel.0[3]) / 255.0;
        assert!(
            (actual - expected).abs() < 0.015,
            "{label} alpha {actual}, expected source-over {expected}"
        );
        // These fixtures use white glass. Premultiplied RGB must equal alpha;
        // a hidden black root/shadow would darken it even with correct alpha.
        for rgb in &pixel.0[..3] {
            assert!(
                (f32::from(*rgb) / 255.0 - actual).abs() < 0.02,
                "{label} is tinted by an extra background: {pixel:?}"
            );
        }
    }
}

#[test]
#[ignore = "opens macOS windows; run with --features capture --test glass -- --ignored"]
fn floating_layers_carry_the_electron_fill_and_blur_the_transcript_in_both_modes() {
    let tokens = Preferences::default().resolve(false, true).tokens;
    let fill = tokens.color(Token::GlassOverlay).a;
    for dark in [false, true] {
        // An empty interior point of each floating layer, away from its own labels,
        // over transcript/settings text behind it.
        for (layer, args, x, y) in [
            (
                "dialog",
                ["--settings", "mcp-form"].as_slice(),
                520.0,
                250.0,
            ),
            ("menu", ["--model-menu"].as_slice(), 900.0, 546.0),
        ] {
            let path = std::env::temp_dir().join(format!(
                "fastvibe-overlay-{}-{dark}-{layer}.png",
                std::process::id()
            ));
            let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_fastvibe"));
            command.args(["--fixture", "theme", "--glass"]);
            command.args(args);
            if dark {
                command.arg("--dark");
            }
            let output = command
                .arg("--screenshot")
                .arg(&path)
                .output()
                .expect("start native overlay fixture");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let image = image::open(&path).expect("read Metal frame").to_rgba8();
            let _ = std::fs::remove_file(path);
            let pixel = image.get_pixel(
                (image.width() as f32 * x / 1100.0) as u32,
                (image.height() as f32 * y / 720.0) as u32,
            );
            let alpha = f32::from(pixel.0[3]) / 255.0;
            // The fill is Electron's `--glass-overlay` (84% dark / 90% light) over the
            // blurred backdrop it replaced: more opaque than that means the old
            // "hide the missing blur with alpha" hack is back, less means the fill
            // lost its token.
            // The backdrop under a dialog is the pane fill plus the modal's 18% veil,
            // so the interior lands a little above the fill alone; the old "hide the
            // missing blur with alpha" hack (96/98%) lands above even that ceiling.
            assert!(
                alpha >= fill - 0.02 && alpha <= fill + (1.0 - fill) * 0.85,
                "{layer}, dark={dark}: alpha {alpha} is not the {fill} glass-overlay \
                 fill over its blurred backdrop"
            );
            // And the backdrop really is blurred: sharp transcript text behind the
            // layer used to show through at 16/10% as readable ghosts (adjacent-pixel
            // jumps of ~30); a 28px blur leaves the interior flat.
            let row = (image.width() as f32 * x / 1100.0) as i32;
            let line = (image.height() as f32 * y / 720.0) as u32;
            let lum = |px: &image::Rgba<u8>| {
                i32::from(px.0[0]) * 299 + i32::from(px.0[1]) * 587 + i32::from(px.0[2]) * 114
            };
            let mut sharpest = 0;
            for sx in (row - 80..row + 80).step_by(2) {
                if sx < 0 || sx + 2 >= image.width() as i32 {
                    continue;
                }
                let step = (lum(image.get_pixel(sx as u32, line))
                    - lum(image.get_pixel(sx as u32 + 2, line)))
                .abs()
                    / 1000;
                sharpest = sharpest.max(step);
            }
            assert!(
                sharpest <= 8,
                "{layer}, dark={dark}: sharpest interior step {sharpest} — the page \
                 behind is not blurred"
            );
        }
    }
}
