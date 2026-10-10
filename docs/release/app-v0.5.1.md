### Improved

- **Connecting to a nearby computer is much faster.** On a direct connection the app no longer compresses every frame, so opening a chat and following a reply keeps up. A relayed connection is unchanged.
- **A running chat downloads less.** When a tool call finishes, the app updates the row it already has instead of downloading the conversation again, and a model's thinking is delivered in batches rather than one piece per token.

Update your FastVibe host to **v0.18.1 or newer** for the faster direct connection.

This Android APK is signed with FastVibe's release key. Its SHA-256 checksum is included with the download. The iOS build is delivered through TestFlight.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.0...app-v0.5.1
