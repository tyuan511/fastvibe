//! Shared preparation limits for images returned by tools.
//!
//! Keeping this in the protocol-independent core makes the transcript store, tools and
//! providers agree on the bytes that are persisted and sent to a model.

use image::{DynamicImage, GenericImageView, ImageFormat};

pub const IMAGE_MAX_EDGE: u32 = 1568;
pub const IMAGE_MAX_BYTES: usize = 512 * 1024;
pub const IMAGE_REQUEST_BUDGET: usize = 4 * 1024 * 1024;

#[derive(Debug)]
pub struct PreparedImage {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    pub original: (u32, u32),
    pub sent: (u32, u32),
}

fn mime_of(format: ImageFormat) -> Option<&'static str> {
    match format {
        ImageFormat::Png => Some("image/png"),
        ImageFormat::Jpeg => Some("image/jpeg"),
        ImageFormat::Gif => Some("image/gif"),
        ImageFormat::WebP => Some("image/webp"),
        _ => None,
    }
}

fn encode(img: &DynamicImage) -> Option<(&'static str, Vec<u8>)> {
    let mut out = std::io::Cursor::new(Vec::new());
    if img.color().has_alpha() {
        img.write_to(&mut out, ImageFormat::Png).ok()?;
        Some(("image/png", out.into_inner()))
    } else {
        let rgb = img.to_rgb8();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        rgb.write_with_encoder(encoder).ok()?;
        Some(("image/jpeg", out.into_inner()))
    }
}

/// Decode and shrink an image to the shared transcript/request limits.
pub fn prepare(bytes: &[u8]) -> Option<PreparedImage> {
    let format = image::guess_format(bytes).ok()?;
    let mime = mime_of(format)?;
    let img = image::load_from_memory_with_format(bytes, format).ok()?;
    let original = img.dimensions();
    if original.0.max(original.1) <= IMAGE_MAX_EDGE && bytes.len() <= IMAGE_MAX_BYTES {
        return Some(PreparedImage {
            mime,
            bytes: bytes.to_vec(),
            original,
            sent: original,
        });
    }

    // Start at the display limit, then reduce further if a noisy image still does not fit the
    // byte budget. The loop is bounded and always makes progress, including for small images.
    let mut current = if original.0.max(original.1) > IMAGE_MAX_EDGE {
        img.resize(
            IMAGE_MAX_EDGE,
            IMAGE_MAX_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    let mut encoded = encode(&current)?;
    for _ in 0..8 {
        if encoded.1.len() <= IMAGE_MAX_BYTES {
            break;
        }
        let (w, h) = current.dimensions();
        let next_w = ((w as f32 * 0.8).round() as u32)
            .max(1)
            .min(w.saturating_sub(1).max(1));
        let next_h = ((h as f32 * 0.8).round() as u32)
            .max(1)
            .min(h.saturating_sub(1).max(1));
        current = current.resize(next_w, next_h, image::imageops::FilterType::Triangle);
        encoded = encode(&current)?;
    }
    let sent = current.dimensions();
    Some(PreparedImage {
        mime: encoded.0,
        bytes: encoded.1,
        original,
        sent,
    })
}
