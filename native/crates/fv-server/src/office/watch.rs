use super::*;
use fv_protocol::office::{OfficeWatchPhase as Phase, OfficeWatchState};
use std::sync::{Weak, atomic::AtomicU64};
#[derive(Default)]
pub(super) struct LiveMaps {
    pub sessions: HashMap<PathBuf, Weak<Live>>,
    leases: HashMap<(u64, String), Arc<Live>>,
    renders: HashMap<(u64, String), Arc<CancellationToken>>,
    closed: HashMap<(u64, String), tokio::time::Instant>,
}
pub(super) struct Live {
    path: PathBuf,
    pub cancel: CancellationToken,
    pub state: channel::Sender<OfficeWatchState>,
    release: AtomicU64,
    pub task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
fn state(
    path: &Path,
    phase: Phase,
    url: Option<String>,
    message: Option<String>,
) -> OfficeWatchState {
    OfficeWatchState {
        phase,
        path: path.to_string_lossy().into(),
        url,
        message,
    }
}
fn terminal(live: &Live) -> bool {
    matches!(live.state.borrow().phase, Phase::Stopped | Phase::Error)
}
impl Manager {
    pub async fn watch_start(
        &self,
        owner: u64,
        lease: &str,
        path: &Path,
    ) -> Result<OfficeWatchState, String> {
        if lease.is_empty() || lease.len() > 160 {
            return Err("无效的预览租约".into());
        }
        if self.inner.cancel.is_cancelled() {
            return Err("文档服务已关闭".into());
        }
        let install = self.install()?;
        let stamp = source(path)?;
        let key = (owner, lease.into());
        let live = {
            let mut maps = self.inner.live.lock().unwrap();
            maps.closed
                .retain(|_, at| at.elapsed() < Duration::from_secs(120));
            if maps.closed.contains_key(&key) || maps.closed.len() >= 4096 {
                return Err("预览已关闭".into());
            }
            if let Some(live) = maps.leases.get(&key) {
                if live.path != stamp.path {
                    return Err("预览租约已用于另一个文档".into());
                }
                live.clone()
            } else {
                if maps.leases.keys().filter(|(id, _)| *id == owner).count() >= 32 {
                    return Err("打开的文档预览过多".into());
                }
                let existing = maps.sessions.get(&stamp.path).and_then(Weak::upgrade);
                let live = if let Some(live) = existing.filter(|l| !terminal(l)) {
                    if live.cancel.is_cancelled() {
                        return Err("实时预览正在关闭，请重试".into());
                    }
                    live
                } else {
                    maps.sessions
                        .retain(|_, l| l.upgrade().is_some_and(|l| !terminal(&l)));
                    if maps.sessions.len() >= 16 {
                        return Err("最多同时实时预览 16 个文档".into());
                    }
                    let live = Arc::new(Live {
                        path: stamp.path.clone(),
                        cancel: self.inner.cancel.child_token(),
                        state: channel::channel(state(&stamp.path, Phase::Starting, None, None)).0,
                        release: AtomicU64::new(0),
                        task: Mutex::new(None),
                    });
                    maps.sessions
                        .insert(stamp.path.clone(), Arc::downgrade(&live));
                    let (worker, data) = (live.clone(), self.inner.data.clone());
                    *live.task.lock().unwrap() = Some(tokio::spawn(async move {
                        run_watch(worker, install, data).await;
                    }));
                    live
                };
                live.release.fetch_add(1, Ordering::AcqRel);
                maps.leases.insert(key.clone(), live.clone());
                live
            }
        };
        let mut events = live.state.subscribe();
        loop {
            let current = events.borrow().clone();
            match current.phase {
                Phase::Ready => {
                    if !self
                        .inner
                        .live
                        .lock()
                        .unwrap()
                        .leases
                        .get(&key)
                        .is_some_and(|l| Arc::ptr_eq(l, &live))
                    {
                        return Err("预览已关闭".into());
                    }
                    return Ok(current);
                }
                Phase::Error | Phase::Stopped => {
                    return Err(current.message.unwrap_or_else(|| "实时预览已停止".into()));
                }
                Phase::Starting => (),
            }
            if !self
                .inner
                .live
                .lock()
                .unwrap()
                .leases
                .get(&key)
                .is_some_and(|l| Arc::ptr_eq(l, &live))
            {
                return Err("预览已关闭".into());
            }
            tokio::select! {biased;_=tokio::time::sleep(Duration::from_millis(100))=>(),_=self.inner.cancel.cancelled()=>return Err("文档服务已关闭".into()),_=live.cancel.cancelled()=>return Err("预览已关闭".into()),changed=events.changed()=>{if changed.is_err(){return Err("实时预览已停止".into());}}}
        }
    }
    pub fn watch_state(&self, owner: u64, lease: &str) -> Result<OfficeWatchState, String> {
        let maps = self.inner.live.lock().unwrap();
        let live = maps
            .leases
            .get(&(owner, lease.into()))
            .ok_or("预览已关闭")?;
        Ok(live.state.borrow().clone())
    }
    pub fn watch_stop(&self, owner: u64, lease: &str) {
        let live = {
            let mut maps = self.inner.live.lock().unwrap();
            let key = (owner, lease.into());
            maps.closed
                .retain(|_, at| at.elapsed() < Duration::from_secs(120));
            if maps.closed.len() < 4096 {
                maps.closed.insert(key.clone(), tokio::time::Instant::now());
            }
            if let Some(cancel) = maps.renders.remove(&key) {
                cancel.cancel();
            }
            maps.leases.remove(&key)
        };
        if let Some(live) = live {
            self.release_later(live);
        }
    }
    pub async fn render_for(
        &self,
        owner: u64,
        lease: &str,
        path: &Path,
    ) -> Result<OfficeRenderResponse, String> {
        if lease.is_empty() || lease.len() > 160 {
            return Err("无效的预览租约".into());
        }
        let key = (owner, lease.into());
        let cancel = Arc::new(self.inner.cancel.child_token());
        {
            let mut maps = self.inner.live.lock().unwrap();
            maps.closed
                .retain(|_, at| at.elapsed() < Duration::from_secs(120));
            if maps.closed.contains_key(&key) || maps.closed.len() >= 4096 {
                return Err("预览已关闭".into());
            }
            if maps.renders.contains_key(&key)
                || maps.renders.keys().filter(|(id, _)| *id == owner).count() >= 16
            {
                return Err("等待预览的文档过多".into());
            }
            maps.renders.insert(key.clone(), cancel.clone());
        }
        let _guard = RenderLease {
            inner: Arc::downgrade(&self.inner),
            key,
            cancel: cancel.clone(),
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err("预览已取消".into()),result=self.render(path)=>result}
    }
    fn release_later(&self, live: Arc<Live>) {
        let version = live.release.fetch_add(1, Ordering::AcqRel) + 1;
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let maps = inner.live.lock().unwrap();
            if live.release.load(Ordering::Acquire) == version
                && !maps.leases.values().any(|l| Arc::ptr_eq(l, &live))
            {
                live.cancel.cancel();
            }
        });
    }
    pub fn disconnected(&self, owner: u64) {
        let leases = self
            .inner
            .live
            .lock()
            .unwrap()
            .leases
            .keys()
            .filter(|(id, _)| *id == owner)
            .map(|(_, l)| l.clone())
            .collect::<Vec<_>>();
        for lease in leases {
            self.watch_stop(owner, &lease);
        }
        let mut maps = self.inner.live.lock().unwrap();
        maps.renders.retain(|(id, _), token| {
            if *id == owner {
                token.cancel();
                false
            } else {
                true
            }
        });
        maps.closed.retain(|(id, _), _| *id != owner);
    }
    pub async fn selection(&self, owner: u64, lease: &str) -> Result<OfficeSelection, String> {
        let live = self
            .inner
            .live
            .lock()
            .unwrap()
            .leases
            .get(&(owner, lease.into()))
            .cloned()
            .ok_or("实时预览已关闭")?;
        if live.state.borrow().phase != Phase::Ready {
            return Err("实时预览尚未就绪".into());
        }
        if live
            .path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"))
        {
            return Err("表格预览不支持引用元素路径".into());
        }
        let payload = process::run(
            &self.install()?,
            &self.inner.data,
            &[
                "get".into(),
                live.path.clone().into_os_string(),
                "selected".into(),
                "--json".into(),
            ],
            &live.cancel,
            Duration::from_secs(15),
            2_000_000,
        )
        .await?;
        if !self
            .inner
            .live
            .lock()
            .unwrap()
            .leases
            .get(&(owner, lease.into()))
            .is_some_and(|current| Arc::ptr_eq(current, &live))
        {
            return Err("预览已关闭".into());
        }
        format_selection(&live.path, &payload)
    }
}
struct RenderLease {
    inner: Weak<Inner>,
    key: (u64, String),
    cancel: Arc<CancellationToken>,
}
impl Drop for RenderLease {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(inner) = self.inner.upgrade() {
            let mut maps = inner.live.lock().unwrap();
            if maps
                .renders
                .get(&self.key)
                .is_some_and(|token| Arc::ptr_eq(token, &self.cancel))
            {
                maps.renders.remove(&self.key);
            }
        }
    }
}
fn format_selection(path: &Path, bytes: &[u8]) -> Result<OfficeSelection, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| "读不到预览里的选中内容")?;
    let mut items = Vec::new();
    if let Some(rows) = value.pointer("/data/results").and_then(|v| v.as_array()) {
        for row in rows.iter().take(24) {
            let Some(path) = row["path"]
                .as_str()
                .filter(|v| !v.trim().is_empty() && v.len() <= 2048)
            else {
                continue;
            };
            let raw = row
                .get("preview")
                .or_else(|| row.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
            let text = if text.chars().count() > 80 {
                format!("{}…", text.chars().take(80).collect::<String>())
            } else {
                text
            };
            items.push(OfficeSelectionItem {
                path: path.into(),
                kind: row["type"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect(),
                text,
            });
        }
    }
    if items.is_empty() {
        return Err("预览里还没有选中内容".into());
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut text = format!("引用文档 {name}（{}）：", path.display());
    for item in &items {
        text.push_str(&format!(
            "\n- {}{}",
            item.path,
            if item.text.is_empty() {
                String::new()
            } else {
                format!(" — {}", item.text)
            }
        ));
    }
    Ok(OfficeSelection { items, text })
}
fn decode_title(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|n| *n < 16) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|v| u32::from_str_radix(v, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|v| v.parse().ok()))
                .and_then(char::from_u32),
        };
        if let Some(ch) = ch {
            out.push(ch);
        } else {
            out.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}
fn valid_watch_page(page: &str, path: &Path) -> bool {
    let title = page
        .split_once("<title>")
        .and_then(|(_, s)| s.split_once("</title>"))
        .map(|(t, _)| decode_title(t));
    title.as_deref() == path.file_name().and_then(|p| p.to_str())
        && page.contains("officecli-selected")
}
async fn probe(client: &reqwest::Client, url: &str, path: &Path) -> bool {
    let Ok(mut response) = client.get(url).timeout(Duration::from_secs(2)).send().await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        let take = (2 * 1024 * 1024usize)
            .saturating_sub(bytes.len())
            .min(chunk.len());
        bytes.extend_from_slice(&chunk[..take]);
        if valid_watch_page(&String::from_utf8_lossy(&bytes), path) {
            return true;
        }
        if bytes.len() >= 2 * 1024 * 1024 {
            break;
        }
    }
    false
}
async fn run_watch(live: Arc<Live>, install: OfficeInstall, data: PathBuf) {
    let result = watch_process(&live, &install, &data).await;
    let phase = if live.cancel.is_cancelled() {
        Phase::Stopped
    } else {
        Phase::Error
    };
    live.state
        .send_replace(state(&live.path, phase, None, result.err()));
}
async fn watch_process(live: &Live, install: &OfficeInstall, data: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut failure = "实时预览未能启动".to_string();
    for _ in 0..3 {
        if live.cancel.is_cancelled() {
            return Ok(());
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}/");
        let mut process = process::spawn(
            install,
            data,
            &[
                "watch".into(),
                live.path.clone().into_os_string(),
                "--port".into(),
                port.to_string().into(),
            ],
        )?;
        let out = tokio::spawn(process::drain(process.child.stdout.take().unwrap(), 0));
        let err = tokio::spawn(process::drain(process.child.stderr.take().unwrap(), 2000));
        let mut ready = false;
        let started = tokio::time::Instant::now();
        while started.elapsed() < Duration::from_secs(15) && !live.cancel.is_cancelled() {
            if process
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                break;
            }
            let response = tokio::select! {biased;_=live.cancel.cancelled()=>break,response=probe(&client,&url,&live.path)=>response};
            if response
                && process
                    .child
                    .try_wait()
                    .map_err(|e| e.to_string())?
                    .is_none()
            {
                ready = true;
                break;
            }
            tokio::select! {_=live.cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(100))=>()}
        }
        if ready {
            live.state
                .send_replace(state(&live.path, Phase::Ready, Some(url.clone()), None));
        }
        let outcome = if ready {
            let mut current = source(&live.path).ok();
            let mut reload_failures = 0u8;
            let mut pending: Option<(Option<Stamp>, tokio::time::Instant)> = None;
            let mut tick = tokio::time::interval(Duration::from_millis(400));
            loop {
                tokio::select! {biased;
                    _=live.cancel.cancelled()=>break Ok(()),
                    result=process.child.wait()=>break Err(format!("实时预览进程已退出：{}",result.map(|s|s.to_string()).unwrap_or_else(|e|e.to_string()))),
                    _=tick.tick()=>{
                        let latest=source(&live.path).ok();
                        if latest==current{pending=None;continue;}
                        if pending.as_ref().is_none_or(|(s,_)|s!=&latest){pending=Some((latest.clone(),tokio::time::Instant::now()));continue;}
                        if pending.as_ref().is_some_and(|(_,at)|at.elapsed()>=Duration::from_millis(400)){
                            let Some(latest)=latest else{break Err("文档已不存在或无法读取".into());};
                            let reload=client.post(format!("{url}api/switch")).json(&serde_json::json!({"file":live.path})).send();
                            let response=tokio::select!{biased;_=live.cancel.cancelled()=>break Ok(()),response=reload=>response};
                            if response.is_ok_and(|r|r.status().is_success()){current=Some(latest);pending=None;reload_failures=0;}
                            else {reload_failures+=1;if reload_failures>=3{break Err("实时预览无法更新文档，请刷新预览".into());}}
                        }
                    }
                }
            }
        } else {
            Err("实时预览未能在 15 秒内就绪".into())
        };
        process.stop().await;
        let _ = tokio::time::timeout(Duration::from_secs(1), out).await;
        let stderr = tokio::time::timeout(Duration::from_secs(1), err)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
            .0;
        if ready || live.cancel.is_cancelled() {
            return outcome;
        }
        failure = if stderr.is_empty() {
            outcome.err().unwrap_or(failure)
        } else {
            format!(
                "实时预览无法启动：{}",
                String::from_utf8_lossy(&stderr).trim()
            )
        };
    }
    Err(failure)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_rejects_an_unrelated_loopback_service_or_another_document() {
        assert!(valid_watch_page(
            "<title>文档&amp;&#x4e00;.docx</title>officecli-selected",
            Path::new("文档&一.docx")
        ));
        assert!(!valid_watch_page(
            "<title>another.docx</title>officecli-selected",
            Path::new("wanted.docx")
        ));
        assert!(!valid_watch_page(
            "<title>wanted.docx</title>another application",
            Path::new("wanted.docx")
        ));
    }
    #[test]
    fn selection_keeps_stable_paths_and_clips_unicode_quotes() {
        let value = serde_json::json!({"data":{"results":[{"path":"@id=stable","type":"paragraph","preview":"原生".repeat(100)}]}});
        let result =
            format_selection(Path::new("/tmp/test.docx"), value.to_string().as_bytes()).unwrap();
        assert_eq!(result.items[0].text.chars().count(), 81);
        assert!(result.text.contains("@id=stable"));
        assert!(format_selection(Path::new("x.docx"), b"{}").is_err());
    }
}
