**English** | [简体中文](https://github.com/tyuan511/fastvibe/blob/app-v0.5.11/docs/release/app-v0.5.11_zh-CN.md)

### Added

- **The phone app is rebuilt, and it connects over iroh.** The Flutter app is replaced by a native Android client on a shared Rust core. It reaches your computer through the account-authenticated iroh transport: sign in to the same FastVibe account and your computer is there — no LAN password, no QR code, no address to type. A connection that cannot go direct falls back to the relay.
- **A conversation list you can filter.** Recent conversations come first, with filters for 全部会话 / 运行中 / 等你操作 / 未读 / 已归档 and by project, plus a search box. A conversation waiting on you is marked, and can raise a notification.
- **Replies render in source order.** Thinking blocks, tool calls, their results, model switches and compaction all appear where they happened, the same as on the desktop, and the list draws lazily — older turns are fetched as you scroll back instead of loading the whole transcript at once.
- **Output files download properly.** Tapping a file a reply produced downloads it in checked chunks: the size and modification time are verified as it goes, so a file that changed mid-download is reported instead of saved half-written.

### Improved

- Drafts survive a failed or uncertain send: if the phone cannot tell whether a prompt went out, the text stays in the composer rather than disappearing.
- Sending a conversation operation now waits for the computer's own answer, so a tap that the connection dropped shows as unfinished instead of silently succeeding.
- The in-app update screen checks for a new build, downloads it with a checksum, and shows that release's notes before installing.

### Upgrading

This build installs over the existing Flutter app — same app id, and a higher version code — so your sign-in and saved computers carry over. Old credentials are migrated on first launch, and the previous app's data is left in place.

The iroh transport is new on the computer side, so this needs your FastVibe desktop host on **v0.24.0 or newer**. A host on an older version will not appear as connectable.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.10...app-v0.5.11
