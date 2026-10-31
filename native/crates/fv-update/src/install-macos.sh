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
launched=$!
# Starting an executable is not evidence it can run: dyld failures and startup panics happen
# in the child after the shell accepted it. Observe a short startup window, then let a live
# GUI run independently. A clean exit is also valid (the user can close the new GUI at once).
launch_failed=0
for ((attempt=0; attempt<15; attempt++)); do
  if ! kill -0 "$launched" 2>/dev/null; then
    if wait "$launched"; then :; else launch_failed=1; fi
    break
  fi
  sleep 0.2
done
if [ "$launch_failed" = 1 ]; then
  echo 'New application failed during launch; restoring the previous application'
  rm -rf "$app"
  mv "$backup/app" "$app"
  rmdir "$backup"
  # Restore the user's app, with the same data directory, after the original quit normally.
  if [ -x "$app/Contents/MacOS/fastvibe" ]; then
    nohup "$app/Contents/MacOS/fastvibe" --data-dir "$data" </dev/null >/dev/null 2>&1 &
  fi
  exit 1
fi
rm -rf "$backup"
echo 'Native update installed'
