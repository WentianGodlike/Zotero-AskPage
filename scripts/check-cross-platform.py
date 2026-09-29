#!/usr/bin/env python3
"""Cross-platform checks that do not need the target platform.

Why this exists: the build chain has to work on a contributor's machine, not
just mine. Two classes of problem are invisible on Linux and fatal elsewhere:

  * **Function annotations that need Python 3.9.** `def f(x: list[str])` is
    evaluated when the function is *defined*, so on Python 3.8 the module raises
    `TypeError: 'type' object is not subscriptable` and the script never runs.
    Because `npm run build` invokes these scripts, the whole build fails.
    `from __future__ import annotations` makes annotations strings and fixes it.

    Only parameter and return annotations matter. A variable annotation such as
    `errors: list[str] = []` is stored unevaluated at module level and is not
    evaluated at all inside a function body, so it is safe on 3.8 and is not
    reported.

  * **Hard-coded absolute paths**, which do not exist on another machine.

Also asserts that `engines` is declared — so an old Node fails with a readable
message instead of deep inside the scaffold — and that line endings are pinned.

Run: python3 scripts/check-cross-platform.py
Exit code 1 on any problem.
"""

from __future__ import annotations

import ast
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "scripts")
BUILTIN_GENERICS = {"list", "dict", "set", "tuple", "frozenset", "type"}


def _uses_builtin_generic(node: ast.AST) -> bool:
    for child in ast.walk(node):
        if isinstance(child, ast.Subscript) and isinstance(child.value, ast.Name):
            if child.value.id in BUILTIN_GENERICS:
                return True
    return False


def check_python_version_safety() -> list[str]:
    """Report function annotations that would fail to evaluate on Python 3.8."""
    problems: list[str] = []
    pattern = os.path.join(SCRIPTS, "**", "*.py")
    for path in sorted(glob.glob(pattern, recursive=True)):
        rel = os.path.relpath(path, ROOT)
        try:
            tree = ast.parse(open(path, encoding="utf-8").read())
        except SyntaxError as e:
            problems.append(f"{rel}: cannot parse — {e}")
            continue

        has_future = any(
            isinstance(n, ast.ImportFrom)
            and n.module == "__future__"
            and any(a.name == "annotations" for a in n.names)
            for n in tree.body
        )
        if has_future:
            continue  # annotations are strings; safe on 3.8

        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            args = list(node.args.args) + list(node.args.kwonlyargs)
            if node.args.vararg:
                args.append(node.args.vararg)
            if node.args.kwarg:
                args.append(node.args.kwarg)
            for arg in args:
                if arg.annotation and _uses_builtin_generic(arg.annotation):
                    problems.append(
                        f"{rel}:{node.lineno} parameter `{arg.arg}` of {node.name}() "
                        f"is annotated with a builtin generic, evaluated at import "
                        f"time — needs 3.9+, or `from __future__ import annotations`"
                    )
            if node.returns and _uses_builtin_generic(node.returns):
                problems.append(
                    f"{rel}:{node.lineno} return type of {node.name}() is a builtin "
                    f"generic, evaluated at import time — needs 3.9+, or "
                    f"`from __future__ import annotations`"
                )
    return problems


def check_absolute_paths() -> list[str]:
    problems: list[str] = []
    pattern = os.path.join(SCRIPTS, "**", "*.py")
    for path in sorted(
        glob.glob(pattern, recursive=True)
        + glob.glob(os.path.join(SCRIPTS, "**", "*.mjs"), recursive=True)
    ):
        rel = os.path.relpath(path, ROOT)
        for number, line in enumerate(open(path, encoding="utf-8"), 1):
            if re.search(r"""["']/(home|Users|mnt|opt|Volumes)/""", line):
                problems.append(f"{rel}:{number} hard-coded absolute path")
    return problems


def check_package_metadata() -> list[str]:
    problems: list[str] = []
    pkg = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))

    if not pkg.get("engines"):
        problems.append(
            "package.json declares no `engines` — an unsupported Node version "
            "fails deep inside the scaffold with no explanation"
        )

    # Shell built-ins are not portable to cmd.exe. npm runs scripts through the
    # platform shell, so the build must not depend on them.
    for name, command in pkg.get("scripts", {}).items():
        if re.search(r"\b(rm|cp|mv|chmod|sed|awk|grep|find)\b", command):
            problems.append(
                f"scripts.{name} uses a unix-only command: {command[:60]}"
            )

    attributes = os.path.join(ROOT, ".gitattributes")
    if not os.path.exists(attributes):
        problems.append(".gitattributes missing — line endings are not pinned")
    elif "eol=lf" not in open(attributes, encoding="utf-8").read():
        problems.append(".gitattributes does not pin `eol=lf`")

    return problems


def main() -> int:
    scripts = glob.glob(os.path.join(SCRIPTS, "**", "*.py"), recursive=True)
    problems = (
        check_python_version_safety()
        + check_absolute_paths()
        + check_package_metadata()
    )

    print(f"scanned {len(scripts)} script(s)")
    if problems:
        print()
        for problem in problems:
            print(f"FAIL: {problem}")
        print(f"\n{len(problems)} problem(s)")
        return 1

    print(
        "OK — Python 3.8-safe, no absolute paths, engines declared, "
        "no shell dependencies, LF pinned"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
