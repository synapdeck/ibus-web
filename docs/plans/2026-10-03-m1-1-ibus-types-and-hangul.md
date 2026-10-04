# M1.1: libibus-web's IBus types and the Hangul side module — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ibus-hangul, built from nixpkgs' recipe as a side module, runs inside the runtime and
composes 한 and converts it to 韓 through Hanja. libibus-web provides the IBus API it compiles
against: the IBus types, emitters that write protocol records into an output buffer, a real
dispatcher for the protocol's requests, and a GSettings backend. All of it is tested in C under
Node. M1's first question gets its answer for Hangul: how many cast and callback fixes it takes,
in which layer, and whether the lazy arity lookup is needed.

**Architecture:** libibus-web gets a second static library, the IBus layer. It compiles
libibus's data types (`IBusObject`, `IBusSerializable`, `IBusText`, `IBusAttribute`,
`IBusAttrList`, `IBusLookupTable`, `IBusProperty`, `IBusPropList`, the keysym helpers) from
sources vendored out of upstream IBus 1.5.34 into `runtime/libibus-web/` and edited in place. Beside them are our own `IBusService`, `IBusEngine`,
`IBusEngineSimple`, `IBusFactory` and `IBusKeymap`, written against upstream's headers. That
keeps engines' struct layouts and vfunc offsets identical to upstream's.

Emitters serialize their arguments with `IBusSerializable` into GVariant and append framed
records (spec §6.2.2) to a runtime-owned output buffer. The Worker host (M1.3) copies the buffer
into the ring. `ibusweb_dispatch()` decodes one framed request (spec §6.1) and emits the matching
`IBusEngine` signal, so engines' class handlers run through GLib's class-closure marshaller
(patch 0011). Init, CreateEngine, DestroyEngine and SettingChanged drive the factory and the
settings backend. The engine is an override of `pkgsWasm.ibus-engines.hangul`: nixpkgs' src,
version and meta, our patch layers, and a build that links `hangul.wasm` plus the data tree the
engine reads at FHS paths.

**Tech Stack:** Nix flake (flake-parts, import-tree), `pkgsWasm` cross set with Emscripten 6.0.9
and its patches, `pkgsWasm.glib` 2.88.3 with patches 0001–0017, libibus sources vendored from
upstream IBus 1.5.34, ibus-hangul 1.5.5 and libhangul 0.2.0 from
nixpkgs, Meson, GLib g_test (TAP) run by the test-program shim under Node, Vitest for the
TypeScript audit script.

## Global constraints

- nixpkgs: whatever `flake.lock` pins. Versions (IBus, ibus-hangul, libhangul, GLib, Emscripten) come from Nix evaluation, never literals.
- Emscripten is `ibusWeb.toolchain.emscripten`. No `-sEMULATE_FUNCTION_POINTER_CASTS`, no forked compiler. Small Emscripten fixes are allowed when tracked upstream.
- Every WASM object is compiled with `ibusWeb.toolchain.commonFlags` (the cc-wrapper adds them). Check and test links add `-sASSERTIONS=1`. Main modules link with `em++` (`$CXX`); side modules with `toolchain.sideModuleFlags`.
- Side modules never link a library the runtime carries (GLib, GObject, GIO, libffi, libibus-web or its IBus layer). They take those symbols from the runtime. Every side module passes `checkSideModuleImports`.
- **Governing principle (spec §1.3):** minimize engine patches. When a fix can live in GLib, libibus-web or the build, put it there. Engine patches are minimal diffs upstream could accept.
- Dendritic layout. Every `.nix` under `modules/`, `packages/`, `runtime/` and (from Task 6) `engines/` is a flake-parts module. Modules share values only through `ibusWeb.*` options and flake outputs. A `_`-prefixed `.nix` file is not a module (callPackage files). WASM builds of nixpkgs recipes live in `legacyPackages.<system>.pkgsWasm`, changed only by overlays gated on the platform: `prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false)`.
- Licensing: libibus-web (both libraries, the vendored IBus sources, its tests) is `LGPL-2.1-or-later`. Vendored files keep upstream's copyright and licence header; a vendored file we change also gets a `Synapdeck, Inc.` copyright line in that header, as LGPL-2.1 §2(a) asks of modified files, and `src/ibus/README.md` records what changed. `REUSE.toml` annotates the vendored files with upstream's copyright holders where their headers carry no SPDX tags. `engines/hangul/` is `GPL-2.0-or-later` (ibus-hangul's `meta.license`), including the glue we write there. Everything else is `MIT OR Apache-2.0`. Copyright for our code is `2026 Synapdeck, Inc.`, never a person. `reuse lint` (in hk) passes.
- **Structured tests:** g_test (TAP) for C that links GLib, GoogleTest for C/C++ that doesn't, Vitest for TypeScript. No ad-hoc `main()` with CHECK macros, no print-then-grep. Build-only and consistency checks (exports, imports, audits, patches applying) are not tests and stay plain.
- **TypeScript first:** new scripts are TypeScript run by Node's type stripping, each directory with a `tsconfig.json` extending the root `tsconfig.base.json`. No `node -e`/`python -c` inlined in Nix. Standard formats are parsed with a maintained library or the platform (`JSON.parse` for SARIF/JSON; `jsonc-parser` for JSONC).
- **GLib's tools are `pkgsWasm.glib`'s:** the WebAssembly builds run by Node (`<tool>` wrappers), which we patch where upstream behaviour must change. Builds get them as their kind of build does: Meson through the cross file `pkgsWasm.glib`'s setup hook installs; anything else through the `.pc` variables (`$PKG_CONFIG --variable=glib_compile_schemas gio-2.0`, …). Never the build machine's GLib, and never a tool by plain name from `PATH`.
- Config files we add are `.jsonc` with an SPDX header and a `$schema` where one exists. oxfmt `printWidth` is 120.
- Comments explain why, not what. They never refer to other files, this plan or its history.
- `nix flake check` passes at the end of every task. Flakes see only git-tracked files: `git add` new files before `nix` commands.
- Stage named paths only (never `git add -A`/`.`/`commit -a`); check `git diff --cached --stat` before committing; commit with `git commit -- <paths>` from the dev shell (the pre-commit hook needs `hk`). The user edits files concurrently: leave changes you didn't make; never `git checkout`/`restore`/`stash`/`reset --hard`.

## Decisions fixed here (later tasks rely on them)

**Two libraries, two pkg-config files.** `libibus-web.a` keeps the runtime API
(`ibus-web/runtime.h`, now also `ibus-web/protocol.h`), built with hidden visibility.
`libibus-web-ibus.a` is the IBus layer, built with default visibility: upstream's sources mark
nothing, so its API is every function the installed IBus headers declare.

- `ibus-1.0.pc` gives engines compile flags only. It has `Cflags: -I${includedir}/ibus-1.0` and `Requires: gio-2.0 gobject-2.0 glib-2.0`, and no `Libs`, with a comment that side modules take the library from the runtime.
- `libibus-web.pc` adds `-libus-web-ibus` to its `Libs`, so the runtime link gets both.
- The export list gains a library `ibus`, versioned `{ibus}+ibus-web.{abi}`:
  - `{ibus}` is evaluated from `IBUS_MAJOR_VERSION`/`IBUS_MINOR_VERSION`/`IBUS_MICRO_VERSION` in the installed `ibusversion.h`.
  - Its archive is `libibus-web-ibus.a`, with `declaredIn = { headers = [ "ibus.h" ]; packages = [ "ibus-1.0" ]; }`.
- `IBUSWEB_RUNTIME_ABI` becomes `1`.

**IBus is vendored, not patched.** The IBus files libibus-web uses are copied from the upstream
IBus 1.5.34 release tarball into the repository: headers under `runtime/libibus-web/include/ibus-1.0/`,
sources, templates and `ibusmarshalers.list` under `runtime/libibus-web/src/ibus/`. Changes are
edits to those copies, not a patch series, since much of the code changes and the result reads
better as files. `src/ibus/README.md` records:

- the release, the tarball's URL and hash;
- every vendored file, as unchanged or changed, with what changed and why for the changed ones;
- the command that diffs the tree against the tarball, which is how a later IBus release is merged
  in.

Nothing builds from nixpkgs' `ibus`.

**Headers are upstream's.** Every IBus type we provide is declared by its vendored upstream
header. Engines compile against exactly upstream's structs, class structs and enums. Headers are
edited only where a change can't break that, such as dropping an include of a header we don't
vendor.

- `ibus.h` is ours. It defines `__IBUS_H_INSIDE__` and includes only the headers of what we provide, so an engine that reaches for anything else fails to compile.
- An upstream header that declares functions we don't implement stays as it is. A call to one fails at the side module's import check or at link, which is the spec's scope rule (§5.2.1).
- `ibusversion.h` is vendored with the release's version filled in, as upstream's build would generate it from `ibusversion.h.in`. This matters to ibus-hangul: `IBUS_CHECK_VERSION(1,5,28)` gates key-event forwarding, and its `ibus version` fallback reads these macros.

**Vendored vs. ours.** Vendored from upstream and edited only where needed:

- the data types: `ibusobject.c`, `ibusserializable.c`, `ibustext.c`, `ibusattribute.c`, `ibusattrlist.c`, `ibuslookuptable.c`, `ibusproperty.c`, `ibusproplist.c`;
- the key helpers: `ibuskeynames.c` with its keyname table, `ibuskeyuni.c` if `ibus_keyval_to_unicode`/`ibus_unicode_to_keyval` are reached, and `ibuskeys.c` for `ibus_key_event_from_string`;
- the generated enum types and marshallers, made at build time with `pkgsWasm.glib`'s own tools from the vendored templates and `ibusmarshalers.list`, so they follow the vendored headers;
- ibus's GSettings schema file, `data/dconf/org.freedesktop.ibus.gschema.xml`, which holds the panel schema `org.freedesktop.ibus.panel` that engines read. libibus-web installs it under `share/glib-2.0/schemas/` for engine builds to compile into their data.

Ours (`runtime/libibus-web/src/ibus/`):

- **`IBusService`**: `object-path` and `connection` properties, no D-Bus.
- **`IBusEngine`**: upstream's signal table, class offsets and properties, taken under LGPL. The emitters write records. The surrounding-text cache follows upstream's semantics.
- **`IBusEngineSimple`**:
  - It is a subclass that adds no behaviour. Its `process_key_event` returns `FALSE`, so Latin keys pass through to the page.
  - Compose sequences, Ctrl+Shift+U and emoji input are the OS's and the browser's job, which is a known gap.
  - `IBusEngineSimple`'s table API (`ibus_engine_simple_add_table` and friends) is declared but left out.
- **`IBusFactory`**: holds the name→`GType` registry. `ibus_factory_new()` makes the runtime's one factory; a second is a critical.
- **`IBusKeymap`**: `ibus_keymap_get()` returns `NULL` and `ibus_keymap_lookup_keysym()` returns its keyval argument. The router computes layout-`us` keyvals from `event.code` itself (spec §7.1.1), so an engine's own keycode remapping is unneeded, and ibus-hangul handles `NULL`.
- `IBusBus`, `IBusConfig`, `IBusComponent` and `IBusEngineDesc` are not provided (ibus-hangul's `main.c` is their only user).

**Protocol constants live in C.** `ibus-web/protocol.h` (LGPL, installed) is the single source of
the numbers. M1.2's TypeScript gets them printed from it by the build, as the host's tests already
get `test-ops.h`'s values.

```c
#define IBUSWEB_PROTOCOL_VERSION 1

/* A request: 8 bytes of header, then the payload, the GVariant normal form
 * of the kind's signature, little-endian. */
typedef struct { uint16_t kind; uint16_t flags; uint32_t ic; } IBusWebRequestHeader;

/* An output record: 16 bytes of header, then len bytes of payload (GVariant
 * normal form), padded with zeros to a multiple of 8. */
typedef struct { uint32_t seq; uint32_t ic; uint16_t kind; uint16_t flags; uint32_t len; } IBusWebRecordHeader;
#define IBUSWEB_RECORD_CONTINUATION 0x0001 /* set by the host when it fragments; never by the runtime */

enum IBusWebRequestKind {
  IBUSWEB_REQ_INIT = 1,             /* (ua{sa{sv}})  protocol version; schema id → key → value */
  IBUSWEB_REQ_CREATE_ENGINE = 2,    /* (s)  engine name */
  IBUSWEB_REQ_DESTROY_ENGINE = 3,   /* () */
  IBUSWEB_REQ_SETTING_CHANGED = 4,  /* (ssv)  schema id, key, value */
  IBUSWEB_REQ_PROCESS_KEY_EVENT = 16, /* (uuu) → reply 0 or 1 */
  IBUSWEB_REQ_FOCUS_IN = 17, IBUSWEB_REQ_FOCUS_OUT = 18, IBUSWEB_REQ_RESET = 19,
  IBUSWEB_REQ_ENABLE = 20, IBUSWEB_REQ_DISABLE = 21,      /* () */
  IBUSWEB_REQ_SET_CURSOR_LOCATION = 22, /* (iiii) */
  IBUSWEB_REQ_SET_CAPABILITIES = 23,    /* (u) */
  IBUSWEB_REQ_PAGE_UP = 24, IBUSWEB_REQ_PAGE_DOWN = 25,
  IBUSWEB_REQ_CURSOR_UP = 26, IBUSWEB_REQ_CURSOR_DOWN = 27, /* () */
  IBUSWEB_REQ_CANDIDATE_CLICKED = 28,   /* (uuu) index, button, state */
  IBUSWEB_REQ_PROPERTY_ACTIVATE = 29,   /* (su) */
  IBUSWEB_REQ_SET_SURROUNDING_TEXT = 30,/* (vuu) IBusText, cursor, anchor */
  IBUSWEB_REQ_SET_CONTENT_TYPE = 31,    /* (uu) purpose, hints */
};

enum IBusWebRecordKind {
  IBUSWEB_REC_COMMIT_TEXT = 1,          /* (v) */
  IBUSWEB_REC_UPDATE_PREEDIT_TEXT = 2,  /* (vubu) text, cursor, visible, mode */
  IBUSWEB_REC_UPDATE_AUXILIARY_TEXT = 3,/* (vb) */
  IBUSWEB_REC_UPDATE_LOOKUP_TABLE = 4,  /* (vb) */
  IBUSWEB_REC_SHOW_PREEDIT_TEXT = 5, IBUSWEB_REC_HIDE_PREEDIT_TEXT = 6,
  IBUSWEB_REC_SHOW_AUXILIARY_TEXT = 7, IBUSWEB_REC_HIDE_AUXILIARY_TEXT = 8,
  IBUSWEB_REC_SHOW_LOOKUP_TABLE = 9, IBUSWEB_REC_HIDE_LOOKUP_TABLE = 10, /* () */
  IBUSWEB_REC_REGISTER_PROPERTIES = 11, /* (v) */
  IBUSWEB_REC_UPDATE_PROPERTY = 12,     /* (v) */
  IBUSWEB_REC_FORWARD_KEY_EVENT = 13,   /* (uuu) */
  IBUSWEB_REC_DELETE_SURROUNDING_TEXT = 14, /* (iu) */
  IBUSWEB_REC_REQUIRE_SURROUNDING_TEXT = 15, /* () */
  IBUSWEB_REC_SETTING_WRITTEN = 32,     /* (ssv) */
  IBUSWEB_REC_LOG = 33,                 /* (uss) GLogLevelFlags, domain, message */
  IBUSWEB_REC_CRASHED = 34,             /* written by the host only */
};
```

`v` payloads are the serialized IBus objects (`ibus_serializable_serialize()`), so the bytes are
what IBus puts on D-Bus. Each kind's signature is also a `const char *` table in the header
(`ibusweb_request_signature(kind)`, `ibusweb_record_signature(kind)`, both `NULL` for unknown
kinds), so the dispatcher and the tests check against one source. The requests have no `Id`
forms: ibus-hangul's `focus_in` runs only for `FocusIn`.

**Runtime API added to `runtime.h`:**

```c
/* Dispatches one request (protocol.h) on the pumping thread. Returns the
 * reply (ProcessKeyEvent's boolean as 0 or 1; 0 for every other kind) or:
 * -EBADMSG  shorter than its header, nonzero flags, or a payload that isn't
 *           the kind's signature in normal form;
 * -ENOSYS   unknown kind;
 * -ENOTCONN any request but Init before Init;
 * -EALREADY a second Init;
 * -EPROTO   Init with another protocol version;
 * -ENOENT   no engine for the input context (CreateEngine excepted);
 * -EEXIST   CreateEngine for an input context that has one;
 * -ESRCH    CreateEngine naming an engine no factory registered;
 * -EPERM    off the pumping thread.
 * It doesn't pump: the host pumps after every dispatch, as after every wake. */
IBUSWEB_API int32_t ibusweb_dispatch(const uint8_t *request, uint32_t len);

/* The output buffer: whole records, in seq order, not yet consumed. The
 * pointer is valid until the next call into the runtime. Pumping thread only. */
IBUSWEB_API const uint8_t *ibusweb_output_peek(uint32_t *len);
/* Drops the first len bytes, which must end on a record boundary
 * (anything else is a critical and drops nothing). */
IBUSWEB_API void ibusweb_output_consume(uint32_t len);
/* The seq of the last record appended, 0 before any. */
IBUSWEB_API uint32_t ibusweb_output_last_seq(void);
```

**Other API details:**

- **Test dispatcher.** The test-op dispatcher becomes `ibusweb_test_dispatch()`, with the same
  contract. The Worker host's two call sites are renamed with it; the ops stay until M1.3
  replaces them.
- **Sequence numbers.** Seqs start at 1, are Worker-wide, and wrap at 2³²; the page compares
  them modulo 2³² (spec §6.2.2).
- **Emitters off the pumping thread.** An emitter called on any other thread builds its record
  there and hands it to the pumping thread with `g_main_context_invoke()` on the default
  context. The record lands in order at the next pump, and the host is woken.

**Ordering: Init before the engine module.**

- `Init` seeds the settings backend with its snapshot and installs the GLib log writer. From
  then on every log message becomes a `Log` record; fatal levels still abort after writing it.
- Only after `Init` does the host load the engine module (`ibusweb_load_module()`). Engines read
  settings in their init (ibus-hangul reads every key into globals in `ibus_hangul_init`).
- Before `Init`, logging goes to stderr as now, which keeps the host's test-op suites
  unchanged.
- How the host obtains `Init` before loading is M1.3's. The C contract is "Init, then load".

**Engine module registration.** An engine's glue defines `ibusweb_module_init(IBusWebModule *)`,
which runs the engine's own init (`ibus_hangul_init(NULL)`), then
`ibus_factory_add_engine(ibus_factory_new(NULL), "hangul", IBUS_TYPE_HANGUL_ENGINE)`.

- `CreateEngine(ic, name)` emits the factory's `create-engine` signal, whose default handler
  makes `g_object_new(type, "engine-name", name, "object-path", "/org/freedesktop/IBus/Engine/<ic>", NULL)`.
  Upstream's override points stay intact.
- `DestroyEngine` calls `ibus_object_destroy()` and drops the runtime's reference.

**The engine sees its data at FHS paths.** The engine is built for the paths a desktop install
uses: `IBUSHANGUL_DATADIR=/usr/share/ibus-hangul`, libhangul's default Hanja dictionary
`/usr/share/libhangul/hanja/hanja.txt`, and GSettings schemas under `/usr/share/glib-2.0/schemas`,
which GLib's default `XDG_DATA_DIRS` already searches.

- The engine derivation's `$out/data/` is the tree to place at `/`: `usr/share/...`.
- Tests mount it there with WasmFS Node backends.
- The host makes those paths resolve into its data mount; that is M1.3's (spec §5.6 is updated
  to say so).

**Patch layers (spec §5.4.2).**

- `engines/hangul/patches/casts/`: function-pointer fixes. The two one-argument `GTypeInfo`
  init functions (`engine.c:370`, `:375`) trap on WebAssembly. _Deviation:_ casts 0001 changes
  three functions; the destroy callback also takes its declared `IBusObjectDestroyFunc` pointer
  type, so the allow-list stays empty.
- `engines/hangul/patches/port/`: the build is ours, so no build-system patch is needed. Port
  patches also fix engine bugs the runtime's lifecycle exposes, as diffs upstream could take:
  - the `changed` handlers are never disconnected on destroy, a use-after-free once engines
    come and go per input context;
  - a digit key past the last candidate trips `ibus_lookup_table_set_cursor_pos`'s assertion.
  - Each is red in the golden tests before its patch.
  - _Deviation:_ review added port 0003 (one module listener keeps the globals current with no
    live engine; instance handlers only reselect their keyboard; init-only settings stay
    init-only) and port 0004 (`CandidateClicked` read as page-relative; a click no visible label
    has is ignored).

**The cast audit replaces the lookup's debug log for now.** Spec §11.3's audit report came from
the lazy arity lookup's debug logging, which isn't built. `ibusWeb.engines.castAudit` compiles
sources with clang's `-Wcast-function-type-strict` in SARIF and reports every cast whose function
types differ. Casts to `GCallback` are left out, since signal-handler arity can't be judged from
the cast; the golden tests' traps cover those.

- The report must equal a committed allow-list (`cast-audit.jsonc`), empty after fixes.
- It runs on libibus-web's vendored IBus sources and on the engine. _Deviation:_ it covers every
  C translation unit of libibus-web, and the private libhangul linked into `hangul.wasm` too.
- A connect-time arity audit, for engines with many handlers, is a known gap for M3–M5.

## File map

| Path                                                                                                                                                                                                                        | Change                                | Task |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- |
| `modules/engines/cast-audit.{nix,ts,test.ts}`, `modules/engines/tsconfig.json`, `modules/engines/fixtures/` (_deviation:_ the TypeScript, tests and fixtures live in `tools/cast-audit/`)                                   | the cast audit                        | 1    |
| `runtime/libibus-web/_package.nix` (from `package.nix`), `runtime/libibus-web/overlay.nix`, `runtime/libibus-web/package.nix`                                                                                               | libibus-web in `pkgsWasm`             | 2    |
| `runtime/libibus-web/meson.build`, `meson.options`, `include/ibus-1.0/` (vendored headers, our `ibus.h`), `src/ibus/` (vendored sources, `README.md`), `cast-audit.jsonc`, `tests/test-serializable.c`, `tests/meson.build` | IBus layer: data types and keys       | 2    |
| `runtime/ibus-runtime/exports.nix`, `exports.py`, `checks.nix`, `package.nix`                                                                                                                                               | the `ibus` export library, ABI 1      | 2    |
| `runtime/libibus-web/include/ibus-web/protocol.h`, `src/output.c`, `src/ibus/ibusservice.c`, `ibusengine.c`, `ibusenginesimple.c`, `ibusfactory.c`, `ibuskeymap.c`, `tests/test-engine.c`                                   | engine types, emitters, output buffer | 3    |
| `runtime/libibus-web/src/dispatch.c` (real), `src/test-dispatch.c` (renamed), `src/log.c`, `include/ibus-web/runtime.h`, `tests/test-dispatch.c`, `packages/worker-host/src/worker/{runtime,loop}.ts`                       | the dispatcher, Log records           | 4    |
| `runtime/libibus-web/src/settings.c`, `tests/test-settings.c`, `tests/schemas/`                                                                                                                                             | GSettings backend                     | 5    |
| `flake.nix`, `engines/hangul/{overlay.nix,package.nix,module.c,cast-audit.jsonc,patches/{casts,port}/,patches/README.md}`, `runtime/ibus-runtime/side-module.nix`, `REUSE.toml`                                             | the Hangul side module                | 6    |
| `engines/hangul/checks/golden/{default.nix,golden.c,harness.{c,h}}`                                                                                                                                                         | golden tests                          | 7    |
| `docs/runtime.md`, `docs/engines.md` (new), `docs/glib.md`, `docs/testing.md`, `docs/known-gaps.md`, `docs/README.md`, spec §5.2, §5.4, §5.6, §6.1, §11.3, §12                                                              | docs                                  | 8    |

---

### Task 1: The cast audit

**Files:** `modules/engines/cast-audit.nix`, `modules/engines/cast-audit.ts`, `modules/engines/cast-audit.test.ts`, `modules/engines/tsconfig.json`, `modules/engines/fixtures/{casts.c,allow.jsonc}`, `modules/engines/options.nix`. _Deviation:_ everything but the Nix moved to `tools/cast-audit/`, with dependencies in `tools/package.json`.

**Interfaces:** Produces `ibusWeb.engines.castAudit { name, src, sources, cflags ? "", buildInputs ? [ ], pkgConfigModules ? [ ], allowList }` → a check derivation, and `checks.engines-cast-audit-script` (its Vitest suite). `allowList` is a path to a JSONC file:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "…/cast-audit.schema.json",
  "casts": [
    {
      "file": "src/engine.c",
      "function": "ibus_hangul_engine_class_init",
      "from": "void (*)(IBusHangulEngineClass *)",
      "to": "GClassInitFunc",
      "reason": "…",
    },
  ],
}
```

**Requirements:**

- The derivation compiles each source with pkgsWasm's `$CC -fsyntax-only -Wno-everything -Wcast-function-type-strict -fdiagnostics-format=sarif` (plus `cflags` and `pkgConfigModules`' cflags), collects the SARIF on stderr, and runs `node cast-audit.ts report <sarif…>` then `… compare <report.json> <allowList>`. The SARIF schema is checked into `modules/engines/` only if clang's output needs it to validate; `$schema` for `cast-audit.jsonc` is a JSON schema file beside the script.
- `report`:
  - Parse SARIF with `JSON.parse`.
  - Keep results whose rule is `-Wcast-function-type-strict`.
  - Drop casts whose target type is `GCallback`; audit generic `void (*)(void)` casts (corrected after final review).
  - Normalise each kept result to `{ file (relative to src), function (the cast operand's name when it is a plain identifier, else null), from, to }`, taking the types from the message. Line numbers are kept for display but not compared.
- `compare`: equality as multisets of `{file, function, from, to}`. Print missing and unexpected entries and fail on either. The output (`$out/report.json`, `$out/report.txt`) is the engine's audit report.
- Parse JSONC with `jsonc-parser` (added to the workspace as a dependency of whatever package the script's Nix builds from; follow how `modules/glib/checks/tests/gate.ts` gets its dependencies).
- Vitest (`cast-audit.test.ts`, run by a check the way `checks.glib-tests-gate` runs `gate.test.ts`), using SARIF that `fixtures/casts.c` produces, checked in as a fixture and regenerated by a documented command:
  - a one-parameter function cast to a two-parameter type is reported;
  - a cast through `G_CALLBACK` is not;
  - a cast whose types match is not;
  - `compare` passes on an equal allow-list and fails on a missing and on an extra entry.
- Prove the derivation bites: `castAudit` over `fixtures/casts.c` with an empty allow-list fails, and with `fixtures/allow.jsonc` passes. That pair is `checks.engines-cast-audit-fixture`.

- [ ] Steps: fixture SARIF; script + Vitest red → green; Nix wrapper; the fixture check both ways; `nix flake check`; commit.

### Task 2: libibus-web in pkgsWasm; the IBus layer's data types and keys

**Files:** `runtime/libibus-web/_package.nix` (the derivation, a callPackage file), `runtime/libibus-web/overlay.nix` (`flake.overlays.libibus-web` adding `libibus-web` to pkgsWasm), `runtime/libibus-web/package.nix` (now `ibusWeb.runtime.libibusWeb = pkgsWasm.libibus-web`), `runtime/libibus-web/checks.nix`, `meson.build`, `meson.options`, `include/ibus-1.0/` (vendored headers, our `ibus.h`, `ibusversion.h`), `src/ibus/` (vendored sources, templates, `ibusmarshalers.list`, `org.freedesktop.ibus.gschema.xml`, `config.h` template if needed, `README.md`), `cast-audit.jsonc`, `tests/test-serializable.c`, `tests/meson.build`, `runtime/ibus-runtime/{exports.nix,exports.py,checks.nix}`, `include/ibus-web/runtime.h` (ABI 1), `REUSE.toml`, `.clangd` if its include paths need the new directory.

**Interfaces:**

- Produces `pkgsWasm.libibus-web`: `lib/libibus-web.a`, `lib/libibus-web-ibus.a`, `include/ibus-web/*.h`, `include/ibus-1.0/*.h`, `lib/pkgconfig/{libibus-web,ibus-1.0}.pc`.
- Produces the export list's `ibus` library.
- Consumed by Tasks 3–7.

**Requirements:**

- **pkgsWasm restructure.** Move the derivation behind an overlay so recipes in pkgsWasm can take `libibus-web` as an input (Task 6 does). `ibusWeb.runtime.libibusWeb`, `packages.libibus-web` and `devLibraries` point at `pkgsWasm.libibus-web`. The fileset logic stays. The overlay is gated on the platform like every other.
- **Vendoring.** Fetch the IBus 1.5.34 release tarball (the URL and hash nixpkgs' `ibus` uses at the current lock is a fine source; record both in the README). Copy in only the files the build needs. Commit them unchanged first, in a commit of their own, so the changes made in this and later tasks show as ordinary diffs against that commit. Then write `src/ibus/README.md`, a table of every vendored file. Add a lint-style check, `checks.libibus-web-vendored`, that fails if a file under `src/ibus/` or `include/ibus-1.0/` is missing from the README's table or the table names a file that isn't there. Our own files under `src/ibus/` are listed as ours.
  - Vendor and compile the data-type and key sources listed in the decisions, plus whatever they need of `ibusinternal.h`, `ibusshare.c` or `ibusdebug`. Take the smallest set that links, and give each file a line on why in the README. Code in a vendored file that we don't need, such as D-Bus paths, is deleted from the copy, not stubbed.
  - Generate `ibusenumtypes.{c,h}` and `ibusmarshalers.{c,h}` with Meson's `gnome.mkenums`/`gnome.genmarshal` from the vendored templates and list. Meson's gnome module runs `pkgsWasm.glib`'s tools through the cross file its setup hook installs, never the build machine's GLib. Their output is plain C; check that the marshallers call through the callback's own type.
- **Headers.**
  - Vendor and install upstream's headers for the provided types under `include/ibus-1.0/`, with the headers they include. Don't vendor `ibusbus.h`, `ibusconfig.h`, `ibuscomponent.h` or `ibusenginedesc.h`; where a vendored header includes one only for a type it doesn't need in its struct layouts, drop the include in the copy. If a layout really needs one, vendor it, leave its types out of `ibus.h`, and say so in the report.
  - Vendor `ibusversion.h` with 1.5.34 filled in.
  - `ibus.h` is ours (LGPL, SPDX header): `#define __IBUS_H_INSIDE__`, the includes, `#undef`.
  - Include `ibuskeysyms.h` and `ibuskeysyms-compat.h`: ibus-hangul uses the un-prefixed names.
- **Libraries and pkg-config** per the decisions. `libibus-web-ibus` is built with default visibility and `-DIBUS_COMPILATION`; its internal helpers are `G_GNUC_INTERNAL`.
- **Export list.**
  - Add the `ibus` library to `spec.libraries` in `exports.nix` after `libibus-web`, versioned `{ibus}+ibus-web.{abi}`; `{ibus}` comes from a new `versions.ibus` entry evaluating the three macros through `ibus-1.0`.
  - Extend `exports.py`'s `verify` with `--api-subset LIBRARY=HEADER` (every exported symbol is declared by the header, not necessarily the reverse), and use it for `ibus` in `checks.ibus-runtime-exports`.
  - `IBUSWEB_RUNTIME_ABI` becomes `1`.
- **Cast audit.** `checks.libibus-web-cast-audit` runs `castAudit` over the upstream sources compiled into the IBus layer (_deviation:_ over every C translation unit of libibus-web, checked against `compile_commands.json`). Fix every finding by editing the vendored file (README row: what and why); the allow-list stays empty unless a cast is provably harmless, with its reason.
- **Tests** (`test-serializable`, g_test, TAP, in `checks.libibus-web`):
  - Each data type serializes to exactly upstream's GVariant type string, checked with `g_variant_get_type_string`:
    - `IBusText` `(sa{sv}sv)`
    - `IBusAttribute` `(sa{sv}uuuu)`
    - `IBusAttrList` `(sa{sv}av)`
    - `IBusLookupTable` `(sa{sv}uubbiavav)`
    - `IBusProperty` `(sa{sv}suvsvbbuvv)`
    - `IBusPropList` `(sa{sv}av)`
  - Each round-trips through `ibus_serializable_deserialize`, with fields equal; a text with attributes and a lookup table with labels are among the cases.
  - An attribute whose end is `-1` (ibus-hangul appends its foreground and background attributes that way) serializes its end as `0xffffffff` and round-trips.
  - New objects are floating.
  - `ibus_prop_list_append` and `ibus_lookup_table_append_candidate` sink their arguments.
  - `ibus_key_event_from_string("Shift+space")` gives `IBUS_space` and `IBUS_SHIFT_MASK`; `ibus_keyval_from_name("Hangul_Hanja")` gives `IBUS_Hangul_Hanja`.
  - A test that the old `runtime.h` API still behaves needs no change.
- `checks.ibus-runtime-load` and the Worker host's checks still pass (the runtime carries the new library; nothing calls it yet).

- [ ] Steps: overlay restructure, outputs unchanged (compare `libibus-web.a` before and after); vendor unchanged (own commit), README and its check; Meson targets, headers, pkg-config; serializable tests red → green; export list and `--api-subset`; cast audit + fixes in the vendored files; `nix flake check`; commit.

### Task 3: Engine types, emitters and the output buffer

**Files:** `runtime/libibus-web/include/ibus-web/protocol.h`, `src/output.c`, `src/output.h` (internal), `src/ibus/ibusservice.c`, `src/ibus/ibusengine.c`, `src/ibus/ibusenginesimple.c`, `src/ibus/ibusfactory.c`, `src/ibus/ibuskeymap.c`, `include/ibus-web/runtime.h`, `meson.build`, `tests/test-engine.c`, `tests/meson.build`.

**Interfaces:**

- Produces `protocol.h` exactly as in the decisions.
- Produces `ibusweb_output_peek/consume/last_seq`.
- Produces internal (hidden) entry points the dispatcher uses:
  - `IBusEngine *ibusweb_factory_create(uint32_t ic, const char *name, int *error)`;
  - `void ibusweb_engine_set_ic(IBusEngine *, uint32_t)`, `uint32_t ibusweb_engine_get_ic(IBusEngine *)`;
  - `void ibusweb_output_append(uint32_t ic, uint16_t kind, GVariant *payload)` (sinks `payload`; any thread).
- Produces the provided half of upstream's `ibusengine.h`, `ibusservice.h`, `ibusenginesimple.h`, `ibusfactory.h` and `ibuskeymap.h`: the functions ibus-hangul calls (see the survey list below) plus the GObject boilerplate (`*_get_type`, constructors, properties).

**Requirements:**

- **`IBusEngine`.**
  - Signals with upstream's names, class offsets, accumulators and flags: `process-key-event`, `focus-in`, `focus-out`, `reset`, `enable`, `disable`, `set-cursor-location`, `set-capabilities`, `page-up`, `page-down`, `cursor-up`, `cursor-down`, `candidate-clicked`, `property-activate`, `property-show`, `property-hide`, `set-surrounding-text`, `set-content-type`. `focus-in-id`/`focus-out-id` are present only if upstream's class struct demands them; keep them inert.
  - Default class handlers as upstream's: `process-key-event` returns `FALSE`; the rest are no-ops, except that `set-surrounding-text` stores the text, and direct `set-capabilities` and `set-content-type` signals retain their cache updates. Protocol dispatch must also update cursor, capabilities and private content caches before emitting signals, independently of class overrides (corrected after final review).
- **Emitters.** Each emitter appends one record with the payload signature from `protocol.h`:
  - `commit_text`, `update_preedit_text` and `update_preedit_text_with_mode` (mode `IBUS_ENGINE_PREEDIT_CLEAR` for the plain form);
  - `update_auxiliary_text`, `update_lookup_table` and `update_lookup_table_fast` (the fast form sends the visible page only, as upstream builds it);
  - `show_*`/`hide_*` for preedit, auxiliary text and lookup table; `register_properties`, `update_property`, `forward_key_event`, `delete_surrounding_text`.
  - After serializing, an emitter unrefs a floating argument as upstream's `_g_object_unref_if_floating` does.
  - `delete_surrounding_text` updates the cached surrounding text first.
  - `get_surrounding_text` returns a new reference to the cached text (initially an empty text), with cursor and anchor; it emits `RequireSurroundingText` every time and, with all-`NULL` arguments, only that.
- **Output buffer.** One `GByteArray` behind a mutex, framing per `protocol.h`, seq per the decisions. `peek` and `consume` are pumping-thread only (else a critical and an empty result). Off-thread `ibusweb_output_append` goes through `g_main_context_invoke`. `consume` off a record boundary is a critical that drops nothing.
- **`IBusEngineSimple`, `IBusFactory`, `IBusKeymap`, `IBusService`** per the decisions. `IBusFactory`'s `create-engine` signal keeps upstream's signature and default handler semantics.
- **Survey list** (what ibus-hangul calls beyond the data types). These must resolve by the end of Task 6, and `checkSideModuleImports` on `hangul.wasm` is the proof:
  - `ibus_engine_{commit_text, update_preedit_text, update_preedit_text_with_mode, update_auxiliary_text, hide_auxiliary_text, update_lookup_table, hide_lookup_table, forward_key_event, register_properties, update_property, delete_surrounding_text, get_surrounding_text, get_name}`;
  - `ibus_engine_simple_get_type`, `ibus_factory_new`, `ibus_factory_add_engine`, `ibus_keymap_get`, `ibus_keymap_lookup_keysym`.
- **Tests** (`test-engine`, g_test), with a test engine subclass defined in the test program, overriding every vfunc and recording calls:
  - each emitter's record: header fields, padding, the payload's type string, and its decoded contents;
  - floating arguments released and owned ones untouched;
  - seqs increase by one per record across emitters;
  - `consume` at and off a boundary;
  - an emission from another thread lands at the next pump, after records already in the buffer;
  - `g_signal_emit` of each signal reaches the subclass's vfunc with exactly its arguments (this is patch 0011 working under the IBus layer);
  - the surrounding-text cache: set, read, delete, and `RequireSurroundingText` on read;
  - the factory: an added name creates an instance of its type with `engine-name` set; an unknown name gives `-ESRCH`; a second `ibus_factory_new` is a critical (`g_test_expect_message`).

- [ ] Steps: protocol.h; output buffer tests red → green; engine/simple/service/factory/keymap; emitter tests red → green; signal-dispatch tests; `nix flake check`; commit.

### Task 4: The dispatcher and Log records

**Files:** `runtime/libibus-web/src/dispatch.c` (the real dispatcher), `src/test-dispatch.c` (the test-op dispatcher, renamed from `dispatch.c`), `src/log.c`, `src/call-op.cpp`, `include/ibus-web/runtime.h`, `meson.build`, `tests/test-dispatch.c`, `tests/test-runtime.c` (renamed calls), `tests/meson.build`, `packages/worker-host/src/worker/runtime.ts`, `packages/worker-host/src/worker/loop.ts`, any worker-host test that names the function.

**Interfaces:** Consumes Task 3's internal entry points. Produces `ibusweb_dispatch()` and `ibusweb_test_dispatch()` as in the decisions.

**Requirements:**

- **Decoding.** Header from the first 8 bytes. The payload must be exactly the kind's type in normal form (`g_variant_new_from_data` + `g_variant_is_normal_form`); anything else gives `-EBADMSG`. GVariant copies a misaligned payload, but the host keeps requests 8-aligned. The `v` in `SetSurroundingText` must deserialize to an `IBusText`, else `-EBADMSG`.
- **Routing.** Per-instance kinds look the engine up by `ic` and emit the matching signal: `ProcessKeyEvent`'s accumulated boolean becomes the reply, `SetContentType` emits `set-content-type`, `SetSurroundingText` emits `set-surrounding-text` with the deserialized text.
- **Lifecycle.**
  - `Init` checks the version (`-EPROTO`), hands the snapshot to the settings backend (Task 5 fills in the call; this task stores it), installs the log writer, and marks the runtime initialised.
  - `CreateEngine` calls the factory and records the instance under `ic`.
  - `DestroyEngine` destroys and drops it.
  - `SettingChanged` hands `(schema, key, value)` to the backend (Task 5).
- Errors per the decisions; nothing is emitted for a request that fails before reaching the engine.
- **Exceptions.** A C++ exception thrown inside an engine's vfunc fails the dispatch with `-ECANCELED`, through a C++ frame as `call-op.cpp` does for test ops (extend that file rather than adding a second one), and leaves a `Log` record of the failure. Other exceptions propagate.
- **Log writer.** `g_log_set_writer_func` after `Init`. Each message becomes a `Log` record `(uss)` with the level flags, the domain (`""` when none) and the message, then `G_LOG_WRITER_HANDLED`. Fatal levels: write the record, then return `G_LOG_WRITER_UNHANDLED` so GLib's default path aborts. Before `Init`, the default writer as now. Debug messages respect `G_MESSAGES_DEBUG` as GLib's default writer does.
- **Test dispatcher rename.** `ibusweb_dispatch` → `ibusweb_test_dispatch` everywhere: header, sources, libibus-web tests, worker-host's `runtime.ts` and `loop.ts`, docs mentions in this task's files. The worker-host checks pass unchanged otherwise.
- **Tests** (`test-dispatch`, g_test), with Task 3's test engine registered through a factory:
  - every request kind's routing with its arguments;
  - each error code by a request that provokes it;
  - `ProcessKeyEvent`'s reply both ways;
  - a misaligned request buffer works;
  - a truncated payload, a wrong signature and nonzero flags give `-EBADMSG`;
  - `Log` records after `Init` (warning, message, debug with and without `G_MESSAGES_DEBUG`) and none before;
  - a C++ exception from a vfunc (a C++ source in the test, as `throwing-op.cpp`) gives `-ECANCELED` and a `Log` record.

- [ ] Steps: rename (host checks green); dispatcher tests red → green; log writer tests red → green; exception path; `nix flake check`; commit.

### Task 5: The GSettings backend

**Files:** `runtime/libibus-web/src/settings.c`, `src/settings.h` (internal), `src/dispatch.c`, `meson.build`, `tests/test-settings.c`, `tests/schemas/org.ibus-web.Test.gschema.xml`, `tests/meson.build`, `runtime/libibus-web/checks.nix` (compile the test schema with `pkgsWasm.glib`'s `glib-compile-schemas`, through Meson's `gnome.compile_schemas`; tests get `GSETTINGS_SCHEMA_DIR`).

**Interfaces:**

- Produces `IBusWebSettingsBackend` (a hidden `GSettingsBackend` subclass) registered on `G_SETTINGS_BACKEND_EXTENSION_POINT_NAME` as `"ibus-web"` with a priority above GLib's built-ins.
- Produces the internal calls `ibusweb_settings_init(GVariant *snapshot)` and `int ibusweb_settings_changed(const char *schema, const char *key, GVariant *value)`.

**Requirements:**

- **Review first.** Read patches 0008, 0009 and 0011's changes to `gsettings.c`, `gsettingsbackend.c` and `gdelayedsettingsbackend.c` (spec §5.1.3) and record in the report whether anything there affects a custom backend.
- **Registration.** The extension point is registered only by GIO's private `_g_io_modules_ensure_extension_points_registered()`. Creating and dropping a `g_memory_settings_backend_new()` once registers it through public API; do that, with a comment, before `g_io_extension_point_implement`. Register during `ibusweb_runtime_init()`, so the backend exists before any engine code runs. `g_settings_backend_get_default()` must return it without `GSETTINGS_BACKEND` set; a test asserts the default backend's type.
- **Values.**
  - The backend stores values by path. The snapshot (`a{sa{sv}}`, schema id → key → value) and `SettingChanged` name schema and key; resolve them with the default `GSettingsSchemaSource` (`g_settings_schema_get_path` + key). Keys that don't exist or have the wrong type are skipped with a warning.
  - Relocatable schemas have no path and are skipped with a warning; none of the target engines' are relocatable.
  - _Deviation:_ this skipping holds for the snapshot only. `SettingChanged` returns an error instead, with the warning as a `Log` record: `-ENOENT` for an unknown schema or key, `-EINVAL` for an invalid value, `-ENOTSUP` for a relocatable schema or a foreign default backend.
  - Snapshot values apply silently. A `SettingChanged` whose value differs calls `g_settings_backend_changed`, so engines' `changed::` handlers run (on the context they were created on, here the default context, possibly at the next pump).
- **Writes.**
  - An engine's write (`write`, `write_tree`, `reset`) updates the store, emits the change, and appends a `SettingWritten` record `(ssv)`; a reset writes the schema default.
  - The path is mapped back to schema and key by looking it up among the source's schemas: the schema whose path is the longest prefix and has the key.
  - `get_writable` is `TRUE`.
- **Tests** (`test-settings`, g_test) with a test schema of every type the target engines use (`s`, `b`, `i`, and an enum string with choices):
  - defaults without a snapshot;
  - snapshot values read back;
  - a `SettingChanged` fires `changed::key` once with the new value;
  - an equal value fires nothing;
  - an unknown schema or key warns and changes nothing;
  - `g_settings_set_*` from engine code produces a `SettingWritten` record with schema, key and value;
  - `g_settings_reset` writes the default.

- [ ] Steps: review; registration test red → green; value and write tests red → green; dispatcher wiring; `nix flake check`; commit.

### Task 6: The Hangul side module

**Files:** `flake.nix` (`./engines` in import-tree), `engines/hangul/overlay.nix` (`flake.overlays.hangul`), `engines/hangul/package.nix` (`ibusWeb.engines.hangul`, `packages.ibus-web-hangul`, the checks), `engines/hangul/module.c`, `engines/hangul/cast-audit.jsonc`, `engines/hangul/patches/casts/0001-*.patch`, `engines/hangul/patches/port/0001-*.patch`, `engines/hangul/patches/port/0002-*.patch`, `engines/hangul/patches/README.md`, `modules/engines/options.nix` (`ibusWeb.engines.<name>` option, an attrset of packages), `REUSE.toml`.

**Interfaces:**

- Produces `pkgsWasm.ibus-engines.hangul` (overridden), with `$out/hangul.wasm` and `$out/data/usr/share/…` (the tree the engine reads at `/`).
- Produces `ibusWeb.engines.hangul`, that package.
- Produces `checks.hangul-imports` and `checks.hangul-cast-audit`.
- Consumed by Task 7.

**Requirements:**

- **Overlay.**
  - `ibus-engines.hangul = prev.ibus-engines.hangul.overrideAttrs (...)`, gated as usual. Keep nixpkgs' `pname`, `version`, `src` and `meta`, and `patches` (nixpkgs' `fix-paths.patch` touches only the setup UI and applies harmlessly); append `patches/port/*` then `patches/casts/*` in order.
  - Replace `nativeBuildInputs`/`buildInputs` with `[ pkg-config ]` and `[ final.libibus-web libhangul' ]`, where `libhangul'` is engine-private: `final.libhangul.overrideAttrs` with a `postPatch` that `substituteInPlace --replace-fail`s the Hanja dictionary define in `hangul/Makefile.in` (or `.am` if nixpkgs autoreconfs) to `/usr/share/libhangul/hanja/hanja.txt`. The global `pkgsWasm.libhangul` stays as it is.
  - `dontConfigure`: ibus-hangul's `configure.ac` requires GTK and Python, used only by its setup UI and GTK test.
- **Build.**
  - Write the `config.h` its sources include, holding the macros they use (find them: at least `GETTEXT_PACKAGE`).
  - Compile `src/engine.c`, `src/ustring.c` and `engines/hangul/module.c` with `$($PKG_CONFIG --cflags ibus-1.0 libhangul)` and `-DIBUSHANGUL_DATADIR="/usr/share/ibus-hangul" -DPKGDATADIR=… -DLOCALEDIR=… -DLIBEXECDIR=…`, each set to its FHS path.
  - Link `hangul.wasm` with `toolchain.sideModuleFlags` and `$($PKG_CONFIG --static --libs libhangul)` only.
  - Refuse any `-l` flag the runtime carries, as `mkSideModule` does. Factor that guard out of `side-module.nix` into a shell function both use, rather than copying it.
- **Data tree** (`$out/data/usr/share/`):
  - `ibus-hangul/data/symbol.txt`;
  - `libhangul/hanja/hanja.txt` (from `libhangul'`);
  - `glib-2.0/schemas/`: ibus-hangul's `org.freedesktop.ibus.engine.hangul.gschema.xml` and ibus's `org.freedesktop.ibus.gschema.xml` (from libibus-web's `share/glib-2.0/schemas/`; it holds the panel schema `org.freedesktop.ibus.panel`, which ibus-hangul's init aborts without), compiled together with `pkgsWasm.glib`'s `glib-compile-schemas` into `gschemas.compiled`. The build isn't Meson, so it takes the tool from `$PKG_CONFIG --variable=glib_compile_schemas gio-2.0`, never by name from `PATH`, where the native one shadows it, with the sources kept beside it (spec §5.2.5).
- **`module.c`** (GPL-2.0-or-later, Synapdeck) defines `ibusweb_module_init` per the decisions; it includes ibus-hangul's `engine.h`. `main.c` is not compiled.
- **Patches.** Each patch is a `git format-patch` against nixpkgs' src, minimal, with a header saying what and why; the README records provenance and upstream status.
  - **casts 0001:** give `ibus_hangul_engine_class_init` and `ibus_hangul_engine_init` their `GClassInitFunc`/`GInstanceInitFunc` signatures (second parameter unused), keeping their bodies. _Deviation:_ it also gives `ibus_hangul_engine_destroy` its `IBusObjectDestroyFunc` parameter type, three functions in all.
  - **port 0001:** disconnect both `changed` handlers in `ibus_hangul_engine_destroy`.
  - **port 0002:** ignore a digit selecting past the last candidate.
  - Write the two port patches in Task 7, after their golden tests are red; this task carries casts 0001 only.
- **Checks.**
  - `checks.hangul-imports`: `checkSideModuleImports` on `hangul.wasm`. Any symbol it lacks means Task 3's survey list missed something: implement it in libibus-web, never stub it in the engine.
  - `checks.hangul-cast-audit`: `castAudit` over `src/engine.c`, `src/ustring.c` and `module.c` with the patches applied; the allow-list is empty. Show it red without casts 0001 (two findings; _deviation:_ three) and green with it, and record both in the report.
- **REUSE:** `engines/hangul/**` annotated `GPL-2.0-or-later`, copyright Synapdeck for our files; patches also name ibus-hangul's authors. A `REUSE.toml` comment states the annotation matches the recipe's `meta.license`.

- [ ] Steps: options; overlay with private libhangul; build + data tree; module.c; imports check (fill libibus-web gaps); cast audit red → casts 0001 → green; `nix flake check`; commit.

### Task 7: Golden tests

**Files:** `engines/hangul/checks/golden/default.nix`, `engines/hangul/checks/golden/golden.c`, `engines/hangul/checks/golden/harness.{c,h}` (request builders, record decoding, mounts; GPL-2.0-or-later like the rest of `engines/hangul/`), `engines/hangul/patches/port/0001-*.patch`, `0002-*.patch`, `engines/hangul/patches/README.md`.

**Interfaces:**

- Consumes `ibusWeb.engines.hangul`, `ibusWeb.testing.program`/`programs`, and libibus-web's runtime and protocol API.
- Produces `checks.hangul-golden`.
- The harness's request builders and record decoder are the pattern later engines copy; M1.3's conformance harness replaces them with TypeScript over the SAB.

**Requirements:**

- **The program.**
  - A g_test program (TAP) built with `ibusWeb.testing.program { format = "tap"; gtest = false; }`, a main module like libibus-web's `test-runtime`: `testMainFlags` without `nodeHostFsFlags`' object, plus libibus-web, with `-sASSERTIONS=1`.
  - It defines `wasmfs_create_root_dir()` to return a memory backend and, in `main` before `g_test_init`'s cases run, mounts Node backends: `$out/data/usr/share` at `/usr/share`, and the directory of `hangul.wasm` at `/sides`. The paths come from the program's `.args` (`--data DIR --module FILE`), parsed after `g_test_init`.
  - Run with `ibusWeb.testing.programs { environments = [ "node" ]; }` as `checks.hangul-golden`.
- **Per-case setup** (a fixture): `ibusweb_runtime_init` once; `Init` once per process, with a snapshot of one non-default key, `hanja-keys` = `"Hangul_Hanja,F9,F8"` (case 6 shows it reached the engine's init); `ibusweb_load_module("/sides/hangul.wasm")` once; then per case `CreateEngine(ic, "hangul")`, `SetCapabilities` (preedit, auxiliary text, lookup table, surrounding text, focus; **not** `IBUS_CAP_SYNC_PROCESS_KEY_V2`, see case 14), `FocusIn`, with a fresh `ic` per case and `DestroyEngine` at teardown. Pump after every request, as the host will, and collect records.
- **Keys** are sent as the router will send them: layout-`us` keyvals from `keysymdef.h` names (`IBUS_g`…), evdev keycodes, and modifiers; releases with `IBUS_RELEASE_MASK` too.
- **Cases** (assertions decode payloads with GVariant and `ibus_serializable_deserialize`):
  1. Initial input mode is Latin (`initial-input-mode` `latin`): `g` passes through (reply 0, no preedit).
  2. `Hangul` toggles to Hangul mode: an `UpdateProperty` for `InputMode` with symbol 한.
  3. 2-set `g k s` → `UpdatePreeditText` ㅎ, 하, 한 in turn, each with mode `IBUS_ENGINE_PREEDIT_COMMIT`, an underline attribute and foreground/background attributes ending at `-1`; `space` → `CommitText` 한, then the space passes through (reply 0). With CapsLock in the modifiers, `G K S` composes the same (ibus-hangul inverts case under CapsLock).
  4. `BackSpace` inside a syllable edits the preedit (한 → 하).
  5. `FocusOut` with a preedit emits no `CommitText`. ibus-hangul resets its composition and relies on the client committing a preedit whose mode was `IBUS_ENGINE_PREEDIT_COMMIT`. So assert no `CommitText` and that the last preedit record carried that mode. `Reset` behaves the same, because the declared IBus version is ≥ 1.5.20. While the Hanja list is open, the mode is `IBUS_ENGINE_PREEDIT_CLEAR`, and `FocusOut` hides the lookup table and auxiliary text. The page's duty to commit a `COMMIT`-mode preedit on blur and reset goes into the known gaps for M1.4's router and adapters.
  6. Hanja: 한 then `F9` → `UpdateLookupTable` whose candidates include 韓, visible (nine to a page, with the auxiliary text); `Down`/`Return` or `CandidateClicked` → `CommitText` 韓 and `HideLookupTable`. `Page_Down` pages. `F8` opens the list too, from the `Init` snapshot.
  7. A digit past the last candidate on the last page doesn't abort (red before port 0002: the program aborts, which the shim reports as the case failing).
  8. Settings: a `SettingChanged` of `hangul-keyboard` to `"39"` with an engine alive makes 3-set keys compose; back to `"2"` restores 2-set. A `SettingChanged` of `preedit-mode` to `"word"` keeps the whole word in the preedit across syllables until a commit key.
  9. `DestroyEngine`, then a `SettingChanged`, then a new engine composes correctly. Red before port 0001 (use-after-free); under `-sASSERTIONS=1` and Emscripten's allocator a freed engine may not trap, so make the case observe the engine's destruction directly (e.g. a weak reference on the destroyed engine and a check that `settings_changed` didn't run for it, via a `Log` record or a counting handler on the settings object). If a reliable red can't be built, say so in the report and keep the case as a regression test.
  10. `SetContentType` with purpose `IBUS_INPUT_PURPOSE_PASSWORD` makes Hangul-mode keys pass through.
  11. `Enable` emits `RequireSurroundingText`.
  12. Hanja from surrounding text: with no preedit and `SetSurroundingText` holding 한 before the cursor, `F9` offers candidates for it. Choosing one emits `DeleteSurroundingText` (a negative offset) then `CommitText`, and the engine's cached surrounding text reflects the deletion.
  13. No `Log` record of level warning or worse in any case, beyond expected ones listed in the case (the simple engine's missing compose resource doesn't apply: it is ours).
  14. With `IBUS_CAP_SYNC_PROCESS_KEY_V2` in the capabilities (and `use-event-forwarding` at its default, true), `space` after 한 is consumed (reply 1), and the records are `CommitText` 한 then `ForwardKeyEvent` space, in that order. The router doesn't advertise that capability: its reply already carries the records in order, and declining the key lets the browser apply it natively. That choice goes into the known gaps as a decision for M1.4.
- **Port patches.** Write port 0001 and 0002 here, after cases 9 and 7 are red; both go green with them.
- **Report:** the patch count per layer (casts 1, port 2, unless something else turned up) and any engine behaviour that surprised. _Deviation:_ port ended at 4 (0003 and 0004 above), and the golden suite at 16 cases.

- [ ] Steps: harness and program; cases 1–6, 8, 10–12 green; case 7 red → port 0002 → green; case 9 red → port 0001 → green; `nix flake check`; commit.

### Task 8: Documentation and the spec

**Files:** `docs/runtime.md`, `docs/engines.md` (new), `docs/glib.md`, `docs/testing.md`, `docs/known-gaps.md`, `docs/README.md`, `docs/specs/2026-09-26-ibus-web-design.md`.

**Requirements:**

- **`docs/runtime.md`:**
  - the two libraries and pkg-config files;
  - the IBus layer: what is vendored, what is ours and why (upstream headers for layout compatibility, `IBusEngineSimple` minimal, `IBusKeymap` `NULL`), and how to merge a later IBus release into the vendored tree;
  - the protocol header;
  - the output buffer and its threading;
  - `ibusweb_dispatch()` and its errors; Init before the module;
  - the log writer; the settings backend (registration, values, writes);
  - the test dispatcher's new name; `IBUSWEB_RUNTIME_ABI` 1; the export list's `ibus` library.
- **`docs/engines.md`:** how an engine is built:
  - the component layout;
  - overriding the nixpkgs recipe without its configure;
  - the private library override for data paths;
  - the FHS data view;
  - the patch layers and what goes in each;
  - the cast audit and its allow-list;
  - golden tests and the harness;
  - Hangul's specifics: settings schemas incl. the panel schema, Hanja data kept open and read by seek, FocusIn rather than FocusInId, setup property inert.
- **`docs/glib.md`, "Callbacks with fewer parameters":** M1's answer for Hangul. Two cast fixes in `patches/casts`, in hand-written `GTypeInfo` init functions; no connected handler with fewer parameters; no GLib-called callback mismatch. So the lazy arity lookup isn't needed for Hangul. The decision stays open until the m17n, libpinyin and Rime audits.
- **`docs/testing.md`:** golden tests as a kind of test, and the cast-audit check.
- **`docs/known-gaps.md`:** remove the items done (IBus types, the engine-share/manifest items stay for M1.3). Add:
  - `IBusEngineSimple`'s compose, Ctrl+Shift+U and emoji;
  - the connect-time arity audit;
  - ibus-hangul's `setup` property spawning nothing;
  - its globals read only at init and updated only through live engines' handlers (a `SettingChanged` with no engine alive is missed until the next init); _deviation:_ port 0003 fixed this instead;
  - the host's FHS data mapping and Init-before-load ordering (M1.3);
  - the runtime has no module shutdown, so `ibus_hangul_exit` never runs;
  - for M1.4: the page commits a preedit whose last mode was `IBUS_ENGINE_PREEDIT_COMMIT` on blur and on reset (ibus-hangul relies on it), and the router doesn't advertise `IBUS_CAP_SYNC_PROCESS_KEY_V2`;
  - for M1.4: the settings persister of spec §7.1.4 (the page's `gsettings` IndexedDB database, `Init` snapshots read from it, `SettingWritten` written back, `SettingChanged` to other Workers and other tabs through a `BroadcastChannel`, replaceable by the host);
  - anything a task reported as left.
- **The spec:**
  - §5.2.3: `ibusweb_dispatch(request, len)` returns the reply; the host pumps; Init precedes loading the engine module.
  - §5.2.5: schemas are compiled with `pkgsWasm.glib`'s `glib-compile-schemas`, not the build machine's.
  - §5.2.1: IBus vendored (headers and the data types), the layer split, `IBusEngineSimple` and `IBusKeymap` as built.
  - §5.4.2: the port layer also carries fixes for engine bugs the runtime's lifecycle exposes.
  - §5.4.3: the factory registration.
  - §5.6: the engine sees data at FHS paths, mapped by the host.
  - §6.1: the protocol's numbers and framing live in `ibus-web/protocol.h`; requests have no `*Id` forms.
  - §11.3: the cast audit is the audit report until a connect-time audit exists.
  - §12: M1 split into M1.1–M1.4 rows (M1.1 done as delivered; M1.2 protocol; M1.3 host transport and conformance harness; M1.4 page side), M1's questions answered for Hangul where they are.
- `git grep -n ibusweb_dispatch` outside `docs/plans` names only the real dispatcher, or the test one by its new name.

- [ ] Steps: pages; known gaps; spec; `nix flake check`; commit.

## Known gaps and follow-ups

(Filled in as tasks finish, then moved to `docs/known-gaps.md` in Task 8.)
