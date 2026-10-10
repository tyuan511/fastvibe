### Improved

- **A relayed connection no longer ends when the relay's credential runs out.** Credentials are short-lived now. Shortly before one expires, the app opens a second connection with a fresh credential and moves your session onto it, then closes the first. The open chat picks up where it was, and no "reconnecting" banner shows. A direct connection is untouched.
- **Reconnecting is quicker.** A broken path is noticed sooner, a signaling connection is reused by the next call for a short while, and the phone's own addresses no longer crowd out the public address and the relay when pairing.

Update your FastVibe host to **v0.19.0 or newer** so a relayed session can move to its new connection without being dropped.

This Android APK is signed with FastVibe's release key. Its SHA-256 checksum is included with the download. The iOS build is delivered through TestFlight.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.1...app-v0.5.2
