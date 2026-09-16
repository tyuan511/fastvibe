#!/bin/sh
# Source this at the start of every release command:
#
#   . .agents/skills/release/scripts/env.sh
#
# FastVibe's agent shell starts from a minimal PATH (`/usr/bin:/bin:...`), so
# node / pnpm / gh — the three tools a release needs — are not on it. Each bash
# call is a fresh shell, so an export does not survive between calls: prefix
# every release command with the line above instead of exporting once.

_nr_node_bin="$(ls -d /usr/local/n/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
if [ -n "$_nr_node_bin" ]; then
  PATH="$_nr_node_bin:$PATH"
fi
PATH="/opt/homebrew/bin:$PATH" # pnpm, gh
export PATH

_missing=""
for _nr_tool in node pnpm gh; do
  command -v "$_nr_tool" >/dev/null 2>&1 || _missing="$_missing $_nr_tool"
done
if [ -n "$_missing" ]; then
  echo "release: missing from PATH:$_missing" >&2
  return 1 2>/dev/null || exit 1
fi
