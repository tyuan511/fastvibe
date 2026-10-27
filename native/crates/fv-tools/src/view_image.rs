// The tool's name, argument, description and refusal messages follow OpenAI Codex (codex-rs/
// core/src/tools/handlers/view_image.rs and view_image_spec.rs), Apache-2.0. See NOTICE.md.

use base64::Engine;
use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use fv_core::{ImagePart, ImageSource};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::paths::resolve;

const UNSUPPORTED: &str = "view_image is not allowed because you do not support image inputs";
const INVALID: &str = "unable to process image: invalid or unsupported image data";

const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Deserialize)]
struct Args {
    path: String,
    // Codex accepts a detail hint; there is nothing to choose here, so it is only tolerated.
    #[serde(default)]
    #[allow(dead_code)]
    detail: Option<String>,
}

/// Shows the model a picture from disk.
pub struct ViewImageTool;

impl Tool for ViewImageTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "view_image".into(),
            description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.".into(),
            schema: json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Local filesystem path to an image file."}
                },
                "required": ["path"],
                "additionalProperties": false
            }),
        }
    }

    fn mutates(&self) -> bool {
        false
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        Box::pin(async move {
            if !ctx.vision {
                return ToolOutput::err(UNSUPPORTED);
            }
            let args: Args = match serde_json::from_value(arguments) {
                Ok(a) => a,
                Err(e) => {
                    return ToolOutput::err(format!("failed to parse function arguments: {e}"));
                }
            };
            let path = match resolve(ctx.cwd.as_deref(), &args.path) {
                Ok(p) => p,
                Err(e) => return ToolOutput::err(e),
            };
            let shown = path.display().to_string();
            let meta = match tokio::fs::metadata(&path).await {
                Ok(m) => m,
                Err(e) => {
                    return ToolOutput::err(format!("unable to locate image at `{shown}`: {e}"));
                }
            };
            if !meta.is_file() {
                return ToolOutput::err(format!("image path `{shown}` is not a file"));
            }
            if meta.len() > MAX_FILE_BYTES {
                return ToolOutput::err(format!(
                    "image at `{shown}` is too large ({} MB)",
                    meta.len() / 1_000_000
                ));
            }
            let bytes = match tokio::fs::read(&path).await {
                Ok(b) => b,
                Err(e) => {
                    return ToolOutput::err(format!("unable to read image at `{shown}`: {e}"));
                }
            };
            // Decoding is CPU work and a screenshot can be large.
            let prepared = tokio::task::spawn_blocking(move || prepare(&bytes)).await;
            match prepared {
                Ok(Some(p)) => {
                    let text = describe(&p, &shown);
                    let image = ImagePart {
                        mime: p.mime.into(),
                        source: ImageSource::Base64 {
                            data: base64::engine::general_purpose::STANDARD.encode(&p.bytes),
                        },
                    };
                    ToolOutput::ok(text).with_images(vec![image])
                }
                _ => ToolOutput::err(INVALID),
            }
        })
    }
}

pub(crate) type Prepared = fv_core::image::PreparedImage;

fn describe(image: &Prepared, path: &str) -> String {
    let kb = image.bytes.len().div_ceil(1024);
    if image.original == image.sent {
        format!(
            "Image loaded: {path} ({}x{}, {kb} KB)",
            image.sent.0, image.sent.1
        )
    } else {
        format!(
            "Image loaded: {path} ({}x{}, shown to you scaled down to {}x{}, {kb} KB)",
            image.original.0, image.original.1, image.sent.0, image.sent.1
        )
    }
}

/// Check the bytes are a picture a provider accepts, and shrink one that is too big to send
/// again with every request. `None` when it is not an image.
pub(crate) fn prepare(bytes: &[u8]) -> Option<Prepared> {
    fv_core::image::prepare(bytes)
}
