#!/usr/bin/env bash
# Build the standalone settings-pane preview and screenshot it in real Gecko.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"

python3 "$HERE/build.py"

if command -v firefox >/dev/null 2>&1; then
  PROFILE="$OUT/.firefox-profile"
  rm -rf "$PROFILE"; mkdir -p "$PROFILE"
  timeout 90 firefox --headless --profile "$PROFILE" \
    --screenshot "$OUT/preview.png" --window-size=760,1400 \
    "file://$OUT/preview.html" >/dev/null 2>&1 || true
  if [ -f "$OUT/preview.png" ]; then
    echo "screenshot: $OUT/preview.png"
  else
    echo "screenshot failed; open $OUT/preview.html manually" >&2
  fi
fi
