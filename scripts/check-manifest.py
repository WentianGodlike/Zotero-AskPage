#!/usr/bin/env python3
"""Validate the built addon before installing it into Zotero.

Gecko rejects an XPI whose manifest has a malformed compatibility block, and the
error Zotero surfaces is only "may not be compatible with this version" — which
gives no hint about the real cause. This script checks the concrete things that
have actually broken an install here:

  * `update_url` present but empty / not an absolute http(s) URL
  * addon `id` that is not a plausible email address
  * `icons` whose declared size does not match the real PNG dimensions
  * missing or mis-ordered `strict_min_version` / `strict_max_version`
  * a `version` that violates the manifest's own compatibility range

Run: python3 scripts/check-manifest.py [dist_dir]
Exit code 1 if anything is wrong.
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 8):  # noqa: UP036
    sys.exit(
        "This script needs Python 3.8 or newer "
        f"(running {sys.version.split()[0]})."
    )

# Version guard first: on an older interpreter this should produce a readable
# message rather than a SyntaxError from the syntax below.

import json
import os
import struct
import sys

DEFAULT_DIST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", ".scaffold", "build", "addon"
)

errors: list[str] = []
warnings: list[str] = []

def png_size(path: str):
    """Read width/height from a PNG IHDR chunk without any dependency."""
    with open(path, "rb") as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    if head[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", head[16:24])
    return width, height

def parse_version(text: str):
    """Loose numeric version key, enough to compare 7.9.9 against 10.0.3."""
    parts = []
    for chunk in str(text).split("."):
        digits = ""
        for ch in chunk:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts[:4])

def main() -> int:
    dist = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIST
    manifest_path = os.path.join(dist, "manifest.json")

    if not os.path.exists(manifest_path):
        print(f"FAIL: manifest not found at {manifest_path}")
        print("      run `npm run build` first")
        return 1

    m = json.load(open(manifest_path, encoding="utf-8"))
    print(f"checking {os.path.normpath(manifest_path)}\n")

    # --- top level -------------------------------------------------------
    for key in ("manifest_version", "name", "version"):
        if not m.get(key):
            errors.append(f"manifest.{key} is missing or empty")

    if m.get("manifest_version") != 2:
        # Zotero 7+ plugins are MV2; MV3 is not accepted.
        errors.append(
            f"manifest_version must be 2 for Zotero plugins, got {m.get('manifest_version')!r}"
        )

    # --- addon id --------------------------------------------------------
    apps = m.get("applications") or m.get("browser_specific_settings") or {}
    zotero = apps.get("zotero") or {}
    addon_id = zotero.get("id")

    if not addon_id:
        errors.append("applications.zotero.id is missing")
    else:
        local, _, domain = str(addon_id).partition("@")
        if not local or not domain:
            errors.append(f"addon id {addon_id!r} is not of the form name@domain")
        elif "." not in domain:
            warnings.append(
                f"addon id {addon_id!r}: domain part {domain!r} has no dot; "
                "Gecko expects something that looks like an email address"
            )

    # --- update_url ------------------------------------------------------
    # This is the check that mattered: an empty string is not a valid URL and
    # makes the whole manifest fail to parse.
    if "update_url" in zotero:
        url = zotero["update_url"]
        if not isinstance(url, str) or not url.strip():
            errors.append(
                "applications.zotero.update_url is present but empty — "
                "remove the key entirely instead"
            )
        elif not url.startswith(("http://", "https://")):
            errors.append(
                f"applications.zotero.update_url {url!r} is not an absolute http(s) URL"
            )
        elif "{{" in url or "}}" in url:
            errors.append(
                f"applications.zotero.update_url {url!r} still contains an "
                "unsubstituted template placeholder"
            )

    # --- version range ---------------------------------------------------
    lo = zotero.get("strict_min_version")
    hi = zotero.get("strict_max_version")
    if not lo:
        errors.append("applications.zotero.strict_min_version is missing")
    if not hi:
        errors.append("applications.zotero.strict_max_version is missing")
    if lo and hi and parse_version(lo) >= parse_version(hi):
        errors.append(f"strict_min_version {lo} is not below strict_max_version {hi}")
    if hi and parse_version(hi) < parse_version("10.0.0"):
        warnings.append(
            f"strict_max_version {hi} excludes Zotero 10 — the plugin will not "
            "install on this machine's Zotero"
        )

    # --- icons -----------------------------------------------------------
    icons = m.get("icons") or {}
    for declared, rel in icons.items():
        path = os.path.join(dist, rel)
        if not os.path.exists(path):
            errors.append(f"icon {rel!r} (declared {declared}px) does not exist")
            continue
        actual = png_size(path)
        if actual is None:
            errors.append(f"icon {rel!r} is not a readable PNG")
            continue
        if str(actual[0]) != str(declared):
            errors.append(
                f"icon {rel!r} declares {declared}px but is actually "
                f"{actual[0]}x{actual[1]}px"
            )

    # --- report ----------------------------------------------------------
    for w in warnings:
        print(f"WARN: {w}")
    for e in errors:
        print(f"FAIL: {e}")

    if errors:
        print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
        return 1

    print(f"\nOK — every compatibility check passed ({len(warnings)} warning(s))")
    return 0

if __name__ == "__main__":
    sys.exit(main())
