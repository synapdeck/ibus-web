# Engines

`engines/<name>/` owns an engine's overlay, package output, module entry point,
patches, cast allow-list and checks. The top-level flake imports that tree.
Hangul is the first port:

```sh
nix build .#ibus-web-hangul
nix build .#checks.x86_64-linux.hangul-golden
nix build .#checks.x86_64-linux.hangul-cast-audit
```

The package contains `hangul.wasm`; `ibus-web-hangul-dist` adds a manifest and
store-path data archives. Its module links engine
code and private libhangul, importing IBus, GLib and system libraries from
`ibus-runtime.wasm`. It is GPL-2.0-or-later. The internal option is
`ibusWeb.engines.hangul`; the public package is `packages.ibus-web-hangul`.

## Build and data

The WASM-gated overlay overrides the pinned nixpkgs `ibus-engines.hangul`
recipe (ibus-hangul 1.5.5), keeping its source and patches. It replaces the
desktop dependency set, including propagated inputs, and builds through
upstream's own Autotools: `configure`, with `--datadir` and `--localedir` in
the `data` output, then `make` for `src/libinternal.a`, which holds `engine.c`
and `ustring.c`. configure requires GTK for the setup tool, which isn't built,
so the overlay presets `GTK_CFLAGS` and `GTK_LIBS` to skip that query. Our
`module.c` compiles with the flags make used for the library, queried from the
generated Makefile, plus `IBUSWEB_SETTINGS_SCHEMA_DIR`. The link of the archive
and module into `hangul.wasm` is ours, since upstream builds only the desktop
`ibus-engine-hangul` executable, and `make -C data install-symboltableDATA`
installs the symbol table. Cross `pkg-config` supplies compile flags. Only
private libhangul contributes link libraries; the shared
`checkSideModuleLibraries` guard rejects runtime libraries accidentally added
by pkg-config.

Engine data keeps the paths compiled by Nix. Private libhangul's Hanja table
and ibus-hangul's symbols retain their respective `/nix/store/<hash>-<name>`
paths; no FHS path patch is needed. libhangul keeps the Hanja dictionary open
and seeks through it. The host mounts the version's data database at
`/nix/store`, while user files stay at `/engines/<encodeComponent(name)>`,
one directory under `/engines` whatever the name holds.

The data closure is the side module's Nix store references, minus its own
output. Every dependency must be data only: dictionaries, schema XML and
`gschemas.compiled`, without runtime libraries, development files or compilers.
The schema output includes Hangul and `org.freedesktop.ibus.panel`. The cross
GLib compiler named by `gio-2.0.pc` runs under Node with `--strict`.
Hangul's module retains the schema directory string as a store reference;
the host sets `GSETTINGS_SCHEMA_DIR` to the manifest's `settingsSchemaDir`
before any Init, since GLib caches its schema source on the first lookup.

### Distribution manifest

`ibusWeb.engines.mkEngineManifest` takes `name`, `package`, `threads`,
`heapBytes`, `settingsSchemaDir`, `engines` and `settingsSchemas`. `engines` is the
module's engine descriptors, as a Nix list or as a JSON file another derivation
builds; the manifest's own check validates them, so evaluation never reads a build
output. It derives
license and the upstream version from the package, runtime ABI and protocol from the build,
and static memory from the module's `dylink.0` section. Build:

```sh
nix build .#ibus-web-hangul-dist
```

The output contains `manifest.json`, generated `settings.json`, `hangul.wasm`, and one
`data/<hash>-<name>.tar.br` per closure store path. A module is one such
distribution, run in one Worker; its engines are the input methods inside it, each
created by name with `CreateEngine`. `ModuleManifest` and `EngineDescriptor` in
`@ibus-web/protocol` have these fields:

```ts
type ModuleManifest = {
  name: string;
  version: string;
  license: string;
  runtimeAbi: number;
  protocol: number;
  module: { url: string; size: number };
  memory: number;
  threads: number;
  data: { storePath: string; url: string; size: number; encoding: "br" | "identity" }[];
  settingsSchemaDir: string;
  engines: EngineDescriptor[];
  settingsSchemas: string[];
  settingsMetadata?: { url: string; size: number };
};

type EngineDescriptor = {
  name: string;
  displayName: string;
  languages: string[]; // BCP 47
  keyboard: { layout: "us" | "default"; passThrough: string[] };
};
```

`settings.json` comes from the compiled schema directory via pinned GLib running
under WebAssembly, then the strict TypeScript GVariant decoder. It records each
listed schema's fixed path, key names/types, defaults, descriptions and any
range/choices supplied by GLib; relocatable schemas fail the build. The page
fetches it through `settingsMetadata` before Init, validates settings and
constructs a metadata-driven form. Hangul's keyboard key has no generated
choices. An engine's `keyboard.layout = "us"` translates physical `event.code`
positions; `"default"` uses translated `event.key`. This engine keyboard preference
is not an OS keyboard-layout detector. The first engine is the module's default.
Hangul's manifest lists one engine: `hangul`, "Hangul", `["ko"]`, with the US
layout and no pass-through keys.

`version` is an immutable distribution identity: `<upstream-version>+nix.<output-hash>`.
The hash comes from the distribution's Nix output path, covering its build
recipe and inputs, including the module, data/schema closure, runtime,
protocol and manifest metadata. Identical builds retain the identity;
rebuilds with changed inputs receive a different one even when the upstream
version is unchanged. This is a Nix build identity, not a digest computed
from the archive bytes. Hosts use the entire version for data-cache and
installation-lock namespaces, so a new build can install while an older
host continues reading its own closure. Manually authored manifests must
likewise change version whenever their distribution changes.

`decodeModuleManifest` enforces:

- `name` matches `[A-Za-z0-9][A-Za-z0-9._+-]*`: it becomes a directory and
  database name, so it must be one path component that can't climb out of
  its parent or hide itself;
- `version`, `license` and every URL are non-empty; `engines` lists at least
  one engine, with non-empty, unique names and non-empty display names;
- `memory` is bytes in whole 64 KiB pages within the runtime bounds;
  `threads` is a nonnegative engine pool share;
- each `storePath` is `/nix/store/<32 base-32 characters>-<name>`, with no
  two alike;
- `settingsSchemaDir` is canonical (no empty, `.` or `..` component) and lies
  inside one of the data's store paths;
- unknown keys are rejected at every level, so a misspelled field fails
  rather than reading as missing.

The host validates the manifest before allocating runtime resources and
rejects ABI/protocol mismatches. Numeric `runtimeAbi`
checks `IBUSWEB_RUNTIME_ABI`; the stronger full library-version identity is
still a [known gap](known-gaps.md#runtime).

The build computes memory as `(runtime minimum + dylink static bytes +
threads × 1 MiB + heapBytes) × 1.25`, rounded up to whole MiB. `heapBytes`
is build/check metadata, not a manifest field: the declared peak of the
program break (`sbrk(0)`), which is an address and so counts the static data
below the heap as well as the heap itself. Adding it to the runtime minimum
and the module's static size therefore counts that memory twice, so the
figure is conservative. `checks.hangul-host` fails
if the measured break peak (`breakPeak`) exceeds `heapBytes` or engine thread
demand exceeds `threads`. Hangul declares a 4 MiB break and zero threads,
based on its current Node conformance workload; the formula adds headroom
separately. Browser storage threads belong to the runtime's storage share.

### Archives and serving

Each archive is deterministic POSIX ustar, Brotli quality 11 and the standard
window (no `--large_window`). Entries are named from `/nix/store`:
`<hash>-<name>/…`, or the bare `<hash>-<name>` file for a store path that is
a single file. `--hard-dereference` stores hard links, which store
optimisation makes of identical files, as regular files, since the installer
takes none. Symbolic links are kept as links, with their targets as the
store has them; before archiving, `tools/engine-manifest/symlinks.ts`
resolves every link in the closure the way the engine's file system will,
holding only the closure's store paths, and fails the build if one leads
outside them. ustar holds a link target of at most 100 bytes; GNU tar
refuses a longer one and the build fails rather than archiving it. `size`
counts unpacked regular-file bytes, every name of a hard-linked file in
full and nothing for a symbolic link.

The host extracts each archive at the root of the `/nix/store` mount. Since
every archive lands there, the host follows each archive's ustar framing as
it streams and refuses an entry outside the archive's own store path before
the extractor sees it. The extractor (`ibusweb_install_feed`) takes regular
files, directories and symbolic links (`SYMTYPE`), keeping a link's target
unresolved; it refuses hard links (`LNKTYPE`) with `-EOPNOTSUPP` and never
writes through a link: a member under one fails with `-ENOTDIR`, and a file
or link member replaces a link already at its name. Before creating or sizing each regular
file, the extractor rejects a member that would exceed the remaining declared
budget. The host also requires exact equality after extraction before writing
the installed marker. A mismatch is an ordinary installation refusal; a
corrected retry reinstalls. This limit excludes tar headers/padding, decoder
buffers and filesystem metadata, so it is not a total-memory or quota bound. Serve
`.tar.br` as opaque bytes, **without `Content-Encoding: br`**: fetch must
not decompress it before the host. `encoding: "identity"` supports plain
ustar fixtures.

Relative module/archive URLs in a fetched manifest resolve against the final
response URL after redirects. Inline manifests retain the caller's URLs.

The host constructs `DecompressionStream("brotli")` to detect native support.
Otherwise it imports, by URL from beside its own script, a separate
`brotli-dec-wasm` streaming decoder bundle (`brotli-fallback.js`, 291 KB) with
its WASM embedded by Rolldown's binary loader. No external decoder WASM fetch
is needed, and native installations never load that bundle. Both paths feed
the bounded C extractor in pieces of at most 64 KiB. Only a failure that
starts in the decoder is reported as a Brotli error, with the hint about
`Content-Encoding: br`; a failure of the body itself (the network, an abort)
passes through as it is, and a fallback that fails to load says so.

### npm package

`packages/engines/hangul/` is `@ibus-web/engine-hangul`, the package that will put this
distribution on npm. It holds only its `package.json` and README, since Nix builds its
contents: `nix build .#npm.engine-hangul` copies `ibus-web-hangul-dist` into it as `dist/`,
adds the license texts of the engine and libhangul to `LICENSES/`, and packs it with
`ibusWeb.typescript.npmTarball`, which fails unless the package's `license` is the engine's
`meta.license`. `checks.typescript-npm` builds it with the other tarballs. It exports
`manifest.json`, `hangul.wasm`, `settings.json` and `data/*`. A host serves `dist/` as it is
and passes `manifest.json`'s URL to ibus-web.

## Startup and patch layers

`ibusweb_module_init` calls `ibus_hangul_init(NULL)`, creates an `IBusFactory`,
registers the `hangul` engine type and releases its reference. The runtime's
registry retains the factory. Send the Init settings snapshot before loading
the module: upstream initialization reads those settings into globals.
Contexts use `FocusIn` and `FocusOut`; the protocol has no ID variants.

Local patches follow nixpkgs' patches, with `port` before `casts`, each sorted
by filename. `port` holds build/startup adaptations and engine behavior fixes;
`casts` holds exact callback-type fixes and can be removed independently if a
future toolchain makes it unnecessary. Keep patches as `git format-patch`
commits against the pinned source. Their [inventory](../engines/hangul/patches/README.md)
records reasons and upstream status.

Hangul has **four port patches and one cast patch**. The port patches:

- 0001 disconnects an engine's settings handlers on destruction.
- 0002 rejects candidate digits beyond the last page.
- 0003 keeps global settings current with no live engine: one module listener,
  connected at init, updates the globals, and instance handlers only reselect
  their context's keyboard. Settings upstream reads only at initialization,
  such as `disable-latin-mode`, stay init-only.
- 0004 treats a `CandidateClicked` index as page-relative, the position of the
  clicked label on the visible page, as the IBus panel sends it, and ignores a
  click no visible label has (at or past the page size, or past the last
  candidate of a short final page). Upstream reads the index as absolute, and
  a cursor past the candidates fails the `g_assert` in
  `ibus_lookup_table_set_cursor_pos`.

The cast patch changes three functions: the two hand-written GType init
callbacks get their second argument, and the destroy callback its declared
pointer type. Its connected settings handlers already have their full declared
signature.

The `setup` property is inert because spawning a desktop settings application
has no meaning here. There is no module shutdown ABI, so `ibus_hangul_exit`
does not run. `preedit-mode`
is copied into a live engine on focus/capability updates, so changing it takes
effect after refocus.

## Cast audit

`tools/cast-audit/` is a TypeScript tool with dependencies isolated in
`tools/cast-audit/package.json`. It consumes Clang SARIF diagnostics using
`@microsoft/sarif` types and parses the C/C++ source with native `tree-sitter`
and the C/C++ grammars. The Nix wrapper uses the engine's real compiler flags
and writes a structured `report.json`.

Each engine commits a JSONC allow-list with the editor schema
`tools/cast-audit/cast-audit.schema.json`. Entries identify a diagnostic and
explain why its source/target types are safe; stale or unmatched allowances
fail. Intentional `GCallback` target casts are excluded; generic `void (*)(void)`
casts remain subject to the exact allow-list. This checks explicit casts; it does
not audit callback arity at
signal connection time. The allow-list is validated against that schema
(Ajv) each time the audit runs, so a misspelled or extra field, or an entry
without a reason, fails.

`checks.hangul-cast-audit` runs the audit twice: over the engine, whose
sources and flags come from the overlay's `passthru` (`auditSources`,
`auditCflags`), with the patches applied and the engine's own configure run
supplying `config.h` and the Makefile the flags are read from, and over the private libhangul linked into `hangul.wasm`, with its own
configured `config.h` and allow-list (`engines/hangul/libhangul-cast-audit.jsonc`).
Hangul's unpatched report contains three findings; its patched report and
allow-list are empty, and libhangul has no findings. A separate import check
verifies the side module against the runtime's export manifest.

## Golden tests

`checks.hangul-golden` is a g_test program, built as a main module with
assertions and run through the test-program shim under Node. The memory-root
WasmFS mounts only the package's data and side-module directory. The harness
initializes the runtime, applies an Init snapshot, loads the real side module,
and creates a fresh input context per case. Engine settings are module
globals, so before each case the fixture resets every key of the Hangul and
panel schemas to its default, except `hanja-keys`, which gets Init's value. It
sends framed protocol requests,
pumps, and decodes owned output records with GVariant and IBus serialization.
Keys use US keysyms, evdev keycodes, modifiers and releases.

Sixteen behavioral cases cover Latin mode, Hangul composition and CapsLock, BackSpace,
focus/reset, Hanja keyboard and click selection (after paging forward), paging
and invalid digits, clicks no visible label has, settings, destruction,
password fields, surrounding text, enable, and commit/forward ordering. The idle-settings case destroys the last engine, changes
the keyboard and Hanja hotkey, then uses both after recreation without a resend.
Warnings and errors fail the harness. All four port bugs were reproduced before
their fixes. The harness holds a weak pointer to each engine and asserts that
`DestroyEngine` frees it; the lifecycle case also counts the `changed` handlers
on the module's GSettings objects, of which none may have the destroyed engine
as data, leaving only the module handler on each.

Preedit attributes are compared after IBus normalizes their endpoints: `-1`
means the actual text length, and an empty underline range is omitted. Cached
surrounding text and cursor change on deletion; upstream leaves the selection
anchor until the next host update. The tests preserve that behavior.

`checks.hangul-differential` runs ten engine-owned traces against the stock
native Hangul engine and the WASM side module. It compares typed replies and
engine signals in order, then checks scenario-specific coverage on both sides.
The corpus covers composition, reset/focus, Hanja selection and paging,
surrounding deletion, password fields, forwarding, and initial F8/layout 39
settings. The stock engine emits five extra signals after an invalid digit on
the final candidate page and prints two GLib criticals. That narrow, versioned
outcome is declared in the engine directory; all preceding and subsequent
records still have to match. The `hanja-click-page` trace pages forward and
back before it clicks, on the first page: stock ibus-hangul, lacking port 0004,
reads the index as absolute and diverges from page 2 on, and an expected
difference can only excuse extra native records, so page-2 clicks are covered
by the golden tests alone. See [the test adapter](../tools/ibus-test/README.md)
for the retained artifacts and expected-difference contract.

The page commits COMMIT-mode preedit on blur and reset, and never advertises
`IBUS_CAP_SYNC_PROCESS_KEY_V2` ([core.md](core.md#adapter-and-client-duties)).
Without it, space passes through after the engine commits; with it, the engine
would consume space and emit `ForwardKeyEvent` after `CommitText`.

The shim reports 17 golden tests, including its run-completion check.
The [Worker-host conformance harness](worker-host.md#transport-and-hangul-conformance)
is a separate Node check: ten scenarios on each asserting/released build,
20 reported tests. It runs the
real engine through SAB requests and records rather than calling WASM directly,
and guards the declared program break and thread share. Neither harness establishes
live browser UI behavior or device input behavior.

## The table module

`engines/table/` is ibus-web's own module: two engines, `latex` and `xsampa`, over one C++23 side module.
[table.md](table.md) describes the table format, the engine and its glue.

```sh
nix build .#ibus-web-table-dist
nix build .#checks.x86_64-linux.table-host
```

`ibus-web-table-dist` is `mkEngineManifest` over `table.wasm`. Its engine descriptors come from the tables'
frontmatter: `table-describe` prints them as JSON and the manifest build reads that file, so Nix needs no build output
at evaluation time. `latex` comes first and is the module's default. The data closure is the two tables and the
compiled `org.freedesktop.ibus.panel` schema, the module's only settings schema. The manifest's licence is
`(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`: the engine, MARISA linked into it, and the LaTeX table's data. It
declares no engine threads and a program break that `checks.table-host` checks with both tables loaded.

The module ships as `@ibus-web/engine-table` (`packages/engines/table/`), packed as Hangul's is: `nix build
.#npm.engine-table` copies `ibus-web-table-dist` in as `dist/` and adds the MIT, Apache-2.0 and W3C texts to `LICENSES/`
and MARISA's own `COPYING.md`, taken from its source, as `LICENSES/marisa/COPYING.md`, and `npmTarball` fails unless
`package.json`'s `license` is the module's. It exports `manifest.json`, `table.wasm`, `settings.json` and `data/*`.

The first `CreateEngine` of `latex` in a Worker parses the LaTeX table and builds its MARISA trie: 7.5 ms under Node
on the released runtime, against 1.1 ms for a second context, which shares the parsed table. `checks.table-host`
records both as `Table released LaTeX load`. There is no target until there is a baseline; this is the baseline.
