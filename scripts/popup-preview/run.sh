#!/usr/bin/env bash
# Build the standalone popup preview and screenshot it in real Gecko.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"

python3 "$HERE/build.py"

if command -v firefox >/dev/null 2>&1; then
  PROFILE="$OUT/.firefox-profile"
  mkdir -p "$PROFILE"
  # Absolute paths for both arguments: a relative --screenshot is ignored.
  timeout 90 firefox --headless --profile "$PROFILE" \
    --screenshot "$OUT/preview.png" --window-size=460,230 \
    "file://$OUT/preview.html" >/dev/null 2>&1 || true
  if [ -f "$OUT/preview.png" ]; then
    echo "screenshot: $OUT/preview.png"
  else
    echo "screenshot failed; open $OUT/preview.html manually" >&2
  fi
else
  echo "firefox not found; open $OUT/preview.html manually" >&2
fi
