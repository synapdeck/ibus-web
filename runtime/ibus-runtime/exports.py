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
    # Integer constant expressions of literals and + - *, such as the
    # (-2147483647-1) INT32_MIN expands to.
    expression = re.sub(r"(\d)[uUlL]+", r"\1", value)
    if not re.fullmatch(r"[\d\s+\-*()]+", expression):
        sys.exit(f"{macro} is {values[0]!r}, not an integer")
    return int(eval(expression, {"__builtins__": {}}))


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


def header_declarations(tree, header, probe, transitive=None):
    """Functions and variables declared in header, which probe includes, by
    their linkage names, each with whether it is declared with default
    visibility. A header may be a chain of files of the same name, each
    including the next (#include_next): an overlay that adds declarations to
    another's. Included headers are left out, but for an umbrella API header
    transitive names the directory it is in, and every header under that
    directory counts: its dependencies' headers, such as GLib's and libc's,
    live elsewhere."""
    for node in tree.get("inner", []):
        kind = node.get("kind")
        if kind in ("LinkageSpecDecl", "NamespaceDecl"):
            yield from header_declarations(node, header, probe, transitive)
            continue
        if kind not in ("FunctionDecl", "VarDecl") or node.get("isImplicit"):
            continue
        # A declaration a macro produced is declared where the macro was used.
        loc = node.get("loc", {})
        loc = loc.get("expansionLoc", loc)
        includer = loc.get("includedFrom", {}).get("file", "")
        if (
            transitive is not None
            and os.path.normpath(loc.get("file", "")).startswith(transitive + os.sep)
        ) or (
            loc.get("file", "").endswith(f"/{header}")
            and (includer == probe or includer.endswith(f"/{header}"))
        ):
            visible = any(
                attr.get("kind") == "VisibilityAttr" and attr.get("visibility") == "default"
                for attr in node.get("inner", [])
            )
            yield node.get("mangledName", node["name"]), visible


def parse_header(header, flags, probe, transitive=False):
    """header's declarations, parsed as C from a source file at probe that
    includes it; "c++" if only C++ can parse it, or None if neither can."""
    with open(probe, "w") as source:
        source.write(f"#include <{header}>\n")
    # -H lists each header the compiler opens on stderr, the probe's own
    # includes first, at depth one.
    dump = subprocess.run(
        [*compiler("c"), *flags, "-fsyntax-only", "-H", "-Xclang", "-ast-dump=json"]
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
    directory = None
    if transitive:
        opened = [line[2:] for line in dump.stderr.splitlines() if line.startswith(". ")]
        if not opened:
            sys.exit(f"{header}: the compiler reported opening no header")
        directory = os.path.dirname(os.path.normpath(opened[0]))
    return dict(header_declarations(tree, header, probe, directory))


def declarations(rule):
    """The names the headers a rule names declare, but for the rule's except,
    each with whether it is declared with default visibility. Each header is
    parsed on its own by the compiler, as C. Those only C++ can parse must be
    exactly the rule's cxxOnly, and those neither can, exactly its
    unparseable."""
    headers = header_files(rule)
    flags = cflags(rule.get("packages", []))
    names = {}
    failed = {"cxxOnly": set(), "unparseable": set()}
    with tempfile.TemporaryDirectory() as tmp:
        workers = int(os.environ.get("NIX_BUILD_CORES") or 0) or os.cpu_count()
        with concurrent.futures.ThreadPoolExecutor(workers) as pool:
            probes = [os.path.join(tmp, f"{index}.c") for index in range(len(headers))]
            parsed = pool.map(
                lambda header, probe: parse_header(header, flags, probe, rule.get("transitive", False)),
                headers, probes
            )
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
    # An exception the headers no longer declare would hide a rule gone stale.
    if stale := sorted(set(rule.get("except", [])) - names.keys()):
        sys.exit(f"excepted, but declared by none of the headers: {stale}")
    for name in rule.get("except", []):
        del names[name]
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
    em++ -v logged with EMCC_DEBUG set, and those of them that need ASYNCIFY.
    Before linking, Emscripten runs its JavaScript compiler on the link's
    settings to list them; EMCC_DEBUG logs that command and keeps the
    settings, so running it again gives the same list."""
    index, args = logged_command(
        lines,
        lambda args: len(args) > 1
        and args[1].endswith("/tools/compiler.mjs")
        and "--symbols-only" in args,
    )
    saved = [m[1] for m in map(SAVED_SETTINGS.search, lines[:index]) if m is not None]
    if not saved:
        sys.exit("the link log names no settings before the JavaScript symbol list")
    with open(saved[-1]) as source:
        settings = json.load(source)
    listing = json.loads(run(args, input=json.dumps(settings)))
    # The compiler names the functions that suspend the program only when
    # ASYNCIFY is on; without it, they're there too, as stubs that abort.
    asyncify = json.loads(run(args, input=json.dumps({**settings, "ASYNCIFY": 1})))
    # Keys with a $ are JavaScript helpers, not C symbols.
    implemented = {name for name in listing["deps"] if not name.startswith("$")}
    return implemented, set(asyncify["asyncFuncs"])


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
    javascript, asynchronous = javascript_symbols(lines)
    print(
        f"JavaScript library: {len(javascript)} C symbols,",
        f"{len(asynchronous)} of them needing ASYNCIFY",
        file=sys.stderr,
    )

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
        if library.get("javascript", {}).get("withoutAsyncify"):
            removed = symbols & asynchronous
            print(f"{name}: needing ASYNCIFY: {' '.join(sorted(removed))}", file=sys.stderr)
            symbols -= removed
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
    for expected in args.expect_major:
        name, major = expected.split("=", 1)
        if versions.get(name, "").split(".")[0] != major:
            fail(f"{name} is at {versions.get(name)}, expected major release {major}")

    side = set(args.api_side_defined)
    side_declared = set()
    apis = []
    for library, header in args.api + args.api_subset:
        found = [symbols for name, _, _, symbols in sections if name == library]
        if len(found) != 1:
            fail(f"{len(found)} sections are named {library}")
        api = set(found[0])
        declared = declarations({
            "headers": [header],
            "packages": args.api_pkg_config,
            "transitive": (library, header) in args.api_subset,
        })
        if stray := sorted(api - declared.keys()):
            fail(f"{library} exports what <{header}> doesn't declare: {stray}")
        # A library built with hidden visibility exports only what its
        # header declares with default visibility, which must be all of it.
        if library in args.api_hidden and (
            hidden := sorted(name for name, default in declared.items() if not default)
        ):
            fail(f"<{header}> declares without default visibility: {hidden}")
        # All the header declares is API; side modules define some of it, for
        # the runtime to call.
        side_declared |= side & declared.keys()
        if (library, header) in args.api and (unexported := sorted(declared.keys() - api - side)):
            fail(f"{library} doesn't export {unexported}")
        apis.append((library, api))
    if not side <= side_declared:
        fail(f"no API header declares {sorted(side - side_declared)}")

    print(f"ABI {abi}: {len(seen)} symbols")
    for name, version, count, _ in sections:
        print(f"  {name} {version}: {count}")
    for library, api in apis:
        print(f"API of {library}: {' '.join(sorted(api))}")
    print(f"API side modules define: {' '.join(sorted(side))}")


def library_header(spec):
    library, separator, header = spec.partition("=")
    if not separator or not library or not header:
        raise argparse.ArgumentTypeError(f"{spec!r} is not LIBRARY=HEADER")
    return library, header


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
    command.add_argument(
        "--expect-major", action="append", default=[], help="NAME=MAJOR, the first part of VERSION"
    )
    command.add_argument(
        "--api",
        action="append",
        required=True,
        type=library_header,
        help="LIBRARY=HEADER: LIBRARY's section must be exactly HEADER's declarations",
    )
    command.add_argument(
        "--api-subset",
        action="append",
        default=[],
        type=library_header,
        help="LIBRARY=HEADER: each export must be declared; unused declarations are allowed",
    )
    command.add_argument(
        "--api-hidden",
        action="append",
        default=[],
        help="an --api LIBRARY built with hidden visibility",
    )
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


if __name__ == "__main__":
    main()
