#!/usr/bin/env bash
set -euo pipefail

XCFRAMEWORK="${1:-apps/mobile/packages/rust_core/ios/Frameworks/FastVibeMobileCore.xcframework}"
[[ -d "$XCFRAMEWORK" ]] || { printf 'missing XCFramework: %s\n' "$XCFRAMEWORK" >&2; exit 1; }
[[ -f "$XCFRAMEWORK/Info.plist" ]] || { printf 'missing XCFramework Info.plist\n' >&2; exit 1; }

plutil -lint "$XCFRAMEWORK/Info.plist" >/dev/null
required_symbols=(
    fv_mobile_core_create
    fv_mobile_core_destroy
    fv_mobile_core_version
    fv_mobile_core_command_json
    fv_mobile_core_poll_json
    fv_mobile_core_free_string
)

has_arm64_device=0
has_arm64_sim=0
has_x86_sim=0
while IFS= read -r library; do
    # CocoaPods derives one -l name from the XCFramework. All slices must use
    # the same conventional lib<name>.a filename or only the device can link.
    [[ "$(basename "$library")" == libfastvibe_mobile_core.a ]] || {
        printf 'inconsistent XCFramework library name: %s\n' "$library" >&2; exit 1;
    }
    arches="$(lipo -archs "$library")"
    case "$library" in
        *ios-arm64/*) [[ "$arches" == *arm64* ]] && has_arm64_device=1 ;;
        *ios-arm64_x86_64-simulator/*) [[ "$arches" == *arm64* ]] && has_arm64_sim=1; [[ "$arches" == *x86_64* ]] && has_x86_sim=1 ;;
    esac
    for arch in $arches; do
        # Rust's embedded LLVM bitcode may be newer than Xcode; inspect Mach-O symbols.
        symbols="$(xcrun nm --no-llvm-bc -arch "$arch" -gU "$library" | grep -E ' [Tt] _fv_mobile_core_[a-z_]+$')"
        for symbol in "${required_symbols[@]}"; do
            grep -Eq " [Tt] _$symbol$" <<< "$symbols" || {
                printf 'missing Rust ABI symbol %s (%s): %s\n' "$symbol" "$arch" "$library" >&2
                exit 1
            }
        done
    done
done < <(find "$XCFRAMEWORK" -name '*.a' -type f -print)

(( has_arm64_device == 1 )) || { printf 'device arm64 slice missing\n' >&2; exit 1; }
(( has_arm64_sim == 1 && has_x86_sim == 1 )) || { printf 'universal simulator slices missing\n' >&2; exit 1; }
printf 'XCFramework architecture and ABI check passed: %s\n' "$XCFRAMEWORK"
