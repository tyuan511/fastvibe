//! Byte- and frame-bounded outgoing queue. Permits live until the transport finishes a write.
use fv_protocol::{Message, RequestId};
use std::sync::{Arc, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

const BUDGET: usize = 32 * 1024 * 1024;

/// A wire-ready frame. The message and its JSON are reference counted so one notification can
/// be fanned out to every subscriber without cloning the payload or serializing it per socket.
#[derive(Clone)]
pub(crate) struct PreparedFrame {
    pub(crate) message: Arc<Message>,
    pub(crate) encoded: Arc<str>,
    bytes: u32,
}

impl PreparedFrame {
    pub(crate) fn from_message(message: Message) -> Result<Self, ()> {
        let encoded = serde_json::to_string(&message).map_err(|_| ())?;
        if encoded.len() > 64 * 1024 * 1024 {
            return Err(());
        }
        Ok(Self {
            message: Arc::new(message),
            bytes: encoded.len().clamp(1, BUDGET) as u32,
            encoded: Arc::from(encoded),
        })
    }
}

pub struct Frame {
    pub(crate) encoded: Arc<str>,
    _permit: OwnedSemaphorePermit,
}
#[derive(Clone)]
pub struct Sender {
    tx: Target,
    prompts: Arc<Mutex<std::collections::HashSet<RequestId>>>,
    closed: Arc<tokio::sync::watch::Sender<bool>>,
}
#[derive(Clone)]
enum Target {
    Bounded(mpsc::Sender<Frame>, Arc<Semaphore>),
    Plain(mpsc::Sender<Message>),
}
pub fn channel(capacity: usize) -> (Sender, mpsc::Receiver<Frame>) {
    let (tx, rx) = mpsc::channel(capacity);
    (
        Sender::new(Target::Bounded(tx, Arc::new(Semaphore::new(BUDGET)))),
        rx,
    )
}
impl From<mpsc::Sender<Message>> for Sender {
    fn from(tx: mpsc::Sender<Message>) -> Self {
        Self::new(Target::Plain(tx))
    }
}
impl Sender {
    fn new(tx: Target) -> Self {
        Self {
            tx,
            prompts: Default::default(),
            closed: Arc::new(tokio::sync::watch::channel(false).0),
        }
    }
    pub fn close(&self) {
        self.closed.send_replace(true);
    }
    pub fn subscribe_closed(&self) -> tokio::sync::watch::Receiver<bool> {
        self.closed.subscribe()
    }
    pub fn offered(&self, id: &RequestId) -> bool {
        self.prompts.lock().unwrap().contains(id)
    }
    pub fn forget(&self, id: &RequestId) {
        self.prompts.lock().unwrap().remove(id);
    }
    fn remember(&self, message: &Message) {
        match message {
            Message::Request { id, .. } => {
                self.prompts.lock().unwrap().insert(id.clone());
            }
            Message::Notification { method, params } if method == "serverRequest/resolved" => {
                if let Some(id) = params
                    .get("requestId")
                    .and_then(|id| serde_json::from_value(id.clone()).ok())
                {
                    self.forget(&id);
                }
            }
            _ => {}
        }
    }
    #[allow(dead_code)]
    pub fn try_send(&self, message: Message) -> Result<(), ()> {
        if matches!(self.tx, Target::Bounded(_, _)) {
            return self.try_send_prepared(PreparedFrame::from_message(message)?);
        }
        if *self.closed.borrow() {
            return Err(());
        }
        let Target::Plain(tx) = &self.tx else {
            unreachable!();
        };
        let slot = tx.try_reserve().map_err(|_| ())?;
        self.remember(&message);
        slot.send(message);
        Ok(())
    }

    pub(crate) fn try_send_prepared(&self, prepared: PreparedFrame) -> Result<(), ()> {
        if *self.closed.borrow() {
            return Err(());
        }
        match &self.tx {
            Target::Plain(tx) => {
                let slot = tx.try_reserve().map_err(|_| ())?;
                self.remember(&prepared.message);
                slot.send((*prepared.message).clone());
            }
            Target::Bounded(tx, budget) => {
                let permit = budget
                    .clone()
                    .try_acquire_many_owned(prepared.bytes)
                    .map_err(|_| ())?;
                let slot = tx.try_reserve().map_err(|_| ())?;
                self.remember(&prepared.message);
                slot.send(Frame {
                    encoded: prepared.encoded,
                    _permit: permit,
                });
            }
        }
        Ok(())
    }

    pub async fn send(&self, message: Message) -> Result<(), ()> {
        self.send_prepared(PreparedFrame::from_message(message)?)
            .await
    }

    pub(crate) async fn send_prepared(&self, prepared: PreparedFrame) -> Result<(), ()> {
        if *self.closed.borrow() {
            return Err(());
        }
        let mut closed = self.subscribe_closed();
        let sending = async {
            match &self.tx {
                Target::Plain(tx) => {
                    let slot = tx.reserve().await.map_err(|_| ())?;
                    self.remember(&prepared.message);
                    slot.send((*prepared.message).clone());
                }
                Target::Bounded(tx, budget) => {
                    let permit = budget
                        .clone()
                        .acquire_many_owned(prepared.bytes)
                        .await
                        .map_err(|_| ())?;
                    let slot = tx.reserve().await.map_err(|_| ())?;
                    self.remember(&prepared.message);
                    slot.send(Frame {
                        encoded: prepared.encoded.clone(),
                        _permit: permit,
                    });
                }
            }
            Ok(())
        };
        tokio::select! {
            _ = closed.changed() => Err(()),
            result = tokio::time::timeout(std::time::Duration::from_secs(15), sending) => match result { Ok(result) => result, Err(_) => { self.close(); Err(()) } },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: i64) -> Message {
        Message::Request {
            id: RequestId::Number(id),
            method: "item/question/request".into(),
            params: serde_json::json!({}),
        }
    }
    #[tokio::test]
    async fn only_enqueued_requests_are_offered_and_close_wakes_blocked_sends() {
        let (sender, mut receiver) = channel(1);
        sender.try_send(request(1)).unwrap();
        assert!(sender.offered(&RequestId::Number(1)));
        assert!(sender.try_send(request(2)).is_err());
        assert!(!sender.offered(&RequestId::Number(2)));
        let waiting = {
            let sender = sender.clone();
            tokio::spawn(async move { sender.send(request(3)).await })
        };
        tokio::task::yield_now().await;
        sender.close();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(!sender.offered(&RequestId::Number(3)));
        drop(receiver.recv().await.unwrap());
    }
    #[tokio::test]
    async fn byte_budget_stays_owned_until_frame_write_finishes() {
        let (sender, mut receiver) = channel(256);
        let message = Message::Notification {
            method: "large".into(),
            params: serde_json::Value::String("x".repeat(20 * 1024 * 1024)),
        };
        sender.try_send(message.clone()).unwrap();
        let writing = receiver.recv().await.unwrap();
        assert!(sender.try_send(message.clone()).is_err());
        drop(writing);
        sender.try_send(message).unwrap();
    }
}
