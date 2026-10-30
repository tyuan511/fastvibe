#!/bin/bash
# CI only: private material and the imported identity live in a disposable keychain.
set -euo pipefail
work="${RUNNER_TEMP:?RUNNER_TEMP is required}/fastvibe-native-signing"
keychain="$work/signing.keychain-db"
read_keychains() {
  previous=()
  while IFS= read -r line; do
    line="${line#*\"}"
    line="${line%\"*}"
    [ -z "$line" ] || previous+=("$line")
  done < "$work/previous-keychains.txt"
}
if [ "${1:-prepare}" = cleanup ]; then
  failed=0
  if [ -f "$work/previous-keychains.txt" ]; then
    read_keychains
    security list-keychains -d user -s "${previous[@]}" || failed=1
  fi
  if [ -f "$keychain" ]; then security delete-keychain "$keychain" || failed=1; fi
  rm -rf "$work"
  exit "$failed"
fi
for name in APPLE_CERT_P12 APPLE_CERT_PASSWORD APPLE_API_KEY_P8 APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!name:-}" ]; then echo "Missing $name; refusing an unsigned or unnotarized CI package" >&2; exit 1; fi
done
umask 077
mkdir -p "$work"
security list-keychains -d user > "$work/previous-keychains.txt"
read_keychains
password="$(openssl rand -base64 32)"
printf '%s' "$APPLE_CERT_P12" | base64 --decode > "$work/certificate.p12"
printf '%s' "$APPLE_API_KEY_P8" > "$work/AuthKey.p8"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$APPLE_CERT_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" "${previous[@]}"
rm -f "$work/certificate.p12"
printf 'APPLE_SIGN_KEYCHAIN=%s\nAPPLE_API_KEY=%s\n' "$keychain" "$work/AuthKey.p8" >> "${GITHUB_ENV:?GITHUB_ENV is required}"
printf 'enabled=true\n' >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
