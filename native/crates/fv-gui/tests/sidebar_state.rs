use fv_gui::sidebar_state::{History, ordered, reordered, section};
use fv_protocol::types::{SidebarSettings, SidebarSort, Thread};

fn thread(id: &str, title: &str, updated_at: i64) -> Thread {
    Thread {
        id: id.into(),
        title: title.into(),
        updated_at,
        created_at: updated_at,
        cwd: None,
        project: None,
        source: None,
        archived: false,
        unread: false,
        model: None,
        thinking: None,
        pinned: false,
        worktree: None,
    }
}

#[test]
fn ordering_survives_activity_and_stale_ids_without_crossing_sections() {
    let (a, b, c) = (
        thread("a", "Zebra", 30),
        thread("b", "apple", 10),
        thread("c", "Bee", 20),
    );
    let mut prefs = SidebarSettings::default();
    prefs
        .order
        .insert("chats".into(), vec!["gone".into(), "b".into(), "a".into()]);
    prefs
        .order
        .insert("pinned".into(), vec!["a".into(), "b".into()]);
    let ids = |key, prefs: &SidebarSettings| {
        ordered(vec![&a, &b, &c], key, prefs)
            .iter()
            .map(|t| t.id.as_str())
            .collect::<Vec<_>>()
    };
    assert_eq!(ids("chats", &prefs), ["b", "a", "c"]);
    assert_eq!(ids("pinned", &prefs), ["a", "b", "c"]);
    prefs.sort = SidebarSort::Updated;
    assert_eq!(ids("chats", &prefs), ["a", "c", "b"]);
    prefs.sort = SidebarSort::Title;
    assert_eq!(ids("chats", &prefs), ["b", "c", "a"]);
    let mut pinned = a.clone();
    pinned.project = Some("/work".into());
    pinned.pinned = true;
    assert_eq!(section(&pinned, &["/work".into()]), "pinned");
    pinned.pinned = false;
    assert_eq!(section(&pinned, &["/work".into()]), "project:/work");
    assert_eq!(
        section(&pinned, &[]),
        "chats",
        "removed projects retain their chats"
    );
}

#[test]
fn drops_use_the_pointer_edge_after_removing_the_source() {
    let ids = vec!["a".into(), "b".into(), "c".into(), "d".into()];
    assert_eq!(
        reordered(&ids, "a", "c", false).unwrap(),
        ["b", "a", "c", "d"]
    );
    assert_eq!(
        reordered(&ids, "a", "c", true).unwrap(),
        ["b", "c", "a", "d"]
    );
    assert_eq!(
        reordered(&ids, "d", "a", false).unwrap(),
        ["d", "a", "b", "c"]
    );
    assert!(reordered(&ids, "a", "b", false).is_none());
    assert!(reordered(&ids, "a", "a", true).is_none());
    assert!(reordered(&ids, "gone", "b", true).is_none());
    assert!(reordered(&ids, "a", "gone", false).is_none());
}

#[test]
fn navigation_truncates_forward_history_and_skips_archived_or_deleted_threads() {
    let mut h = History::default();
    h.visit(None, Some("a".into()));
    h.visit(Some("a".into()), Some("b".into()));
    h.visit(Some("b".into()), Some("c".into()));
    assert_eq!(h.step(false, |id| id != "b"), Some(Some("a".into())));
    assert_eq!(h.step(false, |_| true), Some(None));
    assert_eq!(h.step(false, |_| true), None);
    assert_eq!(h.step(true, |_| true), Some(Some("a".into())));
    h.visit(Some("a".into()), Some("d".into()));
    assert!(!h.can_forward());
    assert_eq!(h.step(false, |_| true), Some(Some("a".into())));
    assert_eq!(h.step(true, |_| true), Some(Some("d".into())));
}
