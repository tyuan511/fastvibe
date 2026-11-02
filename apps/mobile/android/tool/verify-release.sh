#!/usr/bin/env bash
# Verify a release APK is signed by the production key and is structurally valid.
set -euo pipefail

usage() {
  echo "usage: $0 APK (--keystore FILE --alias ALIAS --store-password-env NAME | --trusted-cert-sha256 HEX) [--apksigner FILE]" >&2
  exit 2
}

[[ $# -ge 3 ]] || usage
apk="$1"
shift
keystore=""
alias=""
store_password_env=""
trusted_cert=""
apksigner="${APKSIGNER:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keystore) [[ $# -ge 2 ]] || usage; keystore="$2"; shift 2 ;;
    --alias) [[ $# -ge 2 ]] || usage; alias="$2"; shift 2 ;;
    --store-password-env) [[ $# -ge 2 ]] || usage; store_password_env="$2"; shift 2 ;;
    --trusted-cert-sha256) [[ $# -ge 2 ]] || usage; trusted_cert="$2"; shift 2 ;;
    --apksigner) [[ $# -ge 2 ]] || usage; apksigner="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$apk" ]] || { echo "APK does not exist: $apk" >&2; exit 1; }
[[ -n "$apksigner" ]] || apksigner="$(find "${ANDROID_HOME:?ANDROID_HOME is required}"/build-tools -type f -name apksigner | sort -V | tail -1)"
[[ -x "$apksigner" ]] || { echo "apksigner was not found" >&2; exit 1; }

cert_output="$($apksigner verify --verbose --print-certs "$apk")"
grep -q '^Verified using v[1-4] scheme' <<< "$cert_output" || {
  echo "APK signature verification did not report a supported signing scheme" >&2
  exit 1
}
apk_cert="$(sed -nE 's/.*certificate SHA-256 digest: ([0-9A-Fa-f:]+).*/\1/p' <<< "$cert_output" | head -1 | tr -d ':')"
[[ "$apk_cert" =~ ^[0-9A-Fa-f]{64}$ ]] || {
  echo "Could not read the APK signer certificate from apksigner" >&2
  exit 1
}
apk_cert="$(tr '[:lower:]' '[:upper:]' <<< "$apk_cert")"

if [[ -n "$trusted_cert" ]]; then
  expected_cert="${trusted_cert//:/}"
else
  [[ -n "$keystore" && -n "$alias" && -n "$store_password_env" ]] || usage
  [[ -f "$keystore" ]] || { echo "Keystore does not exist: $keystore" >&2; exit 1; }
  store_password="${!store_password_env:-}"
  [[ -n "$store_password" ]] || { echo "Missing keystore password environment variable: $store_password_env" >&2; exit 1; }
  expected_cert="$(keytool -list -v -keystore "$keystore" -alias "$alias" -storepass "$store_password" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*SHA256:[[:space:]]*([0-9A-Fa-f:]+).*/\1/p' | head -1 | tr -d ':')"
fi
expected_cert="$(tr '[:lower:]' '[:upper:]' <<< "$expected_cert")"
[[ "$expected_cert" =~ ^[0-9A-F]{64}$ ]] || {
  echo "Could not determine the trusted production certificate" >&2
  exit 1
}
[[ "$apk_cert" == "$expected_cert" ]] || {
  echo "APK signer does not match the trusted production certificate" >&2
  exit 1
}

printf 'Verified production signer %s for %s\n' "$apk_cert" "$apk"
