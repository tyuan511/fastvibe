### Improved

- **Long replies open straight away.** A reply is now laid out one block at a time, so the app paints only what is on screen instead of re-reading and re-laying out the whole message on every streamed frame — a 376 KB reply (a model that had started repeating itself) took seconds to open before. Code blocks, formulas, list numbering and tables are never split across blocks, and the Markdown theme is built once instead of on every frame. A long thinking block gets the same treatment inside its card.
- **The todo list expands, as it does on the desktop.** Tap the checklist card above the composer to see every item rather than just the one in progress.

### Fixed

- **The update dialog's button says "Installing…"** instead of the longer "Opening the installer…".

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.4...app-v0.5.5
