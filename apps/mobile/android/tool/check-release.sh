#!/usr/bin/env bash
# Validate native Android release metadata and an optional app-vX.Y.Z tag.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_dir="$(cd -- "$script_dir/.." && pwd)"
# shellcheck source=version.sh
# shellcheck source=version.sh
# shellcheck disable=SC1091
source "$script_dir/version.sh"

properties_file="${1:-$android_dir/version.properties}"
tag="${2:-${RELEASE_TAG:-}}"
load_android_version "$properties_file"

version="$FASTVIBE_ANDROID_VERSION_NAME"
version_code="$FASTVIBE_ANDROID_VERSION_CODE"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "versionName must be MAJOR.MINOR.PATCH: $version" >&2
  exit 1
}
[[ "$version_code" =~ ^[1-9][0-9]*$ && "$version_code" -le 2100000000 ]] || {
  echo "versionCode must be a positive Android int: $version_code" >&2
  exit 1
}

IFS=. read -r major minor patch <<< "$version"
minimum=$((10#$major * 10000 + 10#$minor * 100 + 10#$patch))
((version_code >= minimum)) || {
  echo "versionCode $version_code is below the compatibility floor $minimum for $version" >&2
  exit 1
}

if [[ -n "$tag" ]]; then
  [[ "$tag" == "app-v$version" ]] || {
    echo "Release tag $tag does not match app-v$version" >&2
    exit 1
  }
fi

printf 'Android %s (versionCode %s), ABI arm64-v8a\n' "$version" "$version_code"
