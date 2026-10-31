//! Bounded SSH media transfer. A remote path is never opened on the desktop filesystem.
use super::*;
use base64::Engine as _;
use std::path::PathBuf;

pub(super) struct RemotePreview {
    generation: String,
    path: Option<CachedFile>,
    error: Option<String>,
    transfer: Option<tokio::task::AbortHandle>,
}
impl Drop for RemotePreview {
    fn drop(&mut self) {
        if let Some(transfer) = self.transfer.take() {
            transfer.abort();
        }
    }
}
struct CachedFile(PathBuf);
impl Drop for CachedFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
impl Workspace {
    pub(super) fn remote_media_body(
        &mut self,
        path: &str,
        mime: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let thread = self.selected.clone().unwrap_or_else(|| "__draft__".into());
        let key = format!("{thread}\n{path}");
        // Only the visible media preview is cached per host window: at most 256 MiB,
        // including an in-flight transfer. Navigating away cancels and removes the old file.
        self.remote_previews.retain(|owner, _| owner == &key);
        if !self.remote_previews.contains_key(&key) {
            let Some(backend) = self.backend.clone() else {
                return div().into_any_element();
            };
            let generation = uuid::Uuid::new_v4().to_string();
            self.remote_previews.insert(
                key.clone(),
                RemotePreview {
                    generation: generation.clone(),
                    path: None,
                    error: None,
                    transfer: None,
                },
            );
            let target = std::env::temp_dir().join(format!("fastvibe-ssh-preview-{generation}"));
            let path = path.to_string();
            let worker = backend.clone();
            let task = backend.task(async move {
                let cache = CachedFile(target);
                download(&worker, &thread, &path, &cache.0).await?;
                Ok::<_, String>(cache)
            });
            self.remote_previews.get_mut(&key).unwrap().transfer = Some(task.abort_handle());
            let update_key = key.clone();
            cx.spawn(async move |this, cx| {
                let result = task.await.map_err(|e| e.to_string()).and_then(|r| r);
                let _ = this.update(cx, |this, cx| {
                    if let Some(view) = this
                        .remote_previews
                        .get_mut(&update_key)
                        .filter(|v| v.generation == generation)
                    {
                        view.transfer = None;
                        match result {
                            Ok(path) => view.path = Some(path),
                            Err(error) => view.error = Some(error),
                        }
                    }
                    cx.notify();
                });
            })
            .detach();
        }
        let preview = self.remote_previews.get(&key).unwrap();
        if let Some(path) = &preview.path {
            let path = path.0.display().to_string();
            return self.document_body(&path, None, Some(mime), None, cx);
        }
        let text = preview
            .error
            .clone()
            .unwrap_or_else(|| trs!(self.english(), "ssh.media_loading").into());
        div()
            .p(px(16.))
            .text_size(px(crate::ui::TEXT_SM))
            .child(text)
            .into_any_element()
    }

    pub(super) fn invalidate_remote_preview(&mut self, path: &str) {
        let thread = self.selected.as_deref().unwrap_or("__draft__");
        self.remote_previews.remove(&format!("{thread}\n{path}"));
    }
}

async fn download(
    backend: &Backend,
    thread: &str,
    path: &str,
    target: &std::path::Path,
) -> Result<(), String> {
    use fv_protocol::remote::ReadFileParams;
    download_with(target, |offset, length| {
        let call = backend.call::<WorkspaceReadFile>(ReadFileParams {
            thread_id: thread.into(),
            path: path.into(),
            offset,
            length,
        });
        async move { call.await.map_err(|e| e.to_string()) }
    })
    .await
}

async fn download_with<F, C>(target: &std::path::Path, mut read: F) -> Result<(), String>
where
    F: FnMut(u64, u32) -> C,
    C: std::future::Future<Output = Result<fv_protocol::remote::FileChunk, String>>,
{
    use tokio::io::AsyncWriteExt as _;
    const CHUNK: u32 = 512 * 1024;
    const MAX: u64 = 256 * 1024 * 1024;
    let metadata = tokio::time::timeout(std::time::Duration::from_secs(30), read(0, 0))
        .await
        .map_err(|_| "Remote preview metadata timed out".to_string())?
        .map_err(|e| e.to_string())?;
    if metadata.size > MAX {
        return Err("Remote preview exceeds 256 MiB".into());
    }
    if metadata.offset != 0 || !metadata.data.is_empty() || metadata.eof != (metadata.size == 0) {
        return Err("Invalid remote preview metadata".into());
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true).mode(0o600);
    let mut output = options.open(target).await.map_err(|e| e.to_string())?;
    let mut offset = 0u64;
    while offset < metadata.size {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(30), read(offset, CHUNK))
            .await
            .map_err(|_| "Remote preview transfer timed out".to_string())?
            .map_err(|e| e.to_string())?;
        let bytes = decode_chunk(&metadata, &chunk, offset)?;
        output.write_all(&bytes).await.map_err(|e| e.to_string())?;
        offset += bytes.len() as u64;
    }
    output.flush().await.map_err(|e| e.to_string())
}

fn decode_chunk(
    metadata: &fv_protocol::remote::FileChunk,
    chunk: &fv_protocol::remote::FileChunk,
    offset: u64,
) -> Result<Vec<u8>, String> {
    if chunk.data.len() > (512 * 1024_u64).div_ceil(3) as usize * 4 {
        return Err("Remote file chunk is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&chunk.data)
        .map_err(|e| e.to_string())?;
    let end = offset
        .checked_add(bytes.len() as u64)
        .ok_or("Invalid remote file offset")?;
    if chunk.offset != offset
        || chunk.size != metadata.size
        || chunk.mtime_ms != metadata.mtime_ms
        || bytes.is_empty()
        || bytes.len() > 512 * 1024
        || end > metadata.size
        || chunk.eof != (end == metadata.size)
    {
        return Err(
            "Remote file changed or an invalid file chunk was received; refresh the preview".into(),
        );
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{CachedFile, decode_chunk, download_with};
    use base64::Engine as _;
    use fv_protocol::remote::FileChunk;
    #[tokio::test]
    async fn downloads_multiple_chunks_and_empty_file_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        for bytes in [Vec::new(), vec![47u8; 512 * 1024 + 17]] {
            let target = dir.path().join(format!("media-{}", bytes.len()));
            let content = bytes.clone();
            download_with(&target, |offset, length| {
                assert!(length <= 512 * 1024);
                let end = (offset as usize + length as usize).min(content.len());
                std::future::ready(Ok(FileChunk {
                    size: content.len() as u64,
                    mtime_ms: 9,
                    offset,
                    data: base64::engine::general_purpose::STANDARD
                        .encode(&content[offset as usize..end]),
                    eof: end == content.len(),
                }))
            })
            .await
            .unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), bytes);
            assert_eq!(
                std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn cancelling_transfer_removes_partial_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial");
        let worker_path = path.clone();
        let task = tokio::spawn(async move {
            let cache = CachedFile(worker_path);
            download_with(&cache.0, |_, length| async move {
                if length == 0 {
                    Ok(FileChunk {
                        size: 10,
                        mtime_ms: 2,
                        offset: 0,
                        data: String::new(),
                        eof: false,
                    })
                } else {
                    std::future::pending().await
                }
            })
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !path.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        assert!(!path.exists());
    }
    #[test]
    fn rejects_changed_misordered_truncated_and_oversized_chunks() {
        let metadata = FileChunk {
            size: 6,
            mtime_ms: 10,
            offset: 0,
            data: String::new(),
            eof: false,
        };
        let first = FileChunk {
            data: "YWJj".into(),
            ..metadata.clone()
        };
        assert_eq!(decode_chunk(&metadata, &first, 0).unwrap(), b"abc");
        let last = FileChunk {
            offset: 3,
            data: "ZGVm".into(),
            eof: true,
            ..metadata.clone()
        };
        assert_eq!(decode_chunk(&metadata, &last, 3).unwrap(), b"def");
        for invalid in [
            FileChunk {
                mtime_ms: 11,
                ..first.clone()
            },
            FileChunk {
                offset: 1,
                ..first.clone()
            },
            FileChunk {
                size: 7,
                ..first.clone()
            },
            FileChunk {
                eof: true,
                ..first.clone()
            },
            FileChunk {
                data: String::new(),
                ..first.clone()
            },
            FileChunk {
                data: "X".repeat(700_000),
                ..first.clone()
            },
        ] {
            assert!(decode_chunk(&metadata, &invalid, 0).is_err());
        }
    }
    #[test]
    fn cached_file_is_deleted_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("media");
        std::fs::write(&path, b"private").unwrap();
        drop(CachedFile(path.clone()));
        assert!(!path.exists());
    }
}
