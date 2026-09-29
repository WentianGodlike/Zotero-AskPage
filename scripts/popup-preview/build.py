#!/usr/bin/env python3
"""Render the selection-popup row standalone, for visual inspection.

Why this exists: the popup's layout cannot be checked from the plugin sandbox,
and "the input is too small" is not something a unit test catches. The row is
pure CSS plus a fixed DOM shape, so rendering it standalone reproduces the real
geometry closely enough to judge — and iterating here costs seconds instead of
an install-and-restart cycle in Zotero.

The stylesheet is read from the module, so the preview cannot drift from the
shipped CSS.

Usage:
    python3 scripts/popup-preview/build.py           # writes out/preview.html
    scripts/popup-preview/run.sh                     # also screenshots it
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SOURCE = ROOT / "src" / "modules" / "readerPopup.ts"
OUT = Path(__file__).resolve().parent / "out"


def extract() -> tuple[str, str]:
    """Return (row class name, resolved stylesheet)."""
    src = SOURCE.read_text(encoding="utf-8")

    css_match = re.search(r"const BTN_CSS = `([\s\S]*?)`;", src)
    if not css_match:
        sys.exit("BTN_CSS not found in readerPopup.ts")
    css = css_match.group(1)

    class_match = re.search(r'const BTN_ROW_CLASS = "([^"]+)"', src)
    if not class_match:
        sys.exit("BTN_ROW_CLASS not found in readerPopup.ts")
    row_class = class_match.group(1)

    # The stylesheet uses template placeholders for the class name and the
    # popup width; resolve both so the preview matches what is injected.
    width = 400  # matches the value being iterated on; override with --width
    css = css.replace("${BTN_ROW_CLASS}", row_class)
    css = css.replace("__HA_POPUP_WIDTH__", str(width))
    return row_class, css


def build(row_class: str, css: str) -> str:
    """Render the row inside a container matching the reader's own constraint.

    The reader caps the selection popup at 198px; the plugin raises that cap on
    the popup element itself. The preview reproduces both, so it shows the same
    width the reader will use.
    """
    # The reader's own rules for the popup shell, reduced to what affects layout.
    shell = """
    .view-popup {
      display: flex;
      flex-direction: column;
      background: #fff;
      border-radius: 6px;
      box-shadow: 0 0 3px rgba(0,0,0,.55), 0 8px 40px rgba(0,0,0,.25);
      padding: 8px;
      gap: 8px;
    }
    .selection-popup { padding: 8px; gap: 8px; }
    """
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body {{ margin: 0; padding: 16px; background: #f4f5f7;
        font: 13px -apple-system, "Segoe UI", sans-serif; }}
.label {{ font-size: 11px; color: #888; margin-bottom: 6px; }}
.note {{ font-size: 11px; color: #b06000; margin-bottom: 10px; }}
{shell}
{css}
</style></head><body>
<div class="label">划词弹窗（真实 CSS；宽度取自 popupWidth 偏好）</div>
<div class="note">红色虚线为弹窗边界。注意阅读器本身的 198px 上限已由插件提高</div>
<div class="view-popup selection-popup" style="outline:1px dashed #d33; max-width:320px !important">
  <div class="colors" style="display:flex;gap:4px">
    <span style="width:20px;height:20px;border-radius:4px;background:#ffd400"></span>
    <span style="width:20px;height:20px;border-radius:4px;background:#ff6666"></span>
    <span style="width:20px;height:20px;border-radius:4px;background:#5fb236"></span>
  </div>
  <div class="{row_class}">
    <div class="ha-ask-actions">
      <button class="ha-selection-btn">解释这段</button>
      <button class="ha-selection-btn">翻译</button>
      <button class="ha-selection-btn">有何作用</button>
    </div>
    <div class="ha-ask-form">
      <input type="text" class="ha-ask-input" placeholder="或直接提问，回车发送">
      <button class="ha-ask-send">提问</button>
    </div>
  </div>
</div>
</body></html>
"""


def main() -> int:
    row_class, css = extract()
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / "preview.html"
    target.write_text(build(row_class, css), encoding="utf-8")

    if "${" in css:
        print("WARN: unresolved template placeholder remains in the CSS")
    print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
