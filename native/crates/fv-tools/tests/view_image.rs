use std::path::Path;

use base64::Engine;
use fv_agent::{Tool, ToolCtx, ToolOutput};
use fv_core::ImageSource;
use fv_tools::ViewImageTool;
use image::{ImageBuffer, ImageFormat, Rgb, Rgba};
use serde_json::json;
use tokio_util::sync::CancellationToken;

async fn view(cwd: Option<&Path>, path: &str, vision: bool) -> ToolOutput {
    let mut ctx = ToolCtx::new(CancellationToken::new(), cwd.map(Path::to_path_buf));
    ctx.vision = vision;
    ViewImageTool.call(ctx, json!({ "path": path })).await
}

fn decode(out: &ToolOutput) -> (String, image::DynamicImage) {
    assert_eq!(out.images.len(), 1, "{}", out.content);
    let ImageSource::Base64 { data } = &out.images[0].source else {
        panic!("not inline")
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap();
    (
        out.images[0].mime.clone(),
        image::load_from_memory(&bytes).unwrap(),
    )
}

/// A picture with detail, so that it does not compress to nothing.
fn noisy_rgb(w: u32, h: u32) -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    ImageBuffer::from_fn(w, h, |x, y| {
        Rgb([
            (x * 7 % 251) as u8,
            (y * 13 % 241) as u8,
            ((x ^ y) % 256) as u8,
        ])
    })
}

#[tokio::test]
async fn a_small_picture_is_sent_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("small.png");
    ImageBuffer::from_pixel(4, 3, Rgba([255u8, 0, 0, 255]))
        .save(&path)
        .unwrap();
    let original = std::fs::read(&path).unwrap();

    let out = view(Some(dir.path()), "small.png", true).await;
    assert!(!out.is_error, "{}", out.content);
    assert!(
        out.content.contains("small.png") && out.content.contains("(4x3,"),
        "{}",
        out.content
    );
    let (mime, img) = decode(&out);
    assert_eq!(
        (mime.as_str(), img.width(), img.height()),
        ("image/png", 4, 3)
    );
    // Not re-encoded: the bytes are the file's own.
    let ImageSource::Base64 { data } = &out.images[0].source else {
        unreachable!()
    };
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap(),
        original
    );
}

#[tokio::test]
async fn a_large_picture_is_scaled_down_and_the_model_is_told() {
    let dir = tempfile::tempdir().unwrap();
    noisy_rgb(3200, 2000)
        .save_with_format(dir.path().join("big.png"), ImageFormat::Png)
        .unwrap();
    let out = view(Some(dir.path()), "big.png", true).await;
    assert!(!out.is_error, "{}", out.content);
    assert!(
        out.content.contains("3200x2000") && out.content.contains("scaled down to 1568x980"),
        "{}",
        out.content
    );
    let (mime, img) = decode(&out);
    assert_eq!(
        mime, "image/jpeg",
        "no transparency to keep, so a lighter format"
    );
    assert_eq!((img.width(), img.height()), (1568, 980));
}

#[tokio::test]
async fn a_large_picture_with_transparency_stays_png() {
    let dir = tempfile::tempdir().unwrap();
    ImageBuffer::from_fn(2400, 1200, |x, y| {
        Rgba([(x % 255) as u8, (y % 255) as u8, 0, 128u8])
    })
    .save(dir.path().join("a.png"))
    .unwrap();
    let out = view(Some(dir.path()), "a.png", true).await;
    let (mime, img) = decode(&out);
    assert_eq!(mime, "image/png");
    assert_eq!(img.width(), 1568);
}

#[tokio::test]
async fn things_that_are_not_pictures_are_refused_in_codexs_words() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("notes.png"),
        "this is text, whatever the name says",
    )
    .unwrap();
    std::fs::create_dir(dir.path().join("folder")).unwrap();
    let d = Some(dir.path());

    let out = view(d, "notes.png", true).await;
    assert!(out.is_error && out.images.is_empty());
    assert_eq!(
        out.content,
        "unable to process image: invalid or unsupported image data"
    );
    assert!(
        view(d, "folder", true)
            .await
            .content
            .contains("is not a file")
    );
    assert!(
        view(d, "nope.png", true)
            .await
            .content
            .contains("unable to locate image at")
    );
    assert!(
        view(None, "x.png", true)
            .await
            .content
            .contains("no working directory")
    );
}

#[tokio::test]
async fn a_model_that_cannot_see_is_not_sent_pictures() {
    let dir = tempfile::tempdir().unwrap();
    ImageBuffer::from_pixel(2, 2, Rgb([1u8, 2, 3]))
        .save(dir.path().join("p.png"))
        .unwrap();
    let out = view(Some(dir.path()), "p.png", false).await;
    assert!(out.is_error && out.images.is_empty());
    assert_eq!(
        out.content,
        "view_image is not allowed because you do not support image inputs"
    );
}
