//! Sidebar ordering and navigation, independent of the window system.
use fv_protocol::types::{SidebarSettings, SidebarSort, Thread};

pub fn section(thread: &Thread, projects: &[String]) -> String {
    if thread.pinned {
        "pinned".into()
    } else if let Some(path) = thread.project.as_ref().filter(|p| projects.contains(p)) {
        format!("project:{path}")
    } else {
        "chats".into()
    }
}

pub fn ordered<'a>(
    mut threads: Vec<&'a Thread>,
    key: &str,
    prefs: &SidebarSettings,
) -> Vec<&'a Thread> {
    let order = prefs.order.get(key);
    threads.sort_by(|a, b| {
        let recent = || {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        };
        match prefs.sort {
            SidebarSort::Manual => {
                let rank = |id: &String| {
                    order
                        .and_then(|ids| ids.iter().position(|x| x == id))
                        .unwrap_or(usize::MAX)
                };
                rank(&a.id).cmp(&rank(&b.id)).then_with(recent)
            }
            SidebarSort::Updated => recent(),
            SidebarSort::Created => b.created_at.cmp(&a.created_at).then_with(recent),
            SidebarSort::Title => a
                .title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(recent),
        }
    });
    threads
}

/// Insert relative to a target after lifting the source out. Unknown IDs never enter the list.
pub fn reordered(ids: &[String], source: &str, target: &str, after: bool) -> Option<Vec<String>> {
    if source == target || !ids.iter().any(|id| id == source) {
        return None;
    }
    let mut next: Vec<_> = ids
        .iter()
        .filter(|id| id.as_str() != source)
        .cloned()
        .collect();
    let index = next.iter().position(|id| id == target)? + usize::from(after);
    next.insert(index, source.into());
    (next != ids).then_some(next)
}

#[derive(Default)]
pub struct History {
    entries: Vec<Option<String>>,
    cursor: usize,
}

impl History {
    pub fn visit(&mut self, previous: Option<String>, next: Option<String>) {
        if previous == next {
            return;
        }
        if self.entries.is_empty() {
            self.entries.push(previous);
        }
        self.entries.truncate(self.cursor + 1);
        self.entries.push(next);
        self.cursor = self.entries.len() - 1;
    }
    pub fn can_back(&self) -> bool {
        self.cursor > 0
    }
    pub fn can_forward(&self) -> bool {
        self.cursor + 1 < self.entries.len()
    }
    pub fn step(&mut self, forward: bool, exists: impl Fn(&str) -> bool) -> Option<Option<String>> {
        loop {
            if forward {
                if !self.can_forward() {
                    return None;
                }
                self.cursor += 1;
            } else {
                if !self.can_back() {
                    return None;
                }
                self.cursor -= 1;
            }
            let entry = self.entries[self.cursor].clone();
            if entry.as_deref().is_none_or(&exists) {
                return Some(entry);
            }
        }
    }
}
