//! The answerer caches credential-free STUN addresses, never TURN allocations.
//! Refresh the directory for future calls without changing existing peer configurations.
use crate::{Result, account::AccountSession};
use std::{future::Future, time::Duration};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use webrtc::ice_transport::ice_server::RTCIceServer;

#[derive(Clone, Copy)]
struct RefreshPolicy {
    populated: Duration,
    empty: Duration,
    request_timeout: Duration,
    retry: [Duration; 4],
}
impl Default for RefreshPolicy {
    fn default() -> Self {
        Self {
            populated: Duration::from_secs(30 * 60),
            empty: Duration::from_secs(60),
            request_timeout: Duration::from_secs(3),
            retry: [5, 15, 30, 60].map(Duration::from_secs),
        }
    }
}

pub(crate) struct IceDirectory {
    pub(crate) servers: watch::Receiver<Vec<RTCIceServer>>,
    task: JoinHandle<()>,
}
impl IceDirectory {
    pub(crate) fn start(account: AccountSession, stop: CancellationToken) -> Self {
        let (tx, servers) = watch::channel(Vec::new());
        let task = tokio::spawn(refresh(
            move || {
                let account = account.clone();
                async move { super::official::stun_servers(&account).await }
            },
            tx,
            stop,
            RefreshPolicy::default(),
        ));
        Self { servers, task }
    }
    /// Only the first empty directory may briefly delay startup; calls never wait on HTTP.
    pub(crate) async fn warm(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(3), self.servers.changed()).await;
    }
}
impl Drop for IceDirectory {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn refresh<F, Fut>(
    mut fetch: F,
    tx: watch::Sender<Vec<RTCIceServer>>,
    stop: CancellationToken,
    policy: RefreshPolicy,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Vec<RTCIceServer>>>,
{
    let mut failures = 0_usize;
    loop {
        let fetched = tokio::select! {
            _ = stop.cancelled() => return,
            result = tokio::time::timeout(policy.request_timeout, fetch()) => result,
        };
        let delay = match fetched {
            Ok(Ok(servers)) => {
                failures = 0;
                let delay = if servers.is_empty() {
                    policy.empty
                } else {
                    policy.populated
                };
                // A successful empty directory is authoritative (TURN may be disabled).
                // Failed refreshes retain the last usable credential-free addresses.
                tx.send_replace(servers);
                delay
            }
            // A refused account is terminal, not a transient directory failure.
            // Dropping the sole sender tells signaling to stop this account generation.
            Ok(Err(crate::Error::Unauthorized)) => return,
            _ => {
                let delay = policy.retry[failures.min(policy.retry.len() - 1)];
                failures = failures.saturating_add(1);
                delay
            }
        };
        tokio::select! { _ = stop.cancelled() => return, _ = tokio::time::sleep(delay) => {} }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    fn server(name: &str) -> Vec<RTCIceServer> {
        vec![RTCIceServer {
            urls: vec![format!("stun:{name}:3478")],
            ..Default::default()
        }]
    }
    fn policy() -> RefreshPolicy {
        RefreshPolicy {
            populated: Duration::from_secs(30),
            empty: Duration::from_secs(10),
            request_timeout: Duration::from_secs(3),
            retry: [1, 2, 4, 8].map(Duration::from_secs),
        }
    }
    async fn advance(seconds: u64) {
        tokio::time::advance(Duration::from_secs(seconds)).await;
        tokio::task::yield_now().await;
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_replaces_only_future_call_snapshots_and_retains_last_on_failure() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (tx, mut rx) = watch::channel(Vec::new());
        let stop = CancellationToken::new();
        let task = tokio::spawn(refresh(
            move || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    match n {
                        0 => Ok(server("old.test")),
                        1 => Err(crate::Error::Transport),
                        _ => Ok(server("new.test")),
                    }
                }
            },
            tx,
            stop.clone(),
            policy(),
        ));
        rx.changed().await.unwrap();
        let established_call = rx.borrow().clone();
        advance(30).await;
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(rx.borrow()[0].urls, server("old.test")[0].urls);
        advance(1).await;
        rx.changed().await.unwrap();
        assert_eq!(rx.borrow()[0].urls, server("new.test")[0].urls);
        assert_eq!(established_call[0].urls, server("old.test")[0].urls);
        assert!(established_call[0].credential.is_empty());
        stop.cancel();
        task.await.unwrap();
        advance(100).await;
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn failures_and_stalled_requests_have_capped_backoff_and_cancel_promptly() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (tx, _) = watch::channel(Vec::new());
        let stop = CancellationToken::new();
        let task = tokio::spawn(refresh(
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { std::future::pending::<Result<Vec<RTCIceServer>>>().await }
            },
            tx,
            stop.clone(),
            policy(),
        ));
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        for (i, retry) in [1, 2, 4, 8, 8].into_iter().enumerate() {
            advance(3).await; // each request times out, then waits its retry budget
            assert_eq!(count.load(Ordering::SeqCst), i + 1);
            advance(retry).await;
            assert_eq!(count.load(Ordering::SeqCst), i + 2);
        }
        stop.cancel();
        task.await.unwrap();
        advance(100).await;
        assert_eq!(count.load(Ordering::SeqCst), 6);
    }

    #[tokio::test(start_paused = true)]
    async fn unauthorized_refresh_stops_instead_of_retrying_revoked_account() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (tx, mut rx) = watch::channel(Vec::new());
        let task = tokio::spawn(refresh(
            move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Err(crate::Error::Unauthorized) }
            },
            tx,
            CancellationToken::new(),
            policy(),
        ));
        assert!(rx.changed().await.is_err());
        task.await.unwrap();
        advance(100).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn authoritative_empty_list_rechecks_soon_and_resets_retry_backoff() {
        let count = Arc::new(AtomicUsize::new(0));
        let calls = count.clone();
        let (tx, mut rx) = watch::channel(Vec::new());
        let stop = CancellationToken::new();
        let task = tokio::spawn(refresh(
            move || {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                async move {
                    match n {
                        0 => Ok(server("old.test")),
                        1 => Ok(vec![]),
                        2 => Err(crate::Error::Transport),
                        _ => Ok(server("restored.test")),
                    }
                }
            },
            tx,
            stop.clone(),
            policy(),
        ));
        rx.changed().await.unwrap();
        advance(30).await;
        rx.changed().await.unwrap();
        assert!(rx.borrow().is_empty());
        advance(9).await;
        assert_eq!(count.load(Ordering::SeqCst), 2);
        advance(1).await;
        assert_eq!(count.load(Ordering::SeqCst), 3);
        advance(1).await;
        rx.changed().await.unwrap();
        assert_eq!(rx.borrow()[0].urls, server("restored.test")[0].urls);
        stop.cancel();
        task.await.unwrap();
    }
}
