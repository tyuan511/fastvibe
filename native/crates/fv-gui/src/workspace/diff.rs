//! Reading a unified diff into rows, so the pane can draw a gutter with real line numbers rather
//! than counting rows.
//!
//! The Electron app's `lib/diff.ts`, and the same two shapes are first class here:
//!
//! - A **real** unified diff (`git diff`, a `.patch`): `@@ -12,4 +12,4 @@` carries the numbers,
//!   and both counters follow from it.
//! - **pi's edit format**, which has no headers at all: the file's own line number is baked into
//!   every row (`- 12   label: 'x'`, context rows padded to the same column). Those numbers are
//!   read back out.
//!
//! A hand-written ```diff fence has neither, and renders **unnumbered** — which is the point:
//! a gutter that counted rows put an invented number next to a real one.

/// What one row of a diff is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Added,
    Removed,
    Context,
    /// An `@@ … @@` header, which starts a new block.
    Hunk,
    /// `diff --git`, `index …`, `--- a/x`, `+++ b/x`, a mode change, `Binary files …`.
    Meta,
    /// pi's "context lines were dropped here" row.
    Skip,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffRow {
    pub kind: RowKind,
    /// The unified diff's first character, blank on header rows. Kept because a line whose
    /// content itself starts with `+` is not an addition.
    pub marker: char,
    /// The line without its marker, and without a baked-in number.
    pub text: String,
    pub old_number: Option<u64>,
    pub new_number: Option<u64>,
    /// Which `@@` block this row belongs to, for "jump to the next change".
    pub hunk: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffDocument {
    pub rows: Vec<DiffRow>,
    /// Digits a line number needs, or `0` when the diff carries none — so the pane draws no
    /// gutter at all rather than an empty one.
    pub number_width: usize,
    /// How many `@@` blocks there are.
    pub hunks: usize,
}

fn is_hunk(line: &str) -> Option<(u64, u64)> {
    // `@@ -a,b +c,d @@`, with the counts optional.
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, tail) = rest.split_once(" @@")?;
    let _ = tail;
    let old_start = old.split(',').next()?.parse().ok()?;
    let new_start = new.split(',').next()?.parse().ok()?;
    Some((old_start, new_start))
}

fn is_meta(line: &str) -> bool {
    const PREFIXES: [&str; 22] = [
        "diff --git ",
        "diff --",
        "index ",
        "--- ",
        "+++ ",
        "old mode ",
        "new mode ",
        "new file mode ",
        "deleted file mode ",
        "similarity index ",
        "dissimilarity index ",
        "rename from ",
        "rename to ",
        "copy from ",
        "copy to ",
        "Binary files ",
        "\\ No newline",
        "GIT binary patch",
        "literal ",
        "delta ",
        "Submodule ",
        "mode change ",
    ];
    PREFIXES.iter().any(|prefix| line.starts_with(prefix))
}

/// pi's numbered row: marker, a right-aligned number field, one space, the line.
fn baked(line: &str) -> Option<(char, usize, u64, &str)> {
    let marker = line.chars().next()?;
    if !matches!(marker, '+' | '-' | ' ') {
        return None;
    }
    let rest = &line[marker.len_utf8()..];
    // The number field is blanks then digits; the body starts at the first space **after** the
    // digits. Scanning for the end of the digits, not of "digits and spaces", is what tells a
    // padded field (`  9 body`) from a body that begins with spaces.
    let number_start = rest.find(|c: char| c.is_ascii_digit())?;
    if !rest[..number_start].chars().all(|c| c == ' ') {
        return None;
    }
    let digits_end = rest[number_start..]
        .find(|c: char| !c.is_ascii_digit())
        .map(|at| number_start + at)?;
    let digits = &rest[number_start..digits_end];
    let body = rest[digits_end..].strip_prefix(' ')?;
    let column = 1 + number_start + digits.len();
    Some((marker, column, digits.parse().ok()?, body))
}

/// pi's "context lines were dropped here" row — a number field of blanks.
fn is_elision(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && trimmed.chars().all(|c| c == '.') && line.starts_with(' ')
}

/// Whether these lines are pi's numbered format **and nothing else**: every content row carries
/// a number ending in the same column, and at least one of them is a change. A hand-written diff
/// fails that — its context lines are plain text — and a numbered-looking prose line cannot pass
/// on its own.
fn baked_field(lines: &[&str]) -> Option<usize> {
    let mut end: Option<usize> = None;
    let mut numbered = 0;
    let mut changed = 0;
    for line in lines {
        if is_elision(line) {
            continue;
        }
        let first = line.chars().next()?;
        if !matches!(first, '+' | '-' | ' ') {
            return None;
        }
        // pi pads *before* the number so every body starts at the same column, which means the
        // column is where the number ends. That is the invariant; the field's width is not.
        let (marker, column, _, _) = baked(line)?;
        match end {
            None => end = Some(column),
            Some(known) if known != column => return None,
            Some(_) => {}
        }
        numbered += 1;
        if marker != ' ' {
            changed += 1;
        }
    }
    if numbered >= 2 && changed > 0 {
        end
    } else {
        None
    }
}

/// Parse a diff into rows. Never fails: an unreadable line is a context row, because a diff the
/// pane cannot parse is still something the reader wants to see.
pub fn parse(text: &str) -> DiffDocument {
    let normalised = text.replace("\r\n", "\n");
    let normalised = normalised.strip_suffix('\n').unwrap_or(&normalised);
    let lines: Vec<&str> = normalised.split('\n').collect();
    // Hunk headers win where they exist; pi's baked numbers only make sense without them.
    let has_hunks = lines.iter().any(|line| is_hunk(line).is_some());
    let baked_width = if has_hunks { None } else { baked_field(&lines) };

    let mut rows = Vec::new();
    let (mut old_no, mut new_no) = (0u64, 0u64);
    let mut counted = false;
    let mut old_remaining = 0u64;
    let mut new_remaining = 0u64;
    let mut hunk = 0usize;
    let mut hunks = 0usize;

    for line in &lines {
        if let Some((old_start, new_start)) = is_hunk(line) {
            // The counts are re-derived from the header so `counted` knows when a block ends.
            let counts = line
                .split(" @@")
                .next()
                .and_then(|head| {
                    head.split(' ')
                        .collect::<Vec<_>>()
                        .get(1..)
                        .map(|v| v.to_vec())
                })
                .unwrap_or_default();
            let count_of = |field: &str| -> u64 {
                field
                    .split(',')
                    .nth(1)
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(1)
            };
            let old_count = counts.first().map(|f| count_of(f)).unwrap_or(1);
            let new_count = counts.get(1).map(|f| count_of(f)).unwrap_or(1);
            let _ = (&counts, old_count, new_count);
            old_no = old_start;
            new_no = new_start;
            old_remaining = old_count;
            new_remaining = new_count;
            counted = old_remaining > 0 || new_remaining > 0;
            hunk += 1;
            hunks += 1;
            rows.push(DiffRow {
                kind: RowKind::Hunk,
                marker: ' ',
                text: line.to_string(),
                old_number: None,
                new_number: None,
                hunk,
            });
            continue;
        }
        if is_meta(line)
            && (!counted || line.starts_with("diff --") || line.starts_with("\\ No newline"))
        {
            rows.push(DiffRow {
                kind: RowKind::Meta,
                marker: ' ',
                text: line.to_string(),
                old_number: None,
                new_number: None,
                hunk,
            });
            continue;
        }
        if baked_width.is_some() {
            if is_elision(line) {
                rows.push(DiffRow {
                    kind: RowKind::Skip,
                    marker: ' ',
                    text: line.trim().to_string(),
                    old_number: None,
                    new_number: None,
                    hunk,
                });
                continue;
            }
            if let Some((marker, _, number, body)) = baked(line) {
                let kind = match marker {
                    '+' => RowKind::Added,
                    '-' => RowKind::Removed,
                    _ => RowKind::Context,
                };
                rows.push(DiffRow {
                    kind,
                    marker,
                    text: body.to_string(),
                    // A baked number is the file's own line: an old line for a removal, a new line
                    // for everything else.
                    old_number: (marker != '+').then_some(number),
                    new_number: (marker != '-').then_some(number),
                    hunk,
                });
                continue;
            }
        }
        let marker = line.chars().next().unwrap_or(' ');
        let kind = match marker {
            '+' => RowKind::Added,
            '-' => RowKind::Removed,
            _ => RowKind::Context,
        };
        let marker = if matches!(marker, '+' | '-' | ' ') {
            marker
        } else {
            ' '
        };
        let body = if marker == ' ' && !line.starts_with(' ') {
            line.to_string()
        } else {
            line[marker.len_utf8()..].to_string()
        };
        let mut row = DiffRow {
            kind,
            marker,
            text: body,
            old_number: None,
            new_number: None,
            hunk,
        };
        if counted {
            if kind != RowKind::Added {
                row.old_number = Some(old_no);
                old_no += 1;
                old_remaining = old_remaining.saturating_sub(1);
            }
            if kind != RowKind::Removed {
                row.new_number = Some(new_no);
                new_no += 1;
                new_remaining = new_remaining.saturating_sub(1);
            }
            counted = old_remaining > 0 || new_remaining > 0;
        }
        rows.push(row);
    }

    let number_width = rows
        .iter()
        .map(|row| row.old_number.unwrap_or(0).max(row.new_number.unwrap_or(0)))
        .max()
        .map(|max| if max == 0 { 0 } else { max.to_string().len() })
        .unwrap_or(0);
    DiffDocument {
        rows,
        number_width,
        hunks,
    }
}

/// One row of a side-by-side view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitRow {
    pub left: Option<DiffRow>,
    pub right: Option<DiffRow>,
    /// A row that spans both columns (a hunk header, a meta line).
    pub header: Option<DiffRow>,
    /// The row in the unified document this came from.
    pub source: usize,
}

/// Pair **only adjacent** removals and additions inside one change block; context and hunk
/// headers are boundaries. Pairing across a context line would show a rewrite as if the two lines
/// it left alone had changed too.
pub fn split(rows: &[DiffRow]) -> Vec<SplitRow> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < rows.len() {
        let row = &rows[index];
        if matches!(row.kind, RowKind::Removed | RowKind::Added) {
            let start = index;
            let mut left: Vec<&DiffRow> = Vec::new();
            let mut right: Vec<&DiffRow> = Vec::new();
            while index < rows.len()
                && matches!(rows[index].kind, RowKind::Removed | RowKind::Added)
            {
                if rows[index].kind == RowKind::Removed {
                    left.push(&rows[index]);
                } else {
                    right.push(&rows[index]);
                }
                index += 1;
            }
            for offset in 0..left.len().max(right.len()) {
                out.push(SplitRow {
                    left: left.get(offset).map(|r| (*r).clone()),
                    right: right.get(offset).map(|r| (*r).clone()),
                    header: None,
                    source: start + offset,
                });
            }
        } else {
            let pair = row.kind == RowKind::Context;
            out.push(SplitRow {
                left: pair.then(|| row.clone()),
                right: pair.then(|| row.clone()),
                header: (!pair).then(|| row.clone()),
                source: index,
            });
            index += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_diff_carries_its_own_line_numbers() {
        let text = "diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+2\n+three\n end\n";
        let doc = parse(text);
        assert_eq!(doc.number_width, 1);
        assert_eq!(doc.hunks, 1);
        // Header rows carry no numbers, so the gutter does not invent them.
        assert_eq!(doc.rows[0].kind, RowKind::Meta);
        assert_eq!(doc.rows[0].old_number, None);
        let context: Vec<&DiffRow> = doc
            .rows
            .iter()
            .filter(|r| r.kind == RowKind::Context)
            .collect();
        assert_eq!(
            (context[0].old_number, context[0].new_number),
            (Some(1), Some(1)),
            "the first context line is line 1 on both sides"
        );
        let removed = doc
            .rows
            .iter()
            .find(|r| r.kind == RowKind::Removed)
            .unwrap();
        assert_eq!(
            (removed.old_number, removed.new_number),
            (Some(2), None),
            "a removal has an old line and no new one"
        );
        let added: Vec<&DiffRow> = doc
            .rows
            .iter()
            .filter(|r| r.kind == RowKind::Added)
            .collect();
        assert_eq!((added[0].old_number, added[0].new_number), (None, Some(2)));
        assert_eq!((added[1].old_number, added[1].new_number), (None, Some(3)));
        let last = doc
            .rows
            .iter()
            .rev()
            .find(|r| r.kind == RowKind::Context)
            .unwrap();
        assert_eq!((last.old_number, last.new_number), (Some(3), Some(4)));
    }

    #[test]
    fn the_line_content_is_kept_without_its_marker_so_a_leading_plus_is_not_an_addition() {
        let text = "@@ -1,1 +1,2 @@\n context\n+++this line starts with a plus\n";
        let doc = parse(text);
        let added = doc.rows.iter().find(|r| r.kind == RowKind::Added).unwrap();
        assert_eq!(added.text, "++this line starts with a plus");
    }

    #[test]
    fn a_hand_written_fence_has_no_numbers_and_gets_no_gutter() {
        let text = "-old\n+new";
        let doc = parse(text);
        assert_eq!(doc.number_width, 0, "no invented numbers");
        assert!(
            doc.rows
                .iter()
                .all(|r| r.old_number.is_none() && r.new_number.is_none())
        );
    }

    #[test]
    fn pis_baked_numbers_are_read_back_out() {
        // pi's format: marker, a **padded** number field so every body starts at one column, one
        // space, the line. The padding is what the format detection keys on.
        let text = "   9 line nine\n- 10 line ten\n+ 10 replacement\n  11 line eleven";
        let doc = parse(text);
        assert_eq!(doc.number_width, 2);
        let removed = doc
            .rows
            .iter()
            .find(|r| r.kind == RowKind::Removed)
            .unwrap();
        assert_eq!(removed.old_number, Some(10));
        assert_eq!(removed.text, "line ten");
        let added = doc.rows.iter().find(|r| r.kind == RowKind::Added).unwrap();
        assert_eq!(added.new_number, Some(10));
    }

    #[test]
    fn a_prose_line_that_looks_numbered_cannot_pass_as_a_diff() {
        // One numbered line is not a diff: the format needs at least two rows and one change.
        let text = "+ 12 not a diff row";
        let doc = parse(text);
        assert_eq!(doc.number_width, 0);
    }

    #[test]
    fn a_block_ends_when_its_counts_run_out() {
        // Two hunks: the second one's numbers come from its own header, not from counting on.
        let text = "@@ -1,1 +1,1 @@\n a\n@@ -50,1 +50,1 @@\n b\n";
        let doc = parse(text);
        assert_eq!(doc.hunks, 2);
        let contexts: Vec<&DiffRow> = doc
            .rows
            .iter()
            .filter(|r| r.kind == RowKind::Context)
            .collect();
        assert_eq!(contexts[0].old_number, Some(1));
        assert_eq!(contexts[1].old_number, Some(50));
    }

    #[test]
    fn a_change_block_pairs_only_adjacent_rows() {
        let text = "@@ -1,4 +1,4 @@\n-a\n-b\n+c\n+d\n same\n-e\n+f\n";
        let doc = parse(text);
        let rows = split(&doc.rows);
        // The hunk header spans both columns.
        assert!(rows[0].header.is_some());
        // `a`/`b` pair with `c`/`d`.
        assert_eq!(rows[1].left.as_ref().map(|r| r.text.as_str()), Some("a"));
        assert_eq!(rows[1].right.as_ref().map(|r| r.text.as_str()), Some("c"));
        // The context row is on both sides, and it *breaks* the pairing: `e`/`f` are a new block.
        let context = rows
            .iter()
            .find(|r| r.left.as_ref().is_some_and(|l| l.kind == RowKind::Context));
        assert!(context.is_some(), "a context row spans both columns");
        let last = rows.last().unwrap();
        assert_eq!(last.left.as_ref().map(|r| r.text.as_str()), Some("e"));
        assert_eq!(last.right.as_ref().map(|r| r.text.as_str()), Some("f"));
    }
}
