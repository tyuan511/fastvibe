#!/usr/bin/env bash
# Shared parser for apps/mobile/android/version.properties.
# This file is sourced by the Android release tools; it deliberately never sources
# the properties file itself, so a malformed value cannot become shell code.

load_android_version() {
  local properties_file="${1:?version.properties path is required}"
  [[ -f "$properties_file" ]] || {
    echo "Android version metadata is missing: $properties_file" >&2
    return 1
  }

  local line key value
  local version_name="" version_code=""
  local seen_name=0 seen_code=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || {
      echo "Malformed Android version metadata line in $properties_file" >&2
      return 1
    }
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      versionName)
        ((seen_name == 0)) || { echo "Duplicate versionName in $properties_file" >&2; return 1; }
        version_name="$value"
        seen_name=1
        ;;
      versionCode)
        ((seen_code == 0)) || { echo "Duplicate versionCode in $properties_file" >&2; return 1; }
        version_code="$value"
        seen_code=1
        ;;
      *)
        echo "Unexpected Android version key '$key' in $properties_file" >&2
        return 1
        ;;
    esac
  done < "$properties_file"

  ((seen_name == 1 && seen_code == 1)) || {
    echo "Android version metadata must contain versionName and versionCode" >&2
    return 1
  }

  FASTVIBE_ANDROID_VERSION_NAME="$version_name"
  FASTVIBE_ANDROID_VERSION_CODE="$version_code"
  export FASTVIBE_ANDROID_VERSION_NAME FASTVIBE_ANDROID_VERSION_CODE
}
