#!/usr/bin/env bash
# Render formulas in real Gecko and compare our output against KaTeX's own.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"
mkdir -p "$OUT"

cd "$ROOT"

# Bundle the renderer so the checker can import it.
npx esbuild src/modules/katex.ts --bundle --platform=node --format=esm \
  --external:katex --outfile=.scaffold/render-check.mjs --log-level=warning

node --input-type=module -e "
globalThis.Zotero = { debug: () => {}, logError: () => {} };
const m = await import('$ROOT/.scaffold/render-check.mjs');
const katex = (await import('$ROOT/node_modules/katex/dist/katex.mjs')).default;
const fs = await import('node:fs');

const cases = [
  ['范数 \\\\|', '\\\\left\\\\| \\\\frac{\\\\partial L}{\\\\partial \\\\phi} \\\\right\\\\|^2'],
  ['大括号', '\\\\left\\\\{ \\\\frac{a}{b} \\\\right\\\\}'],
  ['圆括号', '\\\\left( \\\\frac{a}{b} \\\\right)'],
  ['黑板体', '\\\\mathbb{R}^n \\\\to \\\\mathcal{L}'],
  ['矩阵', '\\\\begin{pmatrix} a & b \\\\\\\\ c & d \\\\end{pmatrix}'],
  ['求和', '\\\\sum_{i=1}^{n} x_i^2'],
];

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');
function ser(n) {
  if (n.tag === '#text') return esc(n.attrs.value ?? '');
  const attrs = Object.entries(n.attrs).filter(([k]) => k !== 'xmlns')
    .map(([k, v]) => k + '=\"' + esc(v) + '\"').join(' ');
  return '<' + n.tag + (attrs ? ' ' + attrs : '') + '>' +
    n.children.map(ser).join('') + '</' + n.tag + '>';
}

const rows = cases.map(([label, tex]) => {
  const mine = ser(m.latexToNodes(tex, true));
  const theirs = katex.renderToString(tex, { throwOnError: false, displayMode: true, output: 'html', strict: false });
  return { label, mine, theirs };
});
fs.writeFileSync('$OUT/data.json', JSON.stringify(rows));
"

node --input-type=module -e "
const fs = await import('node:fs');
const rows = JSON.parse(fs.readFileSync('$OUT/data.json', 'utf8'));
const body = rows.map((r) => \`
  <div class=row>
    <div class=lbl>\${r.label} — 我们</div><div class=box>\${r.mine}</div>
    <div class=lbl>\${r.label} — KaTeX</div><div class=box>\${r.theirs}</div>
  </div>\`).join('');
fs.writeFileSync('$OUT/compare.html', \`<!DOCTYPE html><html><head><meta charset=utf-8>
<link rel=stylesheet href=katex.css><style>
body{font:13px/1.5 sans-serif;background:#fff;margin:0;padding:10px}
.row{margin-bottom:12px}.lbl{font-size:10px;color:#999;margin:4px 0 2px}
.box{width:330px;border:1px solid #e3e3e3;padding:4px;background:#fbfbfd;overflow-x:auto}
</style></head><body>\${body}</body></html>\`);
console.log('wrote compare.html');
"

# Fonts and stylesheet, with the path adjusted for the flat output directory.
mkdir -p "$OUT/assets/fonts"
cp "$ROOT"/addon/assets/fonts/*.woff2 "$OUT/assets/fonts/"
sed 's|url(\.\./assets/fonts/|url(assets/fonts/|g' \
  "$ROOT/.scaffold/build/addon/content/katex.css" > "$OUT/katex.css"

if command -v firefox >/dev/null 2>&1; then
  # Absolute paths for both the output and the URL: a relative --screenshot
  # argument is silently ignored by this Firefox build.
  PROFILE="$OUT/.firefox-profile"
  mkdir -p "$PROFILE"
  timeout 90 firefox --headless --profile "$PROFILE" \
    --screenshot "$OUT/compare.png" --window-size=380,1400 \
    "file://$OUT/compare.html" >/dev/null 2>&1 || true
  if [ -f "$OUT/compare.png" ]; then
    echo "screenshot: $OUT/compare.png"
  else
    echo "screenshot failed; open $OUT/compare.html manually" >&2
  fi
else
  echo "firefox not found; open $OUT/compare.html manually" >&2
fi

echo "done: $OUT/compare.html"
