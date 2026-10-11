### Fixed

- **A long chat no longer stutters when the keyboard closes.** Leaving the composer used to resize the whole conversation on every frame of the keyboard animation, so every visible message was laid out again. The transcript now keeps its size, and only the composer moves up with the keyboard.
- **Scrolling follows the phone's high refresh rate on Android.** Some Android skins kept the app at 60 Hz, so the conversation list and an open chat scrolled at 60 frames even on a 120 Hz screen. The app now asks for the panel's highest rate.

This Android APK is signed with FastVibe's release key. Its SHA-256 checksum is included with the download. The iOS build is delivered through TestFlight.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.2...app-v0.5.3
