#!/usr/bin/env bash
set -euo pipefail

XCFRAMEWORK="${1:-apps/mobile/ios/.native-build/FastVibeMobileCore.xcframework}"
[[ -d "$XCFRAMEWORK" ]] || { printf 'missing XCFramework: %s\n' "$XCFRAMEWORK" >&2; exit 1; }
[[ -f "$XCFRAMEWORK/Info.plist" ]] || { printf 'missing XCFramework Info.plist\n' >&2; exit 1; }

plutil -lint "$XCFRAMEWORK/Info.plist" >/dev/null
mapfile_cmd="$(command -v mapfile || true)"
if [[ -n "$mapfile_cmd" ]]; then
    :
fi

has_arm64_device=0
has_arm64_sim=0
has_x86_sim=0
while IFS= read -r library; do
    arches="$(lipo -archs "$library")"
    case "$library" in
        *ios-arm64/*) [[ "$arches" == *arm64* ]] && has_arm64_device=1 ;;
        *ios-arm64_x86_64-simulator/*) [[ "$arches" == *arm64* ]] && has_arm64_sim=1; [[ "$arches" == *x86_64* ]] && has_x86_sim=1 ;;
    esac
done < <(find "$XCFRAMEWORK" -name '*.a' -type f -print)

(( has_arm64_device == 1 )) || { printf 'device arm64 slice missing\n' >&2; exit 1; }
(( has_arm64_sim == 1 && has_x86_sim == 1 )) || { printf 'universal simulator slices missing\n' >&2; exit 1; }
printf 'XCFramework architecture check passed: %s\n' "$XCFRAMEWORK"
