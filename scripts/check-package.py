#!/usr/bin/env python3
"""Verify the BUILT XPI, not just the build directory.

Why this exists: `check-pane.py` and `check-manifest.py` inspect
`.scaffold/build/addon/`. The thing Zotero actually loads is the packed `.xpi`.
Anything that is present in the build directory but missing from the archive —
or referenced by runtime code but never emitted — passes those checks and fails
at runtime with only a console error, e.g.

    Error opening input stream (invalid filename?):
      .../<addonID>.xpi!/content/providers.data.js

which leaves the settings pane silently blank.

This script unpacks the archive and asserts that every asset the plugin
references at runtime is actually inside it.

Run: python3 scripts/check-package.py [path/to.xpi]
Exit code 1 on any problem.
"""
import json
import os
import re
import sys
import zipfile

def _find_built_xpi() -> str:
    """Locate the packed artefact.

    Found by scanning rather than by deriving the name from package.json: the
    scaffold normalises `zotero-askpage` to `ask-page.xpi`, and re-implementing
    that rule here would break again the next time either side changes.
    """
    import glob
    from pathlib import Path

    build = Path(__file__).resolve().parent.parent / ".scaffold" / "build"
    found = sorted(glob.glob(str(build / "*.xpi")))
    if not found:
        # Fall back to a name that at least points at the expected location, so
        # the error message is useful.
        return str(build / "plugin.xpi")
    return found[0]


DEFAULT_XPI = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    ".scaffold",
    "build",
    # Located by scanning: a hard-coded literal here broke the build after the
    # project was renamed.
    _find_built_xpi(),
)
SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def read_sources() -> str:
    """Concatenate all TypeScript sources, for reference extraction."""
    chunks = []
    for dirpath, _dirnames, filenames in os.walk(SRC_DIR):
        for name in filenames:
            if name.endswith((".ts", ".tsx")):
                chunks.append(open(os.path.join(dirpath, name), encoding="utf-8").read())
    return "\n".join(chunks)


def main() -> int:
    xpi = os.path.normpath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XPI)
    if not os.path.exists(xpi):
        print(f"FAIL: package not found at {xpi}")
        print("      run `npm run build` first")
        return 1

    errors: list[str] = []
    warnings: list[str] = []

    print(f"checking {xpi}\n")

    with zipfile.ZipFile(xpi) as z:
        names = set(z.namelist())
        bad = z.testzip()
        if bad is not None:
            errors.append(f"archive is corrupt at {bad}")

        # --- manifest ----------------------------------------------------
        try:
            manifest = json.loads(z.read("manifest.json"))
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL: manifest.json unreadable: {exc}")
            return 1

        print(f"version {manifest.get('version')}")

        for required in ("bootstrap.js", "prefs.js", "manifest.json"):
            if required not in names:
                errors.append(f"required file missing from the package: {required}")

        # --- assets referenced by runtime code ---------------------------
        # `rootURI + "content/..."` is how the plugin names its own files.
        sources = read_sources()
        referenced = set(re.findall(r'rootURI\s*\+\s*"([^"]+)"', sources))
        # Also catch paths built as `content/...` string literals.
        referenced |= set(re.findall(r'"(content/[A-Za-z0-9_./-]+\.(?:js|xhtml|css))"', sources))

        if not referenced:
            warnings.append("no rootURI asset references found; is the extractor still valid?")

        for ref in sorted(referenced):
            if ref in names:
                print(f"  ok   {ref}")
            else:
                errors.append(
                    f"referenced at runtime but missing from the package: {ref}"
                )

        # --- locale files matching l10n ids ------------------------------
        locale_files = sorted(n for n in names if n.endswith(".ftl"))
        if not locale_files:
            errors.append("no .ftl locale files in the package")

        defined: set[str] = set()
        for name in locale_files:
            text = z.read(name).decode("utf-8", "replace")
            defined |= set(re.findall(r"^([A-Za-z0-9_-]+)\s*=", text, re.M))

        used = set(re.findall(r'l10nID:\s*"([^"]+)"', sources))
        missing_l10n = sorted(used - defined)
        if missing_l10n:
            errors.append(
                "l10nID(s) used in src/ but absent from the packaged .ftl files: "
                + ", ".join(missing_l10n)
            )
        elif used:
            print(f"  ok   {len(used)} l10nID(s) resolved in the package")

        # --- warn about assets shipped but never referenced --------------
        # A stale file usually means a rename left something behind.
        content_files = {
            n
            for n in names
            if n.startswith("content/")
            and n.endswith((".js", ".xhtml", ".css"))
            and not n.endswith("/")
        }
        bundled = {n for n in content_files if n.endswith(".js")}
        orphans = sorted(
            n
            for n in bundled
            if n not in referenced and "scripts/" not in n
        )
        for orphan in orphans:
            warnings.append(f"packaged but never referenced: {orphan}")

    for w in warnings:
        print(f"WARN: {w}")
    for e in errors:
        print(f"FAIL: {e}")

    if errors:
        print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
        return 1

    print(f"\nOK — package contents are complete ({len(warnings)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
