//! Pictures a tool returned, drawn on the row of the call that returned them.
//!
//! `Item::Image` carries bounded base64 (the store keeps the file and the protocol carries the
//! bytes), so a picture is decoded once and kept as an `Arc<Image>` — the element hashes its bytes
//! on construction, and decoding on every frame would hash a megabyte per picture per frame.
//!
//! Nothing is drawn large in the transcript: the call's row already names the file, and the strip
//! under it is a thumbnail. A click opens the viewer over the whole window, which is the one place
//! a picture is shown at size.

use std::sync::Arc;

use base64::Engine as _;
use fv_theme::Token;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::Workspace;
use crate::ui::px;

/// 64×48 at the 16px root, the same box the Electron strip uses (`h-9`, `w-12`/`w-14`).
const THUMB_W: f32 = 64.0;
const THUMB_H: f32 = 48.0;

fn format_of(mime: &str) -> Option<ImageFormat> {
    match mime {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/webp" => Some(ImageFormat::Webp),
        "image/gif" => Some(ImageFormat::Gif),
        "image/svg+xml" => Some(ImageFormat::Svg),
        "image/bmp" => Some(ImageFormat::Bmp),
        "image/tiff" => Some(ImageFormat::Tiff),
        "image/ico" => Some(ImageFormat::Ico),
        _ => None,
    }
}

fn decode(mime: &str, data: &str) -> Option<Arc<Image>> {
    let format = format_of(mime)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}

impl Workspace {
    /// The picture as something `img()` can paint, decoded at most once per item.
    pub(super) fn decoded_image(&self, id: &str, mime: &str, data: &str) -> Option<Arc<Image>> {
        if let Some(cached) = self.pictures.borrow().get(id) {
            return cached.clone();
        }
        let decoded = decode(mime, data);
        self.pictures
            .borrow_mut()
            .insert(id.to_string(), decoded.clone());
        decoded
    }

    /// The thumbnails of every picture these calls returned, in call order. `key` keeps the
    /// element ids unique per row, so two calls in one reply never share one.
    pub(super) fn picture_strip(
        &self,
        pictures: Option<&[&fv_protocol::types::Item]>,
        key: &str,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        let pictures = pictures.filter(|pictures| !pictures.is_empty())?;
        let p = &self.palette;
        let mut strip = div().flex().flex_wrap().items_center().gap(px(6.0));
        for (index, item) in pictures.iter().enumerate() {
            let fv_protocol::types::Item::Image {
                id,
                name,
                mime,
                data,
            } = item
            else {
                continue;
            };
            let Some(image) = self.decoded_image(id, mime, data) else {
                continue;
            };
            let label = if name.trim().is_empty() {
                mime.clone()
            } else {
                name.clone()
            };
            let open_name = label.clone();
            let open_image = image.clone();
            strip = strip.child(
                div()
                    .id(SharedString::from(format!("picture-{key}-{index}")))
                    .w(px(THUMB_W))
                    .h(px(THUMB_H))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(p.c(Token::Border))
                    .bg(p.c(Token::Muted).opacity(0.4))
                    .cursor_pointer()
                    .tooltip({
                        let label = label.clone();
                        move |window, cx| {
                            gpui_kit::component::tooltip::Tooltip::new(label.clone())
                                .build(window, cx)
                        }
                    })
                    .child(
                        img(ImageSource::Image(image))
                            .size_full()
                            .object_fit(ObjectFit::Cover),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.open_picture(open_name.clone(), open_image.clone(), cx)
                    })),
            );
        }
        Some(strip)
    }

    fn open_picture(&mut self, name: String, image: Arc<Image>, cx: &mut Context<Self>) {
        self.image_view = Some((name, image));
        cx.notify();
    }

    /// The viewer: the window, dimmed, one picture at size. A press anywhere puts it away, as does
    /// Escape (`on_dismiss`).
    pub(super) fn image_view_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (name, image) = self.image_view.clone()?;
        Some(
            div()
                .id("image-viewer")
                .absolute()
                .inset_0()
                .occlude()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(12.0))
                .bg(hsla(0.0, 0.0, 0.0, 0.86))
                .cursor_pointer()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.image_view = None;
                    cx.notify();
                }))
                .child(
                    img(ImageSource::Image(image))
                        .max_w(relative(0.9))
                        .max_h(relative(0.82))
                        .object_fit(ObjectFit::Contain),
                )
                .child(
                    div()
                        .max_w(relative(0.9))
                        .truncate()
                        .text_size(px(crate::ui::TEXT_SM))
                        .text_color(hsla(0.0, 0.0, 1.0, 0.9))
                        .child(SharedString::from(name)),
                )
                .child(
                    div()
                        .text_size(px(crate::ui::TEXT_XS))
                        .text_color(hsla(0.0, 0.0, 1.0, 0.5))
                        .child(SharedString::from(if self.english() {
                            "Press anywhere or Esc to close"
                        } else {
                            "点任意处或按 Esc 关闭"
                        })),
                )
                .into_any_element(),
        )
    }
}
