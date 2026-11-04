#!/usr/bin/env bash
# Build the Flutter Android client with the shared Rust runtime.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(cd -- "$script_dir/.." && pwd)"
mobile_dir="$(cd -- "$android_dir/.." && pwd)"
repo_dir="$(cd -- "$mobile_dir/../.." && pwd)"
# shellcheck disable=SC1091
source "$script_dir/version.sh"

release=0
for arg in "$@"; do
  case "$arg" in
    --release) release=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

load_android_version "$android_dir/version.properties"
bash "$script_dir/check-release.sh" "$android_dir/version.properties" "${RELEASE_TAG:-}"

# Check signing before any Rust compilation or Flutter dependency resolution. A
# production build must never silently fall back to the development certificate.
if ((release)); then
  required=(
    FASTVIBE_ANDROID_STORE_FILE
    FASTVIBE_ANDROID_STORE_PASSWORD
    FASTVIBE_ANDROID_KEY_ALIAS
    FASTVIBE_ANDROID_KEY_PASSWORD
  )
  for name in "${required[@]}"; do
    [[ -n "${!name:-}" ]] || {
      echo "Signed release requires $name" >&2
      exit 1
    }
  done
  [[ -f "$FASTVIBE_ANDROID_STORE_FILE" ]] || {
    echo "Signing keystore does not exist: $FASTVIBE_ANDROID_STORE_FILE" >&2
    exit 1
  }
fi

command -v flutter >/dev/null || { echo "flutter is required" >&2; exit 1; }
bash "$repo_dir/scripts/build-mobile-android-core.sh"
cd "$mobile_dir"
flutter pub get
flutter_args=(build apk --target-platform android-arm64
  --build-name "$FASTVIBE_ANDROID_VERSION_NAME"
  --build-number "$FASTVIBE_ANDROID_VERSION_CODE")
if ((release)); then
  flutter_args+=(--release --split-per-abi)
  apk="$mobile_dir/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk"
else
  flutter_args+=(--debug)
  apk="$mobile_dir/build/app/outputs/flutter-apk/app-debug.apk"
fi
flutter "${flutter_args[@]}"
[[ -f "$apk" ]] || { echo "Expected APK was not produced: $apk" >&2; exit 1; }
printf '%s\n' "$apk"
