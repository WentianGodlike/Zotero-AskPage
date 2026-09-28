#!/usr/bin/env python3
"""Validate the settings pane markup the way Zotero actually parses it.

Zotero's `_parseXHTMLToFragment()` (chrome/content/zotero/preferences/
preferences.js) does NOT parse the pane file standalone. It wraps the entire
file in a <div> and parses *that* as XML:

    <div xmlns="http://www.w3.org/1999/xhtml"
         xmlns:xul="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">
    ${file contents}
    </div>

Two consequences, both of which have bitten this project:

  1. An XML declaration (`<?xml ... ?>`) at the top of the file becomes illegal
     once wrapped, because such a declaration is only allowed at the very start
     of a document. Zotero then reports
         "XML Parsing Error: XML or text declaration not at start of entity"
         "Error: not well-formed XML"
     and the pane renders blank with no visible reason.
  2. Any stray `&` or unclosed tag is fatal, because this is strict XML — there
     is no HTML error recovery.

Validating the file standalone would pass in exactly the case that fails in
Zotero, so this script always wraps first.

Run: python3 scripts/check-pane.py [path/to/preferences.xhtml]
Exit code 1 on any problem.
"""
import os
import re
import sys
import xml.dom.minidom as minidom

DEFAULT_PANE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "addon",
    "content",
    "preferences.xhtml",
)

# Mirrors Zotero's wrapper exactly (see the docstring).
WRAPPER_OPEN = (
    '<div xmlns="http://www.w3.org/1999/xhtml"\n'
    '\t\txmlns:xul="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">\n'
)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PANE
    path = os.path.normpath(path)

    if not os.path.exists(path):
        print(f"FAIL: pane markup not found at {path}")
        return 1

    src = open(path, encoding="utf-8").read()
    errors: list[str] = []
    warnings: list[str] = []

    print(f"checking {path}\n")

    # --- 1. the specific mistake that produces a silent blank pane --------
    if src.lstrip().startswith("<?xml"):
        errors.append(
            "file starts with an XML declaration (<?xml ... ?>). Zotero wraps "
            "this file in a <div> before parsing, which makes the declaration "
            'illegal ("XML or text declaration not at start of entity") and the '
            "pane renders blank. Remove the declaration."
        )

    # Look for a declaration in actual markup, ignoring comments — the file's
    # own explanatory comment mentions `<?xml` and must not trip this.
    without_comments = re.sub(r"<!--.*?-->", "", src, flags=re.S)
    if re.search(r"<\?xml", without_comments):
        errors.append(
            "file contains an XML declaration somewhere other than the very "
            "start; it will be mid-document after Zotero's wrapping and is fatal"
        )

    # --- 2. parse exactly as Zotero does ---------------------------------
    try:
        doc = minidom.parseString(WRAPPER_OPEN + src + "\n</div>")
    except Exception as exc:  # noqa: BLE001 - report whatever the parser says
        errors.append(f"not well-formed XML after Zotero's wrapping: {exc}")
        doc = None

    # --- 3. element ids the pane script needs ----------------------------
    ids_in_markup: set[str] = set()
    if doc is not None:
        ids_in_markup = {
            el.getAttribute("id")
            for el in doc.getElementsByTagName("*")
            if el.getAttribute("id")
        }
        print(f"markup parses OK; defines {len(ids_in_markup)} ids")

        script_path = os.path.join(os.path.dirname(path), "preferences.js")
        if os.path.exists(script_path):
            js = open(script_path, encoding="utf-8").read()
            # getElementById("x") / $("x")
            used = set(re.findall(r'\$\("([^"]+)"\)', js)) | set(
                re.findall(r'getElementById\("([^"]+)"\)', js)
            )
            missing = sorted(used - ids_in_markup)
            if missing:
                errors.append(
                    "preferences.js looks up ids that do not exist in the "
                    f"markup: {', '.join(missing)}"
                )
            else:
                print(f"all {len(used)} ids used by preferences.js exist")

    # --- 4. things that are legal XML but wrong for this context ---------
    if "<script" in src.lower():
        warnings.append(
            "inline <script> found; Zotero loads pane scripts via the pane "
            "registration instead, so inline scripts may never run"
        )
    if "data-l10n-id" in src:
        warnings.append(
            "data-l10n-id present; these are resolved after insertion, so a "
            "typo only shows up as a console error"
        )

    # --- 5. l10n strings referenced from src/ -----------------------------
    root = os.path.normpath(os.path.join(os.path.dirname(path), "..", ".."))
    errors.extend(check_l10n_strings(root))

    for w in warnings:
        print(f"WARN: {w}")
    for e in errors:
        print(f"FAIL: {e}")

    if errors:
        print(f"\n{len(errors)} error(s), {len(warnings)} warning(s)")
        return 1

    print(f"\nOK — pane markup is valid ({len(warnings)} warning(s))")
    return 0


def check_l10n_strings(root: str) -> list[str]:
    """Every l10nID used in the source must exist in the Fluent files.

    A missing string does not throw — the UI just shows the raw id — so it is
    easy to ship by accident.
    """
    problems: list[str] = []
    src_dir = os.path.join(root, "src")
    locale_dir = os.path.join(root, "addon", "locale")

    used: set[str] = set()
    for dirpath, _dirnames, filenames in os.walk(src_dir):
        for name in filenames:
            if not name.endswith((".ts", ".tsx")):
                continue
            text = open(os.path.join(dirpath, name), encoding="utf-8").read()
            used |= set(re.findall(r'l10nID:\s*"([^"]+)"', text))
            used |= set(re.findall(r'l10n:\s*\{\s*id:\s*"([^"]+)"', text))

    if not used:
        return problems

    defined: set[str] = set()
    if os.path.isdir(locale_dir):
        for dirpath, _dirnames, filenames in os.walk(locale_dir):
            for name in filenames:
                if not name.endswith(".ftl"):
                    continue
                text = open(os.path.join(dirpath, name), encoding="utf-8").read()
                defined |= set(re.findall(r"^([A-Za-z0-9_-]+)\s*=", text, re.M))

    missing = sorted(used - defined)
    if missing:
        problems.append(
            "l10nID(s) used in src/ but not defined in any .ftl: "
            + ", ".join(missing)
        )
    else:
        print(f"all {len(used)} l10nID(s) used in src/ are defined")
    return problems


if __name__ == "__main__":
    sys.exit(main())
