use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use fv_core::Message;
use fv_protocol::types::{ThreadId, Turn, TurnId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::log::{LogEvent, ThreadLog};
use crate::state::{ConnId, ServerState, notification_frame};

/// How long one subscriber may hold up delivery of a thread's events before it is dropped
/// from the thread. It sees a gap in `seq` and re-reads the thread with `thread/resume`.
const SLOW_SUBSCRIBER: Duration = Duration::from_secs(5);

struct Inner {
    log: ThreadLog,
    history: Vec<Message>,
    subscribers: HashSet<ConnId>,
    running: Option<(TurnId, CancellationToken)>,
}

/// Everything about one thread that exists only while the server runs: its subscribers, the
/// turn in flight, the history the next request is built from, and the event log.
///
/// The log, the sequence number and the subscriber set live under one lock, which is what
/// makes `thread/resume` atomic: the snapshot and the subscription cannot straddle an event.
pub struct ThreadRuntime {
    inner: Mutex<Inner>,
}

impl ThreadRuntime {
    pub fn new(thread_id: ThreadId) -> Self {
        Self {
            inner: Mutex::new(Inner {
                log: ThreadLog::new(thread_id),
                history: Vec::new(),
                subscribers: HashSet::new(),
                running: None,
            }),
        }
    }

    /// A runtime for a thread that already has a transcript.
    pub fn restored(thread_id: ThreadId, history: Vec<Message>, turns: Vec<Turn>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                log: ThreadLog::with_turns(thread_id, turns),
                history,
                subscribers: HashSet::new(),
                running: None,
            }),
        }
    }

    pub fn subscribe(&self, conn: ConnId) {
        self.inner.lock().unwrap().subscribers.insert(conn);
    }

    pub fn unsubscribe(&self, conn: ConnId) {
        self.inner.lock().unwrap().subscribers.remove(&conn);
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().unwrap().subscribers.len()
    }

    /// The thread as it stands, and a subscription to what follows.
    pub fn resume(&self, conn: ConnId) -> (Vec<Turn>, u64, bool) {
        let mut g = self.inner.lock().unwrap();
        g.subscribers.insert(conn);
        (g.log.turns.clone(), g.log.seq, g.log.running)
    }

    pub fn history(&self) -> Vec<Message> {
        self.inner.lock().unwrap().history.clone()
    }

    pub fn set_history(&self, history: Vec<Message>) {
        self.inner.lock().unwrap().history = history;
    }

    /// Stop the running turn, if there is one. Returns whether there was.
    pub fn interrupt(&self) -> bool {
        match &self.inner.lock().unwrap().running {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Claim the thread for a turn. `None` when one is already running.
    pub async fn begin(&self, state: &ServerState, turn_id: &str) -> Option<CancellationToken> {
        let token = CancellationToken::new();
        let staged = {
            let mut g = self.inner.lock().unwrap();
            if g.running.is_some() {
                return None;
            }
            g.running = Some((turn_id.to_string(), token.clone()));
            self.stage(&mut g, state, LogEvent::Running(true))
        };
        deliver(self, staged).await;
        Some(token)
    }

    /// The turn has fully settled; the thread is free again.
    pub async fn end(&self, state: &ServerState) {
        let staged = {
            let mut g = self.inner.lock().unwrap();
            g.running = None;
            self.stage(&mut g, state, LogEvent::Running(false))
        };
        deliver(self, staged).await;
    }

    pub async fn publish(&self, state: &ServerState, event: LogEvent) {
        let staged = {
            let mut g = self.inner.lock().unwrap();
            self.stage(&mut g, state, event)
        };
        deliver(self, staged).await;
    }

    /// Number the event and work out who gets it, all under the lock; sending happens after.
    fn stage(&self, g: &mut Inner, state: &ServerState, event: LogEvent) -> Staged {
        let note = g.log.append(event);
        let targets = g
            .subscribers
            .iter()
            .filter_map(|c| state.sender(*c).map(|tx| (*c, tx)))
            .collect();
        Staged {
            frame: notification_frame(&note),
            targets,
        }
    }

    fn drop_subscriber(&self, conn: ConnId) {
        self.inner.lock().unwrap().subscribers.remove(&conn);
    }
}

struct Staged {
    frame: fv_protocol::Message,
    targets: Vec<(ConnId, mpsc::Sender<fv_protocol::Message>)>,
}

/// Events of one thread reach each subscriber in order: they are sent one after another from
/// the single task driving the turn, never reordered. A subscriber that stays full is cut loose
/// instead of stalling everyone else.
async fn deliver(rt: &ThreadRuntime, staged: Staged) {
    for (conn, tx) in staged.targets {
        let sent = tokio::time::timeout(SLOW_SUBSCRIBER, tx.send(staged.frame.clone())).await;
        if !matches!(sent, Ok(Ok(()))) {
            rt.drop_subscriber(conn);
        }
    }
}
