#!/usr/bin/env python3
"""Catch characters that terminate a template literal inside embedded CSS.

Why this exists
---------------
The chat view embeds its stylesheet as a template literal:

    const CSS = `
    .ha-chat { ... }
    `;

A backtick anywhere inside — including inside a CSS comment — ends the literal
early. Everything after it is then parsed as JavaScript, producing errors such
as `Property 'ha' does not exist on type ...` that point at the CSS rather than
at the cause.

This has happened twice, both times in a comment written while editing a rule:

    buttons carry `.ha-chat-btn`, so ...
    `max-width: 100%` plus `min-width: 0` ...

Remembering is not a strategy, so the check is automated.

What it does NOT flag
---------------------
`${...}` interpolation is legitimate and left alone. Only a bare backtick or a
`${` that looks unintended would be a problem; the latter is not detectable
without parsing, so only the unambiguous case is reported.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Matches: const NAME = `   ...   `;
TEMPLATE_RE = re.compile(
    r"const\s+(?P<name>[A-Za-z_$][\w$]*)\s*=\s*`(?P<body>.*?)`;",
    re.DOTALL,
)

# Files worth checking: the ones that embed markup or styles in a template.
TARGETS = ["src/**/*.ts"]


def check_file(path: Path) -> list[str]:
    problems: list[str] = []
    text = path.read_text(encoding="utf-8")

    for match in TEMPLATE_RE.finditer(text):
        name = match.group("name")
        body = match.group("body")
        start_line = text[: match.start()].count("\n") + 1

        for offset, line in enumerate(body.split("\n")):
            line_no = start_line + offset
            if "`" in line:
                problems.append(
                    f"{path}:{line_no}  backtick inside template `{name}` — "
                    f"this ends the literal early: {line.strip()[:70]!r}"
                )
            # A nested `${` is legal but almost always a typo in CSS.
            if re.search(r"\$\{", line) and name == "CSS":
                problems.append(
                    f"{path}:{line_no}  `${{` inside CSS template `{name}` — "
                    f"the stylesheet is not interpolated: {line.strip()[:70]!r}"
                )

    return problems


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    files: list[Path] = []
    for pattern in TARGETS:
        files.extend(sorted(root.glob(pattern)))

    problems: list[str] = []
    for path in files:
        problems.extend(check_file(path))

    print(f"scanned {len(files)} source file(s)")
    if problems:
        print()
        for problem in problems:
            print(f"  FAIL: {problem}")
        print(f"\n{len(problems)} problem(s)")
        return 1

    print("OK — no backticks inside template literals")
    return 0


if __name__ == "__main__":
    sys.exit(main())
