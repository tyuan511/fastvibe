### Improved

- **Connecting to your computer from another network works in more places.** On a network that lets no UDP out, such as some offices, hotels and campuses, the app now notices within a few seconds and tries again through the relay over TCP (over TLS on port 443 when it is offered), instead of waiting until the attempt fails. When your phone has a public IPv6 address, it is now offered to your computer even if the phone has many local IPv4 addresses, which used to crowd it out. The app also uses the connection path your computer actually selected, so the direct/relay indicator is accurate.
- **Better direct connections through some routers.** The app now understands the batch of extra address guesses your computer sends when its router hands out ports in order, and tries each of them. This works best with your FastVibe host on **v0.19.3 or newer**; older hosts connect as before.

This Android APK is signed with FastVibe's release key. Its SHA-256 checksum is included with the download. The iOS build is delivered through TestFlight.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.3...app-v0.5.4
