# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Fails if a side module imports a symbol the runtime's export list lacks.

Imports are read with Emscripten's own reader, the one its linker uses to
learn what side modules need from a main module."""

import argparse
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emscripten", required=True, help="Emscripten's root")
    parser.add_argument("--exports", required=True, help="the export list")
    parser.add_argument("modules", nargs="+")
    args = parser.parse_args()

    sys.path.insert(0, args.emscripten)
    from tools import webassembly

    with open(args.exports) as listing:
        # The list names symbols as Emscripten's settings do, with a
        # leading underscore.
        exported = {
            line.rstrip("\n")[1:] for line in listing if not line.startswith("#")
        }

    failed = False
    for module in args.modules:
        imports = webassembly.get_imports(module)
        # Function and tag imports name symbols directly; data and function
        # addresses come through the GOT.mem and GOT.func tables. The other
        # globals in env are the loader's, set per module (its memory and
        # table bases, the stack pointer), not symbols.
        needed = {
            i.field
            for i in imports
            if (
                i.module == "env"
                and i.kind
                in (webassembly.ExternType.FUNC, webassembly.ExternType.TAG)
            )
            or i.module in ("GOT.mem", "GOT.func")
        }
        # A module's own exports satisfy its GOT entries for them, and a weak
        # import may stay unresolved.
        needed -= {e.name for e in webassembly.get_exports(module)}
        needed -= set(webassembly.get_weak_imports(module))
        missing = sorted(needed - exported)
        print(f"{module}: {len(needed)} imported symbols, {len(missing)} missing")
        for name in missing:
            print(f"  {name}")
        failed |= bool(missing)
    sys.exit(1 if failed else 0)


main()
