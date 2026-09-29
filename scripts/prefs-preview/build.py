#!/usr/bin/env python3
"""Render the settings pane standalone, for visual inspection.

Why this exists: the pane is plain DOM plus two scripts, but it only ever runs
inside Zotero, so layout problems there ("the prompt boxes are crushed") cannot
be seen while iterating. Rendering it here reproduces the real CSS and the real
script, so what is inspected is what ships.

The plugin bundle is loaded so `Zotero.<AddonInstance>.api` resolves, exactly as
in Zotero — otherwise the prompt fields would fall back to a reduced form and
the preview would not match.

Usage: scripts/prefs-preview/run.sh
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = Path(__file__).resolve().parent / "out"


def addon_instance() -> str:
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return pkg["config"]["addonInstance"]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    xhtml = (ROOT / "addon" / "content" / "preferences.xhtml").read_text(
        encoding="utf-8"
    )

    # Zotero wraps the file before parsing, so a leading XML declaration would
    # break it — same reason the pane itself must not have one.
    if xhtml.lstrip().startswith("<?xml"):
        sys.exit("preferences.xhtml must not start with an XML declaration")

    # Shim the few Zotero APIs the pane touches, then load the real scripts.
    shim = """
    window.__prefs = %s;
    window.Zotero = {
      debug: function () {},
      logError: function () {},
      launchURL: function () {},
      Prefs: {
        get: function (key) { return window.__prefs[key]; },
        set: function (key, value) { window.__prefs[key] = value; },
      },
    };
    """ % json.dumps(
        {
            "extensions.zotero.highlightask.provider": "deepseek",
            "extensions.zotero.highlightask.popupWidth": 400,
        }
    )

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>html,body{{margin:0;padding:0}}</style>
</head><body>
{xhtml}
<script>{shim}</script>
<script src="providers.data.js"></script>
<script src="prompt-fields.js"></script>
<script>
  // Stand-in for the plugin bundle's api(). Loading the real bundle here does
  // not initialise Zotero.<AddonInstance>, so the prompt editors would show the
  // "definitions unavailable" fallback instead of the fields under test.
  Zotero.{addon_instance()} = {{
    api: {{ promptFields: function () {{ return window.__PROMPT_FIELDS || []; }} }},
  }};
</script>
<script src="preferences.js"></script>
</body></html>
"""

    (OUT / "preview.html").write_text(html, encoding="utf-8")

    # Ship the scripts next to the page.
    for name, source in [
        ("preferences.js", ROOT / "addon" / "content" / "preferences.js"),
        ("providers.data.js", ROOT / "addon" / "content" / "providers.data.js"),
        (
            "highlightask.js",
            ROOT / ".scaffold" / "build" / "addon" / "content" / "scripts" / "highlightask.js",
        ),
    ]:
        if not source.exists():
            print(f"WARN: missing {source}; run `npm run build` first", file=sys.stderr)
            continue
        shutil.copy2(source, OUT / name)

    print(f"wrote {OUT / 'preview.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
