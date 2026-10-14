### Improved

- **Smoother chat.** Streaming replies repaint 30 times a second instead of on every frame, so long answers no longer stutter on 90/120 Hz screens. Typing in the message box no longer redraws the whole conversation. Large conversations, and replies carried over the relay, are now decoded off the main thread, so opening a long chat or reconnecting no longer freezes the screen for a moment.
- **Lighter glass effect.** The glass bars now use the lightweight rendering by default, and phones with little memory start with "Reduce glass effects" already on (Settings → Appearance). You can switch it either way.
- **Faster launch.** The app starts up in parallel, and the notification permission prompt no longer holds back the first screen on a fresh install.

### Fixed

- **"Update available" no longer offers the version you just installed.** After updating, reopening the app within ten minutes showed the same release again.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.7...app-v0.5.8
