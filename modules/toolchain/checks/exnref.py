# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

"""Fails once every minimum version supports exnref, WebAssembly's standard
exception encoding, so that the switch away from the legacy one isn't missed.

The thresholds are read from Emscripten's feature matrix with `ast` rather
than imported, since importing it pulls in Emscripten's settings machinery.
"""

import ast
import json
import sys

matrix_path, versions_path = sys.argv[1:]
tree = ast.parse(open(matrix_path, encoding="utf-8").read(), matrix_path)

constants = {}
matrix = None
for node in tree.body:
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
        continue
    target = node.targets[0]
    if not isinstance(target, ast.Name):
        continue
    if isinstance(node.value, ast.Constant):
        constants[target.id] = node.value.value
    elif target.id == "min_browser_versions" and isinstance(node.value, ast.Dict):
        matrix = node.value


def value(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name) and node.id in constants:
        return constants[node.id]
    raise SystemExit(f"{matrix_path}: unreadable threshold {ast.unparse(node)}")


if matrix is None:
    raise SystemExit(f"{matrix_path}: no min_browser_versions")
thresholds = None
for key, entry in zip(matrix.keys, matrix.values):
    if ast.unparse(key) == "Feature.WASM_EXCEPTIONS" and isinstance(entry, ast.Dict):
        thresholds = {value(k): value(v) for k, v in zip(entry.keys, entry.values)}
if thresholds is None:
    raise SystemExit(f"{matrix_path}: no min_browser_versions entry for Feature.WASM_EXCEPTIONS")

minimums = json.load(open(versions_path, encoding="utf-8"))
if set(minimums) != set(thresholds):
    raise SystemExit(f"targets differ: minimum versions {sorted(minimums)}, exnref {sorted(thresholds)}")

rows = [f"  {name}: minimum {minimums[name]}, exnref from {thresholds[name]}" for name in sorted(minimums)]
if all(minimums[name] >= thresholds[name] for name in minimums):
    print(
        "Every minimum version now supports exnref, the standard WebAssembly exception encoding:",
        *rows,
        "Switch to exnref now: compile and link everything with -sWASM_LEGACY_EXCEPTIONS=0,",
        "which rebuilds every object and the Emscripten cache.",
        sep="\n",
        file=sys.stderr,
    )
    sys.exit(1)
print("exnref is not yet supported by every minimum version:", *rows, sep="\n")
