**English** | [简体中文](https://github.com/tyuan511/fastvibe/blob/native-v0.1.0/docs/release/native-v0.1.0_zh-CN.md)

## Native macOS preview

- First standalone Rust / GPUI preview for Apple Silicon Macs running macOS 14 or later.
- Installs as **FastVibe Native** alongside the Electron app and keeps its own `FastVibeNative` data directory. Existing Electron data is not imported automatically.
- Includes the native agent server, built-in skills and pinned OfficeCLI resources.
- In **Settings → About**, check for native preview updates, download and verify them, then restart to install. Native previews use their own update channel; Electron users are not prompted to upgrade to them.

## Preview limitations

- Release packages are signed with Developer ID and notarized by Apple. Move the extracted app to Applications. PR artifacts and manual builds with notarization disabled use ad-hoc signatures and may require manual first-launch approval in macOS security settings.
- Windows, Linux and Intel Macs are not included in this preview.
- Remote access, mobile integration and full Electron data migration are still in progress. This preview does not replace the Electron release.

**Full Changelog**: https://github.com/tyuan511/fastvibe/commits/native-v0.1.0
