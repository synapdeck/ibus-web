# ibus-web design

- **Status:** Approved (2026-09-26); expected to change as milestones find problems
- **Date:** 2026-09-26
- **Author:** Alexis Williams

## 1. Summary

ibus-web runs minimally modified C and C++ IBus engines in the browser. It has two halves:

- **Worker side:** a WebAssembly runtime (a patched GLib plus a fresh implementation of `libibus`) that hosts one engine
  per Web Worker, loaded as a dynamically linked side module.
- **Page side:** a TypeScript library that replaces what the IBus daemon, the input-method module and the panel do on
  the desktop. It translates DOM key events, routes them to engines, applies their output to text surfaces and exposes
  panel state to a UI.

The halves talk only through a documented, versioned protocol over a dedicated `SharedArrayBuffer`. That boundary is
both an engineering interface and the licensing boundary that keeps GPL engines from reaching the page code.

ibus-web is a standalone open-source project with its own releases. Products depend on a version of it
(`ibus-web vX.Y.Z`); everything needed to use it, build it and meet its license obligations comes with that release.

### 1.1 Goals

- Run these engines in the browser with the smallest possible patch set to the engine code: **ibus-hangul, ibus-m17n,
  ibus-mozc, ibus-rime**, and a new table-style engine for extended Latin, Greek, Hebrew and similar scripts.
- Keep engine behavior exact on the keystroke path: every key gets the engine's real `process_key_event` answer, in
  order.
- Keep GPL code out of the page: the page-side packages are usable by proprietary hosts.
- Be a library, not an app: headless core, optional default panel, pluggable text surfaces, host-controlled settings and
  logging.

### 1.2 Non-goals

- A browser extension or input on arbitrary third-party pages. Hosts own the page and its text surfaces.
- Python engines (ibus-anthy, ibus-table, ibus-typing-booster).
- Preferences UI. Hosts build settings UI on the settings API.
- A first-party CodeMirror adapter in v1. The adapter contract is checked against CodeMirror 6 so it can be written
  later (§7.2.4).
- Running engines on the main thread.

### 1.3 Governing principle

**Patch GLib and the runtime freely; keep engine patches minimal.** When a problem can be fixed in `pkgsWasm.glib`,
`libibus-web` or the Worker host instead of in engine code, fix it there.

## 2. Context and constraints

- **Hosts are cross-origin isolated.** COOP/COEP is already in place in the first consuming application, so
  `SharedArrayBuffer`, `Atomics` and WASM threads are available.
- **Engines are GObject code.** `IBusEngine` subclasses use `G_DEFINE_TYPE`, GObject signals and GLib throughout.
  Settings come from GSettings (Hangul, m17n, Mozc, and Rime, whose module writes Rime's YAML from them). "Minimally
  modified" therefore requires real GLib and GObject, plus the GSettings part of GIO.
- **Engine libraries are sizable.** libhangul (C, small), m17n-lib (C, data in m17n-db), Mozc (C++, Abseil, Protocol
  Buffers), librime (C++, Boost, LevelDB, marisa-trie, OpenCC, yaml-cpp, glog; a deployer thread).
- **Licenses are mixed.** Engine glue is GPL (versions vary by project); Mozc is BSD-3-Clause; libhangul and m17n-lib
  are LGPL; librime is BSD; GLib is LGPL-2.1+. See §9.
- **WASM rejects function-pointer signature mismatches.** GLib and GObject code relies on calling functions through
  mismatched pointer types. Upstream GLib requires the toolchain to handle this (§5.1.1).
- **The first consuming application is written in Effect 4.** The page side and the Worker host are written in Effect 4,
  with a non-Effect facade for hosts (§7.4).

## 3. Decision log

| #   | Decision             | Chosen                                                                                                                                                                                                                                     | Main alternatives rejected                                                                                                                                    |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Deployment           | Library inside host-owned pages                                                                                                                                                                                                            | Browser extension; canvas remote desktop                                                                                                                      |
| D2  | Engine targets       | Hangul, m17n, Mozc, Rime, custom table engine; Rime alone for Chinese                                                                                                                                                                      | Arbitrary engines from day one; libpinyin as well as Rime (Rime covers its input schemes; Mozc already proved C++ side modules, persistence and large tables) |
| D3  | Engine compatibility | Real GLib/GObject/GIO subset; engine glue compiles with small, layered patches                                                                                                                                                             | Source-unmodified (forces a full GIO port); porting guide with a GObject-free API                                                                             |
| D4  | Main loop            | No `GMainLoop`; pump the default context after each dispatch and on source deadlines                                                                                                                                                       | Real `GMainLoop`                                                                                                                                              |
| D5  | Where engines run    | One Worker per engine module, keeping GPL code out of the page                                                                                                                                                                             | Main thread; Worker per input context; one Worker for everything                                                                                              |
| D6  | Keystroke answer     | Main thread spin-waits on a SAB reply with a time budget; consume-and-replay on timeout                                                                                                                                                    | Always consume and re-implement editing; predict from composition state                                                                                       |
| D7  | Instances            | One engine instance per input context via `IBusFactory`                                                                                                                                                                                    | Shared instance                                                                                                                                               |
| D8  | Linking              | Shared `ibus-runtime.wasm` main module; engines as side modules                                                                                                                                                                            | Static GLib in every engine                                                                                                                                   |
| D9  | GLib base            | nixpkgs `glib` plus Wolthuizen's per-release Emscripten patches, rebased onto nixpkgs' GLib, as a patch series; nixpkgs Emscripten with small fixes tracked upstream, no forked compiler or LLVM                                           | `EMULATE_FUNCTION_POINTER_CASTS`; Fluendo GLib + patched Clang                                                                                                |
| D10 | Settings             | GSettings backend bridge and API only, persisted by the page in a `gsettings` IndexedDB database by default                                                                                                                                | Generated forms; per-engine UI                                                                                                                                |
| D11 | UI                   | Headless core plus separate default panel package                                                                                                                                                                                          | Headless only; built-in themed panel                                                                                                                          |
| D12 | Surfaces             | Adapter contract; `<input>`/`<textarea>` and `contenteditable` built in                                                                                                                                                                    | Textarea only; CodeMirror adapter in v1                                                                                                                       |
| D13 | Storage              | WasmFS per Worker on IndexedDB, through our own lazy backend that stores files as ArrayBuffer chunks; one directory per engine                                                                                                             | Host-managed storage only; WasmFS's OPFS backend; ZenFS; IDBFS                                                                                                |
| D14 | Wire format          | IBus Engine D-Bus methods and signals, GVariant-encoded                                                                                                                                                                                    | Custom CBOR mapping                                                                                                                                           |
| D15 | Output transport     | One sequenced, variable-length, back-pressured output ring per Worker                                                                                                                                                                      | Fixed-size ring with eviction; ring of descriptors into a shared heap                                                                                         |
| D16 | TypeScript stack     | Effect 4 throughout, including the Worker host; the keystroke path and the Worker request loop are synchronous sections                                                                                                                    | Plain TypeScript; Effect 3                                                                                                                                    |
| D17 | Protocol definition  | Effect Schema as the source of truth, with a GVariant byte codec                                                                                                                                                                           | Hand-written codec and separate docs                                                                                                                          |
| D18 | First milestone      | Hangul spike end to end                                                                                                                                                                                                                    | libpinyin or Rime first                                                                                                                                       |
| D19 | Build orchestration  | Nix flake for toolchain, every artifact, checks and the release set; dependencies, engines and data come from a nixpkgs cross package set for wasm32-unknown-none with Emscripten as its compiler; CI only builds outputs and uploads them | emsdk plus scripts; per-language build tools orchestrated by CI                                                                                               |
| D20 | npm registry         | npmjs.com with trusted publishing from GitHub Actions                                                                                                                                                                                      | GitHub Packages                                                                                                                                               |

## 4. Architecture

### 4.1 Components

```
 Page (MIT OR Apache-2.0)                     Worker, one per engine module (engine's GPL)
┌─────────────────────────────────────┐      ┌──────────────────────────────────────────┐
│ Host app                            │      │ Worker host (Effect), wake relay         │
│   │                                 │      │   ▲ wait / dispatch / write ring         │
│   ▼                                 │      │   │                                      │
│ @ibus-web/core  (Effect)            │      │ ibus-runtime.wasm  (main module, LGPL)   │
│  ├─ Router                          │ SAB  │  ├─ libibus-web (dispatcher, emitters,   │
│  │   ├─ key translation             │◄────►│  │   IBusEngine, IBusFactory, GSettings  │
│  │   ├─ input contexts / focus      │      │  │   backend, pump)                      │
│  │   ├─ engine registry / Workers   │      │  ├─ pkgsWasm.glib (GLib, GObject, GIO)   │
│  │   └─ keystroke path (plain TS)   │      │  └─ libc, libc++                         │
│  ├─ Settings API                    │      │                                          │
│  └─ Event streams                   │      │ engine side module                       │
│ @ibus-web/protocol (Schema, codec)  │      │  ├─ engine glue (ibus-hangul, …)         │
│ Surface adapters                    │      │  └─ engine libraries (libhangul, …)      │
│ @ibus-web/panel (optional)          │      │                                          │
└─────────────────────────────────────┘      │ IndexedDB: /engines/<name>/…             │
                                             └──────────────────────────────────────────┘
```

| Component           | Language | Runs in        | Package or artifact                                                     | License                      |
| ------------------- | -------- | -------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `pkgsWasm.glib`     | C        | Worker         | nixpkgs `glib` plus a patch series in this repo; built into the runtime | LGPL-2.1-or-later            |
| `libibus-web`       | C        | Worker         | built into the runtime                                                  | LGPL-2.1-or-later            |
| `ibus-runtime.wasm` | WASM     | Worker         | release asset; npm `@ibus-web/runtime`                                  | LGPL-2.1-or-later (combined) |
| Engine side modules | WASM     | Worker         | release asset per engine                                                | engine's own license         |
| Worker host         | TS       | Worker         | `@ibus-web/worker-host`                                                 | MIT OR Apache-2.0            |
| Protocol            | TS       | Page and tests | `@ibus-web/protocol`                                                    | MIT OR Apache-2.0            |
| Router and services | TS       | Page           | `@ibus-web/core`                                                        | MIT OR Apache-2.0            |
| Facade              | TS       | Page           | `ibus-web`                                                              | MIT OR Apache-2.0            |
| Surface adapters    | TS       | Page           | in `@ibus-web/core`                                                     | MIT OR Apache-2.0            |
| Default panel       | TS       | Page           | `@ibus-web/panel`                                                       | MIT OR Apache-2.0            |

### 4.2 One keystroke, end to end

1. The router's capture-phase `keydown` listener on the attached element hands the event to the active engine's
   keystroke path.
2. The keystroke path translates the event into `(keyval, keycode, state)` (§7.1.1). If the engine or the input context
   isn't ready, the surface is disabled (a password field, for one), or the key is on the engine's declared pass-through
   list, it returns `passthrough` at once.
3. It encodes `ProcessKeyEvent` into the request slot and signals the Worker.
4. The Worker host wakes, calls `ibusweb_dispatch`, which calls the engine's `process_key_event` vfunc. Engine output
   (`CommitText`, `UpdatePreeditText`, …) is appended to the runtime's output buffer.
5. The host pumps due GLib sources, flushes the output buffer into the output ring and writes the reply: the return
   value and the last output sequence number.
6. The main thread, spinning, drains the ring as records arrive and sees the reply.
7. It applies the decoded records to the surface inside the adapter's `batch()`, pushes panel events and returns
   `consumed` or `passthrough`.
8. The router calls `preventDefault()` and `stopPropagation()` when the key was consumed. A declined key keeps its
   browser default.

Editors that own their own key handling attach in async or manual mode instead and call `keyAsync` during the event's
dispatch; the same engine queue serves both (§7.2.2).

## 5. Worker side

### 5.1 `pkgsWasm.glib`

nixpkgs' `glib` recipe with an Emscripten patch series kept in this repository (§10.3). The series starts from Kleis
Auke Wolthuizen's Emscripten patch set (the one wasm-vips uses), taken from his per-release
[`wasm-vips-<version>`](https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1) branches of GLib and rebased onto
nixpkgs' GLib (2.88.3), plus Fluendo's `glist`/`gslist` signature fix and our own. Built with nixpkgs Emscripten and
Meson cross files (§10). D-Bus, networking, subprocesses and file monitoring are disabled or stubbed; GIO is kept for
GSettings and the types it needs.

#### 5.1.1 Function-pointer casts

- **Background.** GLib documents that it requires calls through mismatched function-pointer types to work, and that
  Emscripten builds must use `-sEMULATE_FUNCTION_POINTER_CASTS` (GLib MR !4469). Upstream rejected removing the
  mismatches (!4660, #3670). Emscripten kept the flag for GLib's sake (PR #24169).
- **Why not cast emulation.** With `-sMAIN_MODULE` it breaks catching C++ exceptions (emscripten#22285, open), and our
  C++ engines need exceptions. It also slows every indirect call.
- **Why not Fluendo's Clang.** `-fwasm-fix-function-bitcasts`
  ([llvm#153168](https://github.com/llvm/llvm-project/pull/153168)) is unmerged and contested, needs a forked LLVM for
  everyone who builds an engine, and does not cover callbacks stored as `gpointer`, which is how `GCClosure` holds
  signal handlers.
- **Chosen.** The series' source-level fixes, including the `G_DEFINE_TYPE` header fixes, which engines pick up
  automatically.
- **Watch.** If a toolchain-level fix ships in Emscripten, drop the engine cast patch layer (§5.4.2) and re-run the
  audit.

#### 5.1.2 Callbacks with fewer parameters

Most engine-side mismatches are callbacks that declare fewer trailing parameters than the caller passes: signal handlers
without `user_data`, `(GFunc) g_free`, and similar. When GLib is the caller, `pkgsWasm.glib` absorbs the mismatch so the
engine needs no patch.

- **Class handlers.** Class closures never take `user_data`, so on WebAssembly they are marshalled through libffi with
  the instance and the signal's parameters only. This covers class-struct handlers, `g_signal_new_class_handler`,
  overrides and chaining up, without knowing anything about the callee.
- **Other callbacks: lazy arity lookup.** A function pointer is an index into the WASM function table, and the function
  there has a JS `.length` equal to its parameter count. At the covered call sites GLib asks for it through a small
  `EM_JS` helper and caches the answer per function pointer, so a pointer is looked up once. Nothing is scanned ahead of
  time, and side modules loaded later need no extra step.
- **Covered call sites.** Closure invocation (the generated marshallers and `g_cclosure_marshal_generic`),
  `g_list_foreach`, `g_slist_foreach`, `g_ptr_array_foreach`, `g_hash_table_foreach` and its `_remove`/`_steal`
  variants, `GDestroyNotify` calls, `GSourceFunc` dispatch and sort comparison callbacks.
- **Calling.** Calls with matching arity take the normal path. When the callee takes fewer parameters, the call goes
  through JS (`wasmTable.get(fp)(…)`), which drops the extra arguments itself.
- **Not covered.** Callees declaring _more_ parameters than passed, and mismatches in engine code that GLib never calls.
  Those need engine patches.
- **Audit output.** Debug builds log every absorbed mismatch with the callee's name and the call site. That log is the
  engine audit report (§11.3).
- **Only if needed.** The lookup is built when the engine audit shows it pays for itself. If the target engines have
  only a few such callbacks, they are fixed in each engine's `patches/casts` instead and the lookup is not built.

#### 5.1.3 Other `pkgsWasm.glib` changes

- A hook for the pump (§5.2.4). The GSettings backend (§5.2.5) needs no GLib change: the runtime registers it through
  public GIO API (`g_io_extension_point_implement`). The pump hook includes the context wakeup: on WebAssembly,
  `g_wakeup_signal` (reached through `g_main_context_wakeup`) also calls a hook, after waking the wakeup's own futex,
  from whichever thread signals. `libibus-web` installs it with `g_main_context_wasm_set_wake_hook()` on the default
  context; a context takes one hook for its life, published with a compare-and-swap, so a second call fails with a
  critical whatever `G_DISABLE_CHECKS` says. The hook bumps and notifies the word in WASM memory the Worker host sleeps
  on (§5.2.4). It also runs on the owning thread during its own iterations, where it is harmless.
- Blocking iteration (`g_main_context_iteration(ctx, TRUE)`, `g_main_loop_run`) sleeps. On WebAssembly a `GWakeup` is an
  atomic counter with futex wake and wait (`emscripten_futex_wake`/`_wait`), and a blocking iteration waits on its
  context's wakeup for the computed timeout instead of calling `poll()`, which can't wait there. Any fds are probed with
  a zero timeout between waits of at most 10 ms. Another thread's change to the context (`g_main_context_wakeup`,
  attaching a source, quitting a loop) ends the wait. The runtime's pump still iterates without blocking, which is
  unchanged. A wakeup asked for a poll fd (GCancellable's `g_cancellable_get_fd`, `g_cancellable_make_pollfd`) gets a
  pipe that mirrors the futex; contexts never ask, so they have none. `g_poll()` with a timeout probes and sleeps in 10
  ms slices, since Emscripten's `poll()` can't wait.
- `GTimeZone` takes IANA zones from JavaScript's `Intl` API, not from zoneinfo files, so the runtime ships no tzdata:
  GLib's TZif parser gets data synthesized from `Intl.DateTimeFormat` for 1800–2100, continued past 2100 by a POSIX rule
  where the zone's pattern is one, and the local zone is the one `Intl` resolves unless `TZ` is set. Abbreviations are
  `Intl`'s short English names where it has them (`PST`), else numeric (`+0100`).
- GLib's worker context (`g_get_worker_context()`) runs a blocking loop on a thread GLib starts on first use. `GTask`'s
  type initialization starts it, so in practice any GIO asynchronous call does; so do local file queries for
  `standard::is-hidden`, `GThreadedResolver` lookups with a timeout or cancellable, and `GSubprocess`. GDBus's shared
  thread runs its own blocking loop. Both sleep until woken, so each costs a pthread for the life of the Worker but no
  CPU.
- Fluendo's `gst.wasm` branch made wakeups no-ops, kept the wakeup's poll fd out of the main context and forced poll
  timeouts to zero; the futex wait above supersedes all three, so the series doesn't carry them. Its
  `emscripten_set_main_loop` integration and the deadlock fix that only concerns it are not taken either; the runtime
  pumps the context itself.
- Review the series' GSettings changes (`gsettings.c`, `gdelayedsettingsbackend.c`) before building the settings bridge
  on them.

#### 5.1.4 Platform backends

Where Emscripten's libc or GLib's WebAssembly build stubs a facility that the browser (and Node, for tests) provides,
`pkgsWasm.glib` gets a WebAssembly-only backend that reaches the JavaScript API through `EM_JS`, instead of carrying
data or accepting the stub. Time zones already work this way (`Intl`). The rest land with the first milestone whose
engine needs them; each moves the GLib subtests it fixes from platform-difference skips into `must_pass`. In order of
value to engines:

- **Language and locale.** `g_get_language_names()` and the default locale from `navigator.languages`: musl's locales
  exist in name only, and this decides the language an engine's own messages use. The locale's numeric conventions
  (`localeconv()`'s decimal point and grouping, which GLib's option parsing and number formatting read) come from
  `Intl.NumberFormat`.
- **Collation.** `g_utf8_collate()` and `g_utf8_collate_key()` through `Intl.Collator`, for engines that sort candidates
  or dictionary entries.
- **Localized dates and times.** The locale-dependent parts of `g_date_time_format()` (`%c`, `%x`, `%X`, month and
  weekday names) through `Intl.DateTimeFormat`, for engines that offer dates as conversions. Era-based formats (`%Ec`,
  `%EC`, `%Ex`, `%Ey`, `%EY`) need `nl_langinfo(ERA)`, which musl leaves empty, so GLib's tests skip them today. Rather
  than synthesizing era tables for GLib to parse, GLib's era formatting asks `Intl` directly for the date at hand: the
  locale's calendar (`japanese`, `buddhist`, `roc`) gives the era name and era-relative year through `formatToParts`,
  with no table and no range limit. Japanese engines need this for imperial-era years. (Time zones go the other way, as
  data: GTimeZone's API hands out stable interval indices, so it needs the whole transition table up front, and TZif is
  a format GLib keeps parsing across releases.)
- **Legacy charsets.** Decoding in `g_convert()` and `g_iconv()` through `TextDecoder` (EUC-JP, Shift_JIS, GBK, Big5 and
  the rest), for dictionaries stored in them. Encoding stays with musl's encoders: browsers expose no encoder but
  UTF-8's, and GLib's handling of musl's POSIX-conforming substitutions (it writes `*` and counts the character as
  irreversible rather than failing) makes the fallback and stream converters exact.
- **File monitoring.** A `GFileMonitor` backend that watches WasmFS itself, since every write to the Worker's files goes
  through it, for engines that reload user dictionaries or configuration when they change. Changes another tab makes to
  the same IndexedDB data (§5.6) need a message from that tab.
- **Network state.** `GNetworkMonitor` from `navigator.onLine` and its events.
- **User and host.** `g_get_user_name()`, the home directory and the host name for a synthesized WebAssembly user rather
  than the `getpwuid_r` stub.
- **Memory.** Browsers expose no low-memory events; `navigator.deviceMemory` at most. Only if an engine needs it.

Node can also run subprocesses through `child_process`, which would let `g_test_trap_subprocess()` and the spawning
subtests run in the test harness. That is test coverage of code the runtime never runs, so it is optional. Sockets, DNS,
GDBus, application information and Unix signals have no browser equivalent an input method needs and stay unsupported.

**Native replacements (measure first).** Some facilities work today but have a native browser equivalent that could be
faster or smaller. Each crossing between WebAssembly and JavaScript copies the string (UTF-8 in linear memory, UTF-16 in
JavaScript), so only whole-string operations are candidates; anything called per character stays in WebAssembly. The
runtime links with `-sMAIN_MODULE=2`, which already drops GLib code nothing references, so these pay off only for code
engines reach. The runtime milestone measures a size breakdown of the linked runtime (per function and data segment) and
the cost of the calls engines make before any of them is built.

- **Unicode normalization and case mapping.** `g_utf8_normalize()` through `String.prototype.normalize()`, and
  locale-independent case mapping and casefolding through `toLowerCase()`/`toUpperCase()`, dropping GLib's decomposition
  and composition tables. Likely worth it. Per-character property lookups (`g_unichar_type()` and the like) keep GLib's
  tables.
- **GRegex through `RegExp`.** PCRE2 is a few hundred KB and the browser's regular expressions are native and
  JIT-compiled, but GRegex promises PCRE syntax; possessive quantifiers, recursion, `\K` and callouts have no ECMAScript
  equivalent. Decided by an audit of the patterns the target engines use: route patterns that translate faithfully to
  `RegExp` with PCRE2 as the fallback (time, not size), or drop PCRE2 if no engine needs PCRE-only features (size).
- **Legacy-charset tables.** The `TextDecoder` backend above also removes the conversion tables from the build.
- **ICU.** If an engine depends on ICU (for example through Boost.Locale), a shim over `Intl` could replace ICU's
  roughly 30 MB of data. Checked when each engine is planned; not built otherwise.

`SubtleCrypto` and `CompressionStream` are asynchronous, so they cannot back `GChecksum`, `GHmac` or GIO's zlib
converters; the allocator, math and hash tables already run at native speed in WebAssembly; `DOMParser`, which could
replace libxml2, is unavailable in Workers.

### 5.2 `libibus-web`

A new C implementation of the part of the `libibus` API that engines use, installed with `ibus.h`-compatible headers so
engine glue compiles unchanged. Where code is taken from upstream `libibus`, it keeps its LGPL-2.1+ license.

#### 5.2.1 API surface

M1.1 vendors IBus 1.5.34's public layouts, serializable data types, key helpers and schemas, keeping their
LGPL-2.1-or-later license and recording adaptations in `runtime/libibus-web/src/ibus/README.md`. Exact callback types
preserve WebAssembly call compatibility without changing object layouts.

- `libibus-web.a` contains the runtime API with hidden internals; `libibus-web-ibus.a` contains default-visible IBus
  symbols. `libibus-web.pc` links both; `ibus-1.0.pc` supplies engine compile flags without link libraries.
- Real GObject types include `IBusObject`, `IBusSerializable`, `IBusText`, attributes, lookup tables and properties.
  Local `IBusService`, `IBusEngine` and `IBusFactory` replace the bus-facing implementation against upstream headers,
  with the signals/vfuncs engines use.
- `IBusEngineSimple` is a minimal base; compose, Ctrl+Shift+U and emoji are deferred. `ibus_keymap_get()` returns
  `NULL`, and lookup returns the input keyval because the page translates keys.
- Keysym/Unicode helpers and `ibus_init` are provided. No bus/config/component implementation is present: an opaque
  `IBusBus` declaration permits unused init parameters but supplies no bus functions. Unused APIs remain absent so later
  engines reveal their requirements at compile/link time.

#### 5.2.2 Emitters

`ibus_engine_commit_text`, `ibus_engine_update_preedit_text(_with_mode)`, `ibus_engine_update_auxiliary_text`,
`ibus_engine_update_lookup_table(_fast)`, the show and hide calls, `ibus_engine_register_properties`,
`ibus_engine_update_property`, `ibus_engine_forward_key_event`, `ibus_engine_delete_surrounding_text` and
`ibus_engine_get_surrounding_text` serialize their arguments with `IBusSerializable` and append a record to the
runtime's output buffer, tagged with the instance's input-context ID. They never block. Once `IBusEngine`'s `destroy`
has run, an engine emits nothing: its context may already belong to a new engine.

`ibus_engine_get_surrounding_text` returns the last `SetSurroundingText` the router sent, and emits
`RequireSurroundingText` on every call, including a call with all output arguments NULL.

#### 5.2.3 Dispatcher

`ibusweb_dispatch(request, len)` validates and owns one framed request, finds its input context and invokes the
corresponding engine signal. It returns a key event's 0/1 reply, zero for other successful requests, or a negative
errno; it does not pump or flush. The host pumps (§5.2.4), drains output and publishes the reply in order (§6.2).

Init validates the protocol version, installs the log writer and then applies the settings snapshot, so the snapshot's
warnings become `Log` records on context 0. It must precede loading the engine module, whose initialization reads
settings. `CreateEngine` uses the registered `IBusFactory`; `DestroyEngine` disposes the context. `SetContentType` emits
`set-content-type` only when the purpose or hints change; a context starts at 0 and 0. The former test opcode protocol
remains as `ibusweb_test_dispatch`.

The errors are those `runtime.h` lists: `EBADMSG` for invalid framing or payload (a request of the header alone
included), `ENOSYS` for an unknown kind, `ENOTCONN` before Init, `EALREADY` for a repeated Init, `EPROTO` for a version
mismatch, `ENOENT` for a missing context, `EEXIST` for a duplicate context, `ESRCH` for an unregistered engine, `EIO`
for a registered engine that wasn't made, `EINVAL` for a `SetSurroundingText` cursor or anchor past the text's length in
characters, `EPERM` off the pumping thread, and `ECANCELED` when an engine throws a C++ exception. Requests failing on
their framing, payload or context reach no engine. `SettingChanged` ignores the header's context, so its `ENOENT` means
a path no `Init` entry declared or a key its schema lacks, never a missing context; it returns `EINVAL` for a value
outside the key's type or range and `ENOTSUP` for a default settings backend other than the runtime's, each with a `Log`
record.

`ECANCELED` means the runtime is unusable: the exception unwound through GLib's signal emission, skipping its cleanup
and leaking the engine's reference. The host treats it as a crash (§8). Every later `ibusweb_dispatch` returns
`ENOTRECOVERABLE` without touching GLib or any engine, and `ibusweb_pump` dispatches nothing and returns -1; output
peek, consume and `ibusweb_output_last_seq` still work, so the host can drain the records already written.

#### 5.2.4 Pump

No `GMainLoop` runs. The dispatcher calls `g_main_context_iteration(NULL, FALSE)` until nothing is pending, after every
dispatch (`ibusweb_pump()`, which returns the delay to the next source deadline from `g_main_context_query`). Between
requests, the Worker host sleeps in the runtime: `ibusweb_wait(seen, timeout)` waits with `emscripten_futex_wait` on the
**wake word**, a word in WASM memory, while it holds `seen`, for at most that delay, and the host pumps when it returns.
JS timers are never needed in the Worker, which matters because a Worker serving requests never runs its event loop.

The host sleeps inside the runtime, not in `Atomics.wait`, because Emscripten runs the calls other threads proxy to the
runtime's own thread only from that thread's event loop or from inside its futex waits. Those calls include
`pthread_create()` from any other thread (only the thread that instantiated the runtime holds the Worker pool),
JavaScript library calls proxied synchronously and, with the toolchain's patch, the cleanup of threads that end unjoined
(§10.3). A host asleep on any other word never runs them, so a thread that creates threads, or a `GTask` started from
another thread, hangs. Each `emscripten_futex_wait` on the runtime's thread runs them, so they complete while the host
sleeps, under Node and in Chromium and Firefox. `ibusweb_wait` always makes one futex wait, even when the word has
already moved: that wait returns at once but still runs the queued calls, so a host woken often doesn't starve them. Any
result but success or a timeout is a crash.

Two things bump the wake word:

- **GLib's wake hook** (§5.1.3), from any thread, when a source becomes ready there: a `GTask` finishing in the thread
  pool, or an engine library's own thread calling `g_idle_add`. The host wakes and pumps then rather than at the next
  request or deadline. GLib signals for a source attached from another thread only when the context has an owner, so
  `ibusweb_runtime_init()` acquires the default context on the pump's thread for the Worker's lifetime; acquiring is
  recursive, so its non-blocking iterations still work. A test attaches a source from another thread while the host
  waits and checks that it is dispatched promptly.
- **The wake relay**, for the page, which never touches WASM memory (§9.2). The page bumps the control SAB's `wake` word
  (§6.2.1) for two things: a request it has posted, and ring space the host is waiting for (§6.2.2), so a wake from the
  page means one or the other. The relay, a small Worker the host starts, sleeps in `Atomics.wait` on that word and, for
  each change, bumps and notifies the wake word. It needs no event loop after startup. It compares the word with the
  value it last forwarded, never with a re-read, which would lose a wake that lands mid-forward. The relay and the sleep
  inside the runtime together add about 3 µs under Node and 20 µs in the browsers to a request that finds the host
  asleep, at most. One relay per page could serve every engine, through a page-wide doorbell word and a sequence word
  per engine; that isn't built.

Having the hook notify the control SAB instead, with the host asleep on it, was rejected: getting the SAB into every
pthread's JavaScript realm, including Workers created later, rests on Emscripten internals, and a host asleep outside
the runtime fails as above whatever delivers the buffer.

Output produced by a pump outside a request goes to the ring followed by a doorbell `postMessage` (§6.2.3).

#### 5.2.5 GSettings backend

- **Backend.** `IBusWebSettingsBackend`, a `GSettingsBackend` subclass registered at priority 1000 during runtime init
  on `G_SETTINGS_BACKEND_EXTENSION_POINT_NAME`. It is the default unless `GSETTINGS_BACKEND` explicitly selects another
  backend.
- **Values.** `Init` declares every schema instance the module uses, a schema id at a path (a relocatable schema at as
  many paths as the build declares), with its stored values. `SettingChanged` requests name a path and a key; they
  update the backend and call `g_settings_backend_changed`, so engines' own `changed::` handlers fire. Engine writes
  resolve to the declared instance whose path prefixes their key and emit `SettingWritten` records, with that path, for
  the page to persist (§7.1.4).
- **Schemas.** Compiled at build time with `pkgsWasm.glib`'s `glib-compile-schemas`, run under Node through the cross
  `.pc` tool path, and shipped in the engine's data files under the manifest's store-path `settingsSchemaDir`. The host
  sets `GSETTINGS_SCHEMA_DIR` before Init. The `.gschema.xml` sources are also shipped so the page can describe keys to
  host UIs.

### 5.3 `ibus-runtime.wasm`

- **Contents.** libc, libc++/libc++abi, `pkgsWasm.glib` (GLib, GObject, GModule, the GIO subset), libffi and
  `libibus-web`.
- **Build.** `-sMAIN_MODULE=2` with an explicit export list (below), linked with `em++` from `runtime/ibus-runtime/`.
  Everything is compiled with `-fPIC`. GRegex overflows Emscripten's 64 KiB default stack, on any thread, so the link
  sets `-sSTACK_SIZE` and `-sDEFAULT_PTHREAD_STACK_SIZE` to 1 MiB. `libibus-web`'s public API is marked `IBUSWEB_API`
  (default visibility) and the library is built with hidden visibility, so only that API is exported from it.
- **Thread pool.** A browser starts a Worker only once the thread that created it is back in its event loop (Chromium),
  or only while the page's main thread is free (Firefox), so a Worker host that never returns to its event loop can't
  wait for a new one. Threads run on a pool of Workers made with the runtime (`-sPTHREAD_POOL_SIZE`), sized for the
  threads expected alive at once plus spares, and `-sPTHREAD_POOL_SIZE_STRICT=2` makes a thread beyond the pool fail at
  once with `EAGAIN` instead of waiting for good. The size is made of shares, by what starts the threads, plus spares.
  The base is fixed at link time, from Nix (`ibusWeb.runtime.threadPool`): GLib's share, 3 (what one `GTask` in flight
  keeps alive: the worker context's thread and the thread-pool spawner, kept for good, and a `GTask` worker, kept 15.5 s
  after its last task), the storage backends' 2 (one thread each for the engine's own files and its installed data,
  §5.6), and `lowWater`, 3 spare Workers. The engine's share is added per Worker: Emscripten writes
  `-sPTHREAD_POOL_SIZE` into its JavaScript verbatim, as an expression evaluated inside the modularized runtime's
  factory, where `Module` is the settings object the host passes in. The runtime links with the base (8 today) plus
  `Module["ibuswebEngineThreads"]`, which the host must set from the manifest's `threads`, so Emscripten makes the whole
  pool, and loads the runtime into each Worker, before the runtime runs.
- **Spares.** GLib handles a failed thread creation badly: `g_thread_new()` aborts, so the first `GTask` aborts the
  runtime if no Worker is idle, and a `GTask` whose worker can't start stays queued, silently, until some other worker
  is free. The first `GTask` needs all three of GLib's threads at once, so the spares number GLib's share: a thread an
  engine starts beyond its share takes a spare rather than a Worker GLib counts on. Whenever no request is pending and
  fewer than `lowWater` Workers are idle, which happens only past the shares, the Worker host tops the pool back up
  (§5.5), the one use it makes of Emscripten's internal `PThread`; Workers added stay. Bursts within the pool start
  without an event-loop turn in both browsers; a top-up of one Worker takes 47–48 ms there.
- **Export list.** The runtime exports what side modules may import, a manifest per library, each identified by its
  whole version: `libibus-web` (by `IBUSWEB_RUNTIME_ABI`); GLib, GObject, GModule and GIO (GLib's version); libffi (its
  version; the names its public headers declare); libc (Emscripten's musl by Emscripten's version: the whole archive,
  Emscripten's C internals included, plus the JavaScript-implemented functions libc's headers declare); compiler-rt,
  libc++, libc++abi and libunwind (the bundled LLVM's version); the IndexedDB backend (`IBUSWEB_RUNTIME_ABI`; the
  functions `ibus-web/wasmfs-idb.h` declares, not its C++ internals, §5.6); and Emscripten's own API, the functions, C
  or JavaScript, declared by an allowlist of its core headers (`emscripten.h`, `em_asm.h`, `em_js.h`, `console.h`,
  `threading.h`, `proxying.h`, `eventloop.h`, `heap.h`, `atomic.h`, `stack.h`, `wasmfs.h` less
  `wasmfs_create_opfs_backend`; not `syscalls.h`), less those that work only with Asyncify, listed before libc so it
  owns those names. `runtime/ibus-runtime/exports.nix` derives every list from the build, never by hand, into
  `exports.txt`, grouped by library under a header with its version and count, and `exports.json`. Every side module's
  imports are checked against it at build time (`ibusWeb.runtime.checkSideModuleImports`).
- **ABI.** The runtime's ABI identity is that set of library versions plus `IBUSWEB_RUNTIME_ABI`. M1.3 manifests carry
  only numeric `runtimeAbi`, checked against `IBUSWEB_RUNTIME_ABI`; a mismatch is a load failure (§8). Carrying and
  checking the full library-version identity remains an explicit compatibility gap (`docs/known-gaps.md`).
- **JavaScript surface.** The Worker host also uses parts of Emscripten's JavaScript, `HEAPU8` and the pthread pool's
  `PThread` (`-sEXPORTED_RUNTIME_METHODS`), which the export list, holding only WASM symbols, doesn't cover, so neither
  does the ABI identity. The host refuses to start if they are missing. `PThread` is Emscripten's internal pool; a
  public Emscripten call to grow the pool and settle once its Workers can run threads would replace it.
- **Memory.** Fixed per Worker, made by the host. Growth with pthreads traps in V8: an atomic access that Liftoff
  compiled is bounds-checked against the memory size its thread last saw, which another thread's growth updates only
  once the accessing thread next handles its interrupts. The atomic accesses that faulted this way were libc++'s
  shared-pointer counts (WasmFS opening a file, in GLib's many-thread `1bit-emufutex` test) and a test workload's own
  atomic increments of freshly allocated memory (`docs/runtime.md`, "Why not growth"; note
  `docs/upstream/v8-liftoff-atomics-grown-shared-memory.md`). V8 fixed it on its main branch (issues 529880019 and
  533026477), first in Chrome 157; no Node release line has the fix yet. The runtime is linked without memory growth, so
  nothing in it can grow its memory, whatever maximum the memory was given. Its memory import is declared from
  `ibusWeb.runtime.memory.minimum` (32 MiB) to `ibusWeb.runtime.memory.maximum` (2 GiB), so it takes any memory in
  between (`-sIMPORTED_MEMORY -sMAXIMUM_MEMORY=` without growth, which Emscripten honours only with a patch the
  toolchain carries), and it refuses to start without one. The Worker host makes a shared `WebAssembly.Memory` of the
  engine manifest's `memory` bytes with its maximum at that size, and passes it as `wasmMemory`. `memory` is a whole
  number of 64 KiB pages from the minimum to 2 GiB; the host checks it before making the memory, and a value outside
  that is a load failure (§8) whose error gives the value and the bounds. A full heap aborts the runtime, as a trap does
  (§8): with `-sABORTING_MALLOC=1` (Emscripten's default without growth) every allocation the heap can't hold aborts
  rather than returning `NULL`, including `g_try_malloc()` and `malloc()` of an oversize request, so code that handles a
  failed try-allocation never runs. The size is a manifest field rather than a link per engine so that one runtime
  binary serves every engine and the page compiles it once (Sharing, below). An engine's build sets `memory` to the
  runtime's minimum, plus the side module's own memory (its `dylink.0` memory size), plus 1 MiB per thread of its pool
  share, plus declared `heapBytes`, with a quarter more for margin, rounded up to whole MiB. `mkEngineManifest` computes
  this from build data. `heapBytes` is separate build/check metadata, not a manifest field: the declared peak of the
  program break (`sbrk(0)`), which the conformance harness measures as `breakPeak` and fails if it exceeds the
  declaration. The break is an address, so it counts the static data below the heap as well as the heap; adding it to
  the runtime minimum and the module's static size counts that data twice, and the memory figure is conservative. Engine
  data in IndexedDB is read lazily and does not count; without IndexedDB the host adds unpacked data bytes in whole
  pages to memory and maximum. Hangul declares a 4 MiB program break and zero engine threads, guarded by its Node
  conformance workload, not universal resource bounds. The page's budget is that memory, touched or not, plus each pool
  Worker's own cost, since each holds an instance of the runtime: about 18 MiB in Chromium and 12–16 MiB in Firefox, and
  3–5 MiB more once it has run a thread (about 42 MiB and 10 MiB under Node). GLib's tests and the checks that link with
  `ibusWeb.toolchain.testMainFlags` (the GLib smoke check, libhangul, the toolchain and Emscripten-fix checks) use a
  fixed 512 MiB (`ibusWeb.toolchain.testMemoryFlags`; the largest test, `mainloop`, peaks at 280 MiB). The Meson and
  Autotools consumer checks keep Emscripten's default, a fixed 16 MiB; GLib's tools grow.
- **Sharing.** The page compiles `ibus-runtime.wasm` once and sends the `WebAssembly.Module` to each Worker. Each Worker
  instantiates its own copy with its own memory.

### 5.4 Engine side modules

#### 5.4.1 Contents

Built with `-sSIDE_MODULE=1`: the engine glue plus the engine's private libraries, statically linked. Shared libraries
between engines (such as MARISA, which the table engine and Rime both use) stay private to each engine in v1.

#### 5.4.2 Patch layers

Engine builds are overrides of nixpkgs recipes (§10.3); our patches go after nixpkgs' own. Each engine keeps two ordered
series:

- `patches/port/`: build system, startup (§5.4.3), removal of D-Bus-only code paths, and fixes for engine bugs exposed
  by the runtime lifecycle (such as stale settings callbacks after destruction). Expected to stay small.
- `patches/casts/`: function-pointer fixes that `pkgsWasm.glib` cannot absorb. Removable as a unit if a toolchain-level
  fix ships.

Both layers target minimal diffs that upstream engines could accept, since the code involved is undefined behavior on
every platform.

#### 5.4.3 Startup

Engine `main()` functions connect to the bus, create an `IBusFactory`, add engine types and call `ibus_main()`. The port
layer replaces `main()` with an exported `ibusweb_module_init(IBusWebModule *)` that runs the same registration, usually
by calling the engine's existing init functions (for example `ibus_hangul_init(NULL)`). Hangul then creates an
`IBusFactory`, adds its engine GType under `hangul` and releases its own factory reference; the runtime registry retains
it. Module shutdown is not implemented.

#### 5.4.4 Manifest

Generated by `ibusWeb.engines.mkEngineManifest` from the package, data closure, runtime exports and `dylink.0`. Package
versions and licenses come from Nix metadata; ABI and protocol numbers come from the build. The final `ModuleManifest`
schema is:

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
  data?: string[]; // store paths from the module's data, installed before the engine is first made
};
```

`memory` is bytes in whole 64 KiB pages within runtime bounds, and `threads` is a nonnegative integer. `name` matches
`[A-Za-z0-9][A-Za-z0-9._+-]*`, since it becomes a directory (`/engines/<encodeComponent(name)>`) and database name and
must be one path component that can't climb out of its parent or hide itself. `version`, `license` and every URL are
non-empty, and `engines` lists at least one engine, the first being the module's default, with non-empty and unique
names and non-empty display names. Unknown keys are rejected at every level, so a misspelled field fails rather than
reading as missing. `runtimeAbi` must match `IBUSWEB_RUNTIME_ABI` and `protocol` must match `PROTOCOL_VERSION`;
mismatches fail startup before runtime initialization. Full library ABI identity remains pending (§5.3). Distribution
`version` is `<upstream-version>+nix.<output-hash>`: the Nix distribution output identity covers its recipe and inputs,
including the runtime, protocol, module, schema/data closure and manifest metadata. The same build retains its version;
changed inputs get a distinct data-cache and lock namespace even when the upstream version is unchanged. This is a Nix
build identity, not a hash computed from the final archive bytes. Authored manifests must also change version when their
distribution changes.

Module `size` is fetched byte length; data `size` is unpacked regular-file bytes. Data paths are unique
`/nix/store/<hash>-<name>` roots, and `settingsSchemaDir` must be canonical (no empty, `.` or `..` component) and lie
inside one. `heapBytes` is build/check metadata. Schema IDs are a string array; source-release assets are outside this
manifest's current interface. Each engine's `keyboard` is required. Its `layout` selects how the page translates keys
(§7.1.1), and `passThrough` lists keysym names the page never sends to the engine; the page rejects a manifest that
names an unknown keysym. Hangul declares `us` with an empty list. `settingsMetadata` points to the engine's generated
`settings.json` (§7.1.4), with its size.

`HostInit` carries either `manifest` or `manifestUrl`, replacing separate engine, memory and side-module fields. For a
fetched manifest, relative module and archive URLs resolve against its URL. The host decodes it before planning storage,
fetching the module or creating the runtime.

### 5.5 Worker host

TypeScript on Effect 4. Loaded by URL as its own file, never inlined into the page bundle (§9.2).

1. Receives the compiled runtime module, the SAB and the manifest by `postMessage`.
2. Builds the Worker's resources in nested scopes (below): probes IndexedDB and takes the engine's writer lock if it is
   free, makes the runtime's memory at the manifest's size (§5.3; more without IndexedDB, §5.6) and instantiates the
   runtime with it and with `ibuswebEngineThreads` set to the manifest's `threads`, so Emscripten starts the pool with
   the engine's share in it (§5.3), starts the wake relay (§5.2.4), mounts storage, installs the data files unless they
   are there and lets go of old versions' (§5.6), mounts the version's data at `/nix/store`, and sets
   `GSETTINGS_SCHEMA_DIR` to the manifest's `settingsSchemaDir` with the runtime's `setenv` before any `Init`, since
   GLib caches its schema source on the first lookup.
3. Posts `ready` and enters the request loop. On the first successful `Init`, dispatch applies its settings snapshot,
   then the host loads the module and calls `ibusweb_module_init`, pumps and drains, and only then publishes the reply.
   Other requests before Init return `-ENOTCONN`. A module load failure is a crash with reason `LOAD`. Restart follows
   the same path. Between requests the host waits with the pump deadline.
4. Wraps every dispatch and pump in a handler for WASM traps (§8).

The host grows the thread pool past its start in the top-up (§5.3), through Emscripten's `PThread`: it creates each
Worker, loads the runtime into it, and keeps it out of the pool's free list until it has loaded, since Emscripten hands
out any free Worker, loaded or not, and a thread on one that hasn't loaded would wait for the host's event loop. A
top-up that hasn't finished within 10 s is a host error.

Failures the host must report, beyond traps in its own calls:

- **A thread traps.** Emscripten marks the runtime crashed and wakes the host, whose call into the runtime then throws
  `"unwind"`; the thread's own error reaches the host only afterwards, through its event loop. The host writes a
  `Crashed` record saying only that a thread crashed, then `CRASHED`, at once, then waits briefly for the thread's error
  and reports it in its `crashed` message (§8).
- **The relay fails.** A host asleep in the runtime never hears the relay's `error` event, so the relay catches its own
  failure, writes `CRASHED` and bumps both wake words. A relay killed without running its own code is silent to a
  sleeping host; the page's hang detection (§8) is the backstop.
- **An engine throws a C++ exception.** `ibusweb_dispatch` returns `-ECANCELED` (§5.2.3). The runtime is unusable, so
  the host reports a crash (§8), as for a trap, after draining the records already written and publishing the reply.
- **Startup fails.** A failed `WebAssembly.instantiate()` inside Emscripten's `instantiateWasm` hook, which Emscripten
  never hears of, fails the host's startup rather than leaving it waiting.

#### 5.5.1 Resource scopes

Scopes open in this order and close in reverse:

| Scope                                                              | Acquire                                                                                              | Release on normal close                                                                              | Release after a trap                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Worker                                                             | SAB views, `Logger` layer                                                                            | final `Log` records flushed                                                                          | crash record written                                                               |
| Planned storage                                                    | IndexedDB probe, Web Locks (the writer lock `ifAvailable`); sizes the memory, which can't grow later | every lock let go                                                                                    | every lock let go but a sealable backend's writer lock, held until the Worker ends |
| Runtime                                                            | instantiate `ibus-runtime.wasm`                                                                      | none (freed with the Worker)                                                                         | none                                                                               |
| Wake relay                                                         | start the relay Worker (it bumps a word in the runtime's memory, so it follows the runtime)          | relay terminated                                                                                     | relay terminated                                                                   |
| Storage                                                            | WasmFS mounts, data install                                                                          | backends sealed; their threads and connections end with the Worker (WasmFS never destroys a backend) | skipped; the connections close when the Worker ends                                |
| Engine module                                                      | load side module, `ibusweb_module_init`                                                              | none (no shutdown ABI)                                                                               | skipped                                                                            |
| Engine instance (one per input context, child of the module scope) | `CreateEngine`                                                                                       | `DestroyEngine` (`g_object_unref`)                                                                   | skipped                                                                            |

- **Instances left open at shutdown.** Closing the host with the runtime intact dispatches `DestroyEngine` for each open
  instance, then pumps up to eight rounds, stopping once nothing is due at once, so work the engines' finalizers queued
  runs without chasing a source that keeps itself due. It drains what that wrote and rings the doorbell (§6.2.3) if it
  wrote records, since they belong to no request.
- **Finalizers inspect the `Exit`.** After a trap or fault the WASM heap cannot be trusted, so finalizers that call into
  the runtime run only when no call into it threw (a trap is recognised by where the error came from, not its type);
  JS-side cleanup and crash reporting always run.
- **Nothing depends on finalizers for correctness.** A hang ends in `worker.terminate()`, which runs no finalizers; the
  IndexedDB connections live on the storage backends' threads, pool Workers nested in the engine's Worker, and the
  browser closes them when it ends. Emscripten side modules are not actually unloaded, so the module scope is
  bookkeeping; the Worker is the unit that frees memory.

#### 5.5.2 The request loop and the Effect runtime

The request loop is a single synchronous section inside the scoped program. A thread asleep in `ibusweb_wait` runs no
other fibers, so nothing in the Worker may rely on concurrent fibers or Effect timers while the loop runs; GLib time is
handled by the wait timeout (§5.2.4). Engine-instance scopes are opened and closed synchronously from the loop as
`CreateEngine` and `DestroyEngine` arrive.

The loop leaves its synchronous section for one thing: a pool top-up (§5.3), which runs only while no request is
pending. The host creates the missing Workers and sleeps with `Atomics.waitAsync` on the wake word, its event loop
running, until they have loaded, serving requests and pumping meanwhile, then returns to `ibusweb_wait`. Threads that
end unjoined don't need the event loop: the toolchain's Emscripten patch reclaims them inside `ibusweb_wait` (§10.3).
Should that patch be dropped, the fallback is a brief, periodic return to the event loop while idle.

#### 5.5.3 Logging

The Worker's `Logger` layer writes best-effort `Log` records with `seq = ic = 0` into the output ring, without waiting
for space. GLib's log writer emits runtime-sequenced `Log` records through the runtime output buffer. The page re-emits
them through its own loggers with engine and domain annotations (§7.4).

### 5.6 Storage

- **Filesystem.** WasmFS with our own IndexedDB backend. An engine's own files (Mozc's user dictionary and history,
  Rime's user dictionaries, deployed data and user YAML) are mounted at `/engines/<name>/` (the name encoded as one path
  component), and its installed data at `/nix/store`. The host installs data-only store-path closures there and sets
  `GSETTINGS_SCHEMA_DIR` to the manifest's schema directory before any Init, retaining the paths compiled into the
  module. GSettings values are not stored here; the settings bridge hands them to the page, which persists them (§5.2.5,
  §7.1.4).
- **The backend.** Files are stored as chunks whose IndexedDB values are `ArrayBuffer`s copied out of WASM memory, never
  views of it and never `Blob`s, and read and written lazily, a chunk at a time. IndexedDB is asynchronous, so each
  backend serves calls on a thread of its own, from the pool, to which WasmFS proxies them, as WasmFS's OPFS backend
  does. That thread runs an event loop, which IndexedDB's callbacks need, holds the backend's connection and lasts as
  long as the runtime; a host mounts two backends (the engine's own files and its data), so the storage share of the
  thread pool is 2 (§5.3). Emscripten's WasmFS has no IndexedDB backend; ours is written in C++ after the OPFS backend's
  shape, lives in the repository as the runtime part `runtime/wasmfs-idb/` (compiled against the patched Emscripten's
  WasmFS headers, with an Emscripten JS library), and is a candidate for upstream
  (`docs/upstream/wasmfs-idb-backend.md`). Its API, `ibus-web/wasmfs-idb.h`, is the `wasmfs-idb` section of the
  runtime's export list (§5.3), so side modules can't reach its internals:
  - `wasmfs_create_idb_backend(database, flags)` opens the database, creating it if needed, and returns a backend whose
    root is the database's root directory, or `NULL`, with the cause on stderr. It is called off the browser's main
    thread. `WASMFS_IDB_READ_ONLY` makes every change fail with `EROFS`.
  - `wasmfs_idb_backend_seal(backend)` makes a backend read-only in place: every change started after it fails with
    `EROFS`, descriptors already open for writing included; only the last close of a file unlinked before the seal still
    deletes what it stored. It makes nothing durable; `fsync()` first.
  - `wasmfs_idb_backend_closed(backend)` says whether the backend's connection has closed (below). It is an atomic load,
    cheap whatever the backend's thread is doing.
- **Layout.** One database per mount, at version 1, with four object stores:
  - `meta`: `format` (1), `chunkSize` (fixed when the database is created), `nextIno`, `root` (the root's inode, 1), and
    `installed`, the installed data's marker, which the host writes and the backend never reads;
  - `inodes`, by inode number: kind (file, directory or symlink), mode, size, access, modification and change times in
    milliseconds, and a symlink's target;
  - `entries`, by `[parent, name]`: the child's inode number;
  - `chunks`, by `[inode, index]`: at most a chunk's bytes. A missing chunk reads as zeros, so files may be sparse, and
    no chunk holds bytes past its file's size, so a file truncated and grown again never shows its old bytes.

  An operation that touches more than one record is one transaction. File sizes go up to 2^53 − 1 bytes, the largest a
  JavaScript number holds exactly; beyond that is `EFBIG`. An unlinked file stays readable while open; its inode and
  chunks go at its last close. Inodes no directory holds, which a page that ended with a file unlinked but open leaves,
  are swept, in one transaction, when a read-write backend is created; a read-only one doesn't sweep. A sweep that fails
  is logged and the backend mounts anyway, unless it failed because the connection closed, which fails the open.

- **Chunk size.** 16 KiB for the databases the backend creates; a database keeps the size in its `meta`, and any
  positive size there is read, larger ones included. 16 KiB is the cheapest chunk for the random 4 KiB read that lookups
  make, in both browsers (`docs/storage.md`, "Chunk size"). A chunk is at most 63 KiB, checked against the default at
  compile time: Chromium stores a value whose serialized form exceeds 64 KiB as a `Blob` of its own, which costs two to
  three times as much to read or write, and the margin covers the serialization's own bytes. Firefox keeps values in its
  database far beyond that (one of 768 KiB stayed; one of 896 KiB went to a file).
- **Writes and `fsync`.** A read gets only the chunks it covers. Writes are write-through: each `write()` is one
  read-write transaction, with the browser's default durability, that reads only the chunks it partly overwrites, and
  has committed before it returns. `fsync()` and `fdatasync()` are the durability barrier: a read-write transaction over
  the file's stores with `{ durability: "strict" }` that puts the file's inode record back as it is, and returns once it
  completes. A strict commit makes every earlier change to the database durable, but only if it writes: counted under
  `strace`, an empty strict transaction syncs nothing to disk in either Chromium or Firefox, and one that puts a record
  syncs once. `fsync()` on a backend created read-only commits nothing. WasmFS flushes only regular files, so `fsync()`
  on a directory does nothing, and a rename or a new directory entry has no barrier of its own: it is durable once a
  later `fsync()` of any file in the same database completes.
- **Errors.** IndexedDB's `QuotaExceededError` is `ENOSPC`, with nothing changed, since the operation's one transaction
  aborts; `ConstraintError` is `EEXIST`; `ReadOnlyError`, the read-only flag and a seal are `EROFS`; a closed connection
  (`InvalidStateError`, `VersionError`, the `AbortError` of the transactions a close aborts) is `EIO`; anything else is
  `EIO`, logged. A lookup in a closed database is `EIO` too, never `ENOENT`, since callers take `ENOENT` for leave to
  create a file or fall back to defaults. WasmFS reports any failure to make a symlink as `EPERM`, and any failed lookup
  as `ENOENT`, without the toolchain's patches 0017 and 0019, which carry the backend's errno (§10.3).
- **Why IndexedDB.** In Firefox a Worker reads a `Blob`'s bytes (an OPFS `File`, a `Blob` value in IndexedDB, a cached
  `Response`) only while the page's main thread is free, so under the keystroke spin (§6.2.6) every such read waits out
  the budget and replays; `ArrayBuffer` values come back with the `get()` itself and never wait, nor do opening a
  database, writes and their commits. Nothing in IndexedDB takes an exclusive lock: read-only transactions run side by
  side across Workers and tabs, and one over a store a read-write transaction holds waits for its commit rather than
  failing. Through the backend, with 16 KiB chunks, a random 4 KiB read costs 0.12–0.16 ms on the calling thread and
  0.2–0.32 ms of a keystroke, and no read or write waited for the page's spin (`docs/storage.md`, "What it costs").
- **Not OPFS.** Its synchronous access handles, the one OPFS read path that doesn't wait for the page in Firefox, take
  an exclusive lock on the file across the origin in Firefox (and, by the standard, Safari; only Chromium has shared
  read-only handles), so a second tab or engine instance couldn't open the same data; WasmFS's OPFS backend reads files
  opened read-only through `Blob`s. **Not ZenFS**: its IndexedDB support plugs into Emscripten's legacy JavaScript file
  system rather than WasmFS, its synchronous path loads everything up front, and it is LGPL-3.0. **Not IDBFS**: it
  belongs to the legacy file system too, and syncs whole trees between memory and IndexedDB.
- **Version changes.** Adding or removing object stores, or deleting a database, waits until every other connection
  closes, so every connection the runtime and the host make closes on `versionchange`. The backend's thread hears it
  from its event loop, sets the backend's closed flag, logs why, and fails every later call with `EIO`; nothing reopens
  the connection. The host checks `wasmfs_idb_backend_closed()` for both mounts each time it wakes and reports
  `storage: closed` (§8). Installing a version deletes its data's database first, a version change with no connection to
  close, since no host mounts a version before its marker exists (Installing, below).
- **The page keeps out.** The page opens no transaction on an engine's databases. A transaction commits on the thread
  that made it, so one the page made and hadn't seen commit when it began to spin held up the backend's writes to the
  same store until the spin ended (in both browsers). With §9.2, the page reaches the engine's storage only through the
  protocol.
- **One writer.** Readers never block one another, but two writers would interleave writes to one file, and each
  writer's sweep would take the other's open, unlinked files. Before it creates the backend for the engine's own files,
  the host requests the Web Lock `ibus-web:writer:<name>` with `ifAvailable` and holds it for the Worker's life. The
  instance holding it mounts the engine's files read-write; every other one mounts them with `WASMFS_IDB_READ_ONLY`,
  which skips the sweep, and the host receives a `storage: read-only` event (§8). Hosts don't queue for the lock: a
  backend can't become writable, so a host that starts read-only stays so, and the page restarts it to get a writer.
- **Restarts.** Chromium lets go of the locks of a Worker terminated while it sleeps in `Atomics.wait()`, as the host
  does between requests, some 2 s after `terminate()`; Firefox at once. A host started in between would find the writer
  lock taken and run read-only for good. So the page, having terminated a host that didn't report `storage: read-only`,
  waits for the engine's writer lock to come free before starting the engine's next host, with a queued request it lets
  go of at once, bounded at 10 s, after which another tab holds the lock legitimately. A host that dies without the page
  terminating it (its renderer out of memory, its Worker crashing) gets no such wait, so in Chromium a restart within
  those 2 s may come up read-only.
- **Data files.** Read-only engine data (m17n-db, Hangul Hanja tables, Rime's prebuilt schemas) is fetched as archives
  listed in the manifest, installed once per version, all at start or, for the archives an engine names as its own,
  before that engine is first made, and read lazily like any other file. Archives are Brotli-compressed POSIX ustar, one
  per data-only store path in the side module's reference closure, minus the module's own output. Engines keep the store
  paths compiled by Nix rather than being patched to FHS paths. `mkEngineManifest` writes `<hash>-<name>.tar.br` with
  entries named from `/nix/store` (`<hash>-<name>/…`, or the bare file for a store path that is a single file), Brotli
  quality 11 and the standard window, no `--large_window`. Hard links, which store optimisation makes of identical
  files, are stored as files (`--hard-dereference`); symbolic links are kept, and the build fails if one in the closure
  resolves outside it, or if its target exceeds ustar's 100 bytes. Serve opaque bytes without `Content-Encoding: br`, so
  fetch cannot decode them first; a decoding failure's message says so, while a failure of the body itself (the network,
  an abort) passes through as it is. The host feature-detects `DecompressionStream("brotli")` by construction; otherwise
  it imports, by URL from beside its own script, a separate streaming `brotli-dec-wasm` bundle (291 KB) with its WASM
  embedded by Rolldown's binary loader. Native installations load no decoder bundle, and the fallback needs no external
  WASM fetch. Plain ustar with `encoding: "identity"` serves test fixtures. Decompressed bytes are re-cut into at most
  64 KiB pieces and passed to the bounded C extractor in `libibus-web` (`ibusweb_install_begin`, `_set_limit`, `_feed`,
  `_end`, and `_count`, the files and bytes written) that writes through the mounted file system, so the stored layout
  has one writer. It takes regular files, directories and symbolic links (`SYMTYPE`, the target kept unresolved),
  refuses hard links (`LNKTYPE`) with `EOPNOTSUPP` and absolute paths and `..` with `EINVAL`, never writes through a
  link, gives every entry the archive's mode (its owner can always read and write it, and search a directory), sizes
  each regular file from its header before writing its data, so that a file in memory is allocated once at its size, and
  `fsync()`s each file it writes. Each archive is extracted at the root of the data mount; the host follows its ustar
  framing as it streams and refuses an entry outside the archive's own store path before the extractor sees it, so no
  archive can replace another's files. The extractor uses `tar.h` constants and an explicitly checked ustar header
  layout. The host checks the unpacked regular-file byte count against manifest `size` before marking the install
  complete. Before the first feed, it sets the extractor's uint64 limit from `size` (a JavaScript `bigint` at the WASM
  boundary). Each regular member is refused with `-EFBIG` before creating/sizing its file if it exceeds the remaining
  budget. Metadata, tar padding and decoder buffers are outside this limit; it is not a total-memory or quota bound.
  Low-level callers that omit `_set_limit` retain the unlimited default.
- **A database per version.** Each version's data is a database of its own, `ibus-web/<name>/data/<version>`, apart from
  the engine's own files (`ibus-web/<name>`) and from every other version, so installing one never touches another in
  use. The engine's name and version are encoded in every database and lock name (`encodeURIComponent`, with `!'()*.~`
  also escaped), so neither holds `/` or `:` and neither is `.` or `..`; a manifest without a version fails the start.
  The data database mounts at `/nix/store`, with `/nix` created in memory, separate from user files at
  `/engines/<name>`. The version still installs its entire closure into its own database; sharing content-addressed
  paths across versions and engines is future work (`docs/known-gaps.md`). Three Web Locks per engine:
  - `ibus-web:data:<name>:<version>`, shared, held by every host using that version for its life, and the first lock a
    host waits for;
  - `ibus-web:install:<name>:<version>`, exclusive, for deciding and installing; versions install independently;
  - the writer lock, which covers the engine's own files only. Every host installs a missing version, writer or not.
- **Installing.** At engine start, before the engine accepts requests, the host takes the version's data lock and then
  its install lock, and reads the version's marker, `meta.installed` = `{ version, files, bytes }`, on a short
  connection that doesn't create the database, before mounting anything of that version. With the marker, it mounts the
  version with its install window shut (below). Without it, it deletes the version's database (a deletion still blocked
  after 10 s fails the start), mounts a backend over a new one with its window shut, opens the window, extracts every
  base archive into it, shuts the window, and writes the marker last in a strict transaction on a connection of its own.
  Every host keeps the one data backend it mounted, since a backend's thread lasts as long as the runtime, and seals it
  only as it closes, since any host may later install an engine's own data into the version. Then it lets go of the
  install lock. So an install starts from empty storage, and no partial tree, no other version's file and no stale one
  survives it; no host reads a version before its marker exists, so the deletion has no reader to wait for; an
  interrupted install leaves no marker and the next host redoes it; a second host waiting on the lock finds the marker
  and mounts. The host reports how it found the data in an `install` message: `state` (`installed`, or `present` when
  the marker was there), the `version`, the `files` and `bytes` the marker records, how long it waited for the install
  lock (`lockWaitMs`), when it took and let go of it (`lockedAt`, `releasedAt`, in `Date.now()` milliseconds, which
  hosts share) and `installMs`, from its first lock request to the report. A memory mount installs at every start, with
  no lock.
- **An engine's own data.** An engine descriptor may name store paths of the module's data as its own (`data`, §5.4.4).
  Those archives are lazy; the rest are base data, installed at start as above. Each lazy path gets its own marker,
  `meta.paths/<storePath>` = `{ files, bytes }`, in the version's database. Before the page first makes such an engine
  in a Worker, it sends `PrepareEngine { engine }`, outside the ring and the request loop, as installing is. The host
  takes the version's install lock, reads the engine's lazy paths' markers and, for each missing one, removes whatever
  an interrupted install left under the path, opens the install window, streams and extracts the archive with the checks
  above and its own `size` limit, writes the marker in a strict transaction and shuts the window; it reports progress
  and an `install` report per path, and lets the lock go. With every marker present it does nothing. A host that mounted
  the version before another Worker installed a path finds it by lookup: WasmFS caches the entries it has found, never
  an entry's absence. A memory mount installs every archive at start, since its memory is sized then.
- **The install window.** Since any host may later install a lazy path, the data backend can't be sealed for good.
  `wasmfs_idb_backend_set_writable(backend, writable)` gates it instead: a change while it isn't writable fails with
  `EROFS`, as a sealed backend's does. The host makes it writable only while it holds the version's install lock and
  runs the extractor. This is a weaker guarantee than the seal: while the window is open, an engine thread in the same
  Worker could write under `/nix/store`. None does, and the window lasts one archive's extraction. The engine's own
  files keep the one-way seal and the writer lock.
- **Old versions.** Once it has installed or found its version, the host lists the engine's other versions
  (`indexedDB.databases()`, which is why the minimum Firefox is 126, §10.3) and, for each, requests its data lock
  exclusively with `ifAvailable`; granted, no host uses that version, and none can start to until the lock is let go, so
  it deletes the database. This is best-effort and never fails the start: the host reports it in a `collect` message,
  the encoded versions it deleted (`removed`), those another host still uses (`inUse`) and, if it couldn't list or
  delete, why (`error`).
- **Waiting for locks.** A host waiting for the data or install lock gives up, failing its start, after 120 s. The
  installer says it is still going every second throughout the install lock's lifetime during asynchronous bootstrap, on
  a `BroadcastChannel` named after that lock. The timer spans asynchronous setup, fetch/decode, marker commit and
  sealing, starts at lock acquisition and stops before release; synchronous calls or OS starvation can delay it. It
  never runs in the synchronous request loop, and each word starts a waiter's 120 s over, so a long install holds no one
  up for good. An archive that sends nothing for 30 s fails its installer's start, which lets go of the lock. In Firefox
  the response body waits while the page spins (§6.2.6), which only delays startup, since installing is off the request
  path.
- **Failed starts.** The host keeps every lock it holds in one set, and a start that fails, or a runtime that crashes
  after it, lets go of them all, so a failed host never keeps others from installing, collecting or writing; it stays
  alive to report. Its runtime, and any engine thread already started, may still write through its read-write user
  backend, so it seals that backend before letting go of the writer lock; a runtime that can no longer be called to seal
  it keeps the writer lock until the page terminates the Worker. A host that dies outright (its Worker crashing, its
  renderer out of memory) has no chance to seal; it relies on its locks going only with the Worker, and on the runtime's
  threads, nested Workers the host started, being torn down with it, so that none is left writing once another host can
  become writer.
- **Fallback.** A browser lacks IndexedDB only for an opaque origin (a sandboxed iframe without `allow-same-origin`, a
  `data:` URL, where `indexedDB.open()` throws `SecurityError`), where the user or an enterprise policy blocks site
  data, or where a third-party iframe is denied storage. Private browsing has it in every browser at the Baseline floor,
  cleared when the session ends. The memory is fixed once made, so the host probes IndexedDB first, opening the engine's
  database without creating it and closing it at once. If that fails, the mount is in memory: the data files sit in
  WasmFS's memory backend, so the host makes the runtime's memory and its maximum larger than the manifest's `memory` by
  the data's size, the sum of the manifest's data sizes (unpacked bytes, §5.4.4) in whole pages (§5.3), and installs the
  data at every start, with no lock. That is enough for the files' contents, since the extractor sizes each file before
  writing it, so the memory backend allocates each file once at its size; per-file metadata (WasmFS's file objects and
  directory entries) comes out of the spare in the manifest's base memory. A memory that this takes past the runtime's
  maximum fails the memory check, a load failure (§8) whose message gives the size but not the data's part in it. User
  data then lasts only as long as the Worker, and the host receives a `storage: ephemeral` event (§8). A backend that
  fails to open after the probe succeeded is a load failure too, not this fallback: the memory has been made by then.
- **Node.** Node, where the runtime runs for tests, has no IndexedDB at all, and that is not this fallback: there
  `/engines/<name>/` is WasmFS's Node backend (`wasmfs_create_node_backend`) over `<dir>/user/` of a directory the Node
  host is given, and each version's data over `<dir>/data/<version>/`. The backend runs `fs.*Sync` on the calling
  thread, so nothing is proxied and no pool thread is taken, and works from pthreads under `worker_threads`; its limits
  (32-bit file sizes, `O_WRONLY` opening `"r+"`) don't matter to engine data. A version's marker is the file
  `<version>.installed` beside its directory, written as `<version>.marking`, synced and renamed over it, with the
  directory synced after; one that doesn't parse counts as absent, and removal deletes the marker first. The host takes
  the same locks and reports the same states, but the Node backend has no read-only mode, so neither a read-only mount
  nor a seal refuses writes there. Node hosts are for tests. Web Locks coordinate the threads of one Node process only,
  so two processes sharing a directory are not coordinated, and not reliably even those threads: Node can grant one
  exclusive lock to two `worker_threads` at once (`docs/upstream/node-web-locks-worker-threads.md`). Node hosts sharing
  a directory must therefore not be started concurrently.
- **Host API.** Usage report, export (a tar of the engine directory) and reset.

## 6. The Worker-boundary protocol

### 6.1 Messages

#### 6.1.1 Wire format

Messages are the methods and signals of IBus's `org.freedesktop.IBus.Engine` D-Bus interface, with payloads in GVariant
serialization, which is how IBus already puts `IBusText`, `IBusLookupTable` and `IBusProperty` on the wire. All
per-instance messages carry an input-context ID (`u`). The authoritative numbers, signatures and framing are defined by
`@ibus-web/protocol`'s schemas, from which `ibus-web/protocol.h` is generated: an eight-byte little-endian request
header (`u16 kind`, `u16 flags`, `u32 ic`), and a sixteen-byte record header (`u32 seq`, `u32 ic`, `u16 kind`,
`u16 flags`, `u32 len`, where `len` counts the payload only) with records padded to eight bytes. Requests must have
flags 0, and the runtime writes record flags 0; `CONTINUATION` is the only flag, set only by the host when it fragments
a record (§6.2.2). A request's payload is the normal form of its signature's tuple; the empty tuple `()` is one zero
byte, so every request carries at least one payload byte, and a request of the header alone is malformed (`EBADMSG`).
Requests have `FocusIn`/`FocusOut` only, without `*Id` forms. Protocol version is 1.

#### 6.1.2 Requests (page → Worker)

| Message                                             | Signature (after IC ID)        | Reply |
| --------------------------------------------------- | ------------------------------ | ----- |
| `ProcessKeyEvent`                                   | `(uuu)` keyval, keycode, state | `b`   |
| `FocusIn`, `FocusOut`, `Reset`, `Enable`, `Disable` | `()`                           | none  |
| `SetCursorLocation`                                 | `(iiii)`                       | none  |
| `SetCapabilities`                                   | `(u)`                          | none  |
| `PageUp`, `PageDown`, `CursorUp`, `CursorDown`      | `()`                           | none  |
| `CandidateClicked`                                  | `(uuu)` index, button, state   | none  |
| `PropertyActivate`                                  | `(su)` name, state             | none  |
| `SetSurroundingText`                                | `(vuu)` text, cursor, anchor   | none  |
| `SetContentType`                                    | `(uu)` purpose, hints          | none  |

`CandidateClicked`'s index is page-relative, as IBus's GTK panel sends it: the position of the clicked label on the
visible page, not an absolute candidate index. There are no `PropertyShow`/`PropertyHide` requests; a property's
visibility reaches the page in the engine's `UpdateProperty` records.

#### 6.1.3 Lifecycle and settings requests

| Message          | Payload                                                      | Notes                                 |
| ---------------- | ------------------------------------------------------------ | ------------------------------------- |
| `Init`           | protocol version, schema instances (id, path, stored values) | exact protocol-version match required |
| `CreateEngine`   | IC ID, engine name                                           |                                       |
| `DestroyEngine`  | IC ID                                                        |                                       |
| `SettingChanged` | path, key, `v`                                               |                                       |
| `Persist`        | none                                                         | ignores `ic`                          |

`Persist` has every module write what it keeps only in memory, through the persist function its init set
(`ibusweb_module_set_persist`): Rime's learning stays in an open user-dictionary transaction until the next key it
doesn't handle. The page sends it before it ends a Worker, and when it goes away or is hidden (§7.1.3).

#### 6.1.4 Output records (Worker → page)

`CommitText`, `UpdatePreeditText`, `UpdateAuxiliaryText`, `UpdateLookupTable`, `ShowPreeditText`, `HidePreeditText`,
`ShowAuxiliaryText`, `HideAuxiliaryText`, `ShowLookupTable`, `HideLookupTable`, `RegisterProperties`, `UpdateProperty`,
`ForwardKeyEvent`, `DeleteSurroundingText`, `RequireSurroundingText`, with IBus's signatures; plus
`SettingWritten (ssv)` (path, key, value) and `Log (uss)` (level, domain, message). `Crashed (us)` carries a reason and
message: `TRAP` 1, `FAULT` 2 (a request returned `-ECANCELED`), `RELAY` 3, `LOAD` 4, `HOST` 5; decoders reject any other
reason as a schema error, and a `Crashed` record with a nonzero `seq` or `ic` as a protocol error. Host-written `Log`
and `Crashed` records have `seq = ic = 0` and do not advance `replyOutSeq`; runtime sequence numbers skip zero on wrap.
Kind 0 is padding in both kind spaces, with `seq = ic = flags = 0`, and is discarded by the ring reader.

### 6.2 Transport

Each Worker has one **dedicated** `SharedArrayBuffer`, separate from its `WebAssembly.Memory`. The page never reads or
writes WASM memory.

#### 6.2.1 Layout

| Region         | Size (default) | Contents                                                                                                                                                                             |
| -------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Control header | 64 bytes       | `Int32` words: `state` (IDLE, REQUEST, REPLY, CRASHED), `reqSeq`, `reqLen`, `replyRet`, `replyOutSeq`, `ringWrite`, `ringRead`, `ringWaiting`, `doorbell`, `wake`, `reqMode`, `mail` |
| Request slot   | 64 KB          | one encoded request                                                                                                                                                                  |
| Output ring    | 256 KB         | framed records                                                                                                                                                                       |

The header's twelve words take 48 of its bytes, in table order. `reqMode` is `SYNC` 0, `ASYNC` 1 or `ABANDONED` 2,
written by the page with each request. Sizes are configurable per Worker; the slot and ring are multiples of eight
bytes, and the ring capacity is a power of two from 64 bytes to 2³¹, so it divides the unsigned byte counters' 2³² wrap
and a full ring never reads as empty. The generated `PROTOCOL.md` Transport section owns the layout and each word's
writer. Only the page bumps `wake`: it bumps and notifies it after each request, and after advancing `ringRead` while
`ringWaiting` is set (§6.2.2); the wake relay forwards it into WASM memory, where the host sleeps (§5.2.4).

#### 6.2.2 Records and back-pressure

- **Framing.** `seq` (u32), `ic` (u32), `kind` (u16), `flags` (u16), `len` (u32), then the payload, padded to 8 bytes.
- **Placement.** No framed record wraps. A tail shorter than 16 bytes is skipped by both sides. If at least 16 bytes
  remain but the next frame cannot fit, the host writes a kind-0 padding record with `len = tail - 16`. Free bytes are
  `ringBytes - ((ringWrite - ringRead) >>> 0)`.
- **No overwriting.** The page advances `ringRead` after copying a complete frame; a continuation's payload may be held
  privately while it waits for the remaining fragments.
- **Full ring.** The Worker host sets `ringWaiting` to 1, posts a doorbell, reads the wake word in WASM memory as
  `seen`, and checks both the free space and `ringWaiting` again. It calls `ibusweb_wait(seen, -1)` only if space is
  still short and `ringWaiting` is still 1; otherwise, or after waking, it starts over from setting `ringWaiting`, until
  the record is written. The `ringWaiting` check matters for partial reads: a page read that lands between setting the
  flag and sampling `seen` clears the flag with its wake already counted in `seen`, and later reads, finding the flag
  clear, bump nothing, so a sleep on `seen` would never end. It doesn't pump meanwhile: a wake from GLib's hook only
  prompts the re-check, and a request that lands meanwhile waits for the record to be written. The host sleeps in the
  runtime, not on `ringRead`, so calls other threads proxy to its thread still run (§5.2.4). The page, after advancing
  `ringRead`, clears `ringWaiting` if it was set and bumps and notifies `wake`, which the relay forwards; notifying is
  allowed on the main thread. Setting the flag before the re-check, reading `seen` before it too, and sleeping only
  while the flag still stands means space freed at any point is either seen by the re-check or announced by a wake. A
  relay failure during this drain is diagnosed synchronously as `RELAY`; a wait that traps is `TRAP`.
- **Fragments.** If a record's framed size exceeds free space, the host writes the largest fragment that fits, or waits.
  Every fragment but the last carries `flags = CONTINUATION` and at least eight payload bytes, a multiple of eight, so
  the next stays aligned and each makes progress; the unflagged final fragment carries the rest, which may be shorter.
  The host never shortens a fragment to fit before the ring's end: it pads to the end and writes the fragment at the
  start. Fragments keep the record's `seq`, `ic` and `kind`, and stay consecutive apart from padding. A write that finds
  the ring full reports `needBytes`, the least free space with which the next write publishes a fragment, counting any
  padding or skip before the ring's end. The reader concatenates payloads before `decodeRecord`. Counts and
  `replyOutSeq` are in records, not fragments.
- **Draining.** The host copies the runtime's whole output batch before writing any of it, since the peeked pointer
  lasts only until the next runtime call, and the full-ring wait is one: a call another thread proxies to the host runs
  inside it and can append a record, moving the buffer. It consumes the batch once every record is published;
  back-pressure cannot interleave a pump. `replyOutSeq` is the `seq` of the last runtime record the host published to
  the ring for the request, not the runtime's last appended sequence, so a record appended during a full-ring wait
  reaches the ring with the next drain, after the reply, and the reply doesn't count it.

#### 6.2.3 One ordered stream in each direction

- **Requests.** One request is in flight at a time; requests are processed strictly in order. All page → Worker messages
  use the request slot, including lifecycle ones, because the Worker never returns to its event loop after bootstrap.
- **Output.** All output, whether produced inside a request or by a timer pump, goes through the one ring. Records carry
  a Worker-wide sequence number, skipping zero on wrap, so a timer's output can never be reordered around a keystroke's.
- **Doorbell.** `{ type: "doorbell" }` tells the page to drain and check state. The host sends it after output from an
  idle pump or the pumps at shutdown, before a full-ring wait, or after publishing a reply whose `reqMode` is `ASYNC` or
  `ABANDONED`. It posts only when `Atomics.exchange(doorbell, 1)` returns zero; the page clears that word before
  draining, so suppressed notifications cannot hide earlier output.
- **Abandonment.** At its spin timeout the page compare-exchanges `SYNC` to `ABANDONED`, then rereads `state`. Either
  the host sees abandonment after setting `REPLY` and rings, or the page sees the already-published reply and completes
  it itself.

#### 6.2.4 Synchronous request (keystroke path)

Page:

1. Write the request, store `reqLen` and `reqMode = SYNC`, set `state = REQUEST`, then bump and notify `wake`.
2. Loop: drain available ring records into a pending batch. Stop when `state == REPLY` and every record up to
   `replyOutSeq` is drained; or when `state == CRASHED`; or when the time budget runs out.
3. On reply, set `state = IDLE` and apply the batch.

Worker:

1. Wake (through the relay) and find `state == REQUEST`; dispatch; pump; flush output to the ring (waiting on
   back-pressure as needed).
2. Write `replyRet` and `replyOutSeq`, set `state = REPLY`, notify.

#### 6.2.5 Asynchronous requests

Same protocol with `reqMode = ASYNC`, but the page does not spin: it waits for the doorbell. Every request other than a
synchronous key uses it: `Init`, `CreateEngine`, `DestroyEngine`, `SettingChanged`, focus, cursor-location and
surrounding-text updates, and the keys of async and manual surfaces (§7.2.2). They stay ordered with keys because the
router sends them through the same per-engine queue.

#### 6.2.6 Timeouts and the replay queue

- **Budget.** The page spins for at most 40 ms by default (configurable).
- **On timeout.** The Worker is marked busy. The timed-out key is consumed and kept with its original event, and so are
  later keys; the queue holds 64, the in-flight key included. The request still completes.
- **While an async request is pending.** Keys on a ready input context are consumed and queued the same way while
  another request, such as another surface's `CreateEngine` or a `SettingChanged`, holds the connection. Keys that
  arrive before their own context is ready are not captured; they keep their browser default. Sync, async and manual
  surfaces share one queue per engine.
- **Catch-up.** When the doorbell reports completion, queued keys are sent in order, asynchronously. Keys the engine
  declines are applied by the adapter's `replayKey` (§7.2.1).
- **Overflow or hang.** See §8.
- **Nothing the Worker does for a request waits for the page.** The page's main thread is busy spinning, and in Firefox
  some Worker operations wait for it: `new Worker()` called from a Worker returns, and a Worker reads a `Blob`'s bytes,
  only while the page's main thread is free. The design keeps both off the request path: threads run on a pool made in
  advance (§5.3) and storage reads `ArrayBuffer` values (§5.6). The pool's top-up creates Workers only while no request
  is pending; a request that lands during those calls (about 1 ms) costs at most a replay. Chromium depends on the page
  for neither.

### 6.3 `@ibus-web/protocol`

Effect Schema is the source of truth for the protocol. Three layers:

1. **GVariant values and bytes.** A tagged `GVariantValue` tree and a hand-written codec between `Uint8Array` and that
   tree for any signature, covering GVariant alignment and framing offsets for the types IBus uses. Exposed as a schema
   codec, `GVariantBytes(signature)`. It is the only byte-level code.
2. **IBus types.** `Schema.Struct`s over the tree for `IBusText`, `IBusAttribute`, `IBusAttrList`, `IBusLookupTable`,
   `IBusProperty`, `IBusPropList` and the key-event triple, each annotated with its IBus name (`ibusType`). A
   `serializable(name, fields)` helper covers the common framing (type name, `a{sv}` attachments, fields). Fields carry
   their GVariant type as an annotation, and full signatures are derived by walking the schema.
3. **Messages.** One `Schema.TaggedClass` per request and output record, annotated with its `kind`, combined into tagged
   unions.

The committed `protocol.h` and `packages/protocol/PROTOCOL.md` (names, signatures, field descriptions and message
framing) are generated from these schemas. Their `files:` checks detect drift. The document is in the package's `files`,
so every release carries it, including the generated SAB Transport layout.

The decoder accepts exactly GLib's normal form, as `g_variant_is_normal_form` judges it: it rejects nonzero padding,
invalid sizes and offsets, nonminimal offset widths, invalid booleans, invalid UTF-8 and NUL framing, invalid paths,
signatures and type strings, and nesting past GLib's depth limits. Accepted bytes re-encode exactly, with two
exceptions: JavaScript may lose NaN payload bits, and a zero-byte tuple whose members are all variable-size and accept
zero bytes, which GLib reads with every framing offset 0, re-encodes with those offsets written out (the empty `(ayay)`
as `00`). Tree dictionaries preserve order; schema records reorder integer-like keys.

Lookup tables are decoded lazily. The page's connection decodes records with `decodeRecordLazy`, which checks a lookup
table's envelope, metadata and array framing at once and keeps its own copy of the bytes. The table's `visible()` and
`page(index)` then decode only that page's candidates and labels, with the same strict decoder, offsets and nesting
limits. The panel asks for the visible page when the table arrives and for other pages only when they are shown. The
eager `decodeRecord` stays public.

Eager decoding of 500 candidates measured 1.01 ms median and 4.40 ms p99 under Node, over the budget (§11.7), which is
why decoding is lazy. Lazy decoding of the same framed record to its visible page of nine measured 0.086 ms median and
0.286 ms p99 (`nix run .#protocol-bench`). That figure leaves out the key's trip through the Worker and the ring, and
painting. AOT compilation of the schemas did not lower the eager median and is not used. Method and machine details are
in `docs/protocol.md`.

## 7. Page side

### 7.1 Router

#### 7.1.1 Key translation

- **`keycode`.** `event.code` → evdev code, generated from the evdev column of Chromium's `dom_code_data.inc` at a
  pinned revision (BSD-3-Clause; notice kept). IBus clients send the X keycode minus eight, which is the evdev code.
- **`keyval`, layout `default`.** From `event.key`: a single code point maps to itself in Latin-1, to a legacy keysym
  where the generated table has one, and otherwise to `0x01000000 + codepoint`, the rule `keysymdef.h` itself gives.
  Named keys go through a table from UI Events key values, in which `HangulMode` and `Lang1` are `Hangul` (0xff31) and
  `HanjaMode` and `Lang2` are `Hangul_Hanja` (0xff34).
- **Generated tables.** Keysym values and their Unicode mappings come from xorgproto's `keysymdef.h` at a pinned
  version, not from upstream `ibuskeyuni.c` (LGPL). The generator follows the file's own annotations: a one-to-one
  mapping is used in both directions, a more specific keysym for a character that already has one (`XK_KP_Space`) only
  from keysym to character, and a deprecated or unclear mapping never from character to keysym. Where names share a
  value, the first listed is canonical. The US table comes from xkeyboard-config. The notices live once in the
  repository's `NOTICES/` and `LICENSES/` (`MIT-open-group`, `HPND`, `BSD-3-Clause` and xkeyboard-config's own); packing
  a page package copies in the texts it needs.
- **`keyval`, layout `us`.** Computed from `event.code` with the US table, ignoring `event.key`. Letters follow IBus's
  rule: plain lower case, Shift or CapsLock upper case, both together lower case. For other keys Shift selects the
  second level, and NumLock the keypad's. This gives the keyvals Hangul's keyboards expect whatever the system layout
  is; on the desktop IBus switches the system layout for such engines instead.
- **`state`.** Shift, CapsLock (`LOCK_MASK`), Control, Alt (`MOD1_MASK`), NumLock (`MOD2_MASK`), Meta (`MOD4_MASK`,
  `SUPER_MASK` and `META_MASK`). `getModifierState("AltGraph")` sets `MOD5_MASK` and clears Control and Alt, which fixes
  AltGr on Windows. Releases add `RELEASE_MASK` and take the same path as presses (Rime's Shift toggle acts on release).
- **Never sent to the engine.** Keys on disabled surfaces, events with `isComposing` or `key === "Dead"` (the OS input
  method owns them), keys on the manifest's `passThrough` list, and every key until the Worker is ready and the input
  context's `CreateEngine` and `FocusIn` have succeeded. Registered hotkeys see every `keydown` except those on disabled
  surfaces, composing events and dead keys, so a hotkey works while an engine starts.
- **Layouts.** `us` follows physical key positions and `default` follows the characters the system layout produces.
  Neither detects the system layout. Other layouts, and dead keys, AltGr and shortcuts under them, are not tested
  (`docs/known-gaps.md`).

#### 7.1.2 Input contexts and focus

- Each attached surface is one input context with a router-assigned ID. An instance of the selected engine is created
  for it lazily, on first focus (`CreateEngine`).
- DOM `focus` and `blur` become `FocusIn` and `FocusOut`.
- **Preedit on boundaries.** Before `FocusOut` (blur, detach or an engine switch) and before `Reset` (a caret, selection
  or value change the page made, which the adapter reports), the router commits a visible preedit whose mode is `COMMIT`
  and clears it, in one adapter batch; a `CLEAR` preedit is only cleared. Native IBus clients do this, and engines rely
  on it: Hangul drops its composition on these boundaries without committing it, and sends Hanja candidates' preedit in
  `CLEAR` mode.
- **Capabilities.** `PREEDIT_TEXT`, `AUXILIARY_TEXT`, `LOOKUP_TABLE`, `FOCUS` and `PROPERTY`, less any text capability
  the adapter lacks, plus `SURROUNDING_TEXT` when the adapter supplies it. `SYNC_PROCESS_KEY_V2` is never set: replies
  are already ordered, and with it Hangul would consume every key and forward the ones it doesn't use, where now a
  declined key simply keeps its browser default.
- **Content type.** `type`, `inputmode` and `autocomplete` map to IBus purposes and hints, sent before `FocusIn`.
  Password inputs, and surfaces with `autocomplete` `current-password` or `new-password`, never focus their engine
  instance, so every key passes through.
- The caret rectangle, in viewport coordinates, is sent as `SetCursorLocation` whenever it changes.
- **Surrounding text** is sent on `FocusIn`, after commits and consumed keys, and on `RequireSurroundingText`, each time
  only if text, cursor or anchor changed. The window is ±1000 code points by default (configurable). Offsets are in code
  points on the IBus side, including `DeleteSurroundingText`'s, and converted to the adapters' UTF-16 units at the
  boundary.

#### 7.1.3 Engine selection

- A module is one engine distribution: one manifest, one side module, one Worker. An engine is one input method inside
  it, created with `CreateEngine{name}`.
- One active engine for the page, with composition state per input context, matching IBus's shared-input-method default.
  A per-context override API exists and can name an engine.
- Switching sends `Disable` and `FocusOut` to the old instance, then creates or reuses the new one and sends `Enable`
  and `FocusIn`. Switching engine within a module reuses its Worker: the old engine is destroyed and the new one created
  in the same input context.
- `deselect()` returns every surface to plain browser input; Workers stay loaded.
- A hotkey registry exists with no default bindings.
- A Worker starts when its module is first selected and stays loaded until the host calls `unload(module)` or disposes
  the library.
- Ending a Worker runs none of its engines' finalizers, so before the page ends one, and whenever it goes away
  (`pagehide`) or is hidden (`visibilitychange`), it sends each ready Worker `Persist` and, with the wire free, waits up
  to the hang timeout for the reply, so that the engines have written their state before the browser ends the Workers.

#### 7.1.4 Settings API

Per engine: list its schemas and keys, get, set and reset values, and a stream of changes, including those the engine
writes itself. `SettingsApi` offers `schemas(module)`, `get`, `set`, `reset` and the `changes` stream; the facade offers
the first four as Promise methods.

- **Metadata.** Each key's schema paths, GVariant type, default, description, range and choices come from the engine's
  `settings.json`, which the page fetches through the manifest's `settingsMetadata` (§5.4.4). A build-time tool,
  compiled to WASM against `pkgsWasm.glib`, writes it by asking GLib about the compiled schemas, so nothing parses
  schema XML or GVariant text, at build time or in the browser. A relocatable schema lists the paths the build declares
  for it, and fails the build without any. A key carries only what its schema declares: Hangul's `keyboard` is a plain
  string, so it has no choices.
- **The source service.** Storage sits behind `SettingsSource`: `snapshot` supplies `Init`'s values, `written` receives
  the engine's writes, and a stream carries outside changes to live Workers. Optional `register`, `write` and `read`
  hooks give a persistent source the metadata, the page's own changes and single-key reads. A source with only the first
  three is an in-memory one.

- **Default persister.** The page keeps settings in an IndexedDB database of its own, `gsettings`, shared by every
  engine (engines share schemas such as `org.freedesktop.ibus.panel`). A record is keyed by its schema's path and its
  key, as dconf keys values. Its value is the GVariant type string and the value's serialized bytes, as an `ArrayBuffer`
  (never a `Blob`, §5.6).
- **Not the Worker's.** The Worker host never opens this database: IndexedDB completes requests through an event loop,
  which a host serving requests never returns to, and the settings UI needs values while no engine runs.
- **Starting a Worker.** Before it starts a Worker, the page reads the keys of each of the module's schema instances and
  sends every instance, with its stored values, in `Init`.
- **Changes.** On a `SettingWritten` record, or a change through this API, the page writes the value, sends
  `SettingChanged`, with the path, to its other live Workers whose modules declare that schema at that path, and
  announces `{ schemaPath, key, type, bytes }` on `BroadcastChannel("ibus-web:gsettings")`, with the bytes in GVariant
  normal form, or `null` for a reset. Other tabs forward the change to their own Workers without writing or announcing
  it again.
- **Defaults aren't stored.** A value byte-equal to the key's default deletes its record, as a reset does, so a later
  release that changes the default reaches users who never chose otherwise.
- **Concurrent writers.** The last write to a record wins. Live tabs follow the last announcement they received, and the
  next `Init` reads the database.
- **Replaceable.** The persister is a service. A host that keeps settings elsewhere, in its own user profile or on a
  server, replaces it with a layer (§7.4) or a facade option, and supplies the snapshot and stores changes itself.

### 7.2 Surface adapters

#### 7.2.1 Contract

```ts
interface SurfaceAdapter {
  readonly element: HTMLElement;
  capabilities(): { preedit: boolean; auxText: boolean; lookupTable: boolean; surroundingText: boolean };
  contentType(): { purpose: number; hints: number; disabled: boolean };
  surrounding(window: number): { text: string; cursor: number; anchor: number } | undefined;
  caretRect(): DOMRect | undefined;
  batch(apply: () => void): void;
  commit(text: string): void;
  deleteSurrounding(offset: number, count: number): void;
  setPreedit(preedit: Preedit | undefined): void;
  replayKey(event: KeyboardEvent): boolean | void;
  forwardKey(key: { keyval: number; keycode: number; state: number }): void;
  onReset(listener: () => void): () => void;
}
interface Preedit {
  readonly text: string;
  readonly cursor: number;
  readonly attributes: readonly { type: number; value: number; start: number; end: number }[];
}
type KeyResult = "consumed" | "passthrough";
type AsyncKeyResult = "consumed" | "replayed" | "passthrough" | "cancelled";
```

Offsets are UTF-16 code units. `batch` runs its callback synchronously; an editor maps a batch to one transaction, and
so one undo step. `onReset` reports caret, selection and value changes the router didn't make. `forwardKey` performs a
key an engine forwards (`ForwardKeyEvent`), where `replayKey` performs one the engine declined, and returns false when
it was a shortcut whose browser action the adapter could not perform.

#### 7.2.2 Rules and attachment modes

- **Attaching.** `attach(adapter, { keyMode })` returns a detach function. `keyMode` is chosen per surface, and the
  three modes share one router and one key queue per engine:
  - `sync`, the default: the router listens for `keydown` and `keyup` in the capture phase on the adapter's element and
    runs the keystroke path synchronously (§4.2). Capture-phase listeners on ancestors still run first.
  - `async`: the router listens the same way but sends keys with `keyAsync`.
  - `manual`: the router handles only focus, blur and resets, and the editor captures keys itself and calls `keyAsync`.
- **Consuming a key.** A consumed synchronous key gets `preventDefault()` and `stopPropagation()` before the listener
  returns; a declined one keeps its browser default. `keyAsync(adapter, event)` must be called while the event is being
  dispatched, before any `await`: a key it accepts is prevented and stopped at once, before its Promise settles, and a
  key it excludes is left alone, and the caller must leave it alone too.
- **What `keyAsync` returns.**
  - `consumed`: the reply's records have been applied.
  - `replayed`: the engine declined the key, or crashed, and the router has already applied the key through `replayKey`;
    applying it again would double it.
  - `passthrough`: the key was excluded (§7.1.1) and never captured.
  - `cancelled`: the surface was detached or the library disposed while the key waited, and none of its edits were
    applied.
- **Adapter errors.** An exception from an adapter rejects the `keyAsync` call that caused it; one with no caller to
  reject is logged. Either way it is the page's error, not an engine crash.
- **Applying replies.** Preedit is decoration, never document content: host values, undo history and `input` events
  never contain it. A reply's records are applied in order inside the adapter's batches, and `request` applies them
  itself, so its callers must not.
- **Undo.** The built-in adapter applies a batch's net deletion and commit as one `execCommand("insertText")` or
  `execCommand("delete")` on the focused control, so the browser records one undo step and fires its own `input` events.
  Without focus, or without the command, it uses `setRangeText` and dispatches a synthetic `input` event, and that edit
  can't be undone natively (`docs/known-gaps.md`).
- **Blur and reset ordering.** A blur waits only for the keys accepted before it, so keys typed after focus returns
  can't hold it open. A reset on a focused, ready surface takes its place in the engine's queue at once; on any other
  surface it waits until the surface is focused and ready again, behind any other surface's pending work, and keys
  accepted after it wait for `Reset` and the refreshed surrounding text. The host's own value and selection changes
  always win. A `pointerdown`, caught in the capture phase, commits a visible preedit before the browser moves the
  caret.

#### 7.2.3 Built-in adapters

`textareaAdapter(element, { onPreedit })` serves `<input>` and `<textarea>`.

| Part    | How                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit  | `execCommand` on the focused control, one undo step per batch; `setRangeText` and a synthetic `input` event otherwise (§7.2.2)             |
| Preedit | a clipped overlay at the caret, with the IBus attributes as underline and colours; never in the value or the history                       |
| Caret   | a mirror element styled like the control (font, box, direction, wrapping, scroll); `caretRect` gives the preedit cursor while one is shown |
| Resets  | value assignments and selection changes the adapter didn't make                                                                            |
| Replay  | the character inserted, or the editing action (Backspace, Delete, Enter, arrows, Home, End) performed                                      |

`onPreedit` also receives each preedit, for hosts that show it themselves. Detaching removes the overlay, observers and
listeners. Keys held with Control, Alt or Meta (clipboard keys and shortcuts) aren't replayed, nor is platform-specific
navigation. A `contenteditable` adapter is planned (M2.2, iceboxed). No CodeMirror adapter ships; §7.2.4 shows how one
would map.

#### 7.2.4 CodeMirror 6 check (not in v1)

| Contract                               | CodeMirror 6                                                            |
| -------------------------------------- | ----------------------------------------------------------------------- |
| manual capture                         | `EditorView.domEventHandlers` calling `router.keyAsync` during dispatch |
| `batch`, `commit`, `deleteSurrounding` | one `view.dispatch` with `changes` and `userEvent: "input.type"`        |
| `setPreedit`                           | `Decoration.widget` at the cursor through a `StateField`                |
| `caretRect`                            | `view.coordsAtPos(head)`                                                |
| `surrounding`                          | `state.doc.sliceString` around the selection                            |

### 7.3 Default panel

`@ibus-web/panel` renders the candidate window, auxiliary text and a property menu. It uses only the facade's public
`PanelHost` interface and its own stylesheet, which the host imports, so it is framework-free and serves as reference
code for hosts that build their own panel. It is meant for testing and simple hosts.

- **Candidates.** The panel decodes only the visible page of a lookup table (§6.3) and shows the engine's labels, or the
  position on the page where the engine gives none, with the cursor highlighted. Its previous and next buttons send
  `PageUp` and `PageDown`, the mouse wheel sends `CursorUp` and `CursorDown`, and a click on a candidate sends
  `CandidateClicked` with the clicked label's position on the visible page, as IBus's GTK panel does (§6.1.2).
- **Placement.** The window sits below the caret, or above it when there is no room, and is clamped to the viewport.
  Orientation is the table's own, or for `System` the panel schema's setting. Resizes are batched into one animation
  frame; caret, scroll and record updates move it at once.
- **Properties.** The menu lists visible properties, toggles and radio groups with their state. The first visible toggle
  or radio property with a symbol becomes the compact mode indicator; no engine's property names are special-cased.
  Choosing a toggle or radio item already in that state sends nothing; a normal item is activated every time.
- `FocusOut` and crashes hide everything, and records for an input context that is no longer current are ignored.

### 7.4 Effect architecture

- **Effect 4**, pinned to an exact release candidate until 4.0 is stable.
- **Services and layers.** Router, engine registry, Worker pool, settings, storage and configuration are services.
  Configuration (ring and slot sizes, time budget, hang thresholds, replay limit, surrounding-text window, restart
  schedule) is provided by layers.
- **Resources.** Workers are acquired and released within a `Scope`; engine instances are scoped to their input context.
  Disposing the library terminates all Workers.
- **Restart policy.** A `Schedule` (§8), replaceable through configuration.
- **Errors.** Tagged errors: `EngineLoadFailed`, `RuntimeAbiMismatch`, `ProtocolMismatch`, `EngineCrashed`,
  `EngineHung`, `ProtocolError`, `StorageUnavailable`. Not yet built: M1's core fails with plain `Error`s and reports
  engine trouble only as engine state (§8).
- **Events.** Panel events, engine state, storage and settings changes are `Stream`s.
- **Logging.** `Effect.log*` with annotations for engine, input context and GLib domain. GLib levels map to Effect
  levels. Hosts replace or merge loggers with `Logger.layer` and set verbosity with `References.MinimumLogLevel`.
- **The keystroke path is plain synchronous TypeScript.** It reads a snapshot (active engine, Worker handles, busy
  flags) that services keep current, and hands decoded records and log lines to the streams and loggers through a
  synchronous enqueue drained by fibers. It must finish inside the event handler, and running a fiber per key would add
  overhead and fail if anything on the path became asynchronous. Async and manual surfaces use `keyAsync`'s Promise
  instead, through the same queue (§7.2.2).
- **Facade.** `ibus-web` wraps core in a `ManagedRuntime`: Promise methods, `EventTarget` events carrying typed
  `CustomEvent`s, and a `logger: (entry) => void` option with a minimum level. It starts no Worker and opens no storage
  until an engine is selected or a setting read.

| Package                 | Contents                                        | Uses Effect                                             |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `@ibus-web/protocol`    | GVariant codec, schemas, SAB layout             | yes (Schema)                                            |
| `@ibus-web/core`        | router, services, adapters, keystroke path      | yes, except the keystroke path                          |
| `ibus-web`              | entry package: facade plus re-exports (§7.4.1)  | facade uses it internally; `ibus-web/effect` exposes it |
| `@ibus-web/panel`       | default panel                                   | through the facade                                      |
| `@ibus-web/worker-host` | Worker bootstrap, resource scopes, request loop | yes, except the request loop                            |

#### 7.4.1 The `ibus-web` entry package

Hosts install one package. `ibus-web` depends on the scoped packages and exposes them through subpath exports:

| Import            | Contents                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ibus-web`        | the non-Effect facade                                                                                                                                              |
| `ibus-web/effect` | re-exports of the Effect surface: `@ibus-web/core` (services, layers, streams, tagged errors, adapters) and the public schemas and types from `@ibus-web/protocol` |
| `ibus-web/panel`  | re-export of `@ibus-web/panel`                                                                                                                                     |
| `ibus-web/worker` | `workerUrl`, `relayUrl` and `brotliFallbackUrl` URL constants for deployed assets; never Worker code (§9.2)                                                        |

```ts
createIbusWeb(options: {
  runtimeUrl: URL;
  modules: Record<string, URL>; // module → manifest URL
  hostUrl?: URL; // defaults to ibus-web/worker's workerUrl
  settings?: SettingsSourceService; // replaces the IndexedDB persister
  logger?: (entry: LogEntry) => void;
  logLevel?: "debug" | "info" | "warn" | "error";
  config?: Partial<CoreConfigValues>;
}): IbusWeb;
```

`IbusWeb` is an `EventTarget` and the panel's `PanelHost`:

- `attach(element, options?)` attaches an `<input>` or `<textarea>` through the built-in adapter, and
  `attachAdapter(adapter, options?)` any adapter; both take `keyMode` and return a detach function.
- `keyAsync(adapter, event)` for async and manual surfaces (§7.2.2).
- `select(module, engine?)`, `deselect()`, `unload(module)` and `dispose()`; `selection` is the current
  `{ module, engine }`.
- `engines(module)` reads and validates a module's manifest without starting its Worker.
- `debugRestart(module)`, for development: it terminates the module's Worker and waits for the ordinary crash recovery.
- `settings.schemas`, `get`, `set` and `reset` (§7.1.4).
- Events `modulestate`, `selectionchange`, `storage`, `panel` and `log`.

The `PanelHost` side gives a panel the caret rectangle, the orientation setting, a way to send its actions to the engine
and to report its errors.

- **`effect` is a peer dependency** of every package, so hosts and ibus-web share one copy. Two copies would make
  services and layers from one unrecognizable to the other.
- **The scoped packages stay published** for hosts that want finer-grained dependencies; the re-exports add no code of
  their own.
- **Subpaths are separate entry points**, so importing `ibus-web/effect` does not pull in the facade's `ManagedRuntime`
  wrapper, and the panel is included only when imported.

## 8. Errors and recovery

A WASM trap or `-ECANCELED` fault leaves a Worker's state untrustworthy; a crashed Worker is discarded. The host writes
`Crashed (us)` best-effort, without waiting for ring space, then marks `state = CRASHED` and notifies, so a page that
drains once on seeing `CRASHED` finds the record; it then posts `crashed` with the diagnostic. State is authoritative
even when the ring has no room. For `RELAY` the relay sets `CRASHED` itself, before the host hears of the failure, so
the record follows. Reasons distinguish `TRAP`, `FAULT`, `RELAY`, `LOAD` (module loading after Init) and `HOST`
failures. A thread's crash reaches the host as `"unwind"`, and its record says only that a thread crashed; the `crashed`
message carries the thread's own error once it arrives. On `-ECANCELED`, the host drains the runtime output already
written, publishes the fault reply under the `reqMode` doorbell rule (§6.2.3), then writes `Crashed` and marks the
crash; no subsequent dispatch or pump occurs. A module load failure likewise drains the runtime's output before its
`LOAD` crash. Runtime finalizers are skipped after traps and faults; restart repeats bootstrap and Init-then-load.
**Hangs.** A request hangs when neither a reply nor any movement of the output ring arrives within its window, or when
more than 64 keys are held, the in-flight key included. The window is `hangMs`, 2 s by default, for every request but
`Init`, which gets `initHangMs`, 30 s by default, since it loads the module and its dictionaries. Both are `CoreConfig`
values. Ring movement starts the window again. The longer `Init` window is room, not a promise: one Hangul module load
from IndexedDB was measured at 7.8 s, before a libhangul patch gave each Hanja table a 64 KiB stdio buffer so its small
reads stop costing an IndexedDB transaction each (`docs/core.md` has the measurements).

**What the host sees in M1.** The "Host sees" column is the design. M1's core reports every row as engine state, through
the `modulestate` event: `restarting` after a crash or hang, `ready` again after recovery, and `failed` when a load
fails, when a crash comes before the engine was ever ready, or after the restart limit; `select` rejects with a plain
`Error`. The crash reason and the Worker's diagnostic don't reach the host (`docs/known-gaps.md`).

| Failure                                                      | Detection                                                                                                                                                                                                                                                                                                  | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Host sees                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Trap (signature mismatch, `abort`, `g_error`, out of bounds) | Worker host catches `RuntimeError`, or a thread's error after `"unwind"` (§5.5)                                                                                                                                                                                                                            | Writes `Crashed`, then `CRASHED`, and notifies. The in-flight key and queued keys are replayed through the adapter. Preedit cleared and panel hidden for the module's input contexts. Restart per policy.                                                                                                                                                                                                                                                                       | `EngineCrashed` with message and symbolized stack in debug builds                                            |
| Engine C++ exception                                         | `ibusweb_dispatch` returns `-ECANCELED`: the exception unwound through GLib's signal emission                                                                                                                                                                                                              | as trap: the runtime is unusable and the Worker is discarded. Until then every `ibusweb_dispatch` returns `-ENOTRECOVERABLE` and `ibusweb_pump` dispatches nothing, while output peek and consume still drain the records already written. Restart per policy.                                                                                                                                                                                                                  | `EngineCrashed`                                                                                              |
| Hang                                                         | no reply or ring movement for 2 s (30 s for `Init`), or more than 64 keys held                                                                                                                                                                                                                             | `worker.terminate()`, then treated as a crash                                                                                                                                                                                                                                                                                                                                                                                                                                   | `EngineHung`                                                                                                 |
| Restart                                                      | policy `Schedule`                                                                                                                                                                                                                                                                                          | Immediate retry, then exponential backoff; after 3 crashes in 60 s, or a crash before the engine was first ready, the module is failed and the router returns to direct input. A Worker the page terminated may hold the engine's writer lock for some 2 s more in Chromium, so the page first waits, up to 10 s, for that lock (§5.6). On restart, `Init` with the current settings and lazy instance recreation. Composition is lost; committed text and stored data are not. | engine state `failed` after the limit                                                                        |
| Load failure                                                 | fetch, compile, manifest `memory` check (a memory the in-memory fallback takes past the runtime's maximum included), instantiate, the storage mount (the backend fails to open although the probe found IndexedDB), a storage lock not granted within 120 s of the last word from its holder, data install | Engine never enabled; router stays in direct input; every lock the host took is let go (§5.6)                                                                                                                                                                                                                                                                                                                                                                                   | `EngineLoadFailed`                                                                                           |
| Old versions not collected                                   | listing the engine's other versions (`indexedDB.databases()`) or deleting one's database fails                                                                                                                                                                                                             | the start goes on; the data stays until a later host collects it (§5.6)                                                                                                                                                                                                                                                                                                                                                                                                         | `collect` with `error`                                                                                       |
| Relay failure                                                | the relay writes `CRASHED` and wakes the host; a relay killed outright is a hang                                                                                                                                                                                                                           | as trap                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `EngineCrashed`                                                                                              |
| Thread pool exhausted                                        | `pthread_create` fails with `EAGAIN`                                                                                                                                                                                                                                                                       | `g_thread_try_new` callers get the error; `g_thread_new` aborts, a trap; a `GTask` whose worker can't start stays queued, silently, until a worker is free                                                                                                                                                                                                                                                                                                                      | engine-specific, or as trap; nothing for a queued `GTask`                                                    |
| ABI or protocol mismatch                                     | manifest check; `Init` version check                                                                                                                                                                                                                                                                       | as load failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `RuntimeAbiMismatch`, `ProtocolMismatch`                                                                     |
| No IndexedDB                                                 | the host's probe of IndexedDB fails at startup, before the runtime's memory is made (an opaque origin, blocked site data, a third-party iframe denied storage; never Node, which mounts a Node-side backend)                                                                                               | in-memory mount, with the runtime's memory made larger by the data's size from the manifest, and the data installed at every start (§5.6); user data lasts as long as the Worker                                                                                                                                                                                                                                                                                                | `storage: ephemeral`                                                                                         |
| Not the writer                                               | another instance holds the engine's writer lock (§5.6)                                                                                                                                                                                                                                                     | the engine's own files mounted read-only for the Worker's life; changes fail with `EROFS`, which the engine sees; the page restarts the Worker to get a writer. Under Node the state is reported but not enforced                                                                                                                                                                                                                                                               | `storage: read-only`                                                                                         |
| Quota                                                        | IndexedDB's `QuotaExceededError`; the write fails with `ENOSPC`, nothing changed                                                                                                                                                                                                                           | engine-specific                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `storage` usage events, logs                                                                                 |
| Storage closed                                               | the backend's IndexedDB connection closes: another connection asked for a newer version of the database, or the browser closed it (§5.6); the host checks both mounts whenever it wakes                                                                                                                    | every later storage call fails with `EIO`, which the engine sees, and nothing reopens the connection; the page restarts the Worker per policy                                                                                                                                                                                                                                                                                                                                   | `storage: closed`, when the host next wakes for a request or a GLib source; the close itself doesn't wake it |
| Undecodable record                                           | protocol decode                                                                                                                                                                                                                                                                                            | dev builds throw; production drops and logs                                                                                                                                                                                                                                                                                                                                                                                                                                     | `ProtocolError` log                                                                                          |
| GLib warnings and criticals                                  | GLib log handler                                                                                                                                                                                                                                                                                           | forwarded as `Log` records; test builds use `G_DEBUG=fatal-criticals`                                                                                                                                                                                                                                                                                                                                                                                                           | log entries                                                                                                  |
| Detached surface                                             | adapter detach                                                                                                                                                                                                                                                                                             | `DestroyEngine`; later output for the context dropped                                                                                                                                                                                                                                                                                                                                                                                                                           | nothing                                                                                                      |

## 9. Licensing

### 9.1 Licenses

| Part                               | License                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Page-side packages and Worker host | MIT OR Apache-2.0                                                                                                                 |
| `libibus-web`                      | LGPL-2.1-or-later                                                                                                                 |
| `pkgsWasm.glib`                    | LGPL-2.1-or-later (GLib's)                                                                                                        |
| Engine recipes and patches         | the engine's license                                                                                                              |
| Engine artifacts                   | the engine's license, covering the combined work in that Worker                                                                   |
| The table engine (`engines/table`) | MIT OR Apache-2.0; its artifact `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`, for MARISA, linked in, and the LaTeX table's data |

The repository follows the REUSE specification. License texts live in `LICENSES/`. Source files we write carry SPDX
headers, and `REUSE.toml` annotates the rest by path: patches, generated files, documentation and, for an upstream
engine, its directory. `REUSE.toml` is the authoritative per-path mapping; this table summarizes it.

Third-party tables in page packages keep their notices: Chromium's `dom_code_data.inc` (BSD-3-Clause) and xorgproto's
`keysymdef.h` (`MIT-open-group` plus a Digital HPND-style notice).

The runtime must be compatible with every engine's GPL at once; GPLv2-only and GPLv3 engines conflict with each other,
which LGPL-2.1-or-later avoids, and separate Workers keep differently licensed engines from ever being combined. libc++
is Apache-2.0 with LLVM exceptions (GPLv2-compatible); musl is MIT.

This section is an engineering design. Legal review is required before release.

### 9.2 Boundary rules

1. No Worker, runtime or engine code, including Emscripten glue, enters any page-side bundle. Workers load by URL;
   bundler inlining is forbidden.
2. The page communicates only through the dedicated SAB and `postMessage`, using the published protocol. It never
   touches WASM memory, and the protocol never carries pointers into it. The wake relay (§5.2.4) is host-side: it holds
   the runtime's memory, to bump the wake word there, and is started by the Worker host, not the page.
3. The protocol describes IBus behavior. The router never special-cases a GPL engine's internals.
4. At least one non-GPL engine ships: the table engine (M2.1), MIT OR Apache-2.0, with MARISA (BSD-2-Clause) linked in
   and W3C-licensed data.

### 9.3 Release obligations

- Every artifact is a Nix flake output built from the tagged commit, with the toolchain pinned by `flake.lock` (§10).
- Each engine artifact has a source bundle, itself a flake output, attached to the same release: the engine's fetched
  upstream sources, its patch layers, and the repository's Nix expressions and `flake.lock` at the tag. Because the
  flake is the build definition and pins the toolchain, the bundle is the complete build recipe, not a description of
  one.
- License notices ship with the packages; hosts link them from a licenses page.
- The runtime is a separately replaceable module, which meets LGPL relinking requirements.

### 9.4 CI checks

- `checks.tools-bundle-scan` bundles each of the seven published page entry points, and the production demo, and walks
  the module graph Vite actually emits. It fails on any module from the Worker host, the runtime or the Brotli WASM
  decoder, and on Emscripten or WebAssembly markers, allowing by name only the transport-layout modules the page shares
  with the host. A fixture that inlines the host must fail it. The Worker, relay and Brotli fallback reach the page only
  as URLs to separately deployed files.
- The protocol specification is regenerated and must match the committed one.
- Every engine artifact must have a source bundle.
- `reuse lint` passes (hk's `reuse` step, in `checks.flake-hk`).
- Each `engines/<name>/` annotation in `REUSE.toml` matches that engine's `meta.license`.

## 10. Build, CI and releases

### 10.1 Repository

The flake is dendritic: `flake.nix` holds only inputs and passes its module directories (below) through import-tree to
flake-parts. Every `.nix` file in them is a flake-parts module, except one whose name starts with `_`, which is a plain
`callPackage` recipe. Modules share values only through `ibusWeb.*` per-system options, never by importing each other:
the toolchain and its `pkgsWasm` package set, engines, and the helpers in `ibusWeb.lib`. Non-Nix files a module needs
sit beside it under plain names.

A component's Nix lives in its own directory, each file named for its role:

- `module.nix`, its flake-parts module;
- `options.nix`, options it declares for others;
- `checks.nix`;
- `overlay.nix`, defining `flake.overlays.<component>`: one gated overlay on `pkgsWasm` that may change several nixpkgs
  attributes;
- `_<name>.nix` recipes.

A check with sources of its own has a directory under `checks/`, with its `checks.nix` beside them. `patches/` holds a
component's patch files and a README recording their provenance. `modules/` holds only infrastructure several components
share. The runtime's parts, each engine, each TypeScript package, each tool and each example are components at the
repository root.

Every directory holding TypeScript is a package of the pnpm workspace, and every tsconfig extends a preset of
`@ibus-web/tsconfig`. How the layout works in practice is in `docs/toolchain.md` ("Flake layout") and `docs/tooling.md`.
Entries marked † below don't exist yet.

```
ibus-web/
├─ flake.nix, flake.lock           inputs: nixpkgs, flake-parts, import-tree, devshell, flake-root, systems, github-actions-nix, files
├─ package.json, pnpm-*.yaml       the pnpm workspace (no root dependencies), its catalog (generated from Nix) and its lockfile
├─ hk.pkl                          every formatter and lint check, for the git hooks, `nix fmt` and `checks.flake-hk`
├─ REUSE.toml, LICENSES/, NOTICES/ per-path licensing, license texts, third-party notices
├─ README.md, CONTRIBUTING.md      what ibus-web is and how to work on it; AGENTS.md (and CLAUDE.md) for coding agents; SECURITY.md
├─ modules/                        infrastructure several components share
│  ├─ flake/                       systems, hk, dev shell, the CI workflow, the files writer, ibusWeb.lib
│  ├─ toolchain/                   pkgsWasm (Emscripten cross package set), emscriptenCache, wrapper hooks, probes, checks/
│  ├─ emscripten/                  Emscripten's patches and the checks of what they fix
│  ├─ glib/                        pkgsWasm.glib: overlay.nix, patches/, checks/
│  ├─ baseline-browser-mapping/    the package Emscripten's minimum versions come from
│  ├─ typescript/                  the pnpm workspace's offline build, its generated files, version and metadata checks
│  ├─ testing/                     the GoogleTest harness, the test-program and Vitest checks, nixpkgs' Playwright browsers
│  ├─ engines/                     what every engine shares: manifests, settings metadata, cast audits, the IBus conformance adapter
│  └─ release.nix †                the release set
├─ runtime/
│  ├─ libibus-web/                 C sources, ibus.h-compatible headers, overlay.nix, checks.nix, tests/
│  ├─ wasmfs-idb/                  the WasmFS IndexedDB backend: C++, its JS library, header, tests/
│  └─ ibus-runtime/                the main-module link, its export list, side-module support, tests/
├─ engines/hangul/                 an engine: overlay.nix, patches/{port,casts,libhangul}, checks/, module.c
├─ packages/                       protocol, worker-host, core, panel, ibus-web (published); test-programs; tsconfig
├─ tools/<name>/                   one package per build and check tool; Nix (checks.nix, module.nix) only where it needs any
├─ tools/claude/                   Claude Code language-server plugins (nixd, pkl)
├─ examples/demo/                  the demo of every module and its end-to-end tests
└─ docs/                           this spec and the others; topic pages; upstream/ drafts
```

One version for the whole project. Protocol version and runtime ABI version are recorded separately and checked at load,
but a release ships only matching parts.

### 10.2 Nixpkgs as the source of dependencies

Everything builds through the flake: development dependencies, every artifact and every check. **Dependencies, engines
and engine data come from nixpkgs wherever nixpkgs has them.** Updating the `nixpkgs` input is how versions move; CI's
conformance tests catch breakage, and our patch layers are rebased when needed.

WASM builds come from a nixpkgs cross package set, `pkgsWasm`: nixpkgs instantiated for `wasm32-unknown-none` (made
static), with the cross stdenv's compiler replaced by Emscripten through `config.replaceCrossStdenv` (§10.3). Recipes
are used unmodified wherever possible. Their dependencies, `pkg-config`, and their autotools, Meson and CMake
configuration all come from nixpkgs' ordinary cross-compilation machinery. Where a recipe needs changes, they are
overlays applied to `pkgsWasm`, so every package that depends on it sees the change. The flake's `packages` output holds
only ibus-web's own artifacts; WASM builds of nixpkgs packages are reached through `legacyPackages.<system>.pkgsWasm`,
and sets of our own artifacts that belong together, such as the npm tarballs (`legacyPackages.<system>.npm`), are scopes
in `legacyPackages` too. Only packages nixpkgs lacks (`libibus-web`, the custom table engine) get recipes of their own.

| Artifact             | nixpkgs recipe (at `8ce4ef6`) | Build system | Notes                                                                                                                                                                                                                         |
| -------------------- | ----------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pkgsWasm.glib`      | `glib` 2.88.3                 | Meson        | Emscripten patch set on top of nixpkgs' `glib` (§10.3)                                                                                                                                                                        |
| `pkgsWasm.libffi`    | `libffi` 3.8.0                | autotools    | upstream WASM backend                                                                                                                                                                                                         |
| `pkgsWasm.libhangul` | `libhangul` 0.2.0             | autotools    |                                                                                                                                                                                                                               |
| `engine-hangul`      | `ibus-engines.hangul` 1.5.5   | autotools    | GPL-2.0-or-later                                                                                                                                                                                                              |
| `pkgsWasm.m17n_lib`  | `m17n_lib` 1.8.6              | autotools    |                                                                                                                                                                                                                               |
| `engine-m17n`        | `ibus-engines.m17n` 1.4.40    | autotools    | GPL-2.0-or-later; packed with m17n-lib and m17n-db as GPL-2.0-or-later AND LGPL-2.1-or-later                                                                                                                                  |
| `pkgsWasm.librime`   | `librime` 1.17.0              | CMake        | Boost, LevelDB, marisa-trie, OpenCC, yaml-cpp, glog, each from nixpkgs; the recipe's default plugins, librime-lua and librime-octagram                                                                                        |
| `engine-rime`        | `ibus-engines.rime` 1.6.1     | CMake        | GPL-3.0-or-later; packed with librime, its plugins, their dependencies and the data as GPL-3.0-or-later AND BSD-3-Clause AND GPL-3.0-only AND MIT AND Apache-2.0 AND BSD-2-Clause AND BSL-1.0 AND LGPL-3.0-only AND CC-BY-4.0 |

**Engine data** also comes from nixpkgs:

- **Rime:** every schema of `rime-data` and `rime-ice`, from nixpkgs, and of `rime-loengfan`, which `jyut6ping3` needs
  and `rime-data` lacks, fetched from CanCLID at the revision Debian and Arch ship; `rime-ice`'s `double_pinyin*`
  replace `rime-data`'s. The module's recipe takes `schemas`, every one by default, so a build can ship fewer. The YAML
  sources are compiled at build time by the WASM build of `rime_deployer` under Node, so compiled dictionaries come from
  the librime build that reads them. The output is a common store path (the compiled configurations, `symbols`, OpenCC's
  data and `rime-ice`'s Lua scripts), which is base data, and one path per dictionary, which is data of the engines that
  use it, installed when one is first made (§5.6). Rime data nixpkgs lacks would come from xddxdd's NUR, where the Rime
  community packages it (`rime-moegirl`, `rime-aurora-pinyin` and others), as a flake input whose `nixpkgs` follows
  ours; nothing shipped needs it, so the input waits until some data does. Only data whose license allows redistribution
  in a published package would ship, which rules out its `unfree` dictionaries and `rime-moegirl`'s CC-BY-NC-SA.
- **m17n:** `ibus-web-m17n-db`, the native `m17n_db` output's `share/m17n` alone, without the `bin/` and `scripts/` that
  would bring bash and gawk; m17n-lib compiles in its store path as `M17NDIR`. It is text data.
- **Hangul:** the Hanja tables from nixpkgs' native `libhangul` output; also text.

**License fields** in engine manifests are generated from each recipe's `meta.license` SPDX identifiers.

### 10.3 Toolchain and overrides

How the toolchain and GLib are built as they are now, and the evidence for each choice, is in `docs/toolchain.md` and
`docs/glib.md`.

- **Emscripten from nixpkgs** (6.0.9 at `8ce4ef6`) plus the patches in `modules/emscripten/patches`, as
  `ibusWeb.toolchain.emscripten`. nixpkgs builds it against nixpkgs' LLVM rather than the revision upstream Emscripten
  pins (R12). Each patch is a small fix tracked upstream (an issue, a pull request or a draft report in
  `docs/upstream/`), dropped once an Emscripten release has it; the patches' README says which release that is. They fix
  WasmFS (`getcwd()` under a mount, `poll()` of files and devices, directory search and create permission, `O_NOCTTY`,
  pipes as FIFOs, `futimens()`, a backend's error when creating a file or a symlink or looking one up, the heartbeat
  timer of a backend's own thread outliving the thread), its Node backend (`fsync()`, renames, host errors from `open()`
  and `close()`, `chmod()` and `utimensat()` reaching the host), pthreads (a thread that ends without a join on the main
  runtime thread is reclaimed whenever that thread processes its queued calls, inside `emscripten_futex_wait()` too, not
  only from its event loop, with `dlopen()`'s sync holding those cleanups off while it walks its threads; a joined
  thread's late "finished" message no longer marks a new thread that reuses its `pthread_t`), an imported memory's
  maximum without growth (§5.3) and, backported from 6.0.10, `-sNODERAWFS` `fstat()` on the standard streams. nixpkgs
  installs the patched tree, so the cache and every link see them; `checks.emscripten-fixes` checks each one's
  behaviour.
- **`emscriptenCache`.** nixpkgs precompiles system libraries only for non-PIC variants, and builds otherwise use a
  per-build cache, so every PIC build would recompile libc and libc++. A dedicated derivation fills the cache by
  compiling probe programs with the project's compile flags and link settings, at `-O0` and `-O2`, so Emscripten's own
  link step populates the cache with the variants those flags select, rather than running `embuilder`. All other builds
  use it as a frozen, read-only cache.
- **Minimum versions.** Emscripten chooses WebAssembly and JavaScript features from
  `-sMIN_{CHROME,FIREFOX,SAFARI,NODE}_VERSION`, which every link gets from `ibusWeb.toolchain.minimumVersions`, never by
  hand. The browsers' are Baseline Widely available, from baseline-browser-mapping's CLI in a derivation (the package
  built from source in `modules/baseline-browser-mapping/`), evaluated on the date its data was last updated rather than
  the build machine's clock; Node's is the workspace's Node. A floor raises a browser's minimum above Baseline's where
  the design needs it, and has no effect once Baseline reaches it: Firefox's is 126, the first with
  `indexedDB.databases()`, which the host lists old versions' data with (§5.6); Firefox 124 and 125 together are some
  0.02% of users. With baseline-browser-mapping 2.11.27 that is Chrome 123, Firefox 126, Safari 17.4 and Node 24.19.
  They turn on extended-const and leave off growable shared buffers (`-sGROWABLE_ARRAYBUFFERS=2`) and the standard
  (exnref) encoding of WebAssembly exceptions (R18). `checks.toolchain-cache` compares the features they enable with
  `modules/toolchain/expected-features.txt`, so a change to the data that moves them is reviewed, and
  `checks.toolchain-exnref` fails once they reach exnref's (R18). A link gets only the minimums of the environments its
  `-sENVIRONMENT` allows (all of them when it names none), since emcc ignores the rest with a warning.
- **`pkgsWasm`.** `import nixpkgs` with `crossSystem` set to nixpkgs' `wasm32-unknown-none` example plus
  `isStatic = true` and `useEmscripten = true`, and `config.replaceCrossStdenv` swapping the compiler:
  - `emcc` and `em++` are wrapped by nixpkgs' `cc-wrapper` as a clang (`stdenv.cc.isClang`), with its version taken from
    the clang Emscripten is built against. The wrapper adds `-O2 -fPIC -pthread -fwasm-exceptions -mextended-const`
    (`ibusWeb.toolchain.commonFlags`) to every compile and link, and Emscripten's minimum versions (above) to every
    link, those of the environments it targets. `-O2` goes before the command's own arguments, so a package's own `-O`
    wins. An `-O2` link turns Emscripten's runtime assertions off, so every check and test link adds `-sASSERTIONS=1`
    itself.
  - The Emscripten binutils (`emar`, `emranlib`, LLVM's `nm`, `strip` and friends, `wasm-ld`) carry the target prefix,
    so the bintools wrapper wraps them and builds get `$AR`, `$NM` and the rest from it.
  - The wrapper's `--target` and `-nostdlibinc` are removed (emcc chooses its own target and sysroot), and the hardening
    defaults are limited to `format`, `pic` and `strictflexarrays1`.
  - A `cc-wrapper-hook` drops arguments that clang and lld accept but `emcc` and `wasm-ld` reject (`-static-libgcc`,
    `--undefined-version`). Recipes pass them because the wrapper presents Emscripten as clang with lld; nixpkgs' zlib,
    for example, adds both.
  - `libc` is `null`: Emscripten's libc lives in its cache sysroot, which emcc adds itself.
  - `isStatic` makes nixpkgs apply its `makeStatic` adapter to the cross stdenv: static libraries only, every build
    input propagated, and `-static` at link time. The frozen-cache hook is part of the stdenv.
  - Emscripten is the toolchain's, built for the build machine as `pkgsBuildBuild`'s would be. `buildPackages` would
    give it a WASM target platform, which rehashes it and everything under it, so even its dependencies would miss the
    binary cache.
  - `config.allowUnsupportedSystem` is set, because recipes' platform lists predate this target.
  - A setup hook gives every Meson build a second cross file setting `host_machine.system = 'emscripten'` and Node as
    exe wrapper, so Meson can run tests and `run()` checks. nixpkgs' own cross file reports the platform's kernel,
    `none`, and nixpkgs' `lib.systems` has no Emscripten kernel; autotools and CMake still see `wasm32-unknown-none`.
    Both cross files are exposed as `ibusWeb.toolchain.mesonCrossFlags` for configuring by hand.
- **Overlays** in the flake's `overlays` output carry every recipe change. Each is gated with
  `lib.optionalAttrs (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))`, where
  `useEmscripten` is an attribute on `pkgsWasm`'s platform, so an overlay never reaches a native or WASI package set and
  the overlays are safe to export. The gate reads only the platform, because reading `stdenv.cc` would evaluate the
  wrapped compiler, whose `buildPackages` splicing reaches back into `pkgsWasm` and recurses. Layout: one per component,
  `overlay.nix` in the component's directory defining `flake.overlays.<component>`, with its patches in `patches/`
  beside it. They do three things, and nothing else:
  1. drop desktop-only inputs and features: GTK and Python setup programs, `wrapGAppsHook3`, GObject introspection,
     libnotify, and network features;
  2. drop nixpkgs patches that only serve those features (for example ibus-hangul's `fix-paths.patch`, which edits the
     Python setup program);
  3. append our patch layers after nixpkgs' remaining patches: `patches/port`, then `patches/casts` as a separate list.
     Dependencies are never swapped by hand: cross splicing supplies the WASM builds. A patched package is never defined
     under another name, because dependents inside `pkgsWasm` would not see it.
- **GLib** is nixpkgs' `glib` recipe with an Emscripten patch series kept in this repository (`modules/glib/patches/`)
  and applied to `pkgsWasm.glib` by `flake.overlays.glib`, after nixpkgs' own `glib` patches, which are all kept. The
  patches README lists each patch with its source and the reason for it.
  - **Series.** 17 patches. Kleis Auke Wolthuizen's series from his `wasm-vips-<version>` branches of GLib (the one
    wasm-vips uses), rebased from 2.88.1 onto 2.88.3, without its GRegex removal and with its tool removal cut down to
    girepository and the fuzzers. Fluendo's `glist`/`gslist` signature fixes from `gst.wasm`; its main-context commits
    are superseded by ours. Ours, one patch per topic: GLib's own calls through mismatched function types, including the
    interface init functions `gdbus-codegen` generates, the adapters the dynamic-type macros refer to and class handlers
    called without `user_data`, through libffi (§5.1.2); the Unix parts and tools WebAssembly can take, with subprocess
    tests skipped and `g_file_query_exists` without the `faccessat` flags Emscripten doesn't support; a futex-backed
    `GWakeup` that blocking iteration sleeps on (§5.1.3); platform backends (§5.1.4); characters `iconv()` replaces;
    test-only fixes; and the wake hook the Worker host's pump relies on (§5.1.3).
  - **Tools.** GLib's tools (`glib-compile-schemas`, `glib-compile-resources`, `gio`, `gobject-query`, …) are built for
    WebAssembly as `.js` programs and run under Node; features they reach through Unix sources WebAssembly doesn't build
    report themselves unsupported. Each is installed as `<tool>.js` and `<tool>.wasm` plus a `<tool>` wrapper that runs
    it with the build machine's Node, so the paths `gio-2.0.pc` and `glib-2.0.pc` give (`glib_compile_schemas`,
    `gsettings`, …) run this GLib's tools; the build checks that every tool variable names an installed program. GLib's
    executables link with
    `-sNODERAWFS=1 -sEXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=8 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sASSERTIONS=1`;
    the libraries don't see these. The tools keep Node's raw filesystem, one of Emscripten's JavaScript file systems,
    because WasmFS's stdout turns a NUL byte into a line break (`gresource extract` of `a\0b\nc` prints `a\nb\nc\n`).
    Its Node backend's `fsync()` trap, which a second `glib-compile-schemas` into the same directory hit, is fixed by
    the toolchain's Emscripten patches.
  - **Tests' file system.** `checks.glib-tests` links GLib's tests with WasmFS, the file system the runtime ships, in
    place of `-sNODERAWFS=1`: `ibusWeb.toolchain.nodeHostFsFlags` is `-sWASMFS=1 -sNODE_HOST_ENV=1` and an object that
    roots WasmFS at the host's `/` through its Node backend and starts in Node's working directory. Emscripten's
    `-sNODERAWFS` under WasmFS roots the tree at the working directory instead, so absolute paths miss the build tree.
    Each test gets a `TMPDIR` of its own on the host; with the toolchain's fixes to the Node backend (`fsync()`,
    renames, `chmod()` and `utimensat()`, create errors) nothing needs it kept in memory. The tests link with a fixed
    memory (`ibusWeb.toolchain.testMemoryFlags`, 512 MiB) in place of growth (§5.3). `ibusWeb.toolchain.testMainFlags`
    links the GLib smoke, libhangul, dynamic-linking, toolchain and Emscripten-fix checks the same way.
  - **Tools in consumers' builds.** A cross build runs its tools on the build machine, whose GLib has unpatched ones
    (its `gdbus-codegen` emits interface init functions WebAssembly traps on). `pkgsWasm.glib` carries a setup hook that
    points Meson's gnome module at its tools through a cross file listing every tool its `.pc` files name; Autotools
    consumers get them through the `.pc` variables themselves. The gnome module also chooses tool options by the build
    machine's GLib version, which Meson reads through a build-machine pkg-config; the same hook points it at the build
    platform's pkg-config and GLib `.pc` files, so consumers need no `depsBuildBuild` for it.
  - **Overlay.** Removes `bash-interactive`, `gnum4`, `libsysprof-capture`, `gettext` and `libiconv` from the inputs
    (Emscripten's musl provides iconv and gettext), disables NLS, sysprof, documentation, tests and xattr, and drops the
    `devdoc` output.
- **TypeScript.** One pnpm workspace at the repository root (`package.json`, `pnpm-workspace.yaml` over `packages/*`,
  `tools/*`, `examples/*` and the component directories whose TypeScript needs dependencies), with one `catalog:` for
  what must be one version across the repository, both declared in Nix, which writes the file. Its dependencies are a
  fixed-output derivation (`fetchPnpmDeps` with pnpm 12, installed offline with `pnpmConfigHook`), and
  `ibusWeb.typescript.workspace` builds every package's `dist/` (`tsc`, or tsdown where a package bundles, as the Worker
  host's scripts do), the JavaScript browsers load. The workspace, its build and its configuration are in
  `docs/tooling.md`. Every tsconfig in the repository extends a preset of `@ibus-web/tsconfig` (`base.json`, with
  `strict` and `erasableSyntaxOnly` so Node runs the sources directly while iterating, and `dom.json`, `worker.json`,
  `node.json` and `emscripten-js.json` on top of it), and overrides only what its files need. Each package keeps its
  tsconfigs at its root: a `tsconfig.json` that only references the others, and one per target or purpose
  (`tsconfig.worker.json`, `tsconfig.test.json`, `tsconfig.config.json`, …). Versions pnpm can't know are asserted
  against what it resolved: the `playwright` package equals nixpkgs' `playwright-driver` (1.63.0 at `c59305b`), and
  `packageManager` names nixpkgs' pnpm 12. The tests use `playwright-driver.browsers`, never downloaded, through
  `ibusWeb.testing.playwright` (§11).

#### 10.3.1 Derivation graph

```
emscriptenCache ─ pkgsWasm
 ├─ pkgsWasm.libffi ─┐
 ├─ pkgsWasm.glib ───┴─ libibus-web ─ ibus-runtime (main module and JS glue)
 ├─ pkgsWasm.libhangul ─────────── engine-hangul      (data: libhangul Hanja tables)
 ├─ pkgsWasm.m17n_lib ──────────── engine-m17n        (data: ibus-web-m17n-db)
 └─ pkgsWasm.librime ───────────── engine-rime        (data: ibus-web-rime-common; per engine, ibus-web-rime-dict-*)
```

- **Source bundles** (`engine-<name>-src`) pack the `src` of every recipe in the engine's closure (the fetched upstream
  sources), the nixpkgs recipes as used, our overrides and patch layers, and `flake.lock` at the tagged commit (§9.3).

### 10.4 Checks

`nix flake check` runs every check; `docs/testing.md` says how each is written and run, and how to run one alone. As
built:

- **hk** (`checks.flake-hk`): every formatter and lint step over the whole tree, as the git hooks run them: formatting,
  oxlint, `tsc` in every directory with a `tsconfig.json`, the `tsconfig` extends chain, `reuse lint` (§9.4) and
  actionlint (`docs/tooling.md`)
- **the editor and CI configuration:** every C and C++ source parsing under clangd's configuration (`toolchain-clangd`),
  and the generated CI workflow against its Nix (`files:.github/workflows/ci.yml`)
- **the toolchain:** the Emscripten patches' behaviour (`emscripten-fixes`, GoogleTest programs under Node), the cache
  against every flag combination the builds use, with the features the minimum versions enable (`toolchain-cache`),
  whether they now support the standard exception encoding (`toolchain-exnref`, R18), the cross stdenv
  (`toolchain-cross`), and Meson and nixpkgs recipes building through it (`toolchain-meson-consumer`,
  `hangul-libhangul-link`)
- **GLib:** the patch series applying (`glib-patches`), a smoke program (`glib-smoke`), consumers running its tools
  (`glib-meson-tools`, `glib-autotools-tools`), its own tests under Node gated by their baseline (`glib-tests`), and the
  gate's own Vitest tests (`glib-tests-gate`)
- **the runtime:** `libibus-web`'s g_test programs under `meson test` in Node (`libibus-web-tests`); the runtime's load
  and memory contract under Vitest (`ibus-runtime-load`: it refuses a missing or out-of-bounds memory and never grows
  one); its export manifest against its libraries (`ibus-runtime-exports`) and test side modules' imports against the
  manifest (`ibus-runtime-side-imports`, `worker-host-side-imports`)
- **the IndexedDB backend:** its GoogleTest programs in Chromium and Firefox (`wasmfs-idb-browser`), and its JavaScript
  library type-checked against types Emscripten generates, with every symbol it uses declared in its dependencies
  (`wasmfs-idb-types`); the dependency checker's own Vitest tests (`tools-emscripten-library-deps`) and its acorn
  matching Emscripten's (`tools-emscripten-library-deps-acorn`)
- **the test infrastructure:** the test-program shim against fixtures with known results (`testing-programs`), and the
  GoogleTest harness's JavaScript library (`testing-gtest-main-library`)
- **the Worker host:** its Vitest suites under Node and in Chromium and Firefox, on the asserting and the released
  runtime (`worker-host-node`, `worker-host-browser`; §11)

- **the protocol:** Vitest codec, schema, framing and generator suites (`checks.protocol-node`), real IBus WASM parity
  (`checks.protocol-parity`), and generated artifacts against their committed copies
  (`files:runtime/libibus-web/include/ibus-web/protocol.h`, `files:packages/protocol/PROTOCOL.md`)

Still to come, with the parts they check:

- TypeScript unit and keystroke-path tests (Vitest) of the page packages
- engine conformance golden tests and callback-audit gates
- the license-boundary scan (§9.4)
- Playwright suites on nixpkgs' browsers

### 10.5 CI

- **Pull requests and pushes to `master`:** `nix flake check` on x86_64-linux, with FlakeHub Cache so the toolchain,
  library cache and dependency builds are fetched rather than rebuilt. A push to `master` that passes also publishes the
  flake to FlakeHub, private and rolling, which the cache's access control needs. The workflow is written in Nix and
  kept in the tree by a generated-files check (`docs/tooling.md`, "CI").
- **Tags:** `nix build .#release`, then publish. Publishing needs credentials, so it is the only step outside Nix, and
  it builds nothing: create the GitHub release with the assets from `release/`, then `npm publish` each prebuilt tarball
  in `npm.all` (`legacyPackages.<system>.npm`).
- **npm:** npmjs.com with trusted publishing. The publish job gets `id-token: write` and exchanges its GitHub OIDC token
  for a short-lived npm credential, so no npm token is stored, and npm attaches provenance to each version. Each package
  on npmjs is configured to trust this repository's release workflow (R14).
- **Scheduled:** `nix build --rebuild .#release` to catch non-reproducible outputs.

### 10.6 Development shell

`nix develop` (or direnv, through `.envrc`) provides the toolchain, a writable copy of the library cache, Node, pnpm, hk
and its tools, and the editors' language servers. Day-to-day work runs `meson`, `pnpm` and `hk` directly for fast
iteration; `nix build` is for integration and CI. What it provides, and how, is in `docs/tooling.md` ("The dev shell",
"Editor tooling").

- **WASM toolchain.** `pkgsWasm`'s wrapped compiler, binutils and `pkg-config`, under their target-prefixed names, with
  `meson` and `ninja`. `PKG_CONFIG_PATH` covers the libraries components register in `ibusWeb.toolchain.devLibraries`
  and their propagated inputs. `meson-setup-wasm` runs `meson setup` with `pkgsWasm`'s cross files.
- **TypeScript.** Node 24, nixpkgs' pnpm and the workspace's `tsc`.
- **hk** and every tool its steps run (`pkl`, `oxfmt`, `oxlint`, `nixfmt`, `clang-format` from Emscripten's LLVM,
  `shfmt`, `reuse`, `actionlint`). The shell links hk's pkl package as `.hk` and installs the git hooks, so a commit
  runs the same steps as `checks.flake-hk`; `nix fmt` runs `hk fix`.
- **Language servers.** `clangd`, `typescript-language-server` (a shim that runs the workspace's `tsc --lsp`, since
  TypeScript 7 has no tsserver), `nixd` and `pkl-lsp`. Claude Code reaches them through language-server plugins the
  repository enables, so it is started inside the shell.
- **clangd** comes from the LLVM Emscripten uses, so its builtin headers match, and trusts the wrapped compiler through
  `--query-driver`. The shell links a generated `.clangd` into the checkout that gives loose sources the cross compiler,
  the common flags and the dev libraries' include paths. `checks.toolchain-clangd` keeps every C and C++ source in the
  repository parsing cleanly under it.
- **Generated files.** The shell builds the types Emscripten generates for the repository's JavaScript libraries, as
  git-ignored links, and `write-files` rewrites the generated CI workflow.

### 10.7 Release assets

The npm tarballs, `ibus-runtime.wasm` and its JS glue, each engine's `.wasm`, data archives, manifest and source bundle,
the generated protocol specification and `release.json`. An engine's `.wasm`, data archives and manifest also ship as an
npm package of their own, `@ibus-web/engine-<name>`, under the engine's license.

## 11. Testing

Every test is a flake check, and each kind of code has one structured framework: **GoogleTest** (`pkgsWasm.gtest`, its
`main()` from a shared harness that hands the JSON report to the host) for C and C++ that doesn't link GLib; **GLib's
g_test**, reporting TAP, for C that links GLib; and **Vitest** for TypeScript, with `@effect/vitest` for code written
with Effect. WebAssembly test programs, GoogleTest or g_test, run under Vitest through the test-program shim
(`@ibus-web/test-programs`): a custom Vitest runner under Node and Vitest's browser mode in headless Chromium and
Firefox, each case reported as a Vitest result of its own. There are no ad-hoc `main()` programs with `CHECK` macros or
print-then-grep checks; checks whose only assertion is that something builds, links or stays consistent are not tests
(§10.4). The frameworks, the shim, its storage rules for sequences of programs, and how to add and run a test are in
`docs/testing.md`.

1. **Protocol.** Unit tests and fuzzing for the GVariant codec; C/TS parity (fixtures serialized by real
   `IBusSerializable` in WASM, decoded and re-encoded byte for byte in TS, and the reverse); property tests from
   schema-derived and composed Effect `Arbitrary` inputs with fixed seeds. Parity covers IBus objects in both
   directions, all runtime requests and emitted records, and exact agreement of the strict decoder with GLib's
   `g_variant_is_normal_form` on 1000 fixed-seed byte strings: normal-form encodings with one to three bytes mutated,
   unmutated encodings, and containers with 2- and 4-byte framing offsets, held to floors on the share of normal-form
   inputs and on offset widths so the corpus can't degrade unnoticed. `Crashed (us)` and the generated transport layout
   are covered too.
2. **Runtime.** GLib's own tests (g_test), built by `pkgsWasm.glib`'s recipe and run by `meson test` under Node on
   WasmFS (§10.3) in `checks.glib-tests`, gated by `modules/glib/checks/tests/baseline.toml`: every test that passed in
   three reviewed runs (277 of 301) must pass, and the excluded tests, no part of which can run on Emscripten (11,
   process spawning and sockets), never run. Inside the tests that gate, a subtest whose expectation can't hold here
   skips with its reason. The gate itself is TypeScript, tested with Vitest (`checks.glib-tests-gate`). `docs/glib.md`
   has the results and the reasons. `libibus-web`'s tests are g_test programs under `meson test`
   (`checks.libibus-web-tests`: init, the pump, the wait, dispatch, side-module loading, the archive extractor,
   serialization, emitters, protocol validation, logs and the settings backend), and, if the lazy arity lookup is built
   (§5.1.2), tests for it. `ibus-runtime`'s load contract is Vitest under Node (`checks.ibus-runtime-load`). **The
   IndexedDB backend** is tested where IndexedDB is, in the browsers: `checks.wasmfs-idb-browser` runs its GoogleTest
   programs through the shim in Chromium and Firefox, each in a dedicated Worker on a page served with cross-origin
   isolation; programs named `<prefix>.1`, `<prefix>.2`, … run in order on one origin's storage, so a later one sees
   what an earlier one stored, and every other program starts with that storage cleared. They cover files, directories
   and their persistence across runs; a file read after it is unlinked; reads and writes that touch only the chunks they
   must (counted by a test library linked into tests only); sparse files, truncation, chunk boundaries and `EFBIG`;
   `fsync()` making exactly one strict commit, one that writes; quota failures, injected, that leave the database the
   same byte for byte; read-only and sealed backends refusing every change with `EROFS`; a version change closing every
   backend, with `EIO` after it; a failed open giving its thread back; and the orphan sweep, including one that fails. A
   test context is off the record, and Chromium keeps its IndexedDB in memory, so these checks say nothing about
   durability or its cost; the measurements in `docs/storage.md` use profiles on disk. **The Worker host**
   (`@ibus-web/worker-host`) runs its Vitest suites under Node, with `worker_threads` standing in for browser Workers
   (`checks.worker-host-node`), and in headless Chromium and Firefox, offline in the Nix sandbox, against a server that
   sends COOP/COEP headers on every response (`checks.worker-host-browser`), each on the asserting and the released
   runtime: request latency from cold and back to back, wakes from other threads, source deadlines, thread creation from
   the host and from other threads while the host sleeps, the pool's exhaustion and top-up, threads that end unjoined,
   proxied calls, `fsync()` from a thread, exceptions across modules, thread crashes, a failing relay, and storage: the
   mount and its round trip, the in-memory fallback, a closed connection, installing engine data (fresh, found,
   concurrent, interrupted, upgrades running beside old versions, stale and changed paths, a torn marker, sealed data, a
   failed start letting go of its locks), one writer per engine, and the backend's reads, writes and `fsync()`s at a
   dictionary's scale, for correctness only; timing criteria are asserted on their one-sided part (never early, asleep
   at all) under bounds generous enough for a loaded machine, and their tight figures recorded; its Effect layers are
   tested with `@effect/vitest`. The tests play the page, spinning for replies as the keystroke path does, and a reply
   that needed the page to let go fails as late (`docs/worker-host.md`, "Tests"). `ibusWeb.testing.playwright` supplies
   nixpkgs' browsers and their environment; Chromium keeps its own sandbox unless a builder that forbids unprivileged
   user namespaces turns it off (`chromiumSandbox`), and Firefox needs a writable `HOME`.
3. **Engine conformance.** `checks.hangul-golden` runs 16 C g_test behavior cases plus a run-completion check (17
   reported tests) under Node, loading the real side module and store-path data. Separately, `checks.hangul-host` runs
   ten cases on each asserting/released runtime through a real Node Worker and the test Page's SAB requests. It checks
   composition, Hanja keyboard paging/clicks, Init/settings changes, context lifecycle/independence, surrounding text,
   forwarding, focus, and repeated resource use. Every request checks output sequence and `replyOutSeq`, even when it
   emits nothing; warning/error/critical logs fail. A test-only action performs a real GSettings write to check
   `SettingWritten`, since upstream Hangul has no suitable writing action. It is not a live UI test. Reserved test
   operations `0xff00`–`0xffff` supply statistics only through instruments; the production dispatcher rejects them with
   `-ENOSYS`. The program break (`sbrk(0)`, checked as `breakPeak` against `heapBytes`) peaked at 3,461,120 bytes
   asserting / 3,452,928 released, below the declared 4 MiB; initial/peak pool Workers eight and checked-out pthread
   peak zero support `threads = 0` for this Node storage workload. The break/thread guard fails when declarations become
   insufficient; these measurements are workload evidence, not universal engine bounds. The strict Clang/SARIF cast
   audit covers engine, private libhangul and libibus-web casts against their committed allow-lists. The independent
   native differential tester (§11 and its separate spec) compares ten traces at the native engine D-Bus boundary.
4. **Keystroke path.** Vitest tests against an in-process fake Worker that speaks the ring protocol: timeouts, the
   replay queue, crashes, hangs, fragmented records, ordering with doorbell output.
5. **Adapters and panel.** `packages.playwright-integration` serves the production demo with COOP and COEP and runs
   eight cases in each of Chromium, Firefox and Linux WebKit 26.6, with Playwright's trusted key events: composition
   with the preedit kept out of the value and out of `input` events, commit on blur, one native undo per commit, Hanja
   paging and selection by click and digit, a password field left to native input, recovery after the Worker is really
   terminated, words separated by native Space resets, and a change to the 3-set keyboard that persists across a reload
   and reaches another tab. All 24 pass. WebKit runs in the Nix sandbox on Mesa's software EGL, so it needs no CI
   fallback (R13); it is not Safari, and says nothing about the Safari 17.4 floor.
6. **License boundary.** The CI checks in §9.4.
7. **Performance.** Both benchmarks run on demand, not as checks.
   - `nix run .#protocol-bench` times decoding a framed `UpdateLookupTable` of 500 candidates to its visible page of
     nine, against a 0.5 ms target: 0.086 ms median, 0.286 ms p99 under Node (§6.3).
   - `nix run .#keystroke-bench` times 500 trusted keys in each browser against the production demo, from capture to the
     edit appearing, after 70 warm-up keys. Paint and keyboard hardware are not included.

| Browser           | p50 ms | p99 ms | max ms |
| ----------------- | -----: | -----: | -----: |
| Chromium 153      |  0.805 | 15.115 | 21.105 |
| Firefox 155       |  1.380 |  2.480 |  2.940 |
| Linux WebKit 26.6 |  2.180 |  4.140 |  4.900 |

The keystroke figures were measured at `a174a74`, before the reset-ordering fixes, which were not timed again. Machine
and method are in `docs/testing.md` and `docs/protocol.md`.

## 12. Milestones

|         | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Questions answered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0      | **Done.** M0.1–M0.6. Flake, `emscriptenCache`, `pkgsWasm` and a first `nix flake check`; GLib Emscripten patches rebased onto nixpkgs `glib`; `pkgsWasm.glib` as main module; GLib test subset in Node; minimal `libibus-web`; load a trivial side module and one that starts a pthread; Worker wait loop with Emscripten threads and proxying; WasmFS IndexedDB backend; the Worker host. How each part works and the evidence behind it are the topic pages under `docs/` (`docs/README.md` lists them); what M0 left open is `docs/known-gaps.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Does dynamic linking work with threads? Can the Worker block while threads and WasmFS work (R2)? Where do engine data and user files live? All three are answered: yes, with the toolchain's fixes (R3); yes, the host sleeps in the runtime while threads, proxied calls and `fsync()` complete (R2); in IndexedDB, through a WasmFS backend of our own (§5.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ↳ M0.1  | **Done, merged.** (`docs/toolchain.md`) Dendritic flake (flake-parts, import-tree, treefmt-nix (replaced by hk in M0.6), devshell, flake-root); prebuilt, frozen Emscripten library cache; `wasmStdenv` (replaced in M0.2); WASM libhangul; dynamic-linking spike                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | R3 answered yes for `-sMAIN_MODULE=1`/`-sNODERAWFS=1` under Node (`docs/toolchain.md`, "Dynamic linking"); main modules must link with `em++`; Emscripten 6 defaults to legacy WASM exception handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ↳ M0.2  | **Done, merged.** (`docs/toolchain.md`) `pkgsWasm` cross package set replacing `wasmStdenv`; Emscripten-gated overlays; `legacyPackages` outputs; libhangul, zlib and libffi from unmodified recipes; Meson and cross `pkg-config` proven; WasmFS `-sMAIN_MODULE=2` link check; C, C++ and shell formatting; Darwin evaluation restored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | nixpkgs' cross-compilation machinery works with Emscripten as its compiler (R17 resolved); libffi's WASM backend works; the wrapper must drop `-static-libgcc` and `--undefined-version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ↳ M0.3  | **Done, merged.** (`docs/glib.md`) `pkgsWasm.glib` from nixpkgs' `glib` with a 16-patch Emscripten series (Wolthuizen's, Fluendo's `glist` fix, ours); GLib's tools as `.js` programs under Node; patched `gdbus-codegen` for consumers; GLib's own tests under Node with a gating baseline; Meson host system `emscripten`; `-O2` builds; prefixed binutils; WASM dev shell with clangd; REUSE licensing metadata (`LICENSES/`, SPDX headers, `REUSE.toml`) enforced by `checks.reuse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | GLib 2.88.3 builds for WASM with GRegex and its tools; 277 of 300 of GLib's own tests pass under Node and gate CI; class handlers work without the arity lookup; the remaining function-pointer gap is user callbacks with fewer parameters (§5.1.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ↳ M0.4  | **Done.** (`docs/runtime.md`) The `runtime/` component; GLib's wake hook; `libibus-web` skeleton (pump, `ibusweb_wait`, side-module loader, spike dispatcher; g_test under `meson test`); `ibus-runtime.wasm` with `-sMAIN_MODULE=2`, WasmFS, a fixed imported memory and a strict thread pool, and a per-library export manifest; Emscripten patches for blocked main threads' thread cleanup, reused `pthread_t`s and an imported memory's maximum; pnpm workspace built offline in Nix; spike Worker host and wake relay under Node, Chromium and Firefox; Emscripten's minimum versions from Baseline Widely available                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | R2 settled: the host sleeps in the runtime, woken by GLib's hook and a host-side relay; threads come from a pool sized from shares plus spares, strict, topped up while idle. R3 settled for `-sMAIN_MODULE=2`/WasmFS in Node, Chromium and Firefox. Memory is fixed per Worker, since V8 traps atomics on grown shared memory. OPFS is out: engine and user data go to IndexedDB (M0.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ↳ M0.5  | **Done.** (`docs/storage.md`) WasmFS IndexedDB backend (full lazy) in `runtime/wasmfs-idb/`: files as `ArrayBuffer` chunks of 16 KiB, read and written lazily on the backend's own thread, writes write-through, `fsync()` a strict commit that writes, versionchange closing, a seal and a closed flag in its API (§5.6); its JavaScript library type-checked; a reusable browser test runner; the runtime mounts it in browsers, WasmFS's Node backend under Node and the memory backend without IndexedDB; engine data in a database per version, installed from ustar archives under per-version Web Locks, sealed and marked, old versions collected; one writer per engine's user data; Emscripten patches for symlink errors and a backend thread's heartbeat; a Firefox floor of 126; upstream draft `docs/upstream/wasmfs-idb-backend.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | R2 for the IndexedDB backend: `fsync()` from a pthread completes while the host sleeps, in 4.3 ms in both browsers, within a poll step of the memory backend. A lazy 4 KiB read costs a keystroke 0.2–0.32 ms at 16 KiB chunks, and no read or write waits for the page's spin; 16 KiB is the cheapest of 16, 64 and 256 KiB for it, and chunks stay under 64 KiB, which Chromium stores as Blobs. An empty strict commit syncs nothing in either browser; a synced append costs about 0.5 ms. Chromium lets go of a terminated Worker's locks some 2 s late, so the page waits for the writer lock before a restart (§5.6)                                                                                                                                                                                                                            |
| ↳ M0.6  | **Done.** (`docs/worker-host.md`, `docs/testing.md`, `docs/tooling.md`) `@ibus-web/worker-host` on Effect 4, carrying the spike host's behaviour with its scenarios as Vitest suites under Node, Chromium and Firefox; nixpkgs and flake-parts from FlakeHub; every test structured: GoogleTest for C and C++ without GLib (linked with `-sPROXY_TO_PTHREAD`, `main()` from a shared harness), GLib's g_test for C that links it, Vitest for TypeScript (`@effect/vitest` for Effect code), with the browser test runner replaced by the test-program shim, which runs each WASM program under Node or in Chromium and Firefox and reports each of its cases as a Vitest result; JavaScript that Emscripten doesn't read itself rewritten in TypeScript, the JavaScript it does read typed with JSDoc, and one TypeScript configuration and check across the repository; hk (`hk.pkl`) holding every formatter and lint step, run by the git hooks, `nix fmt` and `checks.flake-hk`, in place of treefmt; oxfmt and oxlint in place of prettier; Claude Code's language-server plugins (clangd, TypeScript, Nix, Pkl) on the dev shell's servers; clangd's configuration following the flake; CI on GitHub Actions, written in Nix, with FlakeHub Cache and a private rolling FlakeHub publish (§10.5); the upstream drafts refreshed against Emscripten's `main`, with an order to post them in; the milestone plans and spike reports replaced by topic pages under `docs/` and `docs/known-gaps.md`, and the spike checks' coverage moved into the runtime's and the host's tests | What of M0's plans and spikes is still needed, and where it belongs: the topic pages under `docs/`, the tests that replaced the spike checks, and `docs/known-gaps.md` for what stays open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M1      | **Done.** Hangul end to end, in M1.1–M1.4b: engine, protocol, Worker transport, page core, persistent settings, panel, facade and demo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Hangul types correctly through the whole stack in Chromium, Firefox and Linux WebKit with trusted key events, and the candidate decode target is met. Unverified: Safari 17.4 on macOS, system layouts other than US, a real CodeMirror integration and paint latency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ↳ M1.1  | **Done.** IBus types and engine API, framed dispatcher/output, settings backend, strict cast audit, Hangul side module/data and 16 Node golden cases; runtime ABI 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Hangul needs one cast patch (two init arity fixes and one destroy pointer type), three port fixes, and GLib listener patch 0018. No lazy arity lookup needed for Hangul; GSettings bridge works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ↳ M1.2  | **Done.** Strict TypeScript GVariant codec matching GLib's normal form, IBus struct and message schemas, framing, generated C header and wire reference, fixed-seed property tests and real IBus WASM C/TS parity, including exact normal-form agreement on 1000 mutated and valid encodings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 500-candidate framed decode (`nix run .#protocol-bench`): 1.01 ms median, 4.40 ms p99 (64,832 bytes; bytes to tree 0.43 ms, tree to schemas 0.46 ms); 0.5 ms target unmet, so M1.4b owns lazy candidate decoding. AOT did not help. See `docs/protocol.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ↳ M1.3  | **Done.** Host output ring and fragments, ordered replyOutSeq/coalesced doorbells, engine scopes, Init-then-load, store-path data closures, Brotli installation, manifest-derived pool/memory and real-engine SAB conformance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Hangul runs through a real Node Worker/Page; ordered replies and full-ring waits are checked. Data retains Nix paths. Measured program-break peaks fit 4 MiB and Node engine-thread demand is zero; full ABI identity and shared store remain gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ↳ M1.4a | **Done.** (`docs/core.md`) `@ibus-web/core`: generated key tables and translation, the Worker connection, sync, async and manual surfaces sharing one replay queue per engine, the client's preedit and surrounding-text duties, hang detection and restart with the writer-lock wait, an in-memory settings source, runtime constants shipped with the runtime, and a first Hangul demo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Hangul types through the real host and runtime in Chromium and Firefox. Engines need the client to commit a COMMIT-mode preedit on blur and reset, and Hangul must not see `SYNC_PROCESS_KEY_V2`. Editors that own their keys can share the queue through `keyAsync`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ↳ M1.4b | **Done.** (`docs/panel.md`, `docs/ibus-web.md`) Settings metadata generated through GLib; the IndexedDB and `BroadcastChannel` persister; lazy lookup-table decoding; the textarea adapter's preedit overlay and single-step undo; `@ibus-web/panel`; the `ibus-web` facade; the full demo; Playwright in three browsers; the keystroke benchmark and the bundle scan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | All 24 trusted-input cases pass; WebKit runs in the Nix sandbox on software EGL. Visible-page decode is 0.086 ms median, under the 0.5 ms target. Undo is native only for focused commits; an unfocused commit falls back to `setRangeText`. Typed errors and crash diagnostics don't reach the host yet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M2      | Custom table engine and `contenteditable` adapter, in M2.1–M2.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Router generality; non-GPL engine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ↳ M2.1  | **Done.** (`docs/table.md`, `docs/engines.md`) Modules and engines on the page side: engine descriptors, `select(module, engine?)`, `deselect`, `selectionchange`, and `CreateEngine` failure reasons reaching the page; the table engine: one C++23 side module with `latex` (generated from W3C's `unicode.xml`) and `xsampa` (hand-written) over MARISA, command and continuous modes (Escape commits the pending buffer raw); `@ibus-web/engine-table`, the table module in the demo, and its Playwright integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The 49 native golden tests pass. `table-host` runs 14 cases under Node, 7 per runtime build, asserting and released. The LaTeX table loads in 7.5 ms for the first context and 1.1 ms for later ones under Node, within `heapBytes` of 4 MiB. Playwright runs 45 tests across Chromium, Firefox and WebKit. `CreateEngine` failure reasons reach the page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ↳ M2.2  | **Iceboxed.** `contenteditable` adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M3      | **Done.** (`docs/mozc.md`) Mozc 2.30 with nixpkgs' UT dictionaries, through Mozc's own Bazel build: the converter, its session layer and ibus-mozc in one side module, with Mozc's client library handing commands to the converter in-process rather than to `mozc_server`; a hand-written module init in place of ibus-mozc's `main()`; settings from a GSettings schema; `@ibus-web/engine-mozc`, Mozc in the demo, and its Playwright integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Can an upstream Bazel build target WebAssembly, and can an engine built around a server run without it? Both yes. `mozc-host` converts, pages through candidates and commits from the panel on each runtime build, starting in 674–833 ms with its 54 MB data set installed from Brotli, within a declared 75 MiB program break. All 416 compiles pass the cast audit with an empty allow-list. Playwright types through it in Chromium, Firefox and WebKit                                                                                                                                                                                                                                                                                                                                                                                            |
| M4      | **Done.** (`docs/m17n.md`) ibus-m17n 1.4.40 over m17n-lib 1.8.6 with m17n-db 1.8.10's input methods: 197 engines, every input method ibus-m17n lists, in one side module, with their descriptors printed by a program that runs the module's own listing; settings addressed by path from the build to the page, with ibus-m17n's relocatable schema at each engine's path and m17n's 53 variables as 34 generated schemas; IBus's US keymap in libibus-web; `@ibus-web/engine-m17n`, m17n in the demo with its engines grouped by language, and its Playwright integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Can a real port read and delete surrounding text, can one relocatable schema hold many engines' settings, and can one module carry many engines? All three yes. `th:kesmanee` takes a tone mark only after the consonant the surrounding text gives it, under Node and in each browser's textarea, and `m17n-golden` deletes surrounding text for it. A change at one engine's path reaches that engine's contexts and no other's, and `Init` declares all 232 instances in 22,378 bytes. One Worker holds all 197 engines open within a declared 31 MiB program break, starting in 561–718 ms under Node with its data installed from Brotli and in 1014–2906 ms from IndexedDB in the browsers. Playwright types Hindi, Vietnamese and Thai in Chromium, Firefox and WebKit                                                                          |
| M5      | **Done.** (`docs/rime.md`) ibus-rime 1.6.1 over librime 1.17.0 with librime-lua and librime-octagram, and every schema of `rime-data`, `rime-loengfan` and `rime-ice`, deployed at build time: 47 engines, one per schema, `rime:rime_ice` the default; settings through GSettings, from which the module writes Rime's `*.custom.yaml` and redeploys on the deployer thread; Rime's switches as IBus properties a page can drive from its own controls; per-engine data, each engine's dictionaries installed when it is first made; a build with fewer schemas through `schemas`; `@ibus-web/engine-rime`, Rime in the demo, and its Playwright integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Can a real engine run threads of its own, and can its data come per engine? Both yes. LevelDB's compaction thread and the deployer's run within the declared 2 engine threads and 150 MiB program break under `rime-host`, which starts the module in 936 ms under Node with its common data installed from Brotli, and a learned word survives a reload in each browser, from LevelDB over IndexedDB. A page downloads only the dictionaries of the engines its users pick: `rime_ice`'s 23.9 MB of the 82.2 MB, its first selection taking 1,891–2,818 ms in the browsers. R19 closed with libpinyin dropped: native librime with `rime_ice` and no grammar model converts 51.5 % of 1,000 Tatoeba sentences exactly to libpinyin's 40.6 % (§13). Playwright types pinyin and Cangjie and drives a page's own switch in Chromium, Firefox and WebKit |
| M6      | 1.0: finished facade, docs, generated protocol spec, release pipeline with source bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 13. Risks and open questions

- **R1. Arity-tolerant callbacks.** The lazy lookup in §5.1.2 is unproven: the cost of a JS call per mismatched
  callback, and whether `.length` is reliable for every table entry Emscripten creates, are measured in M1. If the audit
  finds few mismatches, engine patches replace it.
- **R2. Blocking the Worker. Settled.** The Worker host sleeps inside the runtime, in `ibusweb_wait`, so calls other
  threads proxy to its thread, `pthread_create()` among them, run while it sleeps; a host-side relay forwards the page's
  wakes into WASM memory (§5.2.4). Threads come from a pool sized for the planned peak plus spares, fail with `EAGAIN`
  beyond it and are topped up while the host is idle (§5.3). Threads that end unjoined are reclaimed inside the wait by
  a toolchain patch to Emscripten, and `dlopen()` with live threads needs a second (§10.3); both are tracked by drafts
  in `docs/upstream/`. Calls Emscripten proxies as promises complete too: `fsync()` on WasmFS's memory and Node backends
  doesn't proxy at all, and on its OPFS backend, which proxies to the backend's own thread, it completes in both
  browsers while the host sleeps, because the backend's thread is notified directly through `Atomics.waitAsync`. All of
  this was measured under Node, Chromium 149 and Firefox 151 (`docs/runtime.md`, "Waking the host" and "Threads"). So
  does `fsync()` on the IndexedDB backend (§5.6), proxied the same way: 4.3 ms from a pthread while the host sleeps, in
  both browsers, against 4.2 ms on the memory backend, where the scenario's 2 ms poll dominates; the host's wakes aren't
  counted there, so that it never woke is shown by the time alone, and by the backend's calls running on its own thread.
  Still open: GLib's share covers one `GTask` in flight, and `GTask`s in flight at once can take more workers, up to its
  pool of 10 and beyond, so engines that run them concurrently need a rule; and the top-up rests on Emscripten's
  internal `PThread` until Emscripten has a public call to grow the pool.
- **R3. Dynamic linking with pthreads. Settled.** §5.3's thread pool is pre-allocated, so its workers exist before
  `main` runs and side modules load after the pool already exists: the harder case for dynamic linking with pthreads.
  The M0.1 spike passed in the `-sMAIN_MODULE=1`/`-sNODERAWFS=1`/Node configuration, and M0.4's in the runtime's own,
  `-sMAIN_MODULE=2` with WasmFS, under Node and in Chromium 149 and Firefox 151: side modules loaded into a runtime
  whose pool already runs, threads on pool Workers calling into them, a C++ exception thrown in a side module and caught
  in the runtime, and `dlopen()` while other threads run, once Emscripten's race on reused `pthread_t`s is patched
  (§10.3; `docs/toolchain.md`, "Dynamic linking"). WebKit isn't run (R13).
- **R4. GLib patch rebases.** The series is rebased from Wolthuizen's per-release `wasm-vips-<version>` branches, so
  each nixpkgs GLib update means rebasing from the nearest one. `checks.glib-patches` fails first when a nixpkgs update
  breaks the series. `ibusWeb.toolchain.mesonCrossFlags` imports nixpkgs' `pkgs/build-support/lib/meson.nix`, so an
  update that moves that file fails evaluation.
- **R5. The IndexedDB backend. Narrowed.** The backend is built (§5.6) and ours to keep until upstream takes it (draft
  `docs/upstream/wasmfs-idb-backend.md`). Its cost is measured: a lazy 4 KiB read costs a keystroke 0.2–0.32 ms at 16
  KiB chunks in Chromium 149 and Firefox 151, and nothing it does waits for the page's spin. Its values must stay
  `ArrayBuffer`s under 64 KiB serialized, since a `Blob` brings back Firefox's wait on the page and Chromium wraps
  larger values as `Blob`s. Still open: WebKit's IndexedDB in Workers is unchecked (R13); quota failures are injected in
  the tests, not reached; the figures come from one machine's disk; and under Node, where the Node backend stands in,
  read-only mounts and seals aren't enforced and Web Locks don't span processes. The fallback is an in-memory mount, its
  data's size added to the runtime's memory, with an event.
- **R6. libpinyin databases in WASM. Withdrawn** with libpinyin (D2).
- **R7. Rime data size. Resolved** by per-engine data (§5.6). The shipped dictionaries come to 82.2 MB as Brotli; each
  engine names its own and its dependencies' as data installed when it is first made, so a page downloads only those of
  the engines its users pick: `rime_ice`'s 23.9 MB, beside 1.0 MB of common data at the module's start. The install
  window this needs is weaker than the seal it replaces (§5.6).
- **R8. Engine patch acceptance.** Cast fixes are UB fixes that upstreams may accept, shrinking the patch layers over
  time. Not required.
- **R9. Toolchain fix.** If `-fwasm-fix-function-bitcasts` or a call-site alternative ships in Emscripten, re-evaluate
  §5.1.1 and remove the cast layer.
- **R10. Decode speed. Resolved.** Candidates are decoded lazily (§6.3), well inside the budget under Node. Browser
  keystroke latency is measured separately (§11.7).
- **R11. Legal review.** The boundary argument in §9 needs counsel before 1.0.
- **R12. nixpkgs Emscripten's LLVM.** nixpkgs pairs Emscripten with its own LLVM, not the revision upstream tests with,
  and its package runs only a hello-world test. Our test suites are the real check; if a codegen issue appears, override
  the Emscripten or LLVM version in the flake. At `8ce4ef6`, nixpkgs pairs Emscripten 6.0.9 with LLVM 22.1.8; upstream
  Emscripten expects 24.
- **R13. WebKit in the Nix sandbox. Resolved for Playwright.** Linux WebKit 26.6 runs in the sandbox on Mesa's software
  EGL, and the Playwright suite includes it. Still unchecked: Safari on macOS, and the WasmFS IndexedDB backend's tests
  in WebKit.
- **R14. First publish with trusted publishing.** Check whether npm allows configuring a trusted publisher before a
  package's first version exists. If not, each package's first version needs a one-time manual publish.
- **R15. Native assumptions in nixpkgs recipes.** Engine recipes include desktop features (setup programs,
  notifications) and patches for them. Overrides remove them per engine; a nixpkgs update can add new ones, which the
  WASM build or conformance tests will surface.
- **R16. libpinyin binary data. Withdrawn** with libpinyin (D2).
- **R17. Platform identity of WASM builds. Resolved.** WASM packages come from `pkgsWasm`, whose `hostPlatform` is
  `wasm32-unknown-none` (static), so dependencies are routed by cross splicing and recipes' platform checks see WASM.
  Evaluation succeeds on Darwin again; Darwin builds are not yet verified on a Darwin builder.
- **R18. WebAssembly exception encoding.** `-fwasm-exceptions` emits the legacy encoding, which Firefox warns is
  deprecated for every Worker that instantiates the runtime. Emscripten's `-sWASM_LEGACY_EXCEPTIONS=0` emits the
  standard one (exnref, `try_table`), a compile and link setting that rebuilds every object and the cache. Its support
  (Chrome 137, Firefox 131, Safari 18.4) is Baseline newly available, widely available from about November 2027; Node
  24.20 was measured to validate it. The switch waits until the minimum versions (§10.3) include it:
  `checks.toolchain-exnref` reads exnref's minimum versions from Emscripten's feature matrix (`tools/feature_matrix.py`)
  and fails, asking for the switch, once the derived minimum versions all reach them.
- **R19. Rime's sentence conversion. Settled in M5: libpinyin stays dropped.** `tools/pinyin-compare` converts 1,000
  Mandarin sentences from Tatoeba, of 8 characters or more, typed as toneless pinyin without separators, with native
  libpinyin 2.11.91 at ibus-libpinyin 1.16.5's default options and native librime 1.17.0 with `rime-ice` 2026.06.30's
  `rime_ice`, each with fresh user data and neither with a grammar model; `nix build .#ibus-web-pinyin-compare-report`
  rebuilds the report. Rime converts 51.5 % of the sentences exactly to libpinyin's 40.6 %, 10.9 points ahead (95 %
  interval of the paired difference 7.7 to 14.1), and 90.8 % of their characters to 89.0 %, 1.8 points ahead (1.1 to
  2.6). Its lead narrows with length: on the 79 sentences of 20 characters or more the two are level within the
  intervals (exact 20.3 % and 16.5 %, characters 87.7 % and 88.3 %). libpinyin is ahead on neither metric, so M5 ships
  `rime-ice` without a grammar model, libpinyin stays dropped (D2), and the 398 MB model isn't needed to match it.

## 14. References

- Kleis Auke Wolthuizen's GLib `wasm-vips-<version>` branches: https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1
- Fluendo GLib `gst.wasm`: https://github.com/GNOME/glib/compare/2.76.0...fluendo:glib:gst.wasm
- Fluendo LLVM `wasm-function-pointers`:
  https://github.com/llvm/llvm-project/compare/main...fluendo:llvm-project:wasm-function-pointers
- LLVM PR #153168 (function bitcasts in Clang): https://github.com/llvm/llvm-project/pull/153168
- GLib #3596 (WebAssembly support), MR !4469 (function-pointer cast requirements), #3670, MR !4660:
  https://gitlab.gnome.org/GNOME/glib/-/work_items/3596
- GLib toolchain requirements: https://gitlab.gnome.org/GNOME/glib/-/blob/main/docs/toolchain-requirements.md
- Emscripten #11066 (GLib port), #23952 and PR #24169 (cast emulation deprecation and revert), #22285 (exceptions with
  `MAIN_MODULE` and cast emulation), #15081: https://github.com/emscripten-core/emscripten/issues/11066
- xorgproto `keysymdef.h`: https://gitlab.freedesktop.org/xorg/proto/xorgproto/-/blob/master/include/X11/keysymdef.h
- Chromium `dom_code_data.inc`:
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/events/keycodes/dom/dom_code_data.inc
- Effect 4 documentation: https://www.effect.website/docs/v4/
- nixpkgs Emscripten package and documentation (at `8ce4ef6`): `pkgs/development/compilers/emscripten/default.nix`,
  `doc/languages-frameworks/emscripten.section.md`, `pkgs/top-level/emscripten-packages.nix`
