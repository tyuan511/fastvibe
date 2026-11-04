#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$ROOT_DIR/apps/mobile/core"
OUT_DIR="$ROOT_DIR/apps/mobile/packages/rust_core/android/src/main/jniLibs"
SDK_DIR="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$SDK_DIR" && -f "$ROOT_DIR/apps/mobile/android/local.properties" ]]; then
    SDK_DIR="$(awk -F= '$1 == "sdk.dir" { print substr($0, index($0, "=") + 1); exit }' "$ROOT_DIR/apps/mobile/android/local.properties")"
fi
if [[ -z "$SDK_DIR" && -d /opt/homebrew/share/android-commandlinetools ]]; then
    SDK_DIR=/opt/homebrew/share/android-commandlinetools
fi
NDK_DIR="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-$SDK_DIR/ndk/28.2.13676358}}"
case "$(uname -s)" in
    Darwin) HOST_TAG=darwin-x86_64 ;;
    Linux) HOST_TAG=linux-x86_64 ;;
    *) printf 'Build the Android Rust core on macOS or Linux.\n' >&2; exit 1 ;;
esac
TOOLCHAIN="$NDK_DIR/toolchains/llvm/prebuilt/$HOST_TAG/bin"
LINKER="$TOOLCHAIN/aarch64-linux-android24-clang"
[[ -x "$LINKER" ]] || { printf 'Android NDK linker not found: %s\nSet ANDROID_SDK_ROOT or ANDROID_NDK_HOME.\n' "$LINKER" >&2; exit 1; }
command -v cargo >/dev/null || { printf 'cargo is required\n' >&2; exit 1; }

export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$LINKER"
export CC_aarch64_linux_android="$LINKER"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
# The shipped phone app targets ARM64; there is one source of Rust feature flags.
cargo build --locked --manifest-path "$CORE_DIR/Cargo.toml" --release --target aarch64-linux-android
TARGET_DIR="${CARGO_TARGET_DIR:-$CORE_DIR/target}"
mkdir -p "$OUT_DIR/arm64-v8a"
cp "$TARGET_DIR/aarch64-linux-android/release/libfastvibe_mobile_core.so" "$OUT_DIR/arm64-v8a/"
printf 'Flutter Android Rust core: %s\n' "$OUT_DIR/arm64-v8a/libfastvibe_mobile_core.so"
