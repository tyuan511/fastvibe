use std::sync::Arc;

use base64::Engine as _;
use futures_util::future::BoxFuture;
use fv_agent::{Tool, ToolCtx, ToolOutput, ToolSpec};
use fv_core::{ImagePart, ImageSource};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{Connection, REQUEST_TIMEOUT, resource_list, resource_read};

pub(crate) fn tool_name(server: &str, name: &str) -> String {
    let original = format!("mcp_{server}_{name}");
    let safe: String = original
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe == original && safe.len() <= 64 {
        return safe;
    }
    let digest = format!("{:x}", Sha256::digest(original.as_bytes()));
    format!("{}_{:.10}", &safe[..safe.len().min(53)], digest)
}

pub(crate) struct McpTool {
    pub connection: Arc<Connection>,
    pub tool: rmcp::model::Tool,
}

impl Tool for McpTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: tool_name(&self.connection.config.id, &self.tool.name),
            description: format!(
                "{} / {}: {}",
                self.connection.config.name,
                self.tool.name,
                self.tool.description.as_deref().unwrap_or("MCP tool")
            ),
            schema: serde_json::to_value(&self.tool.input_schema).expect("MCP schema serializes"),
        }
    }

    fn deferred(&self) -> bool {
        self.connection.config.deferred
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let connection = self.connection.clone();
        let name = self.tool.name.to_string();
        Box::pin(async move {
            let Some(arguments) = arguments.as_object().cloned() else {
                return ToolOutput::err("MCP 工具参数必须是对象");
            };
            let request = rmcp::model::CallToolRequestParams::new(name).with_arguments(arguments);
            let result = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => return ToolOutput::err("MCP 调用已停止"),
                result = tokio::time::timeout(REQUEST_TIMEOUT, connection.peer.call_tool(request)) => result,
            };
            let result = match result {
                Ok(Ok(result)) => result,
                Ok(Err(e)) => return ToolOutput::err(format!("MCP 调用失败：{e}")),
                Err(_) => return ToolOutput::err("MCP 调用超时"),
            };
            let failed = result.is_error.unwrap_or(false);
            match serde_json::to_value(result) {
                Ok(value) => output(value, failed, &ctx, &connection.output_dir).await,
                Err(e) => ToolOutput::err(e.to_string()),
            }
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) enum ResourceKind {
    List,
    Templates,
    Read,
}

pub(crate) struct ResourceTool {
    pub connections: Vec<Arc<Connection>>,
    pub output_dir: std::path::PathBuf,
    pub kind: ResourceKind,
}

impl Tool for ResourceTool {
    fn mutates(&self) -> bool {
        false
    }

    fn spec(&self) -> ToolSpec {
        let (name, description) = match self.kind {
            ResourceKind::List => (
                "list_mcp_resources",
                "List resources exposed by connected MCP servers. Pass server to restrict the list; pass its nextCursor to read another page.",
            ),
            ResourceKind::Templates => (
                "list_mcp_resource_templates",
                "List URI templates exposed by connected MCP servers. Read a concrete URI with read_mcp_resource.",
            ),
            ResourceKind::Read => (
                "read_mcp_resource",
                "Read a resource by its server id and URI returned by the MCP resource listing or URI template.",
            ),
        };
        ToolSpec {
            name: name.into(),
            description: description.into(),
            schema: match self.kind {
                ResourceKind::Read => {
                    json!({"type":"object","properties":{"server":{"type":"string"},"uri":{"type":"string"}},"required":["server","uri"],"additionalProperties":false})
                }
                _ => {
                    json!({"type":"object","properties":{"server":{"type":"string"},"cursor":{"type":"string"}},"additionalProperties":false})
                }
            },
        }
    }

    fn call(&self, ctx: ToolCtx, arguments: Value) -> BoxFuture<'static, ToolOutput> {
        let connections = self.connections.clone();
        let output_dir = self.output_dir.clone();
        let kind = self.kind;
        Box::pin(async move {
            let server = arguments.get("server").and_then(Value::as_str);
            let cursor = arguments
                .get("cursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            let work = async {
                match kind {
                    ResourceKind::Read => {
                        let Some(server) = server else {
                            return Err("请指定 server".into());
                        };
                        let Some(uri) = arguments.get("uri").and_then(Value::as_str) else {
                            return Err("请指定 uri".into());
                        };
                        let connection = connections
                            .iter()
                            .find(|c| c.config.id == server)
                            .ok_or_else(|| format!("MCP 服务器未连接：{server}"))?;
                        resource_read(connection, uri).await
                    }
                    _ => {
                        let mut rows = Vec::new();
                        let selected: Vec<_> = connections
                            .iter()
                            .filter(|c| server.is_none_or(|id| c.config.id == id))
                            .collect();
                        if server.is_some() && selected.is_empty() {
                            return Err("MCP 服务器未连接".into());
                        }
                        for connection in selected {
                            let result = resource_list(
                                connection,
                                matches!(kind, ResourceKind::Templates),
                                cursor.clone(),
                            )
                            .await?;
                            rows.push(json!({"server": connection.config.id, "result": result}));
                        }
                        Ok(json!({"servers": rows}))
                    }
                }
            };
            let result = tokio::select! { biased; _ = ctx.cancel.cancelled() => return ToolOutput::err("MCP 资源请求已停止"), result = work => result };
            match result {
                Ok(value) => output(value, false, &ctx, &output_dir).await,
                Err(e) => ToolOutput::err(e),
            }
        })
    }
}

/// Text remains bounded in the model request; full output is available on disk. Images stay
/// images, not base64 inside JSON prose, and use the engine's existing image persistence path.
async fn output(
    mut value: Value,
    failed: bool,
    ctx: &ToolCtx,
    dir: &std::path::Path,
) -> ToolOutput {
    let mut images = Vec::new();
    let mut artifacts_ok = extract_images(&mut value, &mut images, ctx.vision, dir).await;
    let full = serde_json::to_string_pretty(&value).unwrap_or_default();
    let content = if full.len() > 64 * 1024 {
        let saved = save_artifact(dir, "json", full.as_bytes()).await;
        let mut end = 64 * 1024;
        while !full.is_char_boundary(end) {
            end -= 1;
        }
        match saved {
            Ok(path) => format!(
                "{}\n\nOutput truncated. Full result: {}",
                &full[..end],
                path.display()
            ),
            Err(e) => {
                artifacts_ok = false;
                format!(
                    "{}\n\nOutput truncated; could not save the full result: {e}",
                    &full[..end]
                )
            }
        }
    } else {
        full
    };
    ToolOutput {
        content,
        is_error: failed || !artifacts_ok,
        images,
    }
}

/// Only skipped images need a separate file: attached images use the engine's normal
/// transcript/image store. Decode off the async runtime, and never discard an artifact just
/// because the selected model cannot see it or the attachment budget is exhausted.
fn extract_images<'a>(
    value: &'a mut Value,
    images: &'a mut Vec<ImagePart>,
    vision: bool,
    dir: &'a std::path::Path,
) -> BoxFuture<'a, bool> {
    Box::pin(async move {
        let mut ok = true;
        match value {
            Value::Object(object) => {
                let image = object.get("type").and_then(Value::as_str) == Some("image");
                let mime = object
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let field = if image { "data" } else { "blob" };
                if (image || mime.starts_with("image/"))
                    && let Some(data) = object.get(field).and_then(Value::as_str)
                {
                    let attach = vision && images.len() < 8 && data.len() < 12 * 1024 * 1024;
                    let replacement = if attach {
                        images.push(ImagePart {
                            mime,
                            source: ImageSource::Base64 {
                                data: data.to_string(),
                            },
                        });
                        "[image attached]".to_string()
                    } else {
                        let data = data.to_string();
                        let decoded = tokio::task::spawn_blocking(move || {
                            match base64::engine::general_purpose::STANDARD.decode(&data) {
                                Ok(bytes) => (bytes, false),
                                Err(_) => (data.into_bytes(), true),
                            }
                        })
                        .await;
                        let saved = match decoded {
                            Ok((bytes, invalid)) => {
                                let extension = if invalid {
                                    "base64.txt"
                                } else {
                                    match mime.as_str() {
                                        "image/png" => "png",
                                        "image/jpeg" => "jpg",
                                        "image/webp" => "webp",
                                        "image/gif" => "gif",
                                        "image/svg+xml" => "svg",
                                        "image/avif" => "avif",
                                        "image/bmp" => "bmp",
                                        _ => "bin",
                                    }
                                };
                                save_artifact(dir, extension, &bytes).await
                            }
                            Err(e) => Err(std::io::Error::other(e)),
                        };
                        match saved {
                            Ok(path) => format!(
                                "[image saved: {}; {}]",
                                path.display(),
                                if vision {
                                    "attachment budget exceeded"
                                } else {
                                    "this model does not accept images"
                                }
                            ),
                            Err(e) => {
                                ok = false;
                                format!("[could not preserve image: {e}]")
                            }
                        }
                    };
                    object.insert(field.into(), Value::String(replacement));
                }
                for item in object.values_mut() {
                    ok &= extract_images(item, images, vision, dir).await;
                }
            }
            Value::Array(items) => {
                for item in items {
                    ok &= extract_images(item, images, vision, dir).await;
                }
            }
            _ => (),
        }
        ok
    })
}

async fn save_artifact(
    dir: &std::path::Path,
    extension: &str,
    bytes: &[u8],
) -> std::io::Result<std::path::PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let path = dir.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).await?;
    use tokio::io::AsyncWriteExt;
    let result = async {
        file.write_all(bytes).await?;
        file.sync_all().await
    }
    .await;
    if let Err(error) = result {
        drop(file);
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(path)
}
