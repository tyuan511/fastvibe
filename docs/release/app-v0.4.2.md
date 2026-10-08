### Improved

- **Long chats open instantly.** A chat now loads a bounded window of recent history and pulls older messages as you scroll up, prefetching the next page after the first paint — there is no pagination button and no extra row. Copy All still copies the whole conversation: it loads the remaining history first instead of copying only what is on screen.
- **A reconnect keeps what the screen was showing.** Events that arrive while the snapshot is in flight are held and merged by sequence, so a delta can no longer discard the snapshot (which used to leave Send disabled). A chat's own events are replayed when the host still holds them, and a snapshot is read when it does not; returning to the app or changing networks probes a quiet connection immediately.
- **Faster, steadier chat rendering.** The model catalog is cached for a minute, markdown reuses one parser, and completed replies keep their identity while a turn streams — editing the composer no longer redraws history, and streamed text no longer redraws the composer.
- **Sending a message is one call on a host that supports it.** The preview, queue preference and admission all happen host-side, so a queued message can no longer be recorded twice or lost between two calls. Older hosts, and chats reached through a desktop's SSH gateway, keep the previous sequence.
- **Connection diagnostics gained timings.** Settings → About → Copy connection diagnostics now includes socket, auth, welcome, snapshot, history and submission timings with replay-versus-snapshot outcomes, so a dropped connection can be investigated. Message contents are never included.

Update your FastVibe host to **v0.17.2 or newer** for bounded history, one-call sending and the retained-event replay.

This Android APK is signed with FastVibe's release key. Its SHA-256 checksum is included with the download. The iOS build is delivered through TestFlight.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.4.1...app-v0.4.2
