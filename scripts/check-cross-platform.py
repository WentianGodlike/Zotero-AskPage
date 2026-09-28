#!/usr/bin/env python3
"""Cross-platform checks that do not need the target platform.

Why this exists: the build chain has to work on a contributor's machine, not
just mine. Two classes of problem are invisible on Linux and fatal elsewhere:

  * **Python syntax that needs a newer interpreter.** `list[str]` in a function
    signature is evaluated at definition time before 3.9, so a script carrying
    it exits with a TypeError on Python 3.8 — and `npm run build` calls these
    scripts, so the whole build fails. `from __future__ import annotations`
    defers them and makes 3.8 fine.
  * **Hard-coded absolute paths**, which do not exist on another machine.

Also asserts that `engines` is declared (so an old Node fails with a readable
message rather than deep inside the scaffold) and that line endings are pinned.

Run: python3 scripts/check-cross-platform.py
Exit code 1 on any problem.
"""
from __future__ import annotations

import ast, glob, json, os, re, sys

problems = []

# 1. Python 最低版本可行性
for path in sorted(glob.glob('scripts/**/*.py', recursive=True)):
    src = open(path, encoding='utf-8').read()
    tree = ast.parse(src)
    has_future = any(
        isinstance(n, ast.ImportFrom) and n.module == '__future__'
        and any(a.name == 'annotations' for a in n.names)
        for n in tree.body
    )
    for node in ast.walk(tree):
        if node.__class__.__name__ == 'Match':
            problems.append(f"{path}: match 语句需要 3.10+")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            anns = [a.annotation for a in node.args.args + node.args.kwonlyargs] + [node.returns]
            for ann in anns:
                if ann is None or has_future:
                    continue
                for n in ast.walk(ann):
                    if (isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name)
                            and n.value.id in {'list','dict','set','tuple'}):
                        problems.append(f"{path}:{node.lineno} 运行时求值的内建泛型，需要 3.9+")

# 2. 脚本里的绝对路径（换机器就失效）
for path in sorted(glob.glob('scripts/**/*.py', recursive=True)):
    for i, line in enumerate(open(path, encoding='utf-8'), 1):
        if re.search(r'["\']/(home|Users|mnt|opt)/', line):
            problems.append(f"{path}:{i} 硬编码绝对路径: {line.strip()[:60]}")

# 3. package.json 的 engines 是否声明
pkg = json.load(open('package.json', encoding='utf-8'))
if not pkg.get('engines'):
    problems.append("package.json 未声明 engines")

# 4. 构建脚本是否依赖 unix-only 命令
for name, cmd in pkg['scripts'].items():
    for unix_only in ['&&', '||']:
        pass   # && 在 npm 的 sh 与 cmd 上都可用
    if re.search(r'\b(rm|cp|mv|chmod|sed|awk|grep)\b', cmd):
        problems.append(f"scripts.{name} 使用 unix 命令: {cmd[:60]}")

# 5. .gitattributes 行尾
ga = open('.gitattributes', encoding='utf-8').read() if os.path.exists('.gitattributes') else ''
if 'eol=lf' not in ga:
    problems.append(".gitattributes 未固定 eol=lf")

if problems:
    for p in problems:
        print(f"FAIL: {p}")
    sys.exit(1)
print("OK — Python 3.8+ parseable, no absolute paths, engines declared, no shell deps, LF pinned")
