#!/usr/bin/env bash
# Create FastVibe's Android release key and hand it to CI.
#
# Run this yourself, in a terminal: it asks for the password, writes the keystore
# outside the repository, and sets the four GitHub secrets the Mobile Android APK
# workflow signs with. The password is read from the terminal and piped to `gh`,
# so it never appears in shell history, a process listing or a file.
#
# The key is permanent. Android installs an update only over an app signed with the
# same key, so losing it means every user has to uninstall to get the next version.
# Keep the keystore file and its password somewhere that is backed up (a password
# manager takes both).
#
#   bash apps/mobile/scripts/create-release-keystore.sh [output.jks]
set -euo pipefail

out="${1:-$HOME/env/keystore/fastvibe-release.jks}"
alias_name="fastvibe"
repo="tyuan511/fastvibe"

command -v keytool >/dev/null || { echo "keytool not found (install a JDK)" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in (gh auth login)" >&2; exit 1; }
if [ -e "$out" ]; then
  echo "$out already exists; refusing to overwrite a signing key." >&2
  exit 1
fi

read -r -s -p "New keystore password (at least 8 characters): " password; echo
read -r -s -p "Repeat it: " again; echo
[ "$password" = "$again" ] || { echo "The passwords differ." >&2; exit 1; }
[ "${#password}" -ge 8 ] || { echo "Too short." >&2; exit 1; }

mkdir -p "$(dirname "$out")"
# PKCS12 keys its entry with the store password, so there is one password, not two.
export FASTVIBE_KEYSTORE_PASSWORD="$password"
keytool -genkeypair -v \
  -storetype PKCS12 \
  -keystore "$out" \
  -alias "$alias_name" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=FastVibe, O=FastVibe" \
  -storepass:env FASTVIBE_KEYSTORE_PASSWORD \
  -keypass:env FASTVIBE_KEYSTORE_PASSWORD >/dev/null
chmod 600 "$out"

base64 < "$out" | tr -d '\n' | gh secret set FASTVIBE_ANDROID_KEYSTORE_BASE64 --repo "$repo"
printf '%s' "$alias_name" | gh secret set FASTVIBE_ANDROID_KEY_ALIAS --repo "$repo"
printf '%s' "$password" | gh secret set FASTVIBE_ANDROID_STORE_PASSWORD --repo "$repo"
printf '%s' "$password" | gh secret set FASTVIBE_ANDROID_KEY_PASSWORD --repo "$repo"
unset password again FASTVIBE_KEYSTORE_PASSWORD

echo
echo "Keystore: $out (alias: $alias_name)"
echo "Secrets updated on $repo."
echo "Now back up the keystore file and its password — neither can be read back from GitHub."
