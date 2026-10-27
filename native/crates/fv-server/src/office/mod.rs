//! Office previews are App Server resources. Static renders are deduplicated and
//! cached; live processes have connection-scoped leases and survive a short tab switch.
mod process;
mod watch;
use fv_env::OfficeInstall;
use fv_protocol::office::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};
use tokio::sync::watch as channel;
use tokio_util::sync::CancellationToken;

const MAX_SOURCE: u64 = 256 * 1024 * 1024;
const MAX_HTML: u64 = 16 * 1024 * 1024;
const CACHE_BUDGET: u64 = 512 * 1024 * 1024;
#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}
struct Inner {
    data: PathBuf,
    install: Option<OfficeInstall>,
    cancel: CancellationToken,
    renders: Mutex<HashMap<String, Arc<Render>>>,
    live: Mutex<watch::LiveMaps>,
    permits: Arc<tokio::sync::Semaphore>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
struct Render {
    state: channel::Sender<Option<Result<OfficeRenderResponse, String>>>,
    cancel: CancellationToken,
    waiters: AtomicUsize,
}
struct Waiter(Arc<Render>);
impl Drop for Waiter {
    fn drop(&mut self) {
        if self.0.waiters.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.cancel.cancel();
        }
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
}
fn source(path: &Path) -> Result<Stamp, String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("无法读取文档：{e}"))?;
    let supported = |p: &Path| {
        p.extension().and_then(|s| s.to_str()).is_some_and(|e| {
            ["docx", "xlsx", "pptx"]
                .iter()
                .any(|v| e.eq_ignore_ascii_case(v))
        })
    };
    if !supported(path) || !supported(&real) {
        return Err("仅支持 docx、xlsx 和 pptx 文档".into());
    }
    let meta = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX_SOURCE {
        return Err("文档不是普通文件或超过 256 MiB".into());
    }
    Ok(Stamp {
        path: real,
        len: meta.len(),
        modified: meta.modified().map_err(|e| e.to_string())?,
    })
}
fn key(stamp: &Stamp, version: &str) -> String {
    let mut h = Sha256::new();
    h.update(stamp.path.as_os_str().as_encoded_bytes());
    h.update([0]);
    h.update(stamp.len.to_le_bytes());
    h.update(format!("{:?}\0{version}", stamp.modified));
    format!("{:x}", h.finalize())
}
impl Manager {
    pub fn new(data: PathBuf) -> Self {
        Self::with_install(data, fv_env::office_install().cloned())
    }
    /// Library embedders may supply an already verified resource; the desktop always
    /// resolves its immutable pinned bundle through `new`.
    pub fn with_install(data: PathBuf, install: Option<OfficeInstall>) -> Self {
        Self {
            inner: Arc::new(Inner {
                data,
                install,
                cancel: CancellationToken::new(),
                renders: Mutex::new(HashMap::new()),
                live: Mutex::new(Default::default()),
                permits: Arc::new(tokio::sync::Semaphore::new(4)),
            }),
        }
    }
    fn install(&self) -> Result<OfficeInstall, String> {
        self.inner
            .install
            .clone()
            .ok_or_else(|| "此安装未包含通过校验的 OfficeCLI，无法预览文档".into())
    }
    pub async fn render(&self, path: &Path) -> Result<OfficeRenderResponse, String> {
        if self.inner.cancel.is_cancelled() {
            return Err("文档服务已关闭".into());
        }
        let install = self.install()?;
        let stamp = source(path)?;
        let key = key(&stamp, &install.version);
        let cache = self.inner.data.join("office-preview");
        let target = cache.join(format!("{key}.html"));
        if let Some(size) = usable(&target) {
            touch(&target);
            return Ok(OfficeRenderResponse {
                path: target.to_string_lossy().into(),
                size,
                version: install.version,
            });
        }
        let job = {
            let mut map = self.inner.renders.lock().unwrap();
            if let Some(job) = map.get(&key) {
                if job.cancel.is_cancelled() {
                    return Err("预览操作正在取消，请重试".into());
                }
                job.waiters.fetch_add(1, Ordering::AcqRel);
                job.clone()
            } else {
                if map.len() >= 16 {
                    return Err("等待预览的文档过多，请稍后重试".into());
                }
                let job = Arc::new(Render {
                    state: channel::channel(None).0,
                    cancel: self.inner.cancel.child_token(),
                    waiters: AtomicUsize::new(1),
                });
                map.insert(key.clone(), job.clone());
                let (weak, data, permits, worker) = (
                    Arc::downgrade(&self.inner),
                    self.inner.data.clone(),
                    self.inner.permits.clone(),
                    job.clone(),
                );
                tokio::spawn(async move {
                    let result =
                        render_one(&install, &data, stamp, &target, &worker.cancel, permits).await;
                    worker.state.send_replace(Some(result));
                    if let Some(inner) = weak.upgrade() {
                        let mut map = inner.renders.lock().unwrap();
                        if map.get(&key).is_some_and(|j| Arc::ptr_eq(j, &worker)) {
                            map.remove(&key);
                        }
                    }
                });
                job
            }
        };
        let _waiter = Waiter(job.clone());
        let mut state = job.state.subscribe();
        loop {
            if let Some(result) = state.borrow().clone() {
                return result;
            }
            if state.changed().await.is_err() {
                return Err("文档渲染已结束".into());
            }
        }
    }
    pub fn has_running(&self) -> bool {
        !self.inner.renders.lock().unwrap().is_empty()
            || self
                .inner
                .live
                .lock()
                .unwrap()
                .sessions
                .values()
                .filter_map(std::sync::Weak::upgrade)
                .any(|live| {
                    !matches!(
                        live.state.borrow().phase,
                        OfficeWatchPhase::Stopped | OfficeWatchPhase::Error
                    )
                })
    }
    pub async fn shutdown(&self) {
        self.inner.cancel.cancel();
        let lives = self
            .inner
            .live
            .lock()
            .unwrap()
            .sessions
            .values()
            .filter_map(std::sync::Weak::upgrade)
            .collect::<Vec<_>>();
        for live in lives {
            live.cancel.cancel();
            let task = live.task.lock().unwrap().take();
            if let Some(task) = task {
                let _ = task.await;
            }
        }
        let jobs = self
            .inner
            .renders
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for job in jobs {
            let mut state = job.state.subscribe();
            while state.borrow().is_none() {
                if state.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}
fn usable(path: &Path) -> Option<u64> {
    let m = std::fs::metadata(path).ok()?;
    (m.is_file() && m.len() > 0 && m.len() <= MAX_HTML).then_some(m.len())
}
fn touch(path: &Path) {
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()));
    }
}
async fn render_one(
    install: &OfficeInstall,
    data: &Path,
    stamp: Stamp,
    target: &Path,
    cancel: &CancellationToken,
    permits: Arc<tokio::sync::Semaphore>,
) -> Result<OfficeRenderResponse, String> {
    let _permit = tokio::select! {biased;_=cancel.cancelled()=>return Err("预览已取消".into()),p=permits.acquire_owned()=>p.map_err(|e|e.to_string())?};
    if let Some(size) = usable(target) {
        return Ok(OfficeRenderResponse {
            path: target.to_string_lossy().into(),
            size,
            version: install.version.clone(),
        });
    }
    let cache = target.parent().unwrap();
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let temp = cache.join(format!("{}.tmp.html", uuid::Uuid::new_v4()));
    let result = process::run(
        install,
        data,
        &[
            "view".into(),
            stamp.path.clone().into_os_string(),
            "html".into(),
            "-o".into(),
            temp.clone().into_os_string(),
        ],
        cancel,
        Duration::from_secs(60),
        0,
    )
    .await;
    if let Err(e) = result {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }
    if source(&stamp.path).as_ref() != Ok(&stamp) {
        let _ = std::fs::remove_file(&temp);
        return Err("文档在渲染期间发生变化，请刷新预览".into());
    }
    let Some(size) = usable(&temp) else {
        let _ = std::fs::remove_file(&temp);
        return Err("没有生成可用的预览页面，或页面超过 16 MiB".into());
    };
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&temp);
        return Err("预览已取消".into());
    }
    if let Err(error) = std::fs::rename(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    trim(cache, target);
    Ok(OfficeRenderResponse {
        path: target.to_string_lossy().into(),
        size,
        version: install.version.clone(),
    })
}
fn trim(cache: &Path, current: &Path) {
    let Ok(rows) = std::fs::read_dir(cache) else {
        return;
    };
    let mut files = rows
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?;
            if name.ends_with(".tmp.html") {
                if e.metadata()
                    .ok()?
                    .modified()
                    .ok()?
                    .elapsed()
                    .ok()
                    .is_some_and(|age| age > Duration::from_secs(120))
                {
                    let _ = std::fs::remove_file(&path);
                }
                return None;
            }
            if !name.ends_with(".html") {
                return None;
            }
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), path))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, n, _)| n).sum::<u64>();
    if total <= CACHE_BUDGET {
        return;
    }
    files.sort_by_key(|(t, _, _)| *t);
    for (_, len, path) in files {
        if path != current && std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(len);
        }
        if total <= CACHE_BUDGET * 3 / 4 {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_trimming_keeps_the_current_page_and_expires_crash_partials() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..70 {
            let file = std::fs::File::create(dir.path().join(format!("{i:03}.html"))).unwrap();
            file.set_len(8 * 1024 * 1024).unwrap();
            file.set_times(
                std::fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(i)),
            )
            .unwrap();
        }
        let stale = dir.path().join("old.tmp.html");
        let file = std::fs::File::create(&stale).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .unwrap();
        let current = dir.path().join("000.html");
        trim(dir.path(), &current);
        assert!(current.exists());
        assert!(!stale.exists());
        let size = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.metadata().unwrap().len())
            .sum::<u64>();
        assert!(size <= CACHE_BUDGET * 3 / 4);
    }
}
