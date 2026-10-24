#!/bin/sh
# Screenshot the Electron preview and the native app on the same canned conversation, at the
# same size and scale, so the two can be laid side by side.
#
#   npx vite --config vite.config.ts src/renderer --port 5199   # from the repository root
#   native/scripts/compare-ui.sh OUT_DIR [light|dark]
#
# Writes OUT_DIR/{electron,native}-{theme,new}.png (2200x1440: 1100x720 at 2x).
set -eu
out=${1:?usage: compare-ui.sh OUT_DIR [light|dark]}
mode=${2:-light}
port=${MOCK_PORT:-5199}
chrome=${CHROME_PATH:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
here=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$out"

# The preview's dark scene is tokyo-night; its light one is the app default.
native_theme=""
dark_flag=""
if [ "$mode" = dark ]; then
  native_theme="--theme tokyo-night"
  dark_flag="--dark"
fi

cargo build -q --manifest-path "$here/Cargo.toml" -p fv-gui --features capture

for scene in theme new; do
  query="lang=zh&theme=$mode"
  [ "$scene" = new ] && query="$query&new=1"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1100,720 --virtual-time-budget=6000 --user-data-dir="$out/.chrome" \
    --screenshot="$out/electron-$scene.png" "http://localhost:$port/mock.html?$query" 2>/dev/null
  # shellcheck disable=SC2086
  "$here/target/debug/fastvibe" --fixture "$scene" --no-glass $dark_flag $native_theme \
    --screenshot "$out/native-$scene.png"
done
