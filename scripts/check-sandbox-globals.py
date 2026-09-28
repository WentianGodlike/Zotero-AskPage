#!/usr/bin/env python3
"""Flag use of browser globals that Zotero's plugin sandbox does not provide.

Zotero runs plugins in a `Cu.Sandbox` whose globals come from an explicit
allowlist (`wantGlobalProperties` in
chrome/content/zotero/xpcom/plugins.js) plus a handful of extras.

Referencing a global that is neither on that list nor imported by the module
throws `ReferenceError` **at the point of use**. Inside a request path that
kills the whole feature and shows up only as one line in the debug console:

    ReferenceError: AbortController is not defined

Detection rules (deliberately conservative — a false positive trains people to
ignore the check):

  * ``new Foo(`` — a constructor call is always runtime.
  * ``Foo.bar`` where Foo is capitalised — static access is runtime.
  * a name we already know is missing, used bare (e.g. ``navigator``).

Skipped: type-only positions (`: Foo`, `<Foo>`, `as Foo`, `interface Foo`,
`type Foo`), string/comment contents, and any name the module declares or
imports itself.

``typeof SomeGlobal !== "undefined"`` is not reported: that is the *correct*
guard, and flagging it would defeat the purpose.

Run: python3 scripts/check-sandbox-globals.py
Exit code 1 on any problem.
"""
import os
import re
import sys

SRC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")

# From `wantGlobalProperties` in chrome/content/zotero/xpcom/plugins.js.
WEB_ALLOWLIST = {
    "atob", "btoa", "Blob", "crypto", "CSS", "ChromeUtils", "DOMParser",
    "fetch", "File", "FileReader", "TextDecoder", "TextEncoder", "URL",
    "URLSearchParams", "XMLHttpRequest",
}

# Assigned onto the scope by the same file.
SCOPE_EXTRAS = {
    "Zotero", "ChromeWorker", "IOUtils", "Localization", "PathUtils",
    "Services", "Worker", "XMLSerializer", "setTimeout", "clearTimeout",
    "setInterval", "clearInterval", "requestIdleCallback", "cancelIdleCallback",
    "Components",
}

LANGUAGE_BUILTINS = {
    "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
    "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError",
    "SyntaxError", "EvalError", "ReferenceError", "URIError", "Promise",
    "Map", "Set", "WeakMap", "WeakSet", "Proxy", "Reflect", "Function",
    "ArrayBuffer", "Uint8Array", "Int8Array", "Uint16Array", "Int16Array",
    "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "DataView",
    "AggregateError", "FinalizationRegistry", "WeakRef", "Intl",
}

PROJECT_GLOBALS = {"addon", "ztoolkit", "_globalThis", "rootURI", "__env__", "console"}

# Documented exceptions: places that reference a missing global behind a runtime
# check the analyser cannot see through (it does not do cross-line dataflow).
# Keep this list tiny and justified — a growing list means the check is losing
# its value.
GUARDED_EXCEPTIONS = {
    ("src/modules/deepseek.ts", "AbortController"): (
        "reference is inside makeAbortController(), which returns early unless "
        "canAbort() confirmed the global exists"
    ),
}

ALLOWED = WEB_ALLOWLIST | SCOPE_EXTRAS | LANGUAGE_BUILTINS | PROJECT_GLOBALS

# Lowercase names worth detecting specifically, with the fix.
KNOWN_MISSING = {
    "navigator": "not exposed; use Zotero APIs",
    "location": "not exposed; use Zotero.launchURL()",
    "localStorage": "no web storage in the plugin sandbox; use Zotero.Prefs or a file",
    "sessionStorage": "no web storage in the plugin sandbox; use Zotero.Prefs or a file",
    "indexedDB": "no web storage in the plugin sandbox",
    "alert": "not on the sandbox allowlist; use Zotero.alert or a progress window",
    "confirm": "not on the sandbox allowlist",
    "prompt": "not on the sandbox allowlist",
    "getComputedStyle": "not on the sandbox allowlist",
    "structuredClone": "not on the sandbox allowlist",
    "queueMicrotask": "not on the sandbox allowlist",
}

# Capitalised names worth detecting, with the fix.
KNOWN_MISSING_CAPS = {
    "AbortController": "use makeAbortController() in modules/deepseek.ts, which detects support",
    "AbortSignal": "take the signal from makeAbortController()",
    "Request": "not on the sandbox allowlist; call fetch(url, options)",
    "Headers": "not on the sandbox allowlist; pass a plain object",
    "Response": "not on the sandbox allowlist; use the value fetch() resolves to",
    "FormData": "not on the sandbox allowlist",
    "WebSocket": "not on the sandbox allowlist",
    "EventSource": "not on the sandbox allowlist",
    "MutationObserver": "exists in a document, not in the plugin sandbox",
    "Node": "not a DOM context; use the item/document hooks",
    "NodeFilter": "not a DOM context",
}


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    return text


def strip_string_literals(line: str) -> str:
    """Remove string and template contents.

    A global's name appearing inside a message is not a reference to it, and
    flagging those makes the check noisy enough to be ignored.
    """
    line = re.sub(r"`(?:[^`\\]|\\.)*`", "``", line)
    line = re.sub(r"'(?:[^'\\]|\\.)*'", "''", line)
    line = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)
    return line


def strip_type_positions(line: str) -> str:
    """Remove substrings that are TypeScript type syntax, not runtime code."""
    # `as Foo`, `<Foo>`, `: Foo` (annotation), `implements Foo`, `extends Foo`
    line = re.sub(r"\bas\s+[A-Za-z_$][\w$.<>\[\]]*", " ", line)
    line = re.sub(r":\s*[A-Za-z_$][\w$.<>\[\], |]*", " ", line)
    line = re.sub(r"<[A-Za-z_$][\w$.<>\[\], |]*>", " ", line)
    line = re.sub(r"\b(?:implements|extends)\s+[A-Za-z_$][\w$.]*", " ", line)
    return line


def collect_declared(code: str) -> set[str]:
    declared: set[str] = set()
    declared |= set(
        re.findall(r"\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)", code)
    )
    for clause in re.findall(r"\bimport\s+([\s\S]*?)\s+from\s+[\"']", code):
        for part in clause.replace("type ", "").replace("{", "").replace("}", "").split(","):
            piece = part.strip()
            if " as " in piece:
                piece = piece.split(" as ")[-1].strip()
            if piece:
                declared.add(piece)
    for group in re.findall(r"\b(?:const|let|var)\s*\{([^}]*)\}", code):
        for piece in group.split(","):
            name = piece.split(":")[-1].split("=")[0].strip()
            if name:
                declared.add(name)
    declared |= set(re.findall(r"\bcatch\s*\(\s*([A-Za-z_$][\w$]*)", code))
    for params in re.findall(r"\(([^()]*)\)\s*(?::[^=]+)?=>", code):
        for piece in params.split(","):
            name = piece.split(":")[0].split("=")[0].strip().lstrip(".")
            if re.fullmatch(r"[A-Za-z_$][\w$]*", name):
                declared.add(name)
    # Declared types act as names too, so `Foo` in `class X implements Foo`
    # does not get mistaken for a global.
    declared |= set(re.findall(r"\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)", code))
    return declared


def check_prompt_defaults() -> list[str]:
    """Assert every quick action resolves to a real prompt string.

    A `const` referenced before its declaration yields `undefined` at module
    evaluation (temporal dead zone). Nothing throws, so the failure mode is
    silent: the action ships with an empty prompt and the model gets asked
    nothing in particular. That happened once with the translate task.
    """
    prompts_path = os.path.join(SRC_DIR, "modules", "prompts.ts")
    if not os.path.exists(prompts_path):
        return ["prompts.ts not found"]

    code = open(prompts_path, encoding="utf-8").read()

    # Only look inside the QUICK_ACTIONS array: `prefKey` also appears in
    # promptFields(), and those entries are not actions.
    array_start = code.find("QUICK_ACTIONS")
    if array_start < 0:
        return ["QUICK_ACTIONS not found in prompts.ts"]
    array = code[array_start:]
    end = array.find("\n];")
    if end >= 0:
        array = array[:end]

    keys = re.findall(r'prefKey:\s*"([^"]+)"', array)
    if not keys:
        return ["no quick actions found"]

    problems: list[str] = []
    for key in keys:
        block = re.search(
            rf'prefKey:\s*"{re.escape(key)}",(.*?)defaultPrompt:\s*(.+?),?\n',
            array,
            re.S,
        )
        if not block:
            problems.append(f"quick action {key!r} has no defaultPrompt")
            continue

        value = block.group(2).strip().rstrip(",")
        if value in ("undefined", "null", '""'):
            problems.append(
                f"quick action {key!r} resolves its default prompt to {value} "
                "(a const declared after use is undefined at module evaluation)"
            )
            continue

        # A bare identifier must be declared before QUICK_ACTIONS.
        if re.fullmatch(r"[A-Za-z_$][\w$]*", value):
            m = re.search(rf"(?:const|let)\s+{re.escape(value)}\b", code)
            if not m:
                problems.append(f"quick action {key!r} references undeclared {value}")
            elif m.start() > array_start:
                problems.append(
                    f"quick action {key!r} uses {value}, which is declared AFTER "
                    "QUICK_ACTIONS — it will be undefined at module evaluation"
                )
    return problems


def main() -> int:
    problems: list[tuple[str, int, str, str]] = []
    checked = 0

    for dirpath, _dirnames, filenames in os.walk(SRC_DIR):
        for name in sorted(filenames):
            if not name.endswith((".ts", ".tsx")):
                continue
            path = os.path.join(dirpath, name)
            raw = strip_comments(open(path, encoding="utf-8").read())
            declared = collect_declared(raw)

            for line_no, raw_line in enumerate(raw.split("\n"), 1):
                # A typeof guard is the correct way to probe for a global.
                if re.search(r"\btypeof\s+[A-Za-z_$]", raw_line):
                    continue

                line = strip_type_positions(strip_string_literals(raw_line))

                candidates: set[str] = set()
                candidates |= set(re.findall(r"\bnew\s+([A-Za-z_$][\w$]*)", line))
                candidates |= set(
                    re.findall(r"(?<![\w$.])([A-Z][\w$]*)\.[A-Za-z_$]", line)
                )
                for known in list(KNOWN_MISSING) + list(KNOWN_MISSING_CAPS):
                    if re.search(rf"(?<![\w$.]){re.escape(known)}\b", line):
                        candidates.add(known)

                rel_path = os.path.relpath(path, os.path.join(SRC_DIR, ".."))
                for cand in sorted(candidates):
                    if cand in ALLOWED or cand in declared:
                        continue
                    if (rel_path, cand) in GUARDED_EXCEPTIONS:
                        continue
                    problems.append((path, line_no, raw_line.strip(), cand))

            checked += 1

    prompt_problems = check_prompt_defaults()
    for msg in prompt_problems:
        print(f"FAIL: {msg}")

    print(f"scanned {checked} source file(s)")
    print(
        f"allowlist: {len(WEB_ALLOWLIST)} web APIs, {len(SCOPE_EXTRAS)} scope extras, "
        f"{len(LANGUAGE_BUILTINS)} language built-ins"
    )

    if not problems and not prompt_problems:
        if GUARDED_EXCEPTIONS:
            print(f"\n({len(GUARDED_EXCEPTIONS)} documented guarded exception(s) skipped)")
        print("OK — no unavailable globals referenced")
        return 0

    print()
    seen = set()
    for path, line_no, line, name in problems:
        rel = os.path.relpath(path, os.path.join(SRC_DIR, ".."))
        if (rel, line_no) in seen:
            continue
        seen.add((rel, line_no))
        print(f"FAIL: {rel}:{line_no}  [{name}]")
        print(f"      {line}")
        hint = KNOWN_MISSING.get(name) or KNOWN_MISSING_CAPS.get(name)
        if hint:
            print(f"      → {hint}")

    print(f"\n{len(seen)} problem(s)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
