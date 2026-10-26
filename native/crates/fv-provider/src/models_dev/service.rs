//! One refresh per process; callers share the result even when its first caller disconnects.
use super::{Catalog, CatalogStats, fold, meta};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::sync::watch;
const INTERVAL_MS: u64 = 3_600_000;
const START_DELAY_MS: u64 = 15_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);
#[derive(Clone, Debug)]
pub struct CatalogUpdate {
    pub stats: CatalogStats,
    pub changed: bool,
    pub revision: u64,
}
type Answer = Option<Result<CatalogUpdate, String>>;
pub struct CatalogService {
    current: RwLock<Arc<Catalog>>,
    data_dir: PathBuf,
    source: String,
    client: Option<reqwest::Client>,
    flight: Mutex<Option<watch::Receiver<Answer>>>,
    revision: AtomicU64,
    last_attempt: AtomicU64,
    changes: watch::Sender<Option<CatalogUpdate>>,
}
impl CatalogService {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        Self::with_source(data_dir, fold::SOURCE_URL.into(), None)
    }
    /// Alternate source/client for embedding and deterministic HTTP tests. RPC callers cannot
    /// choose either; production always uses the fixed models.dev URL.
    pub fn with_source(
        data_dir: PathBuf,
        source: String,
        client: Option<reqwest::Client>,
    ) -> Arc<Self> {
        Arc::new(Self {
            current: RwLock::new(Arc::new(meta::load_catalog(&data_dir))),
            data_dir,
            source,
            client,
            flight: Mutex::new(None),
            revision: AtomicU64::new(0),
            last_attempt: AtomicU64::new(0),
            changes: watch::channel(None).0,
        })
    }
    pub fn subscribe(&self) -> watch::Receiver<Option<CatalogUpdate>> {
        self.changes.subscribe()
    }
    /// A coherent immutable view; never retain a lock while doing I/O or calling a model.
    pub fn snapshot(&self) -> Arc<Catalog> {
        self.current.read().unwrap().clone()
    }
    pub fn delay(&self, now: u64) -> Duration {
        Duration::from_millis(next_refresh_delay(
            now,
            self.snapshot().stats().generated_at,
            self.last_attempt.load(Ordering::Acquire),
        ))
    }
    pub fn due(&self, now: u64) -> bool {
        let attempted = self.last_attempt.load(Ordering::Acquire);
        if attempted > 0 && attempted <= now && now - attempted < INTERVAL_MS {
            return false;
        }
        let generated = self.snapshot().stats().generated_at;
        generated == 0 || generated > now || now - generated >= INTERVAL_MS
    }
    pub async fn refresh(self: &Arc<Self>) -> Result<CatalogUpdate, String> {
        let mut rx = {
            let mut flight = self.flight.lock().unwrap();
            if let Some(rx) = flight.as_ref().filter(|r| r.borrow().is_none()) {
                rx.clone()
            } else {
                let (tx, rx) = watch::channel(None);
                *flight = Some(rx.clone());
                let this = self.clone();
                tokio::spawn(async move {
                    let result = this.download().await;
                    this.last_attempt.store(now_ms(), Ordering::Release);
                    if let Ok(update) = &result {
                        this.changes.send_replace(Some(update.clone()));
                    }
                    tx.send_replace(Some(result));
                });
                rx
            }
        };
        loop {
            if let Some(result) = rx.borrow().clone() {
                return result;
            }
            rx.changed()
                .await
                .map_err(|_| "catalog refresh stopped".to_string())?;
        }
    }
    async fn download(&self) -> Result<CatalogUpdate, String> {
        // On macOS client construction can synchronously consult system proxy settings.
        let client = match &self.client {
            Some(client) => client.clone(),
            None => tokio::task::spawn_blocking(|| {
                reqwest::Client::builder()
                    .timeout(TIMEOUT)
                    .user_agent("fastvibe-sync-models-dev")
                    .build()
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?,
        };
        let source = self.source.clone();
        let mut response = client
            .get(&source)
            .timeout(TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("could not reach models.dev: {e}"))?
            .error_for_status()
            .map_err(|e| format!("models.dev: {e}"))?;
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err("models.dev catalog exceeds 32 MiB".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err("models.dev catalog exceeds 32 MiB".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let data_dir = self.data_dir.clone();
        let catalog = tokio::task::spawn_blocking(move || {
            let upstream = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let snapshot = fold::build_snapshot(&upstream, now_ms(), &source);
            let path = meta::local_snapshot_path(&data_dir);
            let catalog = meta::read_value(snapshot.clone(), path.display().to_string(), false)
                .ok_or("models.dev returned no models")?;
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            // Same-directory replacement retains the last usable file on failed writes/renames.
            let mut tmp = tempfile::NamedTempFile::new_in(&data_dir).map_err(|e| e.to_string())?;
            serde_json::to_writer(tmp.as_file_mut(), &snapshot).map_err(|e| e.to_string())?;
            tmp.as_file().sync_all().map_err(|e| e.to_string())?;
            tmp.persist(&path).map_err(|e| e.to_string())?;
            Ok::<_, String>(catalog)
        })
        .await
        .map_err(|e| e.to_string())??;
        let mut current = self.current.write().unwrap();
        let changed = current.signature() != catalog.signature();
        let stats = catalog.stats().clone();
        *current = Arc::new(catalog);
        Ok(CatalogUpdate {
            stats,
            changed,
            revision: self.revision.fetch_add(1, Ordering::AcqRel) + 1,
        })
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
/// Fresh data waits out its hour, failure waits another hour, overdue startup waits 15 seconds.
pub fn next_refresh_delay(now: u64, generated: u64, attempted: u64) -> u64 {
    let from_catalog = if generated > 0 {
        generated.saturating_add(INTERVAL_MS)
    } else {
        now
    };
    let from_attempt = if attempted > 0 {
        attempted.saturating_add(INTERVAL_MS)
    } else {
        from_catalog
    };
    let mut due = from_catalog.max(from_attempt);
    if attempted == 0 {
        due = due.max(now.saturating_add(START_DELAY_MS));
    }
    due.min(now.saturating_add(INTERVAL_MS)).saturating_sub(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn upstream(price: u32) -> String {
        serde_json::json!({"p":{"models":{"m":{"id":"m","name":"M",
            "limit":{"context":200000,"output":8000},"cost":{"input":price,"output":10}}}}})
        .to_string()
    }
    async fn http(
        bodies: Vec<(u16, String)>,
        gate: Option<Arc<tokio::sync::Semaphore>>,
    ) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let reads = count.clone();
        let worker = tokio::spawn(async move {
            for (status, body) in bodies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut b = [0; 1024];
                    let n = stream.read(&mut b).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&b[..n]);
                    if request.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                reads.fetch_add(1, Ordering::SeqCst);
                if let Some(gate) = &gate {
                    gate.acquire().await.unwrap().forget();
                }
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{addr}/api.json"), count, worker)
    }
    fn service(dir: &std::path::Path, url: String) -> Arc<CatalogService> {
        CatalogService::with_source(
            dir.into(),
            url,
            Some(reqwest::Client::builder().no_proxy().build().unwrap()),
        )
    }
    async fn until_count(count: &AtomicUsize, expected: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while count.load(Ordering::SeqCst) < expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn callers_share_download_and_cancelled_waiter_does_not_cancel_persistence() {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let (url, count, worker) = http(vec![(200, upstream(2))], Some(gate.clone())).await;
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path(), url);
        let old = service.snapshot();
        let first = {
            let s = service.clone();
            tokio::spawn(async move { s.refresh().await })
        };
        until_count(&count, 1).await;
        let calls = (0..8)
            .map(|_| {
                let s = service.clone();
                tokio::spawn(async move { s.refresh().await })
            })
            .collect::<Vec<_>>();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        tokio::task::yield_now().await;
        gate.add_permits(1);
        for call in calls {
            assert_eq!(call.await.unwrap().unwrap().revision, 1);
        }
        worker.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(
            old.price("m").is_none(),
            "existing snapshot stays immutable"
        );
        assert_eq!(service.snapshot().price("m").unwrap().0.input, 2.0);
        let restart = CatalogService::new(dir.path().into());
        assert_eq!(
            restart.snapshot().signature(),
            service.snapshot().signature()
        );
    }
    #[tokio::test]
    async fn unchanged_refresh_updates_age_and_failures_keep_memory_and_disk() {
        let (url, _, worker) = http(
            vec![
                (200, upstream(2)),
                (200, upstream(2)),
                (200, "{}".into()),
                (200, "{broken".into()),
                (503, "unavailable".into()),
                (200, upstream(4)),
            ],
            None,
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let s = service(dir.path(), url);
        assert!(s.refresh().await.unwrap().changed);
        let same = s.refresh().await.unwrap();
        assert!(!same.changed);
        assert_eq!(same.stats.models, 1);
        let file = meta::local_snapshot_path(dir.path());
        let before = std::fs::read(&file).unwrap();
        let signature = s.snapshot().signature().unwrap().to_owned();
        for _ in 0..3 {
            assert!(s.refresh().await.is_err());
            assert_eq!(std::fs::read(&file).unwrap(), before);
            assert_eq!(s.snapshot().signature(), Some(signature.as_str()));
            assert!(
                s.delay(now_ms()).as_secs() > 3500,
                "failures back off for an hour"
            );
        }
        assert!(s.refresh().await.unwrap().changed);
        worker.await.unwrap();
        assert_eq!(s.snapshot().price("m").unwrap().0.input, 4.0);
        // A failed destination replacement cannot install an in-memory catalog either.
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let (url, _, worker) = http(vec![(200, upstream(8))], None).await;
        let failed = service(dir.path(), url);
        let original = failed.snapshot();
        assert!(failed.refresh().await.is_err());
        assert_eq!(failed.snapshot().signature(), original.signature());
        worker.await.unwrap();
    }
    #[test]
    fn a_manual_failure_during_the_startup_wait_defers_that_existing_timer() {
        let dir = tempfile::tempdir().unwrap();
        let s = CatalogService::new(dir.path().into());
        *s.current.write().unwrap() = Arc::new(super::super::meta::read_value(
            serde_json::json!({"v":5,"t":1,"m":[["m","M",128000,8000,1,null,null]],"x":{"m":0}}),
            "fixture".into(), false).unwrap());
        let now = 10_000_000;
        assert!(s.due(now));
        s.last_attempt.store(now, Ordering::Release);
        assert!(!s.due(now + START_DELAY_MS));
        assert!(s.due(now + INTERVAL_MS));
    }

    #[test]
    fn hourly_schedule_handles_missing_fresh_stale_failed_manual_and_future_data() {
        let now = 10_000_000;
        assert_eq!(next_refresh_delay(now, 0, 0), START_DELAY_MS);
        assert_eq!(
            next_refresh_delay(now, now - INTERVAL_MS, 0),
            START_DELAY_MS
        );
        assert_eq!(next_refresh_delay(now, now - 1_000, 0), INTERVAL_MS - 1_000);
        assert_eq!(next_refresh_delay(now, 1, now - 100), INTERVAL_MS - 100);
        assert_eq!(next_refresh_delay(now, now, now - INTERVAL_MS), INTERVAL_MS);
        assert_eq!(next_refresh_delay(now, u64::MAX, 0), INTERVAL_MS);
        assert_eq!(next_refresh_delay(now, 1, now - INTERVAL_MS), 0);
    }
}
