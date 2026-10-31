//! Capacity learned from actual refusals. It belongs to one conversation, never provider
//! configuration; a different route/model/declared window gets an independent budget.

use std::collections::HashMap;
use std::hash::Hasher;
use std::sync::{Arc, Mutex};

use crate::{Model, ModelRequest};
use fv_core::{Message, estimate_tokens};

pub const MAX_CAPACITY_RECOVERIES: usize = 6;

#[derive(Clone)]
struct Fingerprint {
    count: usize,
    hash: u64,
}

#[derive(Clone)]
struct Capacity {
    ceiling: u64,
    blocked: Option<Fingerprint>,
    shrinks: usize,
}

#[derive(Default)]
pub struct ContextBudget {
    limits: Mutex<HashMap<String, Capacity>>,
}

fn key(model: &dyn Model) -> String {
    format!("{}/{}", model.context_key(), crate::context_window(model))
}

fn fingerprint(messages: &[Message]) -> u64 {
    struct Writer<'a>(&'a mut std::hash::DefaultHasher);
    impl std::io::Write for Writer<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.write(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hash = std::hash::DefaultHasher::new();
    for message in messages {
        let _ = serde_json::to_writer(Writer(&mut hash), message);
    }
    hash.finish()
}

impl ContextBudget {
    pub fn window(&self, model: &dyn Model) -> u64 {
        self.limits
            .lock()
            .unwrap()
            .get(&key(model))
            .map(|c| c.ceiling)
            .unwrap_or_else(|| crate::context_window(model))
    }

    pub fn learned(&self, model: &dyn Model) -> bool {
        self.limits
            .lock()
            .unwrap()
            .get(&key(model))
            .is_some_and(|c| c.ceiling < crate::context_window(model))
    }

    /// Halve the rejected request, including answer room, rather than an advertised window
    /// that may be orders of magnitude larger. Only a real capacity failure calls this.
    pub fn reject(&self, model: &dyn Model, input: u64, output: u64) -> bool {
        let declared = crate::context_window(model);
        let floor = (declared / 4).clamp(128, 2048).min(declared);
        let mut limits = self.limits.lock().unwrap();
        let entry = limits.entry(key(model)).or_insert(Capacity {
            ceiling: declared,
            blocked: None,
            shrinks: 0,
        });
        if entry.shrinks >= MAX_CAPACITY_RECOVERIES {
            return false;
        }
        let smaller = (entry.ceiling.min(
            input
                .saturating_add(output)
                .saturating_add(margin(entry.ceiling)),
        ) / 2)
            .max(floor);
        if smaller >= entry.ceiling {
            return false;
        }
        entry.ceiling = smaller;
        entry.shrinks += 1;
        true
    }

    pub fn block(&self, model: &dyn Model, history: &[Message]) {
        let mut limits = self.limits.lock().unwrap();
        let entry = limits.entry(key(model)).or_insert(Capacity {
            ceiling: crate::context_window(model),
            blocked: None,
            shrinks: 0,
        });
        entry.blocked = Some(Fingerprint {
            count: history.len(),
            hash: fingerprint(history),
        });
    }

    pub fn blocked(&self, model: &dyn Model, history: &[Message]) -> bool {
        let blocked = self
            .limits
            .lock()
            .unwrap()
            .get(&key(model))
            .and_then(|c| c.blocked.clone());
        blocked
            .is_some_and(|b| history.len() >= b.count && fingerprint(&history[..b.count]) == b.hash)
    }

    pub fn recovered(&self, model: &dyn Model) {
        if let Some(c) = self.limits.lock().unwrap().get_mut(&key(model)) {
            c.blocked = None;
            c.shrinks = 0;
        }
    }

    pub(crate) fn probe(self: &Arc<Self>, model: &dyn Model) -> Probe {
        let key = key(model);
        let saved = self.limits.lock().unwrap().remove(&key);
        Probe {
            budget: self.clone(),
            key,
            saved,
            committed: false,
        }
    }
}

pub(crate) struct Probe {
    budget: Arc<ContextBudget>,
    key: String,
    saved: Option<Capacity>,
    committed: bool,
}
impl Probe {
    pub fn commit(&mut self) {
        self.committed = true;
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        if !self.committed {
            let mut limits = self.budget.limits.lock().unwrap();
            limits.remove(&self.key);
            if let Some(saved) = self.saved.take() {
                limits.insert(self.key.clone(), saved);
            }
        }
    }
}

pub fn margin(window: u64) -> u64 {
    (window / 8).min(4096)
}
pub fn reply_reserve(model: &dyn Model, window: u64) -> u64 {
    u64::from(model.max_output_tokens().unwrap_or(4096))
        .min(4096)
        .min(window / 4)
        .max(1)
}

/// The provider's count includes system/tools. Without a measured count, account for that
/// prefix explicitly; the estimate of authored content alone cannot bound a request.
pub fn request_tokens(request: &ModelRequest) -> u64 {
    crate::context_used(&request.messages).max(
        estimate_tokens(&request.messages)
            .saturating_add(prefix_tokens(&request.system, &request.tools)),
    )
}

pub fn prefix_tokens(system: &str, tools: &[crate::ToolSpec]) -> u64 {
    let prefix = system.len() as u64
        + tools
            .iter()
            .map(|t| {
                (t.name.len() + t.description.len() + fv_core::estimate_json_bytes(&t.schema) + 64)
                    as u64
            })
            .sum::<u64>();
    prefix.div_ceil(3)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::ScriptedModel;

    #[test]
    fn budgets_shrink_real_requests_and_block_only_the_unchanged_history_prefix() {
        let model = ScriptedModel::default().with_window(1_000_000);
        let budgets = Arc::new(ContextBudget::default());
        assert!(budgets.reject(&model, 20_000, 4096));
        assert!(budgets.window(&model) < 20_000);
        let history = vec![Message::User {
            text: "work".into(),
        }];
        budgets.block(&model, &history);
        let mut continued = history.clone();
        continued.push(Message::User {
            text: "continue".into(),
        });
        assert!(budgets.blocked(&model, &continued));
        assert!(!budgets.blocked(
            &model,
            &[Message::User {
                text: "edited".into()
            }]
        ));
        let other = ScriptedModel::default().with_window(1_000_000);
        assert_eq!(budgets.window(&other), 1_000_000);
        let window = budgets.window(&model);
        {
            let _probe = budgets.probe(&model);
            assert_eq!(budgets.window(&model), 1_000_000);
        }
        assert_eq!(budgets.window(&model), window);
        assert!(budgets.blocked(&model, &history));
        {
            let mut probe = budgets.probe(&model);
            probe.commit();
        }
        assert_eq!(budgets.window(&model), 1_000_000);
        assert!(!budgets.blocked(&model, &history));
    }
}
