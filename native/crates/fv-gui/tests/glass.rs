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
fn floating_layers_hide_the_unblurred_transcript_in_both_modes() {
    for dark in [false, true] {
        for (layer, flag, x, y) in [
            ("menu", "--model-menu", 1008.0, 546.0),
            ("dialog", "--palette", 760.0, 220.0),
        ] {
            let path = std::env::temp_dir().join(format!(
                "fastvibe-overlay-{}-{dark}-{layer}.png",
                std::process::id()
            ));
            let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_fastvibe"));
            command.args(["--fixture", "theme", "--glass", flag]);
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
            // Empty interior pixels, away from labels, rims and hover fills. The old
            // Electron alpha without its backdrop blur let 5–8% of the page through.
            let pixel = image.get_pixel(
                (image.width() as f32 * x / 1100.0) as u32,
                (image.height() as f32 * y / 720.0) as u32,
            );
            let alpha = f32::from(pixel.0[3]) / 255.0;
            assert!(
                alpha >= 0.97,
                "{layer}, dark={dark}: alpha {alpha} leaves transcript text visible"
            );
        }
    }
}
