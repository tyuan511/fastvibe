#!/usr/bin/env bash
# Release builds for the phone client.
#
# `--split-per-abi` is passed here rather than configured in `build.gradle.kts`: Flutter's
# Gradle plugin sets `defaultConfig.ndk.abiFilters` itself and a `splits { abi { … } }`
# block conflicts with it outright ("Conflicting configuration … cannot be present when
# splits abi filters are set"). The flag is the supported way, and it is worth passing —
# a fat APK carries every architecture's native libraries, which was most of its 92 MB,
# while the self-updater downloads exactly one file.
set -euo pipefail

cd "$(dirname "$0")/.."

bash tool/check_release.sh
flutter build apk --release --split-per-abi --target-platform android-arm64

echo
echo "Android arm64-v8a APK:"
ls -lh build/app/outputs/flutter-apk/app-arm64-v8a-release.apk | awk '{print "  " $5 "\t" $9}'
