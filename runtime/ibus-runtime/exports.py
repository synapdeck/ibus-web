# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""The runtime's export manifest: the symbols each library the runtime
carries contributes, and the library's version.

  manifest  writes exports.txt, the list -sEXPORTED_FUNCTIONS=@file reads,
            grouped by library, and exports.json, each library's version and
            symbol count
  verify    checks a manifest against the versions it must carry
  declared  prints the functions and variables headers declare
  macro     prints the integer a macro expands to

Compilers and pkg-config come from $CC, $CXX and $PKG_CONFIG."""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile

# llvm-objdump -t: address, seven flag columns, section, size, then the
# name, which carries a ".hidden" prefix for hidden symbols. Wasm objects
# have no other way to show visibility: llvm-nm prints hidden and default
# symbols alike.
SYMBOL = re.compile(r"^[0-9a-f]+ (.{7}) (\S+)\t[0-9a-f]+ (.*)$")

# Data that EM_JS and JavaScript-library dependency declarations leave in
# objects for Emscripten to read at link time; the linked module has none.
LINK_METADATA = ("__em_js__", "__em_lib_deps_")

ABI_LINE = "# IBUSWEB_RUNTIME_ABI {}"
SECTION_LINE = re.compile(r"^# (\S+) (\S+): (\d+) symbols$")
SYMBOL_LINE = re.compile(r"^_[A-Za-z0-9_.$]+$")


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        sys.exit(f"{shlex.join(args)} failed:\n{result.stderr}")
    return result.stdout


def compiler(lang):
    return shlex.split(os.environ["CC" if lang == "c" else "CXX"])


def pkg_config(*args):
    return run([os.environ.get("PKG_CONFIG", "pkg-config"), *args]).strip()


def cflags(packages):
    return shlex.split(pkg_config("--cflags", *packages)) if packages else []


def macro_value(include, macro, lang="c", packages=()):
    """The integer macro expands to once include is in."""
    # A marker picks the expansion out of whatever else the header leaves in
    # the preprocessed text.
    text = run(
        [*compiler(lang), *cflags(packages), "-E", "-P", "-x", lang, "-"],
        input=f"#include <{include}>\nibusweb_macro_value {macro}\n",
    )
    values = [
        line.split(None, 1)[1].strip()
        for line in text.splitlines()
        if line.startswith("ibusweb_macro_value ")
    ]
    if len(values) != 1:
        sys.exit(f"<{include}>: {macro} expanded {len(values)} times")
    value = values[0]
    while value.startswith("(") and value.endswith(")"):
        value = value[1:-1].strip()
    match = re.fullmatch(r"(\d+)[uUlL]*", value)
    if match is None:
        sys.exit(f"<{include}>: {macro} is {values[0]!r}, not an integer")
    return int(match[1])


def header_declarations(tree, probe):
    """Functions and variables declared in the header probe includes, by
    their linkage names; those of the headers it includes in turn are left
    out."""
    for node in tree.get("inner", []):
        kind = node.get("kind")
        if kind in ("LinkageSpecDecl", "NamespaceDecl"):
            yield from header_declarations(node, probe)
            continue
        if kind not in ("FunctionDecl", "VarDecl") or node.get("isImplicit"):
            continue
        # A declaration a macro produced is declared where the macro was used.
        loc = node.get("loc", {})
        loc = loc.get("expansionLoc", loc)
        # A location names its own file only where that changes from the
        # location before, but always the file that included it.
        if loc.get("includedFrom", {}).get("file") == probe:
            yield node.get("mangledName", node["name"])


def declared(headers, packages=()):
    """The names headers declare, each header parsed on its own by the
    compiler, as C. Headers only C++ can parse are skipped and returned
    apart; a header neither can parse fails."""
    names = set()
    cxx_only = []
    flags = cflags(packages)
    with tempfile.TemporaryDirectory() as tmp:
        probe = os.path.join(tmp, "probe.c")
        for header in headers:
            with open(probe, "w") as source:
                source.write(f"#include <{header}>\n")
            dump = subprocess.run(
                [*compiler("c"), *flags, "-fsyntax-only", "-Xclang", "-ast-dump=json"]
                + ["-x", "c", probe],
                capture_output=True,
                text=True,
            )
            if dump.returncode != 0:
                run([*compiler("c++"), *flags, "-fsyntax-only", "-x", "c++", probe])
                cxx_only.append(header)
                continue
            names |= set(header_declarations(json.loads(dump.stdout), probe))
    return names, cxx_only


def header_files(rule):
    """The headers a rule names: those listed, and every header in the
    directory where the compiler finds `beside`."""
    headers = list(rule.get("headers", []))
    if "beside" in rule:
        beside = rule["beside"]
        deps = run(
            [*compiler("c"), *cflags(rule.get("packages", [])), "-M", "-x", "c", "-"],
            input=f"#include <{beside}>\n",
        )
        found = [
            path
            for path in deps.replace("\\\n", " ").split()
            if path.endswith(f"/{beside}")
        ]
        if len(found) != 1:
            sys.exit(f"<{beside}> resolved to {found}")
        directory = os.path.dirname(found[0])
        prefix = os.path.dirname(beside)
        headers += sorted(
            f"{prefix}/{name}" if prefix else name
            for name in os.listdir(directory)
            if name.endswith(".h")
        )
    return headers


def public_symbols(objdump, archive, skip_weak=False):
    """Symbols archive defines with default visibility."""
    names = set()
    for line in run([objdump, "-t", archive]).splitlines():
        match = SYMBOL.match(line)
        if match is None:
            continue
        flags, section, name = match.groups()
        scope, weak = flags[0], flags[1]
        if section == "*UND*" or scope == "l" or not (scope == "g" or weak == "w"):
            continue
        if skip_weak and weak == "w":
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
    if not libraries:
        return []
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


def version_of(source):
    if "modversion" in source:
        return pkg_config("--modversion", source["modversion"])
    if "macros" in source:
        return ".".join(
            str(
                macro_value(
                    source["include"],
                    macro,
                    source.get("lang", "c"),
                    source.get("packages", []),
                )
            )
            for macro in source["macros"]
        )
    if "file" in source:
        with open(source["file"]) as text:
            found = set(re.findall(source["pattern"], text.read(), re.MULTILINE))
        if len(found) != 1:
            sys.exit(f"{source['file']}: {source['pattern']!r} matched {sorted(found)}")
        return found.pop()
    sys.exit(f"no way to find a version in {source}")


def manifest(args):
    with open(args.spec) as source:
        spec = json.load(source)
    versions = {name: version_of(source) for name, source in spec["versions"].items()}
    abi = int(versions[spec["abi"]])

    owner = {}
    sections = []
    for library in spec["libraries"]:
        name = library["name"]
        archives = library.get("archives", []) + system_archives(
            args.link_log, library.get("systemLibraries", [])
        )
        symbols = set()
        for archive in archives:
            print(f"{name}: {archive}", file=sys.stderr)
            symbols |= public_symbols(args.objdump, archive, library.get("skipWeak", False))
        if "declaredIn" in library:
            rule = library["declaredIn"]
            headers = header_files(rule)
            public, cxx_only = declared(headers, rule.get("packages", []))
            print(
                f"{name}: {len(public)} names declared in {len(headers)} headers",
                f"(C++ only, skipped: {' '.join(cxx_only)})" if cxx_only else "",
                file=sys.stderr,
            )
            symbols &= public
        # A symbol two libraries define is the first one's, in the order they
        # are listed.
        for symbol in sorted(symbols & owner.keys()):
            print(f"{name}: {symbol} is {owner[symbol]}'s", file=sys.stderr)
        symbols -= owner.keys()
        if not symbols:
            sys.exit(f"{name} contributes no symbols")
        owner.update(dict.fromkeys(symbols, name))
        sections.append((name, library["version"].format(**versions), sorted(symbols)))

    os.makedirs(args.out, exist_ok=True)
    # Emscripten's reader skips lines starting with #, but would take an
    # empty line for a symbol.
    with open(os.path.join(args.out, "exports.txt"), "w") as out:
        print(ABI_LINE.format(abi), file=out)
        for name, version, symbols in sections:
            print(f"# {name} {version}: {len(symbols)} symbols", file=out)
            # Emscripten names a C symbol with a leading underscore in its
            # settings.
            for symbol in symbols:
                print(f"_{symbol}", file=out)
    with open(os.path.join(args.out, "exports.json"), "w") as out:
        libraries = [
            {"name": name, "version": version, "symbols": len(symbols)}
            for name, version, symbols in sections
        ]
        json.dump({"abi": abi, "libraries": libraries}, out, indent=2)
        out.write("\n")


def verify(args):
    def fail(message):
        sys.exit(f"{args.dir}: {message}")

    with open(os.path.join(args.dir, "exports.json")) as source:
        meta = json.load(source)
    with open(os.path.join(args.dir, "exports.txt")) as source:
        lines = source.read().splitlines()

    abi = meta["abi"]
    if not isinstance(abi, int) or lines[0] != ABI_LINE.format(abi):
        fail(f"the first line, {lines[0]!r}, doesn't name ABI {abi!r}")
    sections = []
    for line in lines[1:]:
        if (header := SECTION_LINE.match(line)) is not None:
            sections.append((header[1], header[2], int(header[3]), []))
        elif SYMBOL_LINE.match(line) and sections:
            sections[-1][3].append(line[1:])
        else:
            fail(f"malformed line {line!r}")

    headers = [s[:3] for s in sections]
    listed = [(l["name"], l["version"], l["symbols"]) for l in meta["libraries"]]
    if listed != headers:
        fail(f"exports.json lists {listed}, exports.txt {headers}")
    seen = set()
    for name, _, count, symbols in sections:
        if count == 0 or len(symbols) != count:
            fail(f"{name}: {len(symbols)} symbols under a header of {count}")
        if symbols != sorted(symbols):
            fail(f"{name}: symbols out of order")
        if twice := seen.intersection(symbols):
            fail(f"{name}: also listed earlier: {sorted(twice)}")
        seen.update(symbols)

    versions = {name: version for name, version, _ in headers}
    for expected in args.expect:
        name, version = expected.split("=", 1)
        if versions.get(name) != version:
            fail(f"{name} is at {versions.get(name)}, expected {version}")

    api = next(s[3] for s in sections if s[0] == args.api_library)
    header_names, _ = declared([args.api_header], args.api_pkg_config)
    if stray := sorted(set(api) - header_names):
        fail(f"{args.api_library} exports what <{args.api_header}> doesn't declare: {stray}")

    print(f"ABI {abi}: {len(seen)} symbols")
    for name, version, count in headers:
        print(f"  {name} {version}: {count}")
    print(f"API: {' '.join(api)}")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(required=True)

    command = commands.add_parser("manifest")
    command.add_argument("--spec", required=True, help="the libraries, as JSON")
    command.add_argument("--objdump", required=True)
    command.add_argument("--link-log", required=True, help="em++ -v's output")
    command.add_argument("--out", required=True)
    command.set_defaults(run=manifest)

    command = commands.add_parser("verify")
    command.add_argument("--dir", required=True, help="the manifest's directory")
    command.add_argument("--expect", action="append", default=[], help="NAME=VERSION")
    command.add_argument("--api-library", required=True)
    command.add_argument("--api-header", required=True)
    command.add_argument("--api-pkg-config", action="append", default=[])
    command.set_defaults(run=verify)

    command = commands.add_parser("declared")
    command.add_argument("--pkg-config", action="append", default=[])
    command.add_argument("headers", nargs="+")
    command.set_defaults(
        run=lambda a: print("\n".join(sorted(declared(a.headers, a.pkg_config)[0])))
    )

    command = commands.add_parser("macro")
    command.add_argument("--include", required=True)
    command.add_argument("--lang", default="c", choices=["c", "c++"])
    command.add_argument("--pkg-config", action="append", default=[])
    command.add_argument("macro")
    command.set_defaults(
        run=lambda a: print(macro_value(a.include, a.macro, a.lang, a.pkg_config))
    )

    args = parser.parse_args()
    args.run(args)


main()
