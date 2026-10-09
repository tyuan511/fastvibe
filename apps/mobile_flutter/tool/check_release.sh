#!/usr/bin/env bash
# Check the shared mobile tag and Android versionCode before either native build.
set -euo pipefail

pubspec="${1:-$(dirname "$0")/../pubspec.yaml}"
version="$(sed -nE 's/^version: ([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)[[:space:]]*$/\1+\2/p' "$pubspec")"
if [[ ! "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\+([0-9]+)$ ]]; then
  echo 'pubspec.yaml version must be MAJOR.MINOR.PATCH+BUILD_NUMBER' >&2
  exit 1
fi
major=$((10#${BASH_REMATCH[1]}))
minor=$((10#${BASH_REMATCH[2]}))
patch=$((10#${BASH_REMATCH[3]}))
build=$((10#${BASH_REMATCH[4]}))
# Previous Android releases used MAJOR * 10000 + MINOR * 100 + PATCH.
# A lower Flutter build number would be refused as a downgrade of the shipping app.
minimum=$((major * 10000 + minor * 100 + patch))
if (( minor > 99 || patch > 99 || build < minimum || build <= 0 || build > 2100000000 )); then
  echo "Android build number $build must be at least $minimum and fit versionCode" >&2
  exit 1
fi
if [[ -n "${RELEASE_TAG:-}" && "$RELEASE_TAG" != "app-v${version%+*}" ]]; then
  echo "Release tag $RELEASE_TAG does not match app-v${version%+*}" >&2
  exit 1
fi
echo "Mobile ${version%+*}, Android build $build"
