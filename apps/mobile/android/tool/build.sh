#!/usr/bin/env bash
# Build the native Android client. Production release builds require production signing.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=version.sh
# shellcheck source=version.sh
# shellcheck disable=SC1091
source "$script_dir/version.sh"

release=0
with_aar=0
for arg in "$@"; do
  case "$arg" in
    --release) release=1 ;;
    --with-aar) with_aar=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

load_android_version "$android_dir/version.properties"
bash "$script_dir/check-release.sh" "$android_dir/version.properties" "${RELEASE_TAG:-}"

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
  gradle_args=(assembleRelease -PfastvibeAbis=arm64-v8a)
  ((with_aar)) && gradle_args+=( :native:buildAar )
else
  gradle_args=(assembleDebug -PfastvibeAbis=arm64-v8a)
fi

cd "$android_dir"
./gradlew "${gradle_args[@]}"

if ((release)); then
  apk="$android_dir/app/build/outputs/apk/release/app-release.apk"
else
  apk="$android_dir/app/build/outputs/apk/debug/app-debug.apk"
fi
[[ -f "$apk" ]] || { echo "Expected APK was not produced: $apk" >&2; exit 1; }
printf '%s\n' "$apk"
