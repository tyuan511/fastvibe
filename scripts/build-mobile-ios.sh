#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$ROOT_DIR/apps/mobile/core"
OUT_DIR="${FASTVIBE_IOS_BUILD_DIR:-$CORE_DIR/target/ios-bundle}"
XCFRAMEWORK="${FASTVIBE_IOS_FRAMEWORK:-$ROOT_DIR/apps/mobile/packages/rust_core/ios/Frameworks/FastVibeMobileCore.xcframework}"
HEADER="$CORE_DIR/include/fastvibe_mobile_core.h"

DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGETS=("aarch64-apple-ios-sim" "x86_64-apple-ios")

log() { printf '[build-ios] %s\n' "$*"; }
fail() { printf '[build-ios] error: %s\n' "$*" >&2; exit 1; }

command -v cargo >/dev/null || fail "cargo is required"
command -v xcodebuild >/dev/null || fail "xcodebuild is required"
[[ -f "$HEADER" ]] || fail "missing ABI header: $HEADER"

if ! rustup target list --installed | grep -qx "$DEVICE_TARGET"; then
    log "installing Rust target $DEVICE_TARGET"
    rustup target add "$DEVICE_TARGET"
fi
for target in "${SIM_TARGETS[@]}"; do
    if ! rustup target list --installed | grep -qx "$target"; then
        log "installing Rust target $target"
        rustup target add "$target"
    fi
done

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/headers" "$OUT_DIR/device" "$OUT_DIR/sim-arm64" "$OUT_DIR/sim-x86_64" "$OUT_DIR/simulator"
cp "$HEADER" "$OUT_DIR/headers/"

CARGO_FEATURES="${FASTVIBE_IOS_CARGO_FEATURES:-iroh-transport,mobile-client}"

build_target() {
    local target="$1"
    local output="$2"
    log "building $target with features $CARGO_FEATURES"
    cargo build --locked --manifest-path "$CORE_DIR/Cargo.toml" --release --target "$target" --no-default-features --features "$CARGO_FEATURES"
    local target_dir="${CARGO_TARGET_DIR:-$CORE_DIR/target}"
    cp "$target_dir/$target/release/libfastvibe_mobile_core.a" "$output/libfastvibe_mobile_core.a"
}

build_target "$DEVICE_TARGET" "$OUT_DIR/device"
build_target "aarch64-apple-ios-sim" "$OUT_DIR/sim-arm64"
build_target "x86_64-apple-ios" "$OUT_DIR/sim-x86_64"

log "creating simulator universal static library"
lipo -create \
    "$OUT_DIR/sim-arm64/libfastvibe_mobile_core.a" \
    "$OUT_DIR/sim-x86_64/libfastvibe_mobile_core.a" \
    -output "$OUT_DIR/simulator/libfastvibe_mobile_core.a"

log "creating XCFramework"
mkdir -p "$(dirname "$XCFRAMEWORK")"
rm -rf "$XCFRAMEWORK"
xcodebuild -create-xcframework \
    -library "$OUT_DIR/device/libfastvibe_mobile_core.a" -headers "$OUT_DIR/headers" \
    -library "$OUT_DIR/simulator/libfastvibe_mobile_core.a" -headers "$OUT_DIR/headers" \
    -output "$XCFRAMEWORK"

log "checking slices"
expected_device="arm64"
expected_sim="arm64 x86_64"
actual_device="$(lipo -archs "$OUT_DIR/device/libfastvibe_mobile_core.a")"
actual_sim="$(lipo -archs "$OUT_DIR/simulator/libfastvibe_mobile_core.a")"
[[ "$actual_device" == *"$expected_device"* ]] || fail "device slice is '$actual_device'"
[[ "$actual_sim" == *"arm64"* && "$actual_sim" == *"x86_64"* ]] || fail "simulator slices are '$actual_sim'"
[[ -f "$XCFRAMEWORK/Info.plist" ]] || fail "XCFramework Info.plist was not created"

log "created $XCFRAMEWORK"
