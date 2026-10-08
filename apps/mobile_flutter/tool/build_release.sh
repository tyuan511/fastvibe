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

flutter build apk --release --split-per-abi
flutter build appbundle --release

echo
echo "APKs (one per architecture, plus the Play bundle):"
ls -lh build/app/outputs/flutter-apk/*.apk 2>/dev/null | awk '{print "  " $5 "\t" $9}'
ls -lh build/app/outputs/bundle/release/*.aab 2>/dev/null | awk '{print "  " $5 "\t" $9}'
