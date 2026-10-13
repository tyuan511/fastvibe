### Fixed

- **Checking for updates no longer fails when GitHub is busy.** The app now reads GitHub's public release pages instead of the rate-limited API, so "GitHub refused the request for now" stops appearing on an ordinary check. If GitHub does refuse, the next automatic check waits; Check for updates still tries right away.

**Full Changelog**: https://github.com/tyuan511/fastvibe/compare/app-v0.5.5...app-v0.5.6
