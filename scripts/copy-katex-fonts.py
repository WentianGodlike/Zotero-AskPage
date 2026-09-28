#!/usr/bin/env python3
"""Copy the KaTeX woff2 fonts into the plugin's addon directory.

Why the fonts are shipped
-------------------------
An earlier version pointed KaTeX's `@font-face` rules at Zotero's own copies
under `resource://zotero/note-editor/assets/fonts/`. That directory exists, but
its filenames carry a build-time content hash:

    KaTeX_AMS-Regular.73ea273a.woff2

while the rewritten URLs said `KaTeX_AMS-Regular.woff2`. Every font request
therefore failed, the browser fell back to a system serif, and formulas rendered
with flat, evenly-spaced maths glyphs — which reads as "the formula is broken"
rather than "a font is missing". Zotero's own stylesheet uses different hashed
names again, so there is no stable name to reference.

Shipping the fonts costs ~296 KB of woff2 and removes the dependency entirely.

Only woff2 is copied: it is supported by every Gecko Zotero ships on, and
dropping the woff/ttf fallbacks keeps the size down. `katex.css` is rewritten to
match (see the font-face filter in the build step).
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "node_modules" / "katex" / "dist" / "fonts"
TARGET = ROOT / "addon" / "assets" / "fonts"


def main() -> int:
    if not SOURCE.is_dir():
        print(f"FAIL: KaTeX fonts not found at {SOURCE}")
        print("      run `npm install` first")
        return 1

    fonts = sorted(SOURCE.glob("*.woff2"))
    if not fonts:
        print(f"FAIL: no .woff2 files in {SOURCE}")
        return 1

    TARGET.mkdir(parents=True, exist_ok=True)

    # Clear stale files so a KaTeX upgrade cannot leave orphaned fonts behind.
    for existing in TARGET.glob("*.woff2"):
        if existing.name not in {f.name for f in fonts}:
            existing.unlink()

    total = 0
    for font in fonts:
        shutil.copy2(font, TARGET / font.name)
        total += font.stat().st_size

    print(f"copied {len(fonts)} woff2 font(s), {total / 1024:.0f} KB -> {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
