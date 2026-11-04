**English** | [简体中文](https://github.com/tyuan511/fastvibe/blob/app-v0.5.14/docs/release/app-v0.5.14_zh-CN.md)

### Rebuilt

- **The app is now Flutter on both platforms, replacing the separate native Android and iOS screens.** Everything is new: account sign-in through your browser, the devices list with favorites, connection progress and diagnostics, conversations with live thinking and tool cards, model switching, the composer with photo attachments and queued messages, background notifications, connection diagnostics you can copy, and the in-app updater with release notes. Android installs over the previous version — your account, saved computers and preferences carry over, and credentials from the earlier native app are migrated on first launch.
- Conversations keep everything in source order — thinking, tool calls and their results, model switches, compaction — with older turns loaded as you scroll back, full-chat search, and message actions on long press.
- On the same Wi-Fi as your computer, a **LAN / 局域网** badge appears on a computer when the local discovery record matches its account identity: connecting prefers the direct path and only falls back to the relay when the direct route fails.

### Improved

- The relay list from your account is consumed in full: every configured node is used, so one relay being offline no longer blocks connecting, and an invalid list is reported instead of half-working.
- Transcript scrolling lands on the true bottom, and the update channel follows the new release layout.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.13...app-v0.5.14

This app needs the FastVibe desktop host on **v0.26.0 or newer** (multi-relay configuration and local discovery advertising).
