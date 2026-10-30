#!/bin/bash
set -euo pipefail
pid="$1"
app="$2"
work="$3"
data="$4"
staging=""
backup=""
cleanup() {
  # Preserve the old application if a step between the two renames failed.
  if [ ! -e "$app" ] && [ -n "$backup" ] && [ -d "$backup/app" ]; then
    mv "$backup/app" "$app"
  fi
  if [ -n "$backup" ] && [ ! -e "$backup/app" ]; then rmdir "$backup" 2>/dev/null || true; fi
  [ -z "$staging" ] || rm -rf "$staging"
  rm -rf "$work"
}
trap cleanup EXIT
# Wait for normal application shutdown, including workspace persistence. A stalled quit
# leaves the installed app intact instead of swapping binaries beneath a running GUI.
for ((attempt=0; attempt<600; attempt++)); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if kill -0 "$pid" 2>/dev/null; then echo 'Application did not quit; update canceled'; exit 1; fi
parent="$(dirname "$app")"
staging="$(mktemp -d "$parent/.fastvibe-native-stage.XXXXXX")"
backup="$(mktemp -d "$parent/.fastvibe-native-backup.XXXXXX")"
ditto "$work/FastVibe Native.app" "$staging/app"
mv "$app" "$backup/app"
if ! mv "$staging/app" "$app"; then
  mv "$backup/app" "$app"
  rmdir "$backup"
  exit 1
fi
# Launch the binary directly: ad-hoc previews have no Developer ID for Gatekeeper's `open`.
if [ ! -x "$app/Contents/MacOS/fastvibe" ]; then
  rm -rf "$app"
  mv "$backup/app" "$app"
  rmdir "$backup"
  exit 1
fi
nohup "$app/Contents/MacOS/fastvibe" --data-dir "$data" </dev/null >/dev/null 2>&1 &
rm -rf "$backup"
echo 'Native update installed'
