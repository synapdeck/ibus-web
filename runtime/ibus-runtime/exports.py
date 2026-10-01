# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""The runtime's export manifest: the symbols each library the runtime
carries contributes, and the library's version.

  manifest  writes exports.txt, the list -sEXPORTED_FUNCTIONS=@file reads,
            grouped by library, and exports.json, each library's version and
            symbols
  verify    checks a manifest against the versions it must carry
  declared  prints the functions and variables headers declare
  macro     prints the integer a macro expands to

Compilers and pkg-config come from $CC, $CXX and $PKG_CONFIG."""

import argparse
import concurrent.futures
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

# What EMCC_DEBUG logs as it writes the settings it hands the JavaScript
# compiler.
SAVED_SETTINGS = re.compile(r"saving intermediate file (\S+settings\.json)$")

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
    """The integer macro expands to once include, if any, is in."""
    # A marker picks the expansion out of whatever else the header leaves in
    # the preprocessed text.
    text = run(
        [*compiler(lang), *cflags(packages), "-E", "-P", "-x", lang, "-"],
        input=(f"#include <{include}>\n" if include else "")
        + f"ibusweb_macro_value {macro}\n",
    )
    values = [
        line.split(None, 1)[1].strip()
        for line in text.splitlines()
        if line.startswith("ibusweb_macro_value ")
    ]
    if len(values) != 1:
        sys.exit(f"{macro} expanded {len(values)} times")
    value = values[0]
    while value.startswith("(") and value.endswith(")"):
        value = value[1:-1].strip()
    match = re.fullmatch(r"(\d+)[uUlL]*", value)
    if match is None:
        sys.exit(f"{macro} is {values[0]!r}, not an integer")
    return int(match[1])


def name_files(tree):
    """Writes into every source location of a clang JSON AST dump the file
    it is in. The dump names a location's file only where it differs from
    the location written before, so files are carried along in document
    order. includedFrom isn't a location of its own and doesn't move it."""
    current = None
    pending = [iter([tree])]
    while pending:
        value = next(pending[-1], pending)
        if value is pending:
            pending.pop()
        elif isinstance(value, dict):
            if "offset" in value:
                current = value.setdefault("file", current)
            pending.append(v for k, v in value.items() if k != "includedFrom")
        elif isinstance(value, list):
            pending.append(iter(value))


def header_declarations(tree, header, probe):
    """Functions and variables declared in header, which probe includes, by
    their linkage names, each with whether it is declared with default
    visibility. A header may be a chain of files of the same name, each
    including the next (#include_next): an overlay that adds declarations to
    another's. Declarations of the headers it includes are left out."""
    for node in tree.get("inner", []):
        kind = node.get("kind")
        if kind in ("LinkageSpecDecl", "NamespaceDecl"):
            yield from header_declarations(node, header, probe)
            continue
        if kind not in ("FunctionDecl", "VarDecl") or node.get("isImplicit"):
            continue
        # A declaration a macro produced is declared where the macro was used.
        loc = node.get("loc", {})
        loc = loc.get("expansionLoc", loc)
        includer = loc.get("includedFrom", {}).get("file", "")
        if loc.get("file", "").endswith(f"/{header}") and (
            includer == probe or includer.endswith(f"/{header}")
        ):
            visible = any(
                attr.get("kind") == "VisibilityAttr" and attr.get("visibility") == "default"
                for attr in node.get("inner", [])
            )
            yield node.get("mangledName", node["name"]), visible


def parse_header(header, flags, tmp):
    """header's declarations, parsed as C; "c++" if only C++ can parse it,
    or None if neither can."""
    probe = os.path.join(tmp, f"{header.replace('/', '_')}.c")
    with open(probe, "w") as source:
        source.write(f"#include <{header}>\n")
    dump = subprocess.run(
        [*compiler("c"), *flags, "-fsyntax-only", "-Xclang", "-ast-dump=json"]
        + ["-x", "c", probe],
        capture_output=True,
        text=True,
    )
    if dump.returncode != 0:
        cxx = subprocess.run(
            [*compiler("c++"), *flags, "-fsyntax-only", "-x", "c++", probe],
            capture_output=True,
        )
        return "c++" if cxx.returncode == 0 else None
    tree = json.loads(dump.stdout)
    name_files(tree)
    return dict(header_declarations(tree, header, probe))


def declarations(rule):
    """The names the headers a rule names declare, each with whether it is
    declared with default visibility. Each header is parsed on its own by the
    compiler, as C. Those only C++ can parse must be exactly the rule's
    cxxOnly, and those neither can, exactly its unparseable."""
    headers = header_files(rule)
    flags = cflags(rule.get("packages", []))
    names = {}
    failed = {"cxxOnly": set(), "unparseable": set()}
    with tempfile.TemporaryDirectory() as tmp:
        with concurrent.futures.ThreadPoolExecutor(os.cpu_count()) as pool:
            parsed = pool.map(lambda header: parse_header(header, flags, tmp), headers)
            for header, declared in zip(headers, parsed):
                if declared == "c++":
                    failed["cxxOnly"].add(header)
                elif declared is None:
                    failed["unparseable"].add(header)
                else:
                    for name, visible in declared.items():
                        names[name] = names.get(name, False) or visible
    for key, found in failed.items():
        if found != set(rule.get(key, [])):
            sys.exit(f"{key} headers: {sorted(found)}, expected {sorted(rule.get(key, []))}")
    return names


def header_files(rule):
    """The headers a rule names: those listed, and every header under the
    directory tree, named relative to it."""
    headers = list(rule.get("headers", []))
    if "tree" in rule:
        tree = rule["tree"]
        found = sorted(
            os.path.relpath(os.path.join(directory, name), tree)
            for directory, _, names in os.walk(tree)
            for name in names
            if name.endswith(".h")
        )
        if not found:
            sys.exit(f"{tree}: no headers")
        headers += found
    return headers


def public_symbols(objdump, archive, skip_weak=False):
    """Symbols archive defines with default visibility."""
    names = {}
    for line in run([objdump, "-t", archive]).splitlines():
        match = SYMBOL.match(line)
        if match is None:
            continue
        flags, section, name = match.groups()
        scope, weak = flags[0], flags[1]
        if section == "*UND*" or scope == "l" or not (scope == "g" or weak == "w"):
            continue
        if name.startswith(".hidden ") or name.startswith(LINK_METADATA):
            continue
        names[name] = names.get(name, True) and weak == "w"
    if not names:
        sys.exit(f"{archive}: no public symbols; is this a wasm archive?")
    # A name some member defines strongly isn't a hook.
    return {name for name, weak in names.items() if not (skip_weak and weak)}


def logged_command(lines, is_command):
    """The one command em++ -v echoed (on a line of its own, starting with
    the program's path) that is_command accepts, and its index in lines."""
    found = [
        (index, args)
        for index, args in (
            (index, shlex.split(line))
            for index, line in enumerate(lines)
            if line.startswith(" /")
        )
        if is_command(args)
    ]
    if len(found) != 1:
        sys.exit(f"expected one such command in the link log, found {len(found)}")
    return found[0]


def system_archives(lines, libraries):
    """Finds the archives of the named system libraries, or of all of them
    for "*", on the wasm-ld command line that em++ -v logged. A link names
    each library by its variant, the library's name followed by suffixes for
    the link's settings (libc-mt-debug, libc++-mt-legacyexcept), so exactly
    one must match."""
    if not libraries:
        return []
    _, args = logged_command(lines, lambda args: args[0].endswith("/wasm-ld"))
    dirs = [a[2:] for a in args if a.startswith("-L")]
    linked = [a[2:] for a in args if a.startswith("-l")]

    archives = []
    for library in linked if libraries == "*" else libraries:
        variants = (
            [library]
            if libraries == "*"
            else [l for l in linked if l == library or l.startswith(f"{library}-")]
        )
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


def javascript_symbols(lines):
    """The C symbols Emscripten's JavaScript library implements for the link
    em++ -v logged with EMCC_DEBUG set. Before linking, Emscripten runs its
    JavaScript compiler on the link's settings to list them; EMCC_DEBUG logs
    that command and keeps the settings, so running it again gives the same
    list."""
    index, args = logged_command(
        lines,
        lambda args: len(args) > 1
        and args[1].endswith("/tools/compiler.mjs")
        and "--symbols-only" in args,
    )
    saved = [m[1] for m in map(SAVED_SETTINGS.search, lines[:index]) if m is not None]
    if not saved:
        sys.exit("the link log names no settings before the JavaScript symbol list")
    with open(saved[-1]) as settings:
        listing = json.loads(run(args, stdin=settings))
    # Keys with a $ are JavaScript helpers, not C symbols.
    return {name for name in listing["deps"] if not name.startswith("$")}


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
    with open(args.link_log) as log:
        lines = log.read().splitlines()
    versions = {name: version_of(source) for name, source in spec["versions"].items()}
    abi = int(versions[spec["abi"]])
    javascript = javascript_symbols(lines)
    print(f"JavaScript library: {len(javascript)} C symbols", file=sys.stderr)

    parsed = {}

    def declared(rule):
        key = json.dumps(rule, sort_keys=True)
        if key not in parsed:
            parsed[key] = declarations(rule).keys()
            print(
                f"{len(parsed[key])} names declared in {len(header_files(rule))} headers:",
                " ".join(rule.get("headers", [])) or rule.get("tree"),
                file=sys.stderr,
            )
        return parsed[key]

    owner = {}
    sections = []
    for library in spec["libraries"]:
        name = library["name"]
        archives = library.get("archives", []) + system_archives(
            lines, library.get("systemLibraries", [])
        )
        symbols = set()
        for archive in archives:
            print(f"{name}: {archive}", file=sys.stderr)
            symbols |= public_symbols(args.objdump, archive, library.get("skipWeak", False))
        if "javascript" in library:
            rule = library["javascript"].get("declaredIn", library.get("declaredIn"))
            if rule is None:
                sys.exit(f"{name}: no headers to narrow its JavaScript symbols by")
            implemented = javascript & declared(rule)
            print(
                f"{name}: {len(implemented - symbols)} implemented in JavaScript alone",
                file=sys.stderr,
            )
            symbols |= implemented
        if "declaredIn" in library:
            symbols &= declared(library["declaredIn"])
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
            {"name": name, "version": version, "count": len(symbols), "symbols": symbols}
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

    listed = [(l["name"], l["version"], l["count"], l["symbols"]) for l in meta["libraries"]]
    if listed != sections:
        fail("exports.json and exports.txt list different libraries or symbols")
    seen = set()
    for name, _, count, symbols in sections:
        if count == 0 or len(symbols) != count:
            fail(f"{name}: {len(symbols)} symbols under a header of {count}")
        if symbols != sorted(symbols):
            fail(f"{name}: symbols out of order")
        if twice := seen.intersection(symbols):
            fail(f"{name}: also listed earlier: {sorted(twice)}")
        seen.update(symbols)

    versions = {name: version for name, version, _, _ in sections}
    for expected in args.expect:
        name, version = expected.split("=", 1)
        if versions.get(name) != version:
            fail(f"{name} is at {versions.get(name)}, expected {version}")

    apis = [symbols for name, _, _, symbols in sections if name == args.api_library]
    if len(apis) != 1:
        fail(f"{len(apis)} sections are named {args.api_library}")
    api = set(apis[0])
    declared = declarations({"headers": [args.api_header], "packages": args.api_pkg_config})
    if stray := sorted(api - declared.keys()):
        fail(f"{args.api_library} exports what <{args.api_header}> doesn't declare: {stray}")
    # All the header declares is API, each with default visibility; side
    # modules define some of it, for the runtime to call.
    if hidden := sorted(name for name, default in declared.items() if not default):
        fail(f"<{args.api_header}> declares without default visibility: {hidden}")
    side = set(args.api_side_defined)
    if not side <= declared.keys():
        fail(f"<{args.api_header}> doesn't declare {sorted(side - declared.keys())}")
    if unexported := sorted(declared.keys() - api - side):
        fail(f"{args.api_library} doesn't export {unexported}")

    print(f"ABI {abi}: {len(seen)} symbols")
    for name, version, count, _ in sections:
        print(f"  {name} {version}: {count}")
    print(f"API: {' '.join(sorted(api))}")
    print(f"API side modules define: {' '.join(sorted(side))}")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(required=True)

    command = commands.add_parser("manifest")
    command.add_argument("--spec", required=True, help="the libraries, as JSON")
    command.add_argument("--objdump", required=True)
    command.add_argument(
        "--link-log", required=True, help="em++ -v's output, with EMCC_DEBUG=1"
    )
    command.add_argument("--out", required=True)
    command.set_defaults(run=manifest)

    command = commands.add_parser("verify")
    command.add_argument("--dir", required=True, help="the manifest's directory")
    command.add_argument("--expect", action="append", default=[], help="NAME=VERSION")
    command.add_argument("--api-library", required=True)
    command.add_argument("--api-header", required=True)
    command.add_argument("--api-pkg-config", action="append", default=[])
    command.add_argument(
        "--api-side-defined",
        action="append",
        default=[],
        help="an API function side modules define, not the library",
    )
    command.set_defaults(run=verify)

    command = commands.add_parser("declared")
    command.add_argument("--pkg-config", action="append", default=[])
    command.add_argument("--tree", help="every header under this directory too")
    command.add_argument("--cxx-only", action="append", default=[])
    command.add_argument("--unparseable", action="append", default=[])
    command.add_argument("headers", nargs="*")

    def print_declared(a):
        rule = {
            "headers": a.headers,
            "packages": a.pkg_config,
            "cxxOnly": a.cxx_only,
            "unparseable": a.unparseable,
        }
        if a.tree:
            rule["tree"] = a.tree
        print("\n".join(sorted(declarations(rule))))

    command.set_defaults(run=print_declared)

    command = commands.add_parser("macro")
    command.add_argument("--include")
    command.add_argument("--lang", default="c", choices=["c", "c++"])
    command.add_argument("--pkg-config", action="append", default=[])
    command.add_argument("macro")
    command.set_defaults(
        run=lambda a: print(macro_value(a.include, a.macro, a.lang, a.pkg_config))
    )

    args = parser.parse_args()
    args.run(args)


main()
