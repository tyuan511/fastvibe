# Release notes / 更新说明

GitHub Releases publish the English notes with a link to Simplified Chinese at the top.
GitHub Release 以英文为正文，顶部提供简体中文链接。

| Release / 版本 | English | 简体中文 |
| --- | --- | --- |
| Desktop / 桌面端 v0.22.3 | [English](v0.22.3.md) | [简体中文](v0.22.3_zh-CN.md) |
| Desktop / 桌面端 v0.22.2 | [English](v0.22.2.md) | [简体中文](v0.22.2_zh-CN.md) |
| Desktop / 桌面端 v0.22.1 | [English](v0.22.1.md) | [简体中文](v0.22.1_zh-CN.md) |
| Desktop / 桌面端 v0.22.0 | [English](v0.22.0.md) | [简体中文](v0.22.0_zh-CN.md) |
| Mobile / 手机端 app-v0.5.10 | [English](app-v0.5.10.md) | [简体中文](app-v0.5.10_zh-CN.md) |
| Desktop / 桌面端 v0.21.0 | [English](v0.21.0.md) | [简体中文](v0.21.0_zh-CN.md) |
| Desktop / 桌面端 v0.20.5 | [English](v0.20.5.md) | [简体中文](v0.20.5_zh-CN.md) |
| Desktop / 桌面端 v0.20.4 | [English](v0.20.4.md) | [简体中文](v0.20.4_zh-CN.md) |
| Mobile / 手机端 app-v0.5.9 | [English](app-v0.5.9.md) | [简体中文](app-v0.5.9_zh-CN.md) |
| Desktop / 桌面端 v0.20.3 | [English](v0.20.3.md) | [简体中文](v0.20.3_zh-CN.md) |
| Mobile / 手机端 app-v0.5.8 | [English](app-v0.5.8.md) | [简体中文](app-v0.5.8_zh-CN.md) |

Older notes remain in this directory. Earlier releases may have only one language.
历史更新说明保留在本目录中，早期版本可能只有一种语言。添加新版本时同步更新上表。

## File and publishing contract

Write two aligned files before creating a release tag:

| Purpose | Desktop | Phone app |
| --- | --- | --- |
| English Release body | `vX.Y.Z.md` | `app-vX.Y.Z.md` |
| Simplified Chinese translation | `vX.Y.Z_zh-CN.md` | `app-vX.Y.Z_zh-CN.md` |

Commit both files under `docs/release/` with the version bump. The English file at the
tag **is** the GitHub Release body: `release.yml` and `mobile-android.yml` use it as
`body_path`. Every desktop packaging job and the mobile release build run
`scripts/check-release-note.mjs` first, before spending time on packaging.

New notes start with reciprocal **absolute URLs pinned to their release tag**. Relative
links resolve incorrectly when the file is used as a GitHub Release body or an in-app note.
For example, a future desktop release uses:

```markdown
**English** | [简体中文](https://github.com/tyuan511/fastvibe/blob/vX.Y.Z/docs/release/vX.Y.Z_zh-CN.md)
```

Its Chinese translation starts with:

```markdown
[English](https://github.com/tyuan511/fastvibe/blob/vX.Y.Z/docs/release/vX.Y.Z.md) | **简体中文**
```

Replace every `vX.Y.Z` with the actual tag, including the `app-` prefix for mobile releases.

## Writing and checks

- Write for users: explain shipped improvements, fixes, compatibility requirements, and migration
  steps. Keep desktop and phone changes in their respective releases.
- Keep the English and Chinese notes aligned, including limitations and required host versions.
  Use the interface labels for each language.
- Keep the same final `**Full Changelog**` compare URL in both files. The phone app hides this
  line, so keep that marker in English even in the Chinese file.
- Generate drafts with `.agents/skills/release/scripts/release-notes.mjs --tag <tag>` and
  `--tag <tag> --lang zh-CN`. The latter localizes headings and navigation; **commit text
  still needs rewriting and translation**.
- Run `node scripts/check-release-note.mjs --tag <tag>`. It rejects missing or empty notes
  and, when a language link or translation is present, missing or empty translations and
  incorrect reciprocal links. It does not judge prose language or translation quality.
  Historical single-language notes remain valid for rebuilds.
- Update the version links in the table above when adding new notes.

## Corrections to published notes

A file committed after publication is absent from the existing release tag. When backfilling
a translation, link both languages through `blob/main/docs/release/<filename>` and commit and
push those files before updating a public Release body. The backfilled v0.20.3 and app-v0.5.8
notes follow this rule. Do not move published tags to add documentation.

Editing a file on `main` does not update GitHub Release or in-app notes by itself. If the user
requests a public correction, back up the existing body, then use
`gh release edit <tag> --notes-file docs/release/<tag>.md`. Assets do not need rebuilding.
Rerunning the original workflow reads the old file at its tag again.

## Phone app notes

The phone app reads the English GitHub Release body: the update prompt shows the new version's
note, and Settings → About → Changelog shows the installed version's note. Both render Markdown,
including the link to Chinese; adding a translation does not change the app's language selection.

Draft mobile notes with `--tag app-vX.Y.Z`. The range starts at the previous `app-v` tag and
includes commits touching `apps/mobile_flutter`. Write for someone holding a phone, and state
any required desktop-host version in both languages.

The complete release workflow is in [the release skill](../../.agents/skills/release/SKILL.md).
