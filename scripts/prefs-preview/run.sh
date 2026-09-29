#!/usr/bin/env bash
# Build the standalone settings-pane preview and screenshot it in real Gecko.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"

# Export the prompt field definitions from the real source, so the preview
# renders the same fields (and the same row counts) that ship.
ROOT="$(cd "$HERE/../.." && pwd)"
(
  cd "$ROOT"
  npx esbuild src/modules/prompts.ts --bundle --platform=node --format=esm \
    --outfile=.scaffold/pf.mjs --log-level=warning
  node --input-type=module -e "
    globalThis.Zotero = { debug: () => {} };
    const m = await import('$ROOT/.scaffold/pf.mjs');
    const fs = await import('node:fs');
    fs.writeFileSync('$OUT/prompt-fields.js',
      'window.__PROMPT_FIELDS = ' + JSON.stringify(m.promptFields()) + ';');
  "
)

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
