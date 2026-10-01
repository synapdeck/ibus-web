# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Prints the runtime's export list: every symbol the given static libraries
and system libraries define with default visibility, in the one-per-line
form Emscripten's -sEXPORTED_FUNCTIONS=@file reads, after a comment naming
the ABI version."""

import argparse
import os
import re
import shlex
import subprocess
import sys

# llvm-objdump -t: address, seven flag columns, section, size, then the
# name, which carries a ".hidden" prefix for hidden symbols. Wasm objects
# have no other way to show visibility: llvm-nm prints hidden and default
# symbols alike.
SYMBOL = re.compile(r"^[0-9a-f]+ (.{7}) (\S+)\t[0-9a-f]+ (.*)$")

# Data that EM_JS and JavaScript-library dependency declarations leave in
# objects for Emscripten to read at link time; the linked module has none.
LINK_METADATA = ("__em_js__", "__em_lib_deps_")


def public_symbols(objdump, archive):
    listing = subprocess.run(
        [objdump, "-t", archive], check=True, capture_output=True, text=True
    ).stdout
    names = set()
    for line in listing.splitlines():
        match = SYMBOL.match(line)
        if match is None:
            continue
        flags, section, name = match.groups()
        scope, weak = flags[0], flags[1]
        if section == "*UND*" or scope == "l" or not (scope == "g" or weak == "w"):
            continue
        if name.startswith(".hidden ") or name.startswith(LINK_METADATA):
            continue
        names.add(name)
    if not names:
        sys.exit(f"{archive}: no public symbols; is this a wasm archive?")
    return names


def system_archives(link_log, libraries):
    """Finds the archives of the named system libraries on the wasm-ld command
    line that em++ -v logged. A link names each library by its variant, the
    library's name followed by suffixes for the link's settings
    (libc-mt-debug, libc++-mt-legacyexcept), so exactly one must match."""
    with open(link_log) as log:
        commands = [shlex.split(line) for line in log if "wasm-ld " in line]
    if len(commands) != 1:
        sys.exit(f"{link_log}: expected one wasm-ld command, found {len(commands)}")
    args = commands[0]
    dirs = [a[2:] for a in args if a.startswith("-L")]
    linked = [a[2:] for a in args if a.startswith("-l")]

    archives = []
    for library in libraries:
        variants = [l for l in linked if l == library or l.startswith(f"{library}-")]
        if len(variants) != 1:
            sys.exit(f"the link names {len(variants)} variants of lib{library}: {variants}")
        found = [
            path
            for path in (os.path.join(d, f"lib{variants[0]}.a") for d in dirs)
            if os.path.exists(path)
        ]
        if not found:
            sys.exit(f"lib{variants[0]}.a is in none of {dirs}")
        archives.append(found[0])
    return archives


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abi", required=True, type=int)
    parser.add_argument("--objdump", required=True)
    parser.add_argument("--link-log", required=True, help="em++ -v's output")
    parser.add_argument(
        "--system-library", action="append", default=[], dest="system_libraries"
    )
    parser.add_argument("archives", nargs="+")
    args = parser.parse_args()

    archives = args.archives + system_archives(args.link_log, args.system_libraries)
    for archive in archives:
        print(f"from {archive}", file=sys.stderr)
    names = set()
    for archive in archives:
        names |= public_symbols(args.objdump, archive)
    print(f"# IBUSWEB_RUNTIME_ABI {args.abi}")
    # Emscripten names a C symbol with a leading underscore in its settings.
    for name in sorted(names):
        print(f"_{name}")


main()
