**English** | [简体中文](https://github.com/tyuan511/fastvibe/blob/app-v0.5.10/docs/release/app-v0.5.10_zh-CN.md)

### Added

- **Office documents open on the phone.** A `.docx`, `.xlsx` or `.pptx` from a conversation — tapped in a reply's file row or in the output list — now shows its real layout instead of leaving you a bare download: the host lays the page out and the phone draws it.

### Improved

- **The app draws flat surfaces, and it is faster for it.** The liquid-glass chrome (scroll-edge blur, content-aware brightness, its own glass composer and buttons) made chats stutter on mid-range Android phones; those layers are gone. The **Reduce glass effects** setting went with them — there is nothing left to reduce — and the original palette, corner radii and spinner are back.
- A quick sync no longer flashes *Syncing latest messages*. The banner now waits 1.5 seconds, so a sync that finishes immediately says nothing at all.

### Fixed

- **The transcript is as wide as the composer.** The message list was inset further than the input box, so a conversation looked narrower than the thing you type into, and a reply's text was inset once more on top of that; both now line up with the composer card.

Office documents are laid out by the machine that holds them, so this needs your FastVibe desktop host on **v0.21.0 or newer**. An SSH host needs an Agent runtime built from **v0.21.0 or later** — Agent runtime v14 cannot render a document, and nothing on the phone can do it instead.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.9...app-v0.5.10
