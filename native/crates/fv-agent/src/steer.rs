//! Steering: something the user says *while* a run is working.
//!
//! Codex's shape, kept deliberately: the words are not a new turn and they do not interrupt
//! anything — they sit in a queue until the loop is about to build its next model request, and
//! the request then contains them as a user message. So a run that is halfway through a tool
//! batch gets the correction before its next decision, and a run that has already answered
//! simply ends (in codex that pending input then starts a fresh turn; here the server asks, see
//! `turn::drain_queue`, because the client that queued it may be gone).
//!
//! Three properties matter and each one is why this is a queue rather than a direct call:
//!
//! - **A steer can never split a tool batch.** It is drained at the top of the loop, where the
//!   history ends with the results of the previous batch, so a provider never sees a user
//!   message wedged between a call and its result.
//! - **A steer that arrives too late is not lost.** If the model answered before the drain, the
//!   server turns it into an ordinary queued prompt (`QueuePauseReason` not involved: it is a
//!   user prompt and it runs).
//! - **A steer can be refused.** When the run ends (or never started) the queue is still there
//!   for the next one, so a client that steered a turn that is already over gets its words
//!   instead of a silent drop.

use std::sync::Mutex;

/// Words waiting to be added to a live run, oldest first.
#[derive(Default)]
pub struct Steers {
    pending: Mutex<Vec<String>>,
}

impl Steers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Accept a steer. Returns `false` when the run has already finished draining — the caller
    /// then has a plain prompt on its hands, not a steer.
    pub fn push(&self, text: String) {
        self.pending.lock().unwrap().push(text);
    }

    /// Everything waiting, in the order it was said. Taken at the top of the model loop.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.pending.lock().unwrap())
    }

    /// How many are waiting: a run that is about to end still has to run them, so the turn loop
    /// asks this rather than assuming its own answer is final.
    pub fn len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Put words back, at the front, in their original order — for a run that was interrupted
    /// after they were drained but before they reached the history.
    pub fn push_front(&self, texts: Vec<String>) {
        let mut pending = self.pending.lock().unwrap();
        for text in texts.into_iter().rev() {
            pending.insert(0, text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steers_are_drained_in_the_order_they_were_said() {
        let steers = Steers::new();
        steers.push("first".into());
        steers.push("second".into());
        assert_eq!(steers.len(), 2);
        assert_eq!(steers.take(), ["first", "second"]);
        assert!(steers.is_empty());
    }

    #[test]
    fn putting_them_back_restores_the_order() {
        let steers = Steers::new();
        steers.push("already waiting".into());
        steers.push_front(vec!["first".into(), "second".into()]);
        assert_eq!(
            steers.take(),
            ["first", "second", "already waiting"],
            "a later steer keeps its place behind the ones put back"
        );
    }
}
