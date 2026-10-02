# ibus-web design

- **Status:** Approved (2026-09-26); expected to change as milestones find problems
- **Date:** 2026-09-26
- **Author:** Alexis Williams

## 1. Summary

ibus-web runs minimally modified C and C++ IBus engines in the browser. It has
two halves:

- **Worker side:** a WebAssembly runtime (a patched GLib plus a fresh
  implementation of `libibus`) that hosts one engine per Web Worker, loaded as
  a dynamically linked side module.
- **Page side:** a TypeScript library that replaces what the IBus daemon, the
  input-method module and the panel do on the desktop. It translates DOM key
  events, routes them to engines, applies their output to text surfaces and
  exposes panel state to a UI.

The halves talk only through a documented, versioned protocol over a dedicated
`SharedArrayBuffer`. That boundary is both an engineering interface and the
licensing boundary that keeps GPL engines from reaching the page code.

ibus-web is a standalone open-source project with its own releases. Products
depend on a version of it (`ibus-web vX.Y.Z`); everything needed to use it,
build it and meet its license obligations comes with that release.

### 1.1 Goals

- Run these engines in the browser with the smallest possible patch set to the
  engine code: **ibus-hangul, ibus-m17n, ibus-libpinyin, ibus-rime**, and a
  new table-style engine for extended Latin, Greek, Hebrew and similar scripts.
- Keep engine behavior exact on the keystroke path: every key gets the engine's
  real `process_key_event` answer, in order.
- Keep GPL code out of the page: the page-side packages are usable by
  proprietary hosts.
- Be a library, not an app: headless core, optional default panel, pluggable
  text surfaces, host-controlled settings and logging.

### 1.2 Non-goals

- A browser extension or input on arbitrary third-party pages. Hosts own the
  page and its text surfaces.
- Python engines (ibus-anthy, ibus-table, ibus-typing-booster).
- Preferences UI. Hosts build settings UI on the settings API.
- A first-party CodeMirror adapter in v1. The adapter contract is checked
  against CodeMirror 6 so it can be written later (§7.2.4).
- Running engines on the main thread.

### 1.3 Governing principle

**Patch GLib and the runtime freely; keep engine patches minimal.** When a
problem can be fixed in `pkgsWasm.glib`, `libibus-web` or the Worker host instead
of in engine code, fix it there.

## 2. Context and constraints

- **Hosts are cross-origin isolated.** COOP/COEP is already in place in the
  first consuming application, so `SharedArrayBuffer`, `Atomics` and WASM
  threads are available.
- **Engines are GObject code.** `IBusEngine` subclasses use `G_DEFINE_TYPE`,
  GObject signals and GLib throughout. Settings come from GSettings (Hangul,
  libpinyin, m17n) or YAML files (Rime). "Minimally modified" therefore
  requires real GLib and GObject, plus the GSettings part of GIO.
- **Engine libraries are sizable.** libhangul (C, small), m17n-lib (C, data in
  m17n-db), libpinyin (C++, database backend), librime (C++, Boost, LevelDB,
  marisa-trie, OpenCC, yaml-cpp, glog; a deployer thread).
- **Licenses are mixed.** Engine glue is GPL (versions vary by project);
  libpinyin is GPL; libhangul and m17n-lib are LGPL; librime is BSD; GLib is
  LGPL-2.1+. See §9.
- **WASM rejects function-pointer signature mismatches.** GLib and GObject
  code relies on calling functions through mismatched pointer types. Upstream
  GLib requires the toolchain to handle this (§5.1.1).
- **The first consuming application is written in Effect 4.** The page side
  and the Worker host are written in Effect 4, with a non-Effect facade for
  hosts (§7.4).

## 3. Decision log

| #   | Decision             | Chosen                                                                                                                                                                                                                                     | Main alternatives rejected                                                        |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| D1  | Deployment           | Library inside host-owned pages                                                                                                                                                                                                            | Browser extension; canvas remote desktop                                          |
| D2  | Engine targets       | Hangul, m17n, libpinyin, Rime, custom table engine                                                                                                                                                                                         | Arbitrary engines from day one                                                    |
| D3  | Engine compatibility | Real GLib/GObject/GIO subset; engine glue compiles with small, layered patches                                                                                                                                                             | Source-unmodified (forces a full GIO port); porting guide with a GObject-free API |
| D4  | Main loop            | No `GMainLoop`; pump the default context after each dispatch and on source deadlines                                                                                                                                                       | Real `GMainLoop`                                                                  |
| D5  | Where engines run    | One Worker per engine module, keeping GPL code out of the page                                                                                                                                                                             | Main thread; Worker per input context; one Worker for everything                  |
| D6  | Keystroke answer     | Main thread spin-waits on a SAB reply with a time budget; consume-and-replay on timeout                                                                                                                                                    | Always consume and re-implement editing; predict from composition state           |
| D7  | Instances            | One engine instance per input context via `IBusFactory`                                                                                                                                                                                    | Shared instance                                                                   |
| D8  | Linking              | Shared `ibus-runtime.wasm` main module; engines as side modules                                                                                                                                                                            | Static GLib in every engine                                                       |
| D9  | GLib base            | nixpkgs `glib` plus Wolthuizen's per-release Emscripten patches, rebased onto nixpkgs' GLib, as a patch series; nixpkgs Emscripten with small fixes tracked upstream, no forked compiler or LLVM                                           | `EMULATE_FUNCTION_POINTER_CASTS`; Fluendo GLib + patched Clang                    |
| D10 | Settings             | GSettings backend bridge and API only                                                                                                                                                                                                      | Generated forms; per-engine UI                                                    |
| D11 | UI                   | Headless core plus separate default panel package                                                                                                                                                                                          | Headless only; built-in themed panel                                              |
| D12 | Surfaces             | Adapter contract; `<input>`/`<textarea>` and `contenteditable` built in                                                                                                                                                                    | Textarea only; CodeMirror adapter in v1                                           |
| D13 | Storage              | WasmFS per Worker on IndexedDB, through our own lazy backend that stores files as ArrayBuffer chunks; one directory per engine                                                                                                             | Host-managed storage only; WasmFS's OPFS backend; ZenFS; IDBFS                    |
| D14 | Wire format          | IBus Engine D-Bus methods and signals, GVariant-encoded                                                                                                                                                                                    | Custom CBOR mapping                                                               |
| D15 | Output transport     | One sequenced, variable-length, back-pressured output ring per Worker                                                                                                                                                                      | Fixed-size ring with eviction; ring of descriptors into a shared heap             |
| D16 | TypeScript stack     | Effect 4 throughout, including the Worker host; the keystroke path and the Worker request loop are synchronous sections                                                                                                                    | Plain TypeScript; Effect 3                                                        |
| D17 | Protocol definition  | Effect Schema as the source of truth, with a GVariant byte codec                                                                                                                                                                           | Hand-written codec and separate docs                                              |
| D18 | First milestone      | Hangul spike end to end                                                                                                                                                                                                                    | libpinyin or Rime first                                                           |
| D19 | Build orchestration  | Nix flake for toolchain, every artifact, checks and the release set; dependencies, engines and data come from a nixpkgs cross package set for wasm32-unknown-none with Emscripten as its compiler; CI only builds outputs and uploads them | emsdk plus scripts; per-language build tools orchestrated by CI                   |
| D20 | npm registry         | npmjs.com with trusted publishing from GitHub Actions                                                                                                                                                                                      | GitHub Packages                                                                   |

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
| `ibus-runtime.wasm` | WASM     | Worker         | release asset                                                           | LGPL-2.1-or-later (combined) |
| Engine side modules | WASM     | Worker         | release asset per engine                                                | engine's own license         |
| Worker host         | TS       | Worker         | `@ibus-web/worker-host`                                                 | MIT OR Apache-2.0            |
| Protocol            | TS       | Page and tests | `@ibus-web/protocol`                                                    | MIT OR Apache-2.0            |
| Router and services | TS       | Page           | `@ibus-web/core`                                                        | MIT OR Apache-2.0            |
| Facade              | TS       | Page           | `ibus-web`                                                              | MIT OR Apache-2.0            |
| Surface adapters    | TS       | Page           | in `@ibus-web/core`                                                     | MIT OR Apache-2.0            |
| Default panel       | TS       | Page           | `@ibus-web/panel`                                                       | MIT OR Apache-2.0            |

### 4.2 One keystroke, end to end

1. The surface adapter's capture-phase `keydown` listener calls
   `KeySink.key(event)`.
2. The keystroke path translates the event into `(keyval, keycode, state)`
   (§7.1.1). If no engine is enabled, or the key is on the active engine's
   declared pass-through list, it returns `passthrough` immediately.
3. It encodes `ProcessKeyEvent` into the request slot and signals the Worker.
4. The Worker host wakes, calls `ibusweb_dispatch`, which calls the engine's
   `process_key_event` vfunc. Engine output (`CommitText`,
   `UpdatePreeditText`, …) is appended to the runtime's output buffer.
5. The dispatcher pumps due GLib sources, flushes the output buffer into the
   output ring and writes the reply: the return value and the last output
   sequence number.
6. The main thread, spinning, drains the ring as records arrive and sees the
   reply.
7. It applies the decoded records to the surface inside one `batch()`, pushes
   panel events and returns `consumed` or `passthrough`.
8. The adapter calls `preventDefault()` and `stopPropagation()` when the key
   was consumed.

## 5. Worker side

### 5.1 `pkgsWasm.glib`

nixpkgs' `glib` recipe with an Emscripten patch series kept in this
repository (§10.3). The series starts from Kleis Auke Wolthuizen's
Emscripten patch set (the one wasm-vips uses), taken from his per-release
[`wasm-vips-<version>`](https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1)
branches of GLib and rebased onto nixpkgs' GLib (2.88.3), plus Fluendo's
`glist`/`gslist` signature fix and our own. Built with nixpkgs Emscripten
and Meson cross files (§10). D-Bus,
networking, subprocesses and file monitoring are disabled or stubbed; GIO is
kept for GSettings and the types it needs.

#### 5.1.1 Function-pointer casts

- **Background.** GLib documents that it requires calls through mismatched
  function-pointer types to work, and that Emscripten builds must use
  `-sEMULATE_FUNCTION_POINTER_CASTS` (GLib MR !4469). Upstream rejected
  removing the mismatches (!4660, #3670). Emscripten kept the flag for GLib's
  sake (PR #24169).
- **Why not cast emulation.** With `-sMAIN_MODULE` it breaks catching C++
  exceptions (emscripten#22285, open), and our C++ engines need exceptions.
  It also slows every indirect call.
- **Why not Fluendo's Clang.** `-fwasm-fix-function-bitcasts`
  ([llvm#153168](https://github.com/llvm/llvm-project/pull/153168)) is
  unmerged and contested, needs a forked LLVM for everyone who builds an
  engine, and does not cover callbacks stored as `gpointer`, which is how
  `GCClosure` holds signal handlers.
- **Chosen.** The series' source-level fixes, including the `G_DEFINE_TYPE`
  header fixes, which engines pick up automatically.
- **Watch.** If a toolchain-level fix ships in Emscripten, drop the engine cast
  patch layer (§5.4.2) and re-run the audit.

#### 5.1.2 Callbacks with fewer parameters

Most engine-side mismatches are callbacks that declare fewer trailing
parameters than the caller passes: signal handlers without `user_data`,
`(GFunc) g_free`, and similar. When GLib is the caller, `pkgsWasm.glib` absorbs
the mismatch so the engine needs no patch.

- **Class handlers.** Class closures never take `user_data`, so on
  WebAssembly they are marshalled through libffi with the instance and the
  signal's parameters only. This covers class-struct handlers,
  `g_signal_new_class_handler`, overrides and chaining up, without knowing
  anything about the callee.
- **Other callbacks: lazy arity lookup.** A function pointer is an index into
  the WASM function table, and the function there has a JS `.length` equal to
  its parameter count. At the covered call sites GLib asks for it through a
  small `EM_JS` helper and caches the answer per function pointer, so a
  pointer is looked up once. Nothing is scanned ahead of time, and side
  modules loaded later need no extra step.
- **Covered call sites.** Closure invocation (the generated marshallers and
  `g_cclosure_marshal_generic`), `g_list_foreach`, `g_slist_foreach`,
  `g_ptr_array_foreach`, `g_hash_table_foreach` and its `_remove`/`_steal`
  variants, `GDestroyNotify` calls, `GSourceFunc` dispatch and sort comparison
  callbacks.
- **Calling.** Calls with matching arity take the normal path. When the callee
  takes fewer parameters, the call goes through JS (`wasmTable.get(fp)(…)`),
  which drops the extra arguments itself.
- **Not covered.** Callees declaring _more_ parameters than passed, and
  mismatches in engine code that GLib never calls. Those need engine patches.
- **Audit output.** Debug builds log every absorbed mismatch with the callee's
  name and the call site. That log is the engine audit report (§11.3).
- **Only if needed.** The lookup is built when the engine audit shows it pays
  for itself. If the target engines have only a few such callbacks, they are
  fixed in each engine's `patches/casts` instead and the lookup is not built.

#### 5.1.3 Other `pkgsWasm.glib` changes

- Hooks for the pump (§5.2.4) and GSettings backend registration (§5.2.5).
  The pump hook includes the context wakeup: on WebAssembly,
  `g_wakeup_signal` (reached through `g_main_context_wakeup`) also calls a
  hook, after waking the wakeup's own futex, from whichever thread
  signals. `libibus-web` installs it with
  `g_main_context_wasm_set_wake_hook()` on the default context; a context
  takes one hook for its life, published with a compare-and-swap, so a
  second call fails with a critical whatever `G_DISABLE_CHECKS` says. The
  hook bumps and notifies the word in WASM memory the Worker host sleeps on
  (§5.2.4). It also runs on the owning thread during its own iterations,
  where it is harmless.
- Blocking iteration (`g_main_context_iteration(ctx, TRUE)`,
  `g_main_loop_run`) sleeps. On WebAssembly a `GWakeup` is an atomic
  counter with futex wake and wait (`emscripten_futex_wake`/`_wait`), and a
  blocking iteration waits on its context's wakeup for the computed
  timeout instead of calling `poll()`, which can't wait there. Any fds are
  probed with a zero timeout between waits of at most 10 ms. Another
  thread's change to the context (`g_main_context_wakeup`, attaching a
  source, quitting a loop) ends the wait. The runtime's pump still
  iterates without blocking, which is unchanged. A wakeup asked for a
  poll fd (GCancellable's `g_cancellable_get_fd`,
  `g_cancellable_make_pollfd`) gets a pipe that mirrors the futex;
  contexts never ask, so they have none. `g_poll()` with a timeout probes
  and sleeps in 10 ms slices, since Emscripten's `poll()` can't wait.
- `GTimeZone` takes IANA zones from JavaScript's `Intl` API, not from
  zoneinfo files, so the runtime ships no tzdata: GLib's TZif parser gets
  data synthesized from `Intl.DateTimeFormat` for 1800–2100, continued
  past 2100 by a POSIX rule where the zone's pattern is one, and the
  local zone is the one `Intl` resolves unless `TZ` is set. Abbreviations
  are `Intl`'s short English names where it has them (`PST`), else
  numeric (`+0100`).
- GLib's worker context (`g_get_worker_context()`) runs a blocking loop on
  a thread GLib starts on first use. `GTask`'s type initialization starts
  it, so in practice any GIO asynchronous call does; so do local file
  queries for `standard::is-hidden`, `GThreadedResolver` lookups with a
  timeout or cancellable, and `GSubprocess`. GDBus's shared thread runs
  its own blocking loop. Both sleep until woken, so each costs a pthread
  for the life of the Worker but no CPU.
- Fluendo's `gst.wasm` branch made wakeups no-ops, kept the wakeup's poll
  fd out of the main context and forced poll timeouts to zero; the futex
  wait above supersedes all three, so the series doesn't carry them. Its
  `emscripten_set_main_loop` integration and the deadlock fix that only
  concerns it are not taken either; the runtime pumps the context itself.
- Review the series' GSettings changes (`gsettings.c`,
  `gdelayedsettingsbackend.c`) before building the settings bridge on them.

#### 5.1.4 Platform backends

Where Emscripten's libc or GLib's WebAssembly build stubs a facility that the
browser (and Node, for tests) provides, `pkgsWasm.glib` gets a
WebAssembly-only backend that reaches the JavaScript API through `EM_JS`,
instead of carrying data or accepting the stub. Time zones already work this
way (`Intl`). The rest land with the first milestone whose engine needs them;
each moves the GLib subtests it fixes from platform-difference skips into
`must_pass`. In order of value to engines:

- **Language and locale.** `g_get_language_names()` and the default locale
  from `navigator.languages`: musl's locales exist in name only, and this
  decides the language an engine's own messages use. The locale's numeric
  conventions (`localeconv()`'s decimal point and grouping, which GLib's
  option parsing and number formatting read) come from `Intl.NumberFormat`.
- **Collation.** `g_utf8_collate()` and `g_utf8_collate_key()` through
  `Intl.Collator`, for engines that sort candidates or dictionary entries.
- **Localized dates and times.** The locale-dependent parts of
  `g_date_time_format()` (`%c`, `%x`, `%X`, month and weekday names) through
  `Intl.DateTimeFormat`, for engines that offer dates as conversions.
  Era-based formats (`%Ec`, `%EC`, `%Ex`, `%Ey`, `%EY`) need
  `nl_langinfo(ERA)`, which musl leaves empty, so GLib's tests skip them
  today. Rather than synthesizing era tables for GLib to parse, GLib's era
  formatting asks `Intl` directly for the date at hand: the locale's calendar
  (`japanese`, `buddhist`, `roc`) gives the era name and era-relative year
  through `formatToParts`, with no table and no range limit. Japanese engines
  need this for imperial-era years. (Time zones go the other way, as data:
  GTimeZone's API hands out stable interval indices, so it needs the whole
  transition table up front, and TZif is a format GLib keeps parsing across
  releases.)
- **Legacy charsets.** Decoding in `g_convert()` and `g_iconv()` through
  `TextDecoder` (EUC-JP, Shift_JIS, GBK, Big5 and the rest), for dictionaries
  stored in them. Encoding stays with musl's encoders: browsers expose no
  encoder but UTF-8's, and GLib's handling of musl's POSIX-conforming
  substitutions (it writes `*` and counts the character as irreversible
  rather than failing) makes the fallback and stream converters exact.
- **File monitoring.** A `GFileMonitor` backend that watches WasmFS itself,
  since every write to the Worker's files goes through it, for engines that
  reload user dictionaries or configuration when they change. Changes
  another tab makes to the same IndexedDB data (§5.6) need a message from
  that tab.
- **Network state.** `GNetworkMonitor` from `navigator.onLine` and its events.
- **User and host.** `g_get_user_name()`, the home directory and the host name
  for a synthesized WebAssembly user rather than the `getpwuid_r` stub.
- **Memory.** Browsers expose no low-memory events; `navigator.deviceMemory`
  at most. Only if an engine needs it.

Node can also run subprocesses through `child_process`, which would let
`g_test_trap_subprocess()` and the spawning subtests run in the test harness.
That is test coverage of code the runtime never runs, so it is optional.
Sockets, DNS, GDBus, application information and Unix signals have no browser
equivalent an input method needs and stay unsupported.

**Native replacements (measure first).** Some facilities work today but have
a native browser equivalent that could be faster or smaller. Each crossing
between WebAssembly and JavaScript copies the string (UTF-8 in linear memory,
UTF-16 in JavaScript), so only whole-string operations are candidates;
anything called per character stays in WebAssembly. The runtime links with
`-sMAIN_MODULE=2`, which already drops GLib code nothing references, so these
pay off only for code engines reach. The runtime milestone measures a size
breakdown of the linked runtime (per function and data segment) and the cost
of the calls engines make before any of them is built.

- **Unicode normalization and case mapping.** `g_utf8_normalize()` through
  `String.prototype.normalize()`, and locale-independent case mapping and
  casefolding through `toLowerCase()`/`toUpperCase()`, dropping GLib's
  decomposition and composition tables. Likely worth it. Per-character
  property lookups (`g_unichar_type()` and the like) keep GLib's tables.
- **GRegex through `RegExp`.** PCRE2 is a few hundred KB and the browser's
  regular expressions are native and JIT-compiled, but GRegex promises PCRE
  syntax; possessive quantifiers, recursion, `\K` and callouts have no
  ECMAScript equivalent. Decided by an audit of the patterns the target
  engines use: route patterns that translate faithfully to `RegExp` with
  PCRE2 as the fallback (time, not size), or drop PCRE2 if no engine needs
  PCRE-only features (size).
- **Legacy-charset tables.** The `TextDecoder` backend above also removes the
  conversion tables from the build.
- **ICU.** If an engine depends on ICU (for example through Boost.Locale),
  a shim over `Intl` could replace ICU's roughly 30 MB of data. Checked when
  each engine is planned; not built otherwise.

`SubtleCrypto` and `CompressionStream` are asynchronous, so they cannot back
`GChecksum`, `GHmac` or GIO's zlib converters; the allocator, math and hash
tables already run at native speed in WebAssembly; `DOMParser`, which could
replace libxml2, is unavailable in Workers.

### 5.2 `libibus-web`

A new C implementation of the part of the `libibus` API that engines use,
installed with `ibus.h`-compatible headers so engine glue compiles unchanged.
Where code is taken from upstream `libibus`, it keeps its LGPL-2.1+ license.

#### 5.2.1 API surface

- **Real GObject types:** `IBusObject`, `IBusService` (enough for
  `IBusEngine` to derive from it), `IBusEngine`, `IBusFactory`,
  `IBusComponent`, `IBusEngineDesc`, `IBusSerializable` and its data types
  (`IBusText`, `IBusAttribute`, `IBusAttrList`, `IBusLookupTable`,
  `IBusProperty`, `IBusPropList`).
- **Utility API:** keysym and Unicode helpers (`ibus_keyval_*`,
  `ibus_unicode_to_keyval`), `ibus_init`, `ibus_main` (a no-op that returns
  immediately, see §5.4.3), logging helpers.
- **Stubs:** `IBusBus` reports connected and treats component and name
  requests as successful no-ops. `IBusConfig`, if an engine uses it, is backed
  by the settings bridge in an `ibus-config` namespace.
- **Scope rule:** implement what the target engines call, found by building
  them. Unused API is left out, not stubbed, so a new engine fails at link
  time instead of misbehaving at run time.

#### 5.2.2 Emitters

`ibus_engine_commit_text`, `ibus_engine_update_preedit_text(_with_mode)`,
`ibus_engine_update_auxiliary_text`, `ibus_engine_update_lookup_table(_fast)`,
the show and hide calls, `ibus_engine_register_properties`,
`ibus_engine_update_property`, `ibus_engine_forward_key_event`,
`ibus_engine_delete_surrounding_text` and `ibus_engine_get_surrounding_text`
serialize their arguments with `IBusSerializable` and append a record to the
runtime's output buffer, tagged with the instance's input-context ID. They
never block.

`ibus_engine_get_surrounding_text` returns the last `SetSurroundingText` the
router sent, and emits `RequireSurroundingText` if none has arrived yet.

#### 5.2.3 Dispatcher

`ibusweb_dispatch(request) → reply` decodes one request, finds the engine
instance for its input context and calls the matching vfunc
(`process_key_event`, `focus_in`, `set_surrounding_text`, …). It also handles
lifecycle requests (§6.1.3): `Init` registers the engine module and settings,
`CreateEngine` asks the module's `IBusFactory` for an instance, and
`DestroyEngine` disposes it. After the vfunc returns it pumps (§5.2.4) and
flushes the output buffer.

#### 5.2.4 Pump

No `GMainLoop` runs. The dispatcher calls `g_main_context_iteration(NULL,
FALSE)` until nothing is pending, after every dispatch (`ibusweb_pump()`,
which returns the delay to the next source deadline from
`g_main_context_query`). Between requests, the Worker host sleeps in the
runtime: `ibusweb_wait(seen, timeout)` waits with `emscripten_futex_wait` on
the **wake word**, a word in WASM memory, while it holds `seen`, for at most
that delay, and the host pumps when it returns. JS timers are never needed in
the Worker, which matters because a Worker serving requests never runs its
event loop.

The host sleeps inside the runtime, not in `Atomics.wait`, because Emscripten
runs the calls other threads proxy to the runtime's own thread only from that
thread's event loop or from inside its futex waits. Those calls include
`pthread_create()` from any other thread (only the thread that instantiated
the runtime holds the Worker pool), JavaScript library calls proxied
synchronously and, with the toolchain's patch, the cleanup of threads that end
unjoined (§10.3). A host asleep on any other word never runs them, so a thread
that creates threads, or a `GTask` started from another thread, hangs. Each
`emscripten_futex_wait` on the runtime's thread runs them, so they complete
while the host sleeps, under Node and in Chromium and Firefox. `ibusweb_wait`
always makes one futex wait, even when the word has already moved: that wait
returns at once but still runs the queued calls, so a host woken often
doesn't starve them. Any result but success or a timeout is a crash.

Two things bump the wake word:

- **GLib's wake hook** (§5.1.3), from any thread, when a source becomes ready
  there: a `GTask` finishing in the thread pool, or an engine library's own
  thread calling `g_idle_add`. The host wakes and pumps then rather than at
  the next request or deadline. GLib signals for a source attached from
  another thread only when the context has an owner, so
  `ibusweb_runtime_init()` acquires the default context on the pump's thread
  for the Worker's lifetime; acquiring is recursive, so its non-blocking
  iterations still work. A test attaches a source from another thread while
  the host waits and checks that it is dispatched promptly.
- **The wake relay**, for the page, which never touches WASM memory (§9.2).
  The page bumps the control SAB's `wake` word (§6.2.1) for two things: a
  request it has posted, and ring space the host is waiting for (§6.2.2), so
  a wake from the page means one or the other. The relay, a small
  Worker the host starts, sleeps in `Atomics.wait` on that word and, for each
  change, bumps and notifies the wake word. It needs no event loop after
  startup. It compares the word with the value it last forwarded, never with
  a re-read, which would lose a wake that lands mid-forward. The relay and the
  sleep inside the runtime together add about 3 µs under Node and 20 µs in
  the browsers to a request that finds the host asleep, at most. One relay
  per page could serve every engine, through a page-wide doorbell word and a
  sequence word per engine; that isn't built.

Having the hook notify the control SAB instead, with the host asleep on it,
was rejected: getting the SAB into every pthread's JavaScript realm, including
Workers created later, rests on Emscripten internals, and a host asleep
outside the runtime fails as above whatever delivers the buffer.

Output produced by a pump outside a request goes to the ring followed by a
doorbell `postMessage` (§6.2.3).

#### 5.2.5 GSettings backend

- **Backend.** `IBusWebSettingsBackend`, a `GSettingsBackend` subclass
  registered on `G_SETTINGS_BACKEND_EXTENSION_POINT_NAME` and selected with
  `GSETTINGS_BACKEND`.
- **Values.** Seeded from the snapshot in `Init`. `SettingChanged` requests
  update the backend and call `g_settings_backend_changed`, so engines' own
  `changed::` handlers fire. Engine writes emit `SettingWritten` records for
  the host to persist.
- **Schemas.** Compiled at build time with the build machine's
  `glib-compile-schemas` and shipped in the engine's data files under
  `/usr/share/glib-2.0/schemas`. The `.gschema.xml` sources are also shipped
  so the page can describe keys to host UIs.

### 5.3 `ibus-runtime.wasm`

- **Contents.** libc, libc++/libc++abi, `pkgsWasm.glib` (GLib, GObject, GModule,
  the GIO subset), libffi and `libibus-web`.
- **Build.** `-sMAIN_MODULE=2` with an explicit export list (below), linked
  with `em++` from `runtime/ibus-runtime/`. Everything is compiled with
  `-fPIC`. GRegex overflows Emscripten's 64 KiB default stack, on any thread,
  so the link sets `-sSTACK_SIZE` and `-sDEFAULT_PTHREAD_STACK_SIZE` to
  1 MiB. `libibus-web`'s public API is marked `IBUSWEB_API` (default
  visibility) and the library is built with hidden visibility, so only that
  API is exported from it.
- **Thread pool.** A browser starts a Worker only once the thread that created
  it is back in its event loop (Chromium), or only while the page's main
  thread is free (Firefox), so a Worker host that never returns to its event
  loop can't wait for a new one. Threads run on a pool of Workers made with
  the runtime (`-sPTHREAD_POOL_SIZE`), sized for the threads expected alive
  at once plus spares, and `-sPTHREAD_POOL_SIZE_STRICT=2` makes a thread
  beyond the pool fail at once with `EAGAIN` instead of waiting for good.
  The size is made of shares, by what starts the threads, plus spares. The
  base is fixed at link time, from Nix (`ibusWeb.runtime.threadPool`):
  GLib's share, 3 (what one `GTask` in flight keeps alive: the worker
  context's thread and the thread-pool spawner, kept for good, and a `GTask`
  worker, kept 15.5 s after its last task), the storage backends' 2 (one
  thread each for the engine's own files and its installed data, §5.6),
  and `lowWater`, 3 spare Workers. The engine's share is added per Worker:
  Emscripten writes `-sPTHREAD_POOL_SIZE` into its JavaScript verbatim, as
  an expression evaluated inside the modularized runtime's factory, where
  `Module` is the settings object the host passes in. The runtime links with
  the base plus `Module["ibuswebEngineThreads"]`, which the host sets from
  the manifest's `threads`, so Emscripten makes the whole pool, and loads
  the runtime into each Worker, before the runtime runs.
- **Spares.** GLib handles a failed thread creation badly: `g_thread_new()`
  aborts, so the first `GTask` aborts the runtime if no Worker is idle, and
  a `GTask` whose worker can't start stays queued, silently, until some
  other worker is free. The first `GTask` needs all three of GLib's threads
  at once, so the spares number GLib's share: a thread an engine starts
  beyond its share takes a spare rather than a Worker GLib counts on.
  Whenever no request is pending and fewer than `lowWater` Workers are idle,
  which happens only past the shares, the Worker host tops the pool back up
  (§5.5), the one use it makes of Emscripten's internal `PThread`; Workers
  added stay. Bursts within the pool start without an event-loop turn in
  both browsers; a top-up of one Worker takes 47–48 ms there.
- **Export list.** The runtime exports what side modules may import, a
  manifest per library, each identified by its whole version:
  `libibus-web` (by `IBUSWEB_RUNTIME_ABI`); GLib, GObject, GModule and GIO
  (GLib's version); libffi (its version; the names its public headers
  declare); libc (Emscripten's musl by Emscripten's version: the whole
  archive, Emscripten's C internals included, plus the JavaScript-implemented
  functions libc's headers declare); compiler-rt, libc++, libc++abi and
  libunwind (the bundled LLVM's version); the IndexedDB backend
  (`IBUSWEB_RUNTIME_ABI`; the functions `ibus-web/wasmfs-idb.h` declares,
  not its C++ internals, §5.6); and Emscripten's own API, the
  functions, C or JavaScript, declared by an allowlist of its core headers
  (`emscripten.h`, `em_asm.h`, `em_js.h`, `console.h`, `threading.h`,
  `proxying.h`, `eventloop.h`, `heap.h`, `atomic.h`, `stack.h`, `wasmfs.h`
  less `wasmfs_create_opfs_backend`; not `syscalls.h`), less those that
  work only with Asyncify, listed before libc so it owns those names. `runtime/ibus-runtime/exports.nix` derives
  every list from the build, never by hand, into `exports.txt`, grouped by
  library under a header with its version and count, and `exports.json`.
  Every side module's imports are checked against it at build time
  (`ibusWeb.runtime.checkSideModuleImports`).
- **ABI.** The runtime's ABI identity is that set of library versions plus
  `IBUSWEB_RUNTIME_ABI`. Every engine manifest records the identity it was
  built against, and a mismatch is a load failure (§8).
- **JavaScript surface.** The Worker host also uses parts of Emscripten's
  JavaScript, `HEAPU8` and the pthread pool's `PThread`
  (`-sEXPORTED_RUNTIME_METHODS`), which the export list, holding only WASM
  symbols, doesn't cover, so neither does the ABI identity. The host refuses
  to start if they are missing. `PThread` is Emscripten's internal pool; a
  public Emscripten call to grow the pool and settle once its Workers can run
  threads would replace it.
- **Memory.** Fixed per Worker, made by the host. Growth with pthreads
  traps in V8: an atomic access that Liftoff compiled is bounds-checked
  against the memory size its thread last saw, which another thread's
  growth updates only once the accessing thread next handles its
  interrupts. In the spike, the atomic accesses that faulted this way were
  libc++'s shared-pointer counts (WasmFS opening a file, in GLib's
  many-thread `1bit-emufutex` test) and the spike workload's own atomic
  increments of freshly allocated memory (spike
  `docs/spikes/2026-10-01-runtime-worker.md`, "Memory growth"; note
  `docs/upstream/v8-liftoff-atomics-grown-shared-memory.md`). V8 fixed it on
  its main branch (issues 529880019 and 533026477), first in Chrome 157; no
  Node release line has the fix yet. The runtime is linked without memory
  growth, so nothing in it can grow its memory, whatever maximum the memory
  was given. Its memory import is declared from
  `ibusWeb.runtime.memory.minimum` (32 MiB) to
  `ibusWeb.runtime.memory.maximum` (2 GiB), so it takes any memory in
  between (`-sIMPORTED_MEMORY -sMAXIMUM_MEMORY=` without growth, which
  Emscripten honours only with a patch the toolchain carries), and it
  refuses to start without one. The Worker host makes a
  shared `WebAssembly.Memory` of the engine manifest's `memory` bytes with
  its maximum at that size, and passes it as `wasmMemory`. `memory` is a
  whole number of 64 KiB pages from the minimum to 2 GiB; the host checks
  it before making the memory, and a value outside that is a load failure
  (§8) whose error gives the value and the bounds. A full heap aborts the
  runtime, as a trap does (§8): with `-sABORTING_MALLOC=1` (Emscripten's
  default without growth) every allocation the heap can't hold aborts
  rather than returning `NULL`, including `g_try_malloc()` and `malloc()`
  of an oversize request, so code that handles a failed try-allocation
  never runs. The size is a manifest field rather than a link per
  engine so that one runtime binary serves every engine and the page
  compiles it once (Sharing, below). An engine's build sets `memory` to the
  runtime's minimum, plus the side module's own memory (its `dylink.0`
  memory size), plus any files it keeps in WasmFS's memory backend (engine
  data in IndexedDB, §5.6, is read lazily and doesn't count; without
  IndexedDB the host adds the data's size to the memory and its maximum
  itself), plus 1 MiB per
  thread of its pool share, plus the heap its checks measure at their peak,
  with a quarter more for margin, rounded up to whole MiB. The page's budget
  is that memory, touched or not, plus each pool Worker's own cost, since
  each holds an instance of the runtime: about 18 MiB in Chromium and
  12–16 MiB in Firefox, and 3–5 MiB more once it has run a thread (about
  42 MiB and 10 MiB under Node). GLib's tests and
  the checks that link with `ibusWeb.toolchain.testMainFlags` (the GLib
  smoke check, libhangul, the dynamic-linking spike, the toolchain and
  Emscripten-fix checks) use a fixed 512 MiB
  (`ibusWeb.toolchain.testMemoryFlags`; the largest test, `mainloop`, peaks
  at 280 MiB). The Meson and Autotools consumer checks keep Emscripten's
  default, a fixed 16 MiB; GLib's tools grow.
- **Sharing.** The page compiles `ibus-runtime.wasm` once and sends the
  `WebAssembly.Module` to each Worker. Each Worker instantiates its own copy
  with its own memory.

### 5.4 Engine side modules

#### 5.4.1 Contents

Built with `-sSIDE_MODULE=1`: the engine glue plus the engine's private
libraries, statically linked. Shared libraries between engines (such as
OpenCC for libpinyin and Rime) stay private to each engine in v1.

#### 5.4.2 Patch layers

Engine builds are overrides of nixpkgs recipes (§10.3); our patches go after
nixpkgs' own. Each engine keeps two ordered series:

- `patches/port/`: build system, startup (§5.4.3), removal of D-Bus-only
  code paths. Expected to stay small.
- `patches/casts/`: function-pointer fixes that `pkgsWasm.glib` cannot absorb.
  Removable as a unit if a toolchain-level fix ships.

Both layers target minimal diffs that upstream engines could accept, since the
code involved is undefined behavior on every platform.

#### 5.4.3 Startup

Engine `main()` functions connect to the bus, create an `IBusFactory`, add
engine types and call `ibus_main()`. The port layer replaces `main()` with an
exported `ibusweb_module_init(IBusWebModule *)` that runs the same
registration, usually by calling the engine's existing init functions (for
example `ibus_hangul_init`).

#### 5.4.4 Manifest

Generated at build time, partly from the engine's component XML. Example
(values illustrative):

```jsonc
{
  "name": "hangul",
  "version": "1.5.4+ibusweb.1", // its installed data is kept and marked per version (§5.6)
  "license": "GPL-2.0-or-later",
  // the runtime ABI identity: IBUSWEB_RUNTIME_ABI and every library's version (§5.3)
  "runtimeAbi": {
    "libibus-web": 1,
    "glib-2.0": "2.88.3",
    "libc": "1.2.6+emscripten.6.0.9",
    // …
  },
  "protocol": 1,
  "module": "hangul.wasm",
  "memory": 67108864, // bytes, whole 64 KiB pages, fixed for the runtime's life (§5.3)
  "threads": 1, // the engine's share of the thread pool, added to the runtime's base (§5.3)
  "data": [
    {
      "path": "/usr/share/libhangul", // where the archive lands under /engines/<name>/data (§5.6)
      "url": "hangul-data.tar",
      "size": 1048576, // bytes once unpacked (§5.6)
    },
  ],
  "engines": [
    {
      "name": "hangul",
      "longname": "Korean",
      "language": "ko",
      "layout": "us", // "us" or "default" (§7.1.1)
      "passthroughKeys": ["F1", "F2"], // DOM key names that skip the round trip
      "symbol": "한",
    },
  ],
  "settingsSchemas": ["org.freedesktop.ibus.engine.hangul"],
  "source": "hangul-src.tar.zst",
}
```

### 5.5 Worker host

TypeScript on Effect 4. Loaded by URL as its own file, never inlined into the
page bundle (§9.2).

1. Receives the compiled runtime module, the SAB and the manifest by
   `postMessage`.
2. Builds the Worker's resources in nested scopes (below): probes
   IndexedDB and takes the engine's writer lock if it is free, makes the
   runtime's memory at the manifest's size (§5.3; more without IndexedDB,
   §5.6) and instantiates the runtime with it and with
   `ibuswebEngineThreads` set to the manifest's `threads`, so Emscripten
   starts the pool with the engine's share in it (§5.3), starts the wake
   relay (§5.2.4), mounts storage, installs the data files unless they are
   there and lets go of old versions' (§5.6), loads the side module and
   calls `ibusweb_module_init`.
3. Enters the request loop: `ibusweb_wait` on the wake word with the pump
   deadline as timeout, dispatch or pump, write the reply, repeat.
4. Wraps every dispatch and pump in a handler for WASM traps (§8).

The host grows the thread pool past its start in the top-up (§5.3), through
Emscripten's `PThread`: it creates each Worker, loads the runtime into it, and
keeps it out of the pool's free list until it has loaded, since Emscripten
hands out any free Worker, loaded or not, and a thread on one that hasn't
loaded would wait for the host's event loop. A top-up that hasn't finished
within 10 s is a host error.

Failures the host must report, beyond traps in its own calls:

- **A thread traps.** Emscripten marks the runtime crashed and wakes the host,
  whose call into the runtime then throws `"unwind"`; the thread's own error
  reaches the host only afterwards, through its event loop. The host writes
  `CRASHED` at once, then waits briefly for the thread's error and reports it
  (§8).
- **The relay fails.** A host asleep in the runtime never hears the relay's
  `error` event, so the relay catches its own failure, writes `CRASHED` and
  bumps both wake words. A relay killed without running its own code is
  silent to a sleeping host; the page's hang detection (§8) is the backstop.
- **Startup fails.** A failed `WebAssembly.instantiate()` inside Emscripten's
  `instantiateWasm` hook, which Emscripten never hears of, fails the host's
  startup rather than leaving it waiting.

#### 5.5.1 Resource scopes

| Scope                                                              | Acquire                                 | Release on normal close                                                                                   | Release after a trap                                     |
| ------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Worker                                                             | SAB views, `Logger` layer, wake relay   | final `Log` records flushed                                                                               | crash record written                                     |
| Runtime                                                            | instantiate `ibus-runtime.wasm`         | none (freed with the Worker)                                                                              | none                                                     |
| Storage                                                            | Web Locks, WasmFS mounts, data install  | locks let go; the backends' threads and connections end with the Worker (WasmFS never destroys a backend) | locks let go; the connections close when the Worker ends |
| Engine module                                                      | load side module, `ibusweb_module_init` | module shutdown call                                                                                      | skipped                                                  |
| Engine instance (one per input context, child of the module scope) | `CreateEngine`                          | `DestroyEngine` (`g_object_unref`)                                                                        | skipped                                                  |

- **Finalizers inspect the `Exit`.** After a trap the WASM heap cannot be
  trusted, so finalizers that call into the runtime run only on a normal close;
  JS-side cleanup and crash reporting always run.
- **Nothing depends on finalizers for correctness.** A hang ends in
  `worker.terminate()`, which runs no finalizers; the IndexedDB connections
  live on the storage backends' threads, pool Workers nested in the engine's
  Worker, and the browser closes them when it ends. Emscripten side modules
  are not actually unloaded, so the module scope is bookkeeping; the Worker is
  the unit that frees memory.

#### 5.5.2 The request loop and the Effect runtime

The request loop is a single synchronous section inside the scoped program. A
thread asleep in `ibusweb_wait` runs no other fibers, so nothing in the
Worker may rely on concurrent fibers or Effect timers while the loop runs; GLib
time is handled by the wait timeout (§5.2.4). Engine-instance scopes are opened
and closed synchronously from the loop as `CreateEngine` and `DestroyEngine`
arrive.

The loop leaves its synchronous section for one thing: a pool top-up (§5.3),
which runs only while no request is pending. The host creates the missing
Workers and sleeps with `Atomics.waitAsync` on the wake word, its event loop
running, until they have loaded, serving requests and pumping meanwhile, then
returns to `ibusweb_wait`. Threads that end unjoined don't need the event
loop: the toolchain's Emscripten patch reclaims them inside `ibusweb_wait`
(§10.3). Should that patch be dropped, the fallback is a brief, periodic
return to the event loop while idle.

#### 5.5.3 Logging

The Worker's `Logger` layer writes `Log` records into the output ring, and the
GLib log handler (§8) feeds the same logger. The page re-emits them through
its own loggers with engine and domain annotations (§7.4).

### 5.6 Storage

- **Filesystem.** WasmFS with our own IndexedDB backend. An engine's own
  files (user dictionaries for libpinyin and Rime, Rime's deployed data and
  user YAML) are mounted at `/engines/<name>/`, and its installed data at
  `/engines/<name>/data`. GSettings values are not stored here; the
  settings bridge hands them to the host (§5.2.5).
- **The backend.** Files are stored as chunks whose IndexedDB values are
  `ArrayBuffer`s copied out of WASM memory, never views of it and never
  `Blob`s, and read and written lazily, a chunk at a time. IndexedDB is
  asynchronous, so each backend serves calls on a thread of its own, from
  the pool, to which WasmFS proxies them, as WasmFS's OPFS backend does.
  That thread runs an event loop, which IndexedDB's callbacks need, holds
  the backend's connection and lasts as long as the runtime; a host mounts
  two backends (the engine's own files and its data), so the storage share
  of the thread pool is 2 (§5.3). Emscripten's WasmFS has no IndexedDB
  backend; ours is written in C++ after the OPFS backend's shape, lives in
  the repository as the runtime part `runtime/wasmfs-idb/` (compiled
  against the patched Emscripten's WasmFS headers, with an Emscripten JS
  library), and is a candidate for upstream
  (`docs/upstream/wasmfs-idb-backend.md`). Its API, `ibus-web/wasmfs-idb.h`,
  is the `wasmfs-idb` section of the runtime's export list (§5.3), so side
  modules can't reach its internals:
  - `wasmfs_create_idb_backend(database, flags)` opens the database,
    creating it if needed, and returns a backend whose root is the
    database's root directory, or `NULL`, with the cause on stderr. It is
    called off the browser's main thread. `WASMFS_IDB_READ_ONLY` makes every
    change fail with `EROFS`.
  - `wasmfs_idb_backend_seal(backend)` makes a backend read-only in place:
    every change started after it fails with `EROFS`, descriptors already
    open for writing included; only the last close of a file unlinked before
    the seal still deletes what it stored. It makes nothing durable;
    `fsync()` first.
  - `wasmfs_idb_backend_closed(backend)` says whether the backend's
    connection has closed (below). It is an atomic load, cheap whatever the
    backend's thread is doing.
- **Layout.** One database per mount, at version 1, with four object stores:
  - `meta`: `format` (1), `chunkSize` (fixed when the database is created),
    `nextIno`, `root` (the root's inode, 1), and `installed`, the installed
    data's marker, which the host writes and the backend never reads;
  - `inodes`, by inode number: kind (file, directory or symlink), mode,
    size, access, modification and change times in milliseconds, and a
    symlink's target;
  - `entries`, by `[parent, name]`: the child's inode number;
  - `chunks`, by `[inode, index]`: at most a chunk's bytes. A missing chunk
    reads as zeros, so files may be sparse, and no chunk holds bytes past
    its file's size, so a file truncated and grown again never shows its
    old bytes.

  An operation that touches more than one record is one transaction. File
  sizes go up to 2^53 − 1 bytes, the largest a JavaScript number holds
  exactly; beyond that is `EFBIG`. An unlinked file stays readable while
  open; its inode and chunks go at its last close. Inodes no directory
  holds, which a page that ended with a file unlinked but open leaves, are
  swept, in one transaction, when a read-write backend is created; a
  read-only one doesn't sweep. A sweep that fails is logged and the backend
  mounts anyway, unless it failed because the connection closed, which
  fails the open.
- **Chunk size.** 16 KiB for the databases the backend creates; a database
  keeps the size in its `meta`, and any positive size there is read,
  larger ones included. 16 KiB is the cheapest chunk for the random 4 KiB
  read that lookups make, in both browsers (spike
  `docs/spikes/2026-10-01-runtime-worker.md`, "What it costs"). A chunk is
  at most 63 KiB, checked against the default at compile time: Chromium
  stores a value whose serialized form exceeds 64 KiB as a `Blob` of its
  own, which costs two to three times as much to read or write, and the
  margin covers the serialization's own bytes. Firefox keeps values in its
  database far beyond that (one of 768 KiB stayed; one of 896 KiB went to a
  file).
- **Writes and `fsync`.** A read gets only the chunks it covers. Writes are
  write-through: each `write()` is one read-write transaction, with the
  browser's default durability, that reads only the chunks it partly
  overwrites, and has committed before it returns. `fsync()` and
  `fdatasync()` are the durability barrier: a read-write transaction over
  the file's stores with `{ durability: "strict" }` that puts the file's
  inode record back as it is, and returns once it completes. A strict
  commit makes every earlier change to the database durable, but only if it
  writes: counted under `strace`, an empty strict transaction syncs nothing
  to disk in either Chromium or Firefox, and one that puts a record syncs
  once. `fsync()` on a backend created read-only commits nothing. WasmFS
  flushes only regular files, so `fsync()` on a directory does nothing,
  and a rename or a new directory entry has no barrier of its own: it is
  durable once a later `fsync()` of any file in the same database
  completes.
- **Errors.** IndexedDB's `QuotaExceededError` is `ENOSPC`, with nothing
  changed, since the operation's one transaction aborts; `ConstraintError`
  is `EEXIST`; `ReadOnlyError`, the read-only flag and a seal are `EROFS`; a
  closed connection (`InvalidStateError`, `VersionError`, the `AbortError`
  of the transactions a close aborts) is `EIO`; anything else is `EIO`,
  logged. A lookup in a closed database is `EIO` too, never `ENOENT`,
  since callers take `ENOENT` for leave to create a file or fall back to
  defaults. WasmFS reports any failure to make a symlink as `EPERM`, and
  any failed lookup as `ENOENT`, without the toolchain's patches 0017 and
  0019, which carry the backend's errno (§10.3).
- **Why IndexedDB.** In Firefox a Worker reads a `Blob`'s bytes (an OPFS
  `File`, a `Blob` value in IndexedDB, a cached `Response`) only while the
  page's main thread is free, so under the keystroke spin (§6.2.6) every such
  read waits out the budget and replays; `ArrayBuffer` values come back with
  the `get()` itself and never wait, nor do opening a database, writes and
  their commits. Nothing in IndexedDB takes an exclusive lock: read-only
  transactions run side by side across Workers and tabs, and one over a
  store a read-write transaction holds waits for its commit rather than
  failing. Through the backend, with 16 KiB chunks, a random 4 KiB read
  costs 0.12–0.16 ms on the calling thread and 0.2–0.32 ms of a keystroke,
  and no read or write waited for the page's spin (spike, "What it
  costs").
- **Not OPFS.** Its synchronous access handles, the one OPFS read path that
  doesn't wait for the page in Firefox, take an exclusive lock on the file
  across the origin in Firefox (and, by the standard, Safari; only Chromium
  has shared read-only handles), so a second tab or engine instance couldn't
  open the same data; WasmFS's OPFS backend reads files opened read-only
  through `Blob`s. **Not ZenFS**: its IndexedDB support plugs into
  Emscripten's legacy JavaScript file system rather than WasmFS, its
  synchronous path loads everything up front, and it is LGPL-3.0. **Not
  IDBFS**: it belongs to the legacy file system too, and syncs whole trees
  between memory and IndexedDB.
- **Version changes.** Adding or removing object stores, or deleting a
  database, waits until every other connection closes, so every connection
  the runtime and the host make closes on `versionchange`. The backend's
  thread hears it from its event loop, sets the backend's closed flag, logs
  why, and fails every later call with `EIO`; nothing reopens the
  connection. The host checks `wasmfs_idb_backend_closed()` for both mounts
  each time it wakes and reports `storage: closed` (§8). Installing a
  version deletes its data's database first, a version change with no
  connection to close, since no host mounts a version before its marker
  exists (Installing, below).
- **The page keeps out.** The page opens no transaction on an engine's
  databases. A transaction commits on the thread that made it, so one the
  page made and hadn't seen commit when it began to spin held up the
  backend's writes to the same store until the spin ended (in both
  browsers). With §9.2, the page reaches the engine's storage only through
  the protocol.
- **One writer.** Readers never block one another, but two writers would
  interleave writes to one file, and each writer's sweep would take the
  other's open, unlinked files. Before it creates the backend for the
  engine's own files, the host requests the Web Lock
  `ibus-web:writer:<name>` with `ifAvailable` and holds it for the Worker's
  life. The instance holding it mounts the engine's files read-write; every
  other one mounts them with `WASMFS_IDB_READ_ONLY`, which skips the sweep,
  and the host receives a `storage: read-only` event (§8). Hosts don't queue
  for the lock: a backend can't become writable, so a host that starts
  read-only stays so, and the page restarts it to get a writer.
- **Restarts.** Chromium lets go of the locks of a Worker terminated while it
  sleeps in `Atomics.wait()`, as the host does between requests, some 2 s
  after `terminate()`; Firefox at once. A host started in between would find
  the writer lock taken and run read-only for good. So the page, having
  terminated a host that didn't report `storage: read-only`, waits for the
  engine's writer lock to come free before starting the engine's next host,
  with a queued request it lets go of at once, bounded at 10 s, after which
  another tab holds the lock legitimately. A host that dies without the page
  terminating it (its renderer out of memory, its Worker crashing) gets no
  such wait, so in Chromium a restart within those 2 s may come up
  read-only.
- **Data files.** Read-only engine data (m17n-db, Hangul Hanja tables, Rime's
  prebuilt schemas) is fetched as archives listed in the manifest, installed
  once per version and read lazily like any other file. Archives are
  uncompressed POSIX ustar (compression is HTTP's job), streamed from the
  response body into a streaming extractor in `libibus-web`
  (`ibusweb_install_begin`, `_feed`, `_end`, and `_count`, the files and
  bytes written) that writes through the mounted file system, so the stored
  layout has one writer. It takes regular files and directories only,
  refuses absolute paths and `..` with `EINVAL`, gives every entry the
  archive's mode (its owner can always read and write it, and search a
  directory), sizes each regular file from its header before writing its
  data, so that a file in memory is allocated once at its size, and
  `fsync()`s each file it writes. Each archive lands under the
  data mount at its manifest entry's `path`.
- **A database per version.** Each version's data is a database of its own,
  `ibus-web/<name>/data/<version>`, apart from the engine's own files
  (`ibus-web/<name>`) and from every other version, so installing one never
  touches another in use. The engine's name and version are encoded in
  every database and lock name (`encodeURIComponent`, with `!'()*.~` also
  escaped), so neither holds `/` or `:` and neither is `.` or `..`; a
  manifest without a version fails the start. The data mount is a WasmFS
  mount inside the user mount, which records nothing in the user database,
  so the engine can't make a `data` entry of its own there. Three Web Locks
  per engine:
  - `ibus-web:data:<name>:<version>`, shared, held by every host using that
    version for its life, and the first lock a host waits for;
  - `ibus-web:install:<name>:<version>`, exclusive, for deciding and
    installing; versions install independently;
  - the writer lock, which covers the engine's own files only. Every host
    installs a missing version, writer or not.
- **Installing.** At engine start, before the engine accepts requests, the
  host takes the version's data lock and then its install lock, and reads
  the version's marker, `meta.installed` = `{ version, files, bytes }`, on a
  short connection that doesn't create the database, before mounting
  anything of that version. With the marker, it mounts the version
  read-only. Without it, it deletes the version's database (a deletion
  still blocked after 10 s fails the start), creates a read-write backend
  over a new one and mounts it, extracts every archive into it, writes the
  marker last in a strict transaction on a connection of its own, and seals
  the backend: the installing host keeps its backend rather than mount a
  third, since a backend's thread lasts as long as the runtime. Then it lets
  go of the install lock. So an install starts from empty storage, and no
  partial tree, no other version's file and no stale one survives it; no
  host reads a version before its marker exists, so the deletion has no
  reader to wait for; an interrupted install leaves no marker and the next
  host redoes it; a second host waiting on the lock finds the marker and
  mounts.
- **Old versions.** Once it has installed or found its version, the host
  lists the engine's other versions (`indexedDB.databases()`, which is why
  the minimum Firefox is 126, §10.3) and, for each, requests its data lock
  exclusively with `ifAvailable`; granted, no host uses that version, and
  none can start to until the lock is let go, so it deletes the database.
  This is best-effort: a failure is reported and never fails the start.
- **Waiting for locks.** A host waiting for the data or install lock gives
  up, failing its start, after 120 s. The installer says it is still
  going, at most once a second while archive bytes arrive, on a
  `BroadcastChannel` named after the install lock, and each word starts a
  waiter's 120 s over, so a long install holds no one up for good. An
  archive that sends nothing for 30 s fails its installer's start, which
  lets go of the lock. In Firefox the response body waits while the page
  spins (§6.2.6), which only delays startup, since installing is off the
  request path.
- **Failed starts.** The host keeps every lock it holds in one set, and a
  start that fails, or a runtime that crashes after it, lets go of them
  all, so a failed host never keeps others from installing, collecting or
  writing; it stays alive to report. Its runtime, and any engine thread
  already started, may still write through its read-write user backend, so
  it seals that backend before letting go of the writer lock; a runtime
  that can no longer be called to seal it keeps the writer lock until the
  page terminates the Worker. A host that dies outright (its Worker
  crashing, its renderer out of memory) has no chance to seal; it relies
  on its locks going only with the Worker, and on the runtime's threads,
  nested Workers the host started, being torn down with it, so that none
  is left writing once another host can become writer.
- **Fallback.** A browser lacks IndexedDB only for an opaque origin (a
  sandboxed iframe without `allow-same-origin`, a `data:` URL, where
  `indexedDB.open()` throws `SecurityError`), where the user or an enterprise
  policy blocks site data, or where a third-party iframe is denied storage.
  Private browsing has it in every browser at the Baseline floor, cleared
  when the session ends. The memory is fixed once made, so the host probes
  IndexedDB first, opening the engine's database without creating it and
  closing it at once. If that fails, the mount is in memory: the data files
  sit in WasmFS's memory backend, so the host makes the runtime's memory
  and its maximum larger than the manifest's `memory` by the data's size,
  the sum of the manifest's data sizes (unpacked bytes, §5.4.4) in whole
  pages (§5.3), which is enough because the extractor sizes each file
  before writing it, and installs the data at every start, with no lock. A memory that this takes
  past the runtime's maximum fails the memory check, a load failure (§8)
  whose message gives the size but not the data's part in it. User data
  then lasts only as long as the Worker, and the host receives a
  `storage: ephemeral` event (§8). A backend that fails to open after the
  probe succeeded is a load failure too, not this fallback: the memory has
  been made by then.
- **Node.** Node, which the runtime also targets, has no IndexedDB at all,
  and that is not this fallback: there `/engines/<name>/` is WasmFS's Node
  backend (`wasmfs_create_node_backend`) over `<dir>/user/` of a directory
  the Node host is given, and each version's data over `<dir>/data/<version>/`.
  The backend runs `fs.*Sync` on the calling thread, so nothing is proxied
  and no pool thread is taken, and works from pthreads under
  `worker_threads`; its limits (32-bit file sizes, no symlinks) don't matter
  to engine data. A version's marker is the file `<version>.installed`
  beside its directory, written as `<version>.marking`, synced and renamed
  over it, with the directory synced after; one that doesn't parse counts
  as absent, and removal deletes the marker first. The host takes the same
  locks and reports the same states, but the Node backend has no read-only
  mode, so neither a read-only mount nor a seal refuses writes there, and
  Web Locks coordinate the threads of one Node process only: two processes
  sharing a directory are not coordinated.
- **Host API.** Usage report, export (a tar of the engine directory) and reset.

## 6. The Worker-boundary protocol

### 6.1 Messages

#### 6.1.1 Wire format

Messages are the methods and signals of IBus's `org.freedesktop.IBus.Engine`
D-Bus interface, with payloads in GVariant serialization, which is how IBus
already puts `IBusText`, `IBusLookupTable` and `IBusProperty` on the wire. All
per-instance messages carry an input-context ID (`u`).

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

#### 6.1.3 Lifecycle and settings requests

| Message          | Payload                             | Notes                                 |
| ---------------- | ----------------------------------- | ------------------------------------- |
| `Init`           | protocol version, settings snapshot | exact protocol-version match required |
| `CreateEngine`   | IC ID, engine name                  |                                       |
| `DestroyEngine`  | IC ID                               |                                       |
| `SettingChanged` | schema, key, `v`                    |                                       |

#### 6.1.4 Output records (Worker → page)

`CommitText`, `UpdatePreeditText`, `UpdateAuxiliaryText`,
`UpdateLookupTable`, `ShowPreeditText`, `HidePreeditText`,
`ShowAuxiliaryText`, `HideAuxiliaryText`, `ShowLookupTable`,
`HideLookupTable`, `RegisterProperties`, `UpdateProperty`, `ForwardKeyEvent`,
`DeleteSurroundingText`, `RequireSurroundingText`, with IBus's signatures;
plus `SettingWritten`, `Log` (level, domain, message) and `Crashed`.

### 6.2 Transport

Each Worker has one **dedicated** `SharedArrayBuffer`, separate from its
`WebAssembly.Memory`. The page never reads or writes WASM memory.

#### 6.2.1 Layout

| Region         | Size (default) | Contents                                                                                                                                                          |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control header | 64 bytes       | `Int32` words: `state` (IDLE, REQUEST, REPLY, CRASHED), `reqSeq`, `reqLen`, `replyRet`, `replyOutSeq`, `ringWrite`, `ringRead`, `ringWaiting`, `doorbell`, `wake` |
| Request slot   | 64 KB          | one encoded request                                                                                                                                               |
| Output ring    | 256 KB         | framed records                                                                                                                                                    |

The header's ten words take 40 of its bytes. Sizes are configurable per
Worker. Only the page bumps `wake`: it bumps and notifies it after each
request, and after advancing `ringRead` while `ringWaiting` is set (§6.2.2);
the wake relay forwards it into WASM memory, where the host sleeps (§5.2.4).

#### 6.2.2 Records and back-pressure

- **Framing.** `seq` (u32), `ic` (u32), `kind` (u16), `flags` (u16), `len`
  (u32), then the payload, padded to 8 bytes.
- **No overwriting.** The page advances `ringRead` only after decoding a
  record.
- **Full ring.** The Worker host sets `ringWaiting` to 1, posts a doorbell,
  reads the wake word in WASM memory as `seen` and checks the free space
  again; if the ring is still full, it calls `ibusweb_wait(seen, -1)` and
  starts over, until there is space. It doesn't pump meanwhile: a wake from
  GLib's hook only prompts the re-check, and a request that lands meanwhile
  waits for the record to be written. The host sleeps in the runtime, not on
  `ringRead`, so calls other threads proxy to its thread still run (§5.2.4).
  The page, after advancing `ringRead`, clears `ringWaiting` if it was set
  and bumps and notifies `wake`, which the relay forwards; notifying is
  allowed on the main thread. Setting the flag before the re-check, and
  reading `seen` before it too, means space freed at any point is either
  seen by the re-check or announced by a wake.
- **Oversize messages.** A payload larger than the free space is split into
  fragments (`flags` = CONTINUATION, final fragment unflagged) and reassembled
  by the page.

#### 6.2.3 One ordered stream in each direction

- **Requests.** One request is in flight at a time; requests are processed
  strictly in order. All page → Worker messages use the request slot,
  including lifecycle ones, because the Worker never returns to its event loop
  after bootstrap.
- **Output.** All output, whether produced inside a request or by a timer
  pump, goes through the one ring. Records carry a Worker-wide sequence
  number, so a timer's output can never be reordered around a keystroke's.
- **Doorbell.** A `postMessage` that tells an idle page to drain the ring. It
  is sent when a pump outside a request produces output, before waiting on a
  full ring, and when a request the page is not spinning on completes.

#### 6.2.4 Synchronous request (keystroke path)

Page:

1. Write the request, store `reqLen`, set `state = REQUEST`, then bump and
   notify `wake`.
2. Loop: drain available ring records into a pending batch. Stop when
   `state == REPLY` and every record up to `replyOutSeq` is drained; or when
   `state == CRASHED`; or when the time budget runs out.
3. On reply, set `state = IDLE` and apply the batch.

Worker:

1. Wake (through the relay) and find `state == REQUEST`; dispatch; pump;
   flush output to the ring
   (waiting on back-pressure as needed).
2. Write `replyRet` and `replyOutSeq`, set `state = REPLY`, notify.

#### 6.2.5 Asynchronous request (lifecycle, settings, non-key methods)

Same protocol, but the page does not spin: it waits for the doorbell. Used
for `Init`, `CreateEngine`, `DestroyEngine` and `SettingChanged`. Focus,
cursor-location and surrounding-text updates stay synchronous so they remain
ordered with keys.

#### 6.2.6 Timeouts and the replay queue

- **Budget.** The page spins for at most 40 ms by default (configurable).
- **On timeout.** The Worker is marked busy. The timed-out key is consumed
  and queued with its original event, and so are later keys, up to 64. The
  request still completes.
- **Catch-up.** When the doorbell reports completion, queued keys are sent in
  order, asynchronously. Keys the engine declines are applied by the adapter's
  `replayKey` (§7.2.1).
- **Overflow or hang.** See §8.
- **Nothing the Worker does for a request waits for the page.** The page's
  main thread is busy spinning, and in Firefox some Worker operations wait
  for it: `new Worker()` called from a Worker returns, and a Worker reads a
  `Blob`'s bytes, only while the page's main thread is free. The design keeps
  both off the request path: threads run on a pool made in advance (§5.3)
  and storage reads `ArrayBuffer` values (§5.6). The pool's top-up creates
  Workers only while no request is pending; a request that lands during
  those calls (about 1 ms) costs at most a replay. Chromium depends on the
  page for neither.

### 6.3 `@ibus-web/protocol`

Effect Schema is the source of truth for the protocol. Three layers:

1. **GVariant values and bytes.** A tagged `GVariantValue` tree and a
   hand-written codec between `Uint8Array` and that tree for any signature,
   covering GVariant alignment and framing offsets for the types IBus uses.
   Exposed as a schema codec, `GVariantBytes(signature)`. It is the only
   byte-level code.
2. **IBus types.** `Schema.Class`es over the tree for `IBusText`,
   `IBusAttribute`, `IBusAttrList`, `IBusLookupTable`, `IBusProperty`,
   `IBusPropList` and the key-event triple. A `serializable(name, fields)`
   helper covers the common framing (type name, `a{sv}` attachments, fields).
   Fields carry their GVariant type as an annotation, and full signatures are
   derived by walking the schema.
3. **Messages.** One schema per request and output record, combined into a
   tagged union by record `kind`.

The published protocol specification (names, signatures, field descriptions,
SAB layout) is generated from these schemas and released with every version.

Keystroke-path decoding uses `Schema.decodeUnknownSync`. If benchmarks exceed
the budget (§11.7), candidates are decoded lazily: the visible page eagerly,
the rest on request from the panel.

## 7. Page side

### 7.1 Router

#### 7.1.1 Key translation

- **`keycode`.** `event.code` → evdev code, from Chromium's
  [`dom_code_data.inc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/events/keycodes/dom/dom_code_data.inc)
  evdev column (BSD-3-Clause; notice kept).
- **`keyval`, layout `default`.** From `event.key`:
  - a single code point: Latin-1 directly; a legacy keysym where
    `keysymdef.h` defines one; otherwise `0x01000000 + codepoint`, the rule
    `keysymdef.h` itself specifies.
  - a named key: a table from UI Events key values to keysyms (`Backspace`,
    `ArrowLeft`, `Shift`, `HangulMode`, `HanjaMode`, …), with keysym values
    taken from `keysymdef.h`.
- **Keysym tables** are generated at build time from xorgproto's
  [`keysymdef.h`](https://gitlab.freedesktop.org/xorg/proto/xorgproto/-/blob/master/include/X11/keysymdef.h),
  not from upstream `ibuskeyuni.c` (LGPL). The file is under The Open Group's
  MIT-style license (SPDX `MIT-open-group`) and a Digital HPND-style notice;
  both notices ship with the page packages. Generation rules come from the
  file's own annotations:
  - `// U+xxxx` marks a one-to-one mapping and is used in both directions.
  - `//<U+xxxx>` marks a more specific keysym for a character that already has
    a generic one (for example `XK_KP_Space`). These map keysym → character
    only; character → keysym picks the generic keysym.
  - `(U+xxxx)` marks a deprecated or unclear legacy mapping and is not used
    for character → keysym.
  - Where several names share a value, the first listed is canonical; aliases
    are ignored.
- **`keyval`, layout `us`.** Computed from `event.code` with a bundled US
  layout table and the Shift and CapsLock state, ignoring `event.key`. On the
  desktop IBus switches the system layout for such engines; in a browser the
  router emulates that. v1 bundles only the US table.
- **`state`.** Shift, Control, Alt (`MOD1_MASK`), Meta (`SUPER_MASK` and
  `META_MASK`), CapsLock (`LOCK_MASK`). `getModifierState("AltGraph")` sets
  `MOD5_MASK` and clears Control and Alt, which fixes AltGr on Windows. Key
  releases add `RELEASE_MASK`.
- **Releases.** Sent through the same synchronous path as presses (Rime's
  Shift toggle acts on release).
- **Never intercepted.** Events with `isComposing` or `key === "Dead"` (the
  OS input method owns them), and all keys while no engine is enabled.

#### 7.1.2 Input contexts and focus

- Each attached surface is one input context with a router-assigned ID.
- An engine instance per input context is created lazily on first focus
  (`CreateEngine`).
- DOM `focus` and `blur` become `FocusIn` and `FocusOut`.
- Capabilities come from the adapter and are sent with `SetCapabilities`.
- Content type comes from `type`, `inputmode` and `autocomplete`, mapped to
  IBus purposes and hints. `type=password` disables the engine for that input
  context.
- The caret rectangle is sent as `SetCursorLocation` after each batch in which
  it changed.
- Surrounding text is sent on `FocusIn`, after each commit and on
  `RequireSurroundingText`, as a window of about ±1000 characters
  (configurable).
- Offsets are converted between the adapters' UTF-16 units and IBus's code
  points.

#### 7.1.3 Engine selection

- One active engine for the page, with composition state per input context,
  matching IBus's shared-input-method default. A per-context override API
  exists.
- Switching sends `Disable` and `FocusOut` to the old instance, then creates
  or reuses the new one and sends `Enable` and `FocusIn`.
- A hotkey registry exists with no default bindings.
- A Worker starts when its engine is first selected and stays loaded until the
  host calls `unload(name)`.

#### 7.1.4 Settings API

Per engine: list schemas and keys (with types, ranges, enum values and
descriptions parsed from the shipped `.gschema.xml`), get and set values, and
a stream of changes, including those written by the engine itself. The host
supplies the initial snapshot and persists changes; the library stores
nothing.

### 7.2 Surface adapters

#### 7.2.1 Contract

```ts
interface SurfaceAdapter {
  attach(sink: KeySink): () => void;
  readonly capabilities: Capabilities; // preedit, auxText, lookupTable, surroundingText
  contentType(): ContentType;

  surrounding(maxUnits: number): { text: string; cursor: number; anchor: number };
  caretRect(): DOMRect | null; // viewport coordinates

  batch(fn: () => void): void; // one host transaction, one undo step
  commit(text: string): void; // insert at the caret as user input
  deleteSurrounding(offset: number, length: number): void;
  setPreedit(p: Preedit | null): void; // text, attributes, cursor; null clears
  replayKey(e: KeyboardEvent): void; // apply a declined key after a timeout
}

interface KeySink {
  key(e: KeyboardEvent): "consumed" | "passthrough"; // synchronous
  focus(): void;
  blur(): void;
}
```

Offsets are UTF-16 code units.

#### 7.2.2 Rules

- On `consumed`, the adapter calls `preventDefault()` and
  `stopPropagation()`. Built-in adapters listen in the capture phase on their
  element; capture-phase listeners on ancestors still run first, and this is
  documented.
- Preedit text is never document content: it is rendered as decoration, so
  host values, undo history and `input` events never contain it.
- Each reply's records are applied inside one `batch()` call, in order.

#### 7.2.3 Built-in adapters

|         | `<input>` / `<textarea>`                                | `contenteditable`                                                     |
| ------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Commit  | `setRangeText`, then an `input` event                   | `execCommand('insertText')`, which keeps native undo                  |
| Preedit | positioned overlay; caret found with a mirror element   | non-editable inline `<span>` at the caret, removed before each commit |
| Replay  | insert character or perform the editing action manually | same, via `execCommand`                                               |

#### 7.2.4 CodeMirror 6 check (not in v1)

| Contract                               | CodeMirror 6                                                     |
| -------------------------------------- | ---------------------------------------------------------------- |
| `attach`                               | `EditorView.domEventHandlers` at high precedence                 |
| `batch`, `commit`, `deleteSurrounding` | one `view.dispatch` with `changes` and `userEvent: "input.type"` |
| `setPreedit`                           | `Decoration.widget` at the cursor through a `StateField`         |
| `caretRect`                            | `view.coordsAtPos(head)`                                         |
| `surrounding`                          | `state.doc.sliceString` around the selection                     |

### 7.3 Default panel

`@ibus-web/panel` renders the candidate window, auxiliary text, preedit styling
for the built-in adapters and a property menu. It uses only the public facade
API, so it is framework-free and serves as reference code for hosts that
build their own panel. It is meant for testing and simple hosts.

### 7.4 Effect architecture

- **Effect 4**, pinned to an exact release candidate until 4.0 is stable.
- **Services and layers.** Router, engine registry, Worker pool, settings,
  storage and configuration are services. Configuration (ring and slot sizes,
  time budget, hang threshold, replay limit, surrounding-text window, restart
  schedule) is provided by layers.
- **Resources.** Workers are acquired and released within a `Scope`; engine
  instances are scoped to their input context. Disposing the library
  terminates all Workers.
- **Restart policy.** A `Schedule` (§8), replaceable through configuration.
- **Errors.** Tagged errors: `EngineLoadFailed`, `RuntimeAbiMismatch`,
  `ProtocolMismatch`, `EngineCrashed`, `EngineHung`, `ProtocolError`,
  `StorageUnavailable`.
- **Events.** Panel events, engine state, storage and settings changes are
  `Stream`s.
- **Logging.** `Effect.log*` with annotations for engine, input context and
  GLib domain. GLib levels map to Effect levels. Hosts replace or merge
  loggers with `Logger.layer` and set verbosity with
  `References.MinimumLogLevel`.
- **The keystroke path is plain synchronous TypeScript.** It reads a snapshot
  (active engine, Worker handles, busy flags) that services keep current, and
  hands decoded records and log lines to the streams and loggers through a
  synchronous enqueue drained by fibers. It must finish inside the event
  handler, and running a fiber per key would add overhead and fail if
  anything on the path became asynchronous.
- **Facade.** `ibus-web` wraps core in a `ManagedRuntime`: Promise methods,
  `EventTarget` events and a `logger: (entry) => void` option with a minimum
  level.

| Package                 | Contents                                        | Uses Effect                                             |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `@ibus-web/protocol`    | GVariant codec, schemas, SAB layout             | yes (Schema)                                            |
| `@ibus-web/core`        | router, services, adapters, keystroke path      | yes, except the keystroke path                          |
| `ibus-web`              | entry package: facade plus re-exports (§7.4.1)  | facade uses it internally; `ibus-web/effect` exposes it |
| `@ibus-web/panel`       | default panel                                   | through the facade                                      |
| `@ibus-web/worker-host` | Worker bootstrap, resource scopes, request loop | yes, except the request loop                            |

#### 7.4.1 The `ibus-web` entry package

Hosts install one package. `ibus-web` depends on the scoped packages and
exposes them through subpath exports:

| Import            | Contents                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ibus-web`        | the non-Effect facade                                                                                                                                              |
| `ibus-web/effect` | re-exports of the Effect surface: `@ibus-web/core` (services, layers, streams, tagged errors, adapters) and the public schemas and types from `@ibus-web/protocol` |
| `ibus-web/panel`  | re-export of `@ibus-web/panel`                                                                                                                                     |
| `ibus-web/worker` | the Worker script's URL only, for `new Worker(new URL(…, import.meta.url))`; never its code (§9.2)                                                                 |

- **`effect` is a peer dependency** of every package, so hosts and ibus-web
  share one copy. Two copies would make services and layers from one
  unrecognizable to the other.
- **The scoped packages stay published** for hosts that want finer-grained
  dependencies; the re-exports add no code of their own.
- **Subpaths are separate entry points**, so importing `ibus-web/effect` does
  not pull in the facade's `ManagedRuntime` wrapper, and the panel is included
  only when imported.

## 8. Errors and recovery

A WASM trap leaves a Worker's state untrustworthy; a crashed Worker is always
discarded, never repaired.

| Failure                                                      | Detection                                                                                                                                                                                                                                                                                                  | Handling                                                                                                                                                                                                                                                                                                                                                                                                                         | Host sees                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Trap (signature mismatch, `abort`, `g_error`, out of bounds) | Worker host catches `RuntimeError`, or a thread's error after `"unwind"` (§5.5)                                                                                                                                                                                                                            | Writes `CRASHED` and notifies. In-flight key passes through. Preedit cleared and panel hidden for the module's input contexts. Restart per policy.                                                                                                                                                                                                                                                                               | `EngineCrashed` with message and symbolized stack in debug builds                                            |
| Hang                                                         | no progress for 2 s, or replay queue over 64                                                                                                                                                                                                                                                               | `worker.terminate()`, then treated as a crash                                                                                                                                                                                                                                                                                                                                                                                    | `EngineHung`                                                                                                 |
| Restart                                                      | policy `Schedule`                                                                                                                                                                                                                                                                                          | Immediate retry, then exponential backoff; after 3 crashes in 60 s the module is failed and the router returns to direct input. A Worker the page terminated may hold the engine's writer lock for some 2 s more in Chromium, so the page first waits, up to 10 s, for that lock (§5.6). On restart, `Init` with the current settings and lazy instance recreation. Composition is lost; committed text and stored data are not. | engine state `failed` after the limit                                                                        |
| Load failure                                                 | fetch, compile, manifest `memory` check (a memory the in-memory fallback takes past the runtime's maximum included), instantiate, the storage mount (the backend fails to open although the probe found IndexedDB), a storage lock not granted within 120 s of the last word from its holder, data install | Engine never enabled; router stays in direct input; every lock the host took is let go (§5.6)                                                                                                                                                                                                                                                                                                                                    | `EngineLoadFailed`                                                                                           |
| Relay failure                                                | the relay writes `CRASHED` and wakes the host; a relay killed outright is a hang                                                                                                                                                                                                                           | as trap                                                                                                                                                                                                                                                                                                                                                                                                                          | `EngineCrashed`                                                                                              |
| Thread pool exhausted                                        | `pthread_create` fails with `EAGAIN`                                                                                                                                                                                                                                                                       | `g_thread_try_new` callers get the error; `g_thread_new` aborts, a trap; a `GTask` whose worker can't start stays queued, silently, until a worker is free                                                                                                                                                                                                                                                                       | engine-specific, or as trap; nothing for a queued `GTask`                                                    |
| ABI or protocol mismatch                                     | manifest check; `Init` version check                                                                                                                                                                                                                                                                       | as load failure                                                                                                                                                                                                                                                                                                                                                                                                                  | `RuntimeAbiMismatch`, `ProtocolMismatch`                                                                     |
| No IndexedDB                                                 | the host's probe of IndexedDB fails at startup, before the runtime's memory is made (an opaque origin, blocked site data, a third-party iframe denied storage; never Node, which mounts a Node-side backend)                                                                                               | in-memory mount, with the runtime's memory made larger by the data's size from the manifest, and the data installed at every start (§5.6); user data lasts as long as the Worker                                                                                                                                                                                                                                                 | `storage: ephemeral`                                                                                         |
| Not the writer                                               | another instance holds the engine's writer lock (§5.6)                                                                                                                                                                                                                                                     | the engine's own files mounted read-only for the Worker's life; changes fail with `EROFS`, which the engine sees; the page restarts the Worker to get a writer. Under Node the state is reported but not enforced                                                                                                                                                                                                                | `storage: read-only`                                                                                         |
| Quota                                                        | IndexedDB's `QuotaExceededError`; the write fails with `ENOSPC`, nothing changed                                                                                                                                                                                                                           | engine-specific                                                                                                                                                                                                                                                                                                                                                                                                                  | `storage` usage events, logs                                                                                 |
| Storage closed                                               | the backend's IndexedDB connection closes: another connection asked for a newer version of the database, or the browser closed it (§5.6); the host checks both mounts whenever it wakes                                                                                                                    | every later storage call fails with `EIO`, which the engine sees, and nothing reopens the connection; the page restarts the Worker per policy                                                                                                                                                                                                                                                                                    | `storage: closed`, when the host next wakes for a request or a GLib source; the close itself doesn't wake it |
| Undecodable record                                           | protocol decode                                                                                                                                                                                                                                                                                            | dev builds throw; production drops and logs                                                                                                                                                                                                                                                                                                                                                                                      | `ProtocolError` log                                                                                          |
| GLib warnings and criticals                                  | GLib log handler                                                                                                                                                                                                                                                                                           | forwarded as `Log` records; test builds use `G_DEBUG=fatal-criticals`                                                                                                                                                                                                                                                                                                                                                            | log entries                                                                                                  |
| Detached surface                                             | adapter detach                                                                                                                                                                                                                                                                                             | `DestroyEngine`; later output for the context dropped                                                                                                                                                                                                                                                                                                                                                                            | nothing                                                                                                      |

## 9. Licensing

### 9.1 Licenses

| Part                               | License                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| Page-side packages and Worker host | MIT OR Apache-2.0                                               |
| `libibus-web`                      | LGPL-2.1-or-later                                               |
| `pkgsWasm.glib`                    | LGPL-2.1-or-later (GLib's)                                      |
| Engine recipes and patches         | the engine's license                                            |
| Engine artifacts                   | the engine's license, covering the combined work in that Worker |

The repository follows the REUSE specification. License texts live in `LICENSES/`. Source files we write carry SPDX headers, and `REUSE.toml` annotates the rest by path: patches, generated files, documentation and, for each engine, its `engines/<name>/` directory. `REUSE.toml` is the authoritative per-path mapping; this table summarizes it.

Third-party tables in page packages keep their notices: Chromium's
`dom_code_data.inc` (BSD-3-Clause) and xorgproto's `keysymdef.h`
(`MIT-open-group` plus a Digital HPND-style notice).

The runtime must be compatible with every engine's GPL at once; GPLv2-only and
GPLv3 engines conflict with each other, which LGPL-2.1-or-later avoids, and
separate Workers keep differently licensed engines from ever being combined.
libc++ is Apache-2.0 with LLVM exceptions (GPLv2-compatible); musl is MIT.

This section is an engineering design. Legal review is required before
release.

### 9.2 Boundary rules

1. No Worker, runtime or engine code, including Emscripten glue, enters any
   page-side bundle. Workers load by URL; bundler inlining is forbidden.
2. The page communicates only through the dedicated SAB and `postMessage`,
   using the published protocol. It never touches WASM memory, and the
   protocol never carries pointers into it. The wake relay (§5.2.4) is
   host-side: it holds the runtime's memory, to bump the wake word there, and
   is started by the Worker host, not the page.
3. The protocol describes IBus behavior. The router never special-cases a GPL
   engine's internals.
4. At least one non-GPL engine ships: the custom table engine (MIT), second
   milestone.

### 9.3 Release obligations

- Every artifact is a Nix flake output built from the tagged commit, with the
  toolchain pinned by `flake.lock` (§10).
- Each engine artifact has a source bundle, itself a flake output, attached to
  the same release: the engine's fetched upstream sources, its patch layers,
  and the repository's Nix expressions and `flake.lock` at the tag. Because the
  flake is the build definition and pins the toolchain, the bundle is the
  complete build recipe, not a description of one.
- License notices ship with the packages; hosts link them from a licenses
  page.
- The runtime is a separately replaceable module, which meets LGPL relinking
  requirements.

### 9.4 CI checks

- Page bundles are scanned for Worker, runtime and Emscripten code.
- The protocol specification is regenerated and must match the committed one.
- Every engine artifact must have a source bundle.
- `reuse lint` passes (`checks.reuse`).
- Each `engines/<name>/` annotation in `REUSE.toml` matches that engine's `meta.license`.

## 10. Build, CI and releases

### 10.1 Repository

The flake is dendritic: `flake.nix` holds only inputs and passes `modules/`
through import-tree to flake-parts, so every `.nix` file there is a
flake-parts module. Modules share values only through `ibusWeb.*` per-system
options (the toolchain and its `pkgsWasm` package set, engines), never by
importing each other. import-tree imports only `.nix` files outside
`_`-prefixed paths, so non-Nix files a module needs sit beside it under
plain names; a `_` prefix is only for `.nix` files that aren't flake-parts
modules. Each component the build changes has one directory,
`modules/<component>/`: `overlay.nix` defines `flake.overlays.<component>`,
one gated overlay that may change several nixpkgs attributes; `patches/`
holds its patch files and a README recording their provenance; `checks/`
holds its checks, `checks/<name>.nix` or, with sources of its own,
`checks/<name>/default.nix` with its files beside it. The runtime and
each engine are components too, living at the repository root with their
flake-parts modules beside the sources they build. Each part of the
runtime has one directory, `runtime/<part>/`, holding its sources, its
modules (`package.nix`, `checks.nix`) and its tests, with runtime-wide
options in `runtime/options.nix`; `engines/<name>/` has the same shape as
`modules/<component>/` plus its manifest template and data. `flake.nix`
passes `./modules`, `./runtime` and, once it exists, `./engines` to
import-tree. Spikes' modules live in `modules/spikes/` until the code they
test replaces them.

```
ibus-web/
├─ flake.nix, flake.lock           inputs: nixpkgs, flake-parts, import-tree, treefmt-nix, devshell, flake-root, systems
├─ package.json, pnpm-*.yaml       the pnpm workspace and its lockfile
├─ modules/
│  ├─ flake/                       systems, formatting (treefmt-nix), dev shell, CI outputs
│  ├─ toolchain/                   pkgsWasm (Emscripten cross package set), emscriptenCache, wrapper hooks, probes
│  │  └─ checks/                   checks of the toolchain itself
│  ├─ <component>/                 overlay.nix, patches/, checks/ for one component (glib, libhangul, …)
│  ├─ engines/                     side-module packaging, data, source bundles
│  ├─ baseline-browser-mapping/    the package Emscripten's minimum versions come from
│  ├─ typescript/                  pnpm workspace builds, npm tarballs, protocol spec
│  ├─ playwright/                  nixpkgs' browsers and the environment the harnesses launch them in
│  ├─ spikes/                      spikes' checks and runners
│  └─ release.nix                  the release set
├─ docs/                           specs, plans, spike reports
├─ runtime/                        the runtime component; options.nix
│  ├─ libibus-web/                 C sources, ibus.h-compatible headers, package.nix, checks.nix, tests/
│  ├─ wasmfs-idb/                  the WasmFS IndexedDB backend: C++, its JS library, header, browser tests
│  └─ ibus-runtime/                the main-module link: package.nix, exports.nix, checks.nix, tests/
├─ engines/<name>/                 one component per engine: overlay.nix, patches/{port,casts}, checks/, manifest template, data
├─ packages/                       protocol, core, ibus-web, panel, worker-host
└─ tests/                          browser test runner, conformance harness, Playwright suites, benchmarks, spikes
```

One version for the whole project. Protocol version and runtime ABI version
are recorded separately and checked at load, but a release ships only
matching parts.

### 10.2 Nixpkgs as the source of dependencies

Everything builds through the flake: development dependencies, every artifact
and every check. **Dependencies, engines and engine data come from nixpkgs
wherever nixpkgs has them.** Updating the `nixpkgs` input is how versions move;
CI's conformance tests catch breakage, and our patch layers are rebased when
needed.

WASM builds come from a nixpkgs cross package set, `pkgsWasm`: nixpkgs
instantiated for `wasm32-unknown-none` (made static), with the cross stdenv's
compiler replaced by Emscripten through `config.replaceCrossStdenv` (§10.3).
Recipes are used unmodified wherever possible. Their dependencies,
`pkg-config`, and their autotools, Meson and CMake configuration all come from
nixpkgs' ordinary cross-compilation machinery. Where a recipe needs changes,
they are overlays applied to `pkgsWasm`, so every package that depends on it
sees the change. The flake's `packages` output holds only ibus-web's own
artifacts; WASM builds of nixpkgs packages are reached through
`legacyPackages.<system>.pkgsWasm`. Only packages nixpkgs lacks
(`libibus-web`, the custom table engine) get recipes of their own.

| Artifact             | nixpkgs recipe (at `8ce4ef6`)   | Build system | Notes                                                                  |
| -------------------- | ------------------------------- | ------------ | ---------------------------------------------------------------------- |
| `pkgsWasm.glib`      | `glib` 2.88.3                   | Meson        | Emscripten patch set on top of nixpkgs' `glib` (§10.3)                 |
| `pkgsWasm.libffi`    | `libffi` 3.8.0                  | autotools    | upstream WASM backend                                                  |
| `pkgsWasm.libhangul` | `libhangul` 0.2.0               | autotools    |                                                                        |
| `engine-hangul`      | `ibus-engines.hangul` 1.5.5     | autotools    | GPL-2.0-or-later                                                       |
| `pkgsWasm.m17n_lib`  | `m17n_lib` 1.8.6                | autotools    |                                                                        |
| `engine-m17n`        | `ibus-engines.m17n` 1.4.40      | autotools    | GPL-2.0-or-later                                                       |
| `pkgsWasm.libpinyin` | `libpinyin` 2.11.91             | autotools    | Kyoto Cabinet backend, as nixpkgs configures it                        |
| `engine-libpinyin`   | `ibus-engines.libpinyin` 1.16.5 | autotools    | GPL-3.0-or-later; also Berkeley DB 5.3 (Sleepycat), SQLite, OpenCC     |
| `pkgsWasm.librime`   | `librime` 1.17.0                | CMake        | Boost, LevelDB, marisa-trie, OpenCC, yaml-cpp, glog, each from nixpkgs |
| `engine-rime`        | `ibus-engines.rime` 1.6.1       | CMake        | GPL-3.0-or-later                                                       |

**Engine data** also comes from nixpkgs:

- **Rime:** `rime-data`, plus any other `rime-*` data packages, chosen through
  the same `rimeDataPkgs` parameter nixpkgs' `ibus-rime` uses. The YAML sources
  are compiled at build time by the WASM build of `rime_deployer` under Node,
  so compiled dictionaries come from the librime build that reads them.
- **m17n:** `m17n_db`'s output, used directly; it is text data.
- **Hangul:** the Hanja tables from nixpkgs' native `libhangul` output; also
  text.
- **libpinyin:** the model data nixpkgs' `libpinyin` recipe fetches, compiled
  into binary tables by the WASM build's own tools (R16).

**License fields** in engine manifests are generated from each recipe's
`meta.license` SPDX identifiers.

### 10.3 Toolchain and overrides

- **Emscripten from nixpkgs** (6.0.9 at `8ce4ef6`) plus the patches in
  `modules/emscripten/patches`, as `ibusWeb.toolchain.emscripten`. nixpkgs
  builds it against nixpkgs' LLVM rather than the revision upstream
  Emscripten pins (R12). Each patch is a small fix tracked upstream (an
  issue, a pull request or a draft report in `docs/upstream/`), dropped
  once an Emscripten release has it; the patches' README says which
  release that is. They fix WasmFS (`getcwd()` under a mount, `poll()` of
  files and devices, directory search and create permission, `O_NOCTTY`,
  pipes as FIFOs, `futimens()`, a backend's error when creating a file
  or a symlink or looking one up, the heartbeat timer of a backend's own thread outliving
  the thread),
  its Node backend (`fsync()`, renames, host errors from `open()` and
  `close()`, `chmod()` and `utimensat()` reaching the host), pthreads
  (a thread that ends without a join on the main runtime thread is
  reclaimed whenever that thread processes its queued calls, inside
  `emscripten_futex_wait()` too, not only from its event loop, with
  `dlopen()`'s sync holding those cleanups off while it walks its threads;
  a joined thread's late "finished" message no longer marks a new thread
  that reuses its `pthread_t`), an imported memory's maximum without growth
  (§5.3) and, backported from 6.0.10, `-sNODERAWFS` `fstat()` on the
  standard streams. nixpkgs installs the patched tree, so
  the cache and every link see them; `checks.emscripten-fixes` checks
  each one's behaviour.
- **`emscriptenCache`.** nixpkgs precompiles system libraries only for non-PIC
  variants, and builds otherwise use a per-build cache, so every PIC build
  would recompile libc and libc++. A dedicated derivation fills the cache by
  compiling probe programs with the project's compile flags and link
  settings, at `-O0` and `-O2`, so Emscripten's own link step populates the
  cache with the variants those flags select, rather than running
  `embuilder`. All other builds use it as a frozen, read-only cache.
- **Minimum versions.** Emscripten chooses WebAssembly and JavaScript
  features from `-sMIN_{CHROME,FIREFOX,SAFARI,NODE}_VERSION`, which every
  link gets from `ibusWeb.toolchain.minimumVersions`, never by hand. The
  browsers' are Baseline Widely available, from baseline-browser-mapping's
  CLI in a derivation (the package built from source in
  `modules/baseline-browser-mapping/`), evaluated on the date its data was
  last updated rather than the build machine's clock; Node's is the
  workspace's Node. A floor raises a browser's minimum above Baseline's
  where the design needs it, and has no effect once Baseline reaches it:
  Firefox's is 126, the first with `indexedDB.databases()`, which the host
  lists old versions' data with (§5.6); Firefox 124 and 125 together are
  some 0.02% of users. With baseline-browser-mapping 2.11.27 that is Chrome
  123, Firefox 126, Safari 17.4 and Node 24.19. They turn on extended-const
  and leave off growable shared buffers (`-sGROWABLE_ARRAYBUFFERS=2`) and
  the standard (exnref) encoding of WebAssembly exceptions (R18).
  `checks.toolchain-cache` compares the features they enable with
  `modules/toolchain/expected-features.txt`, so a change to the data that
  moves them is reviewed, and `checks.toolchain-exnref` fails once they
  reach exnref's (R18). A link gets only the minimums of the environments
  its `-sENVIRONMENT` allows (all of them when it names none), since emcc
  ignores the rest with a warning.
- **`pkgsWasm`.** `import nixpkgs` with `crossSystem` set to nixpkgs'
  `wasm32-unknown-none` example plus `isStatic = true` and
  `useEmscripten = true`, and
  `config.replaceCrossStdenv` swapping the compiler:
  - `emcc` and `em++` are wrapped by nixpkgs' `cc-wrapper` as a clang
    (`stdenv.cc.isClang`), with its version taken from the clang Emscripten
    is built against. The wrapper adds
    `-O2 -fPIC -pthread -fwasm-exceptions -mextended-const`
    (`ibusWeb.toolchain.commonFlags`) to every compile and link, and
    Emscripten's minimum versions (above) to every link, those of the
    environments it targets. `-O2` goes before the
    command's own arguments, so a package's own `-O` wins. An `-O2` link turns
    Emscripten's runtime assertions off, so every check and test link adds
    `-sASSERTIONS=1` itself.
  - The Emscripten binutils (`emar`, `emranlib`, LLVM's `nm`, `strip` and
    friends, `wasm-ld`) carry the target prefix, so the bintools wrapper
    wraps them and builds get `$AR`, `$NM` and the rest from it.
  - The wrapper's `--target` and `-nostdlibinc` are removed (emcc chooses its
    own target and sysroot), and the hardening defaults are limited to
    `format`, `pic` and `strictflexarrays1`.
  - A `cc-wrapper-hook` drops arguments that clang and lld accept but `emcc`
    and `wasm-ld` reject (`-static-libgcc`, `--undefined-version`). Recipes
    pass them because the wrapper presents Emscripten as clang with lld;
    nixpkgs' zlib, for example, adds both.
  - `libc` is `null`: Emscripten's libc lives in its cache sysroot, which
    emcc adds itself.
  - `isStatic` makes nixpkgs apply its `makeStatic` adapter to the cross
    stdenv: static libraries only, every build input propagated, and
    `-static` at link time. The frozen-cache hook is part of the stdenv.
  - Emscripten is the toolchain's, built for the build machine as
    `pkgsBuildBuild`'s would be. `buildPackages` would give it a WASM
    target platform, which rehashes it and everything under it, so even
    its dependencies would miss the binary cache.
  - `config.allowUnsupportedSystem` is set, because recipes' platform lists
    predate this target.
  - A setup hook gives every Meson build a second cross file setting
    `host_machine.system = 'emscripten'` and Node as exe wrapper, so Meson
    can run tests and `run()` checks. nixpkgs' own cross file reports the
    platform's kernel, `none`, and nixpkgs' `lib.systems` has no Emscripten
    kernel; autotools and CMake still see `wasm32-unknown-none`. Both cross
    files are exposed as `ibusWeb.toolchain.mesonCrossFlags` for configuring
    by hand.
- **Overlays** in the flake's `overlays` output carry every recipe change.
  Each is gated with
  `lib.optionalAttrs (prev.stdenv.hostPlatform.isWasm && (prev.stdenv.hostPlatform.useEmscripten or false))`,
  where `useEmscripten` is an attribute on `pkgsWasm`'s platform, so an
  overlay never reaches a native or WASI package set and the overlays are
  safe to export. The gate reads only the platform, because reading
  `stdenv.cc` would evaluate the wrapped compiler, whose `buildPackages`
  splicing reaches back into `pkgsWasm` and recurses. Layout: one per
  component, `modules/<component>/overlay.nix` defining
  `flake.overlays.<component>`, with its patches in
  `modules/<component>/patches/`. They do three things, and nothing else:
  1. drop desktop-only inputs and features: GTK and Python setup programs,
     `wrapGAppsHook3`, GObject introspection, libnotify, and network features
     such as ibus-libpinyin's cloud input (`libsoup_3`, `--enable-cloud-input-mode`);
  2. drop nixpkgs patches that only serve those features (for example
     ibus-hangul's `fix-paths.patch`, which edits the Python setup program);
  3. append our patch layers after nixpkgs' remaining patches: `patches/port`,
     then `patches/casts` as a separate list.
     Dependencies are never swapped by hand: cross splicing supplies the WASM
     builds. A patched package is never defined under another name, because
     dependents inside `pkgsWasm` would not see it.
- **GLib** is nixpkgs' `glib` recipe with an Emscripten patch series kept in
  this repository (`modules/glib/patches/`) and applied to
  `pkgsWasm.glib` by `flake.overlays.glib`, after nixpkgs' own `glib`
  patches, which are all kept. The patches README lists each patch with its
  source and the reason for it.
  - **Series.** 17 patches. Kleis Auke Wolthuizen's series from his
    `wasm-vips-<version>` branches of GLib (the one wasm-vips uses), rebased
    from 2.88.1 onto 2.88.3, without its GRegex removal and with its tool
    removal cut down to girepository and the fuzzers. Fluendo's
    `glist`/`gslist` signature fixes from `gst.wasm`; its main-context
    commits are superseded by ours. Ours, one patch per topic: GLib's own
    calls through mismatched function types, including the interface init
    functions `gdbus-codegen` generates, the adapters the dynamic-type
    macros refer to and class handlers called without `user_data`, through
    libffi (§5.1.2); the Unix parts and tools WebAssembly can take, with
    subprocess tests skipped and `g_file_query_exists` without the
    `faccessat` flags Emscripten doesn't support; a futex-backed `GWakeup`
    that blocking iteration sleeps on (§5.1.3); platform backends
    (§5.1.4); characters `iconv()` replaces; test-only fixes; and the wake
    hook the Worker host's pump relies on (§5.1.3).
  - **Tools.** GLib's tools (`glib-compile-schemas`,
    `glib-compile-resources`, `gio`, `gobject-query`, …) are built for
    WebAssembly as `.js` programs and run under Node; features they reach
    through Unix sources WebAssembly doesn't build report themselves
    unsupported. Each is installed as `<tool>.js` and `<tool>.wasm` plus a
    `<tool>` wrapper that runs it with the build machine's Node, so the
    paths `gio-2.0.pc` and `glib-2.0.pc` give (`glib_compile_schemas`,
    `gsettings`, …) run this GLib's tools; the build checks that every
    tool variable names an installed program. GLib's executables link
    with `-sNODERAWFS=1 -sEXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=8
-sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sASSERTIONS=1`; the
    libraries don't see these. The tools keep Node's raw filesystem, one of
    Emscripten's JavaScript file systems, because WasmFS's stdout turns a
    NUL byte into a line break (`gresource extract` of `a\0b\nc` prints
    `a\nb\nc\n`). Its Node backend's `fsync()` trap, which a second
    `glib-compile-schemas` into the same directory hit, is fixed by the
    toolchain's Emscripten patches.
  - **Tests' file system.** `checks.glib-tests` links GLib's tests with
    WasmFS, the file system the runtime ships, in place of
    `-sNODERAWFS=1`: `ibusWeb.toolchain.nodeHostFsFlags` is `-sWASMFS=1
-sNODE_HOST_ENV=1` and an object that roots WasmFS at the host's `/`
    through its Node backend and starts in Node's working directory.
    Emscripten's `-sNODERAWFS` under WasmFS roots the tree at the working
    directory instead, so absolute paths miss the build tree. Each test
    gets a `TMPDIR` of its own on the host; with the toolchain's fixes to
    the Node backend (`fsync()`, renames, `chmod()` and `utimensat()`,
    create errors) nothing needs it kept in memory. The tests link
    with a fixed memory (`ibusWeb.toolchain.testMemoryFlags`, 512 MiB)
    in place of growth (§5.3). `ibusWeb.toolchain.testMainFlags` links the
    GLib smoke, libhangul, dynamic-linking, toolchain and Emscripten-fix
    checks the same way.
  - **Tools in consumers' builds.** A cross build runs its tools on the
    build machine, whose GLib has unpatched ones (its `gdbus-codegen`
    emits interface init functions WebAssembly traps on). `pkgsWasm.glib`
    carries a setup hook that points Meson's gnome module at its tools
    through a cross file listing every tool its `.pc` files name; Autotools
    consumers get them through the `.pc` variables themselves. The gnome
    module also chooses tool options by the build machine's GLib version,
    which Meson reads through a build-machine pkg-config; the same hook
    points it at the build platform's pkg-config and GLib `.pc` files, so
    consumers need no `depsBuildBuild` for it.
  - **Overlay.** Removes `bash-interactive`, `gnum4`, `libsysprof-capture`,
    `gettext` and `libiconv` from the inputs (Emscripten's musl provides
    iconv and gettext), disables NLS, sysprof, documentation, tests and
    xattr, and drops the `devdoc` output.
- **TypeScript.** One pnpm workspace at the repository root (`package.json`,
  `pnpm-workspace.yaml` over `packages/*`, `tests/browser` and
  `tests/spikes/*`). Its
  dependencies are a fixed-output derivation (`fetchPnpmDeps` with pnpm 11,
  installed offline with `pnpmConfigHook`), and `ibusWeb.typescript.workspace`
  builds every package's `dist/` with `tsc`, the JavaScript browsers load.
  Each package has one `tsconfig.json` per environment directory over a
  shared base (`strict`, `erasableSyntaxOnly`, so Node runs the sources
  directly while iterating): `shared/` sees no environment's globals,
  `worker/` the WebWorker library, `page/` the DOM and `node/` Node's types.
  Versions pnpm can't know are asserted against what it resolved: the
  `playwright` package equals nixpkgs' `playwright-driver` (1.61.1 at
  `8ce4ef6`), and `packageManager` names nixpkgs' pnpm 11. The tests use
  `playwright-driver.browsers`, never downloaded, through
  `ibusWeb.testing.playwright` (§11).

#### 10.3.1 Derivation graph

```
emscriptenCache ─ pkgsWasm
 ├─ pkgsWasm.libffi ─┐
 ├─ pkgsWasm.glib ───┴─ libibus-web ─ ibus-runtime (main module and JS glue)
 ├─ pkgsWasm.libhangul ─────────── engine-hangul      (data: libhangul Hanja tables)
 ├─ pkgsWasm.m17n_lib ──────────── engine-m17n        (data: m17n_db)
 ├─ pkgsWasm.libpinyin ─────────── engine-libpinyin   (data: compiled model tables)
 └─ pkgsWasm.librime ───────────── engine-rime        (data: rime-data, deployed)
```

- **Source bundles** (`engine-<name>-src`) pack the `src` of every recipe in
  the engine's closure (the fetched upstream sources), the nixpkgs recipes as
  used, our overrides and patch layers, and `flake.lock` at the tagged commit
  (§9.3).

### 10.4 Checks

`nix flake check` runs:

- TypeScript unit and keystroke-path tests (Vitest), and a type check of every
  package in each of its environments (`checks.typescript`)
- `libibus-web` C tests (GTest, run by `meson test` under Node) and the GLib
  test subset, under Node
- the runtime's export manifest against its libraries (`ibus-runtime-exports`),
  its memory contract (`ibus-runtime-load`: it refuses a missing or
  out-of-bounds memory and never grows one), and every side module's imports
  against the manifest
- the IndexedDB backend's C test programs in Chromium and Firefox
  (`wasmfs-idb`), and its JavaScript library type-checked against types
  Emscripten generates, with every symbol it uses declared in its
  dependencies (`wasmfs-idb-types`)
- the browser test runner's own fixtures (`browser-run`)
- the toolchain's Emscripten fixes (`emscripten-fixes`), and the cache against
  every flag combination the builds use, with the features the minimum
  versions enable (`toolchain-cache`), and whether they now support the
  standard exception encoding (`toolchain-exnref`, R18)
- the Worker host's scenarios under Node and in Chromium and Firefox (§11)
- C/TS protocol parity
- engine conformance golden tests and callback-audit gates
- the license-boundary scan (§9.4)
- the generated protocol spec against the committed copy
- Playwright suites on nixpkgs' browsers

### 10.5 CI

- **Pull requests:** `nix flake check`, with a binary cache so the toolchain,
  library cache and dependency builds are fetched rather than rebuilt.
- **Tags:** `nix build .#release`, then publish. Publishing needs credentials,
  so it is the only step outside Nix, and it builds nothing: create the GitHub
  release with the assets from `release/`, then `npm publish` each prebuilt
  tarball.
- **npm:** npmjs.com with trusted publishing. The publish job gets
  `id-token: write` and exchanges its GitHub OIDC token for a short-lived npm
  credential, so no npm token is stored, and npm attaches provenance to each
  version. Each package on npmjs is configured to trust this repository's
  release workflow (R14).
- **Scheduled:** `nix build --rebuild .#release` to catch non-reproducible
  outputs.

### 10.6 Development shell

`nix develop` provides the toolchain, a writable copy of the library cache,
Node, pnpm and the Playwright browsers. Day-to-day work runs `meson` and
`pnpm` directly for fast iteration; `nix build` is for integration and CI.

- **WASM toolchain.** `pkgsWasm`'s wrapped compiler, binutils and
  `pkg-config`, under their target-prefixed names, with `meson` and `ninja`.
  `PKG_CONFIG_PATH` covers the libraries components register in
  `ibusWeb.toolchain.devLibraries` and their propagated inputs.
  `meson-setup-wasm` runs `meson setup` with `pkgsWasm`'s cross files.
- **clangd** comes from the LLVM Emscripten uses, so its builtin headers
  match, and trusts the wrapped compiler through `--query-driver`. The shell
  links a generated `.clangd` into the checkout that gives loose sources the
  cross compiler, the common flags and the dev libraries' include paths.
  `checks.clangd` keeps every C and C++ source in the repository parsing
  cleanly under it.

### 10.7 Release assets

The npm tarballs, `ibus-runtime.wasm` and its JS glue, each engine's `.wasm`,
data archives, manifest and source bundle, the generated protocol
specification and `release.json`.

## 11. Testing

1. **Protocol.** Unit tests and fuzzing for the GVariant codec; C/TS parity
   (fixtures serialized by real `IBusSerializable` in WASM, decoded and
   re-encoded byte for byte in TS, and the reverse); property tests from
   schema-derived arbitraries (fast-check).
2. **Runtime.** GLib's own tests, built by `pkgsWasm.glib`'s recipe and run
   under Node on WasmFS (§10.3) in `checks.glib-tests`.
   `modules/glib/checks/tests/baseline.toml` lists the tests that must pass,
   every one that passed in three reviewed runs (277 of 301), and the
   excluded tests, no part of which can run on Emscripten, with the reason:
   process spawning and sockets (11), which are reported but never run.
   Inside the tests that gate, a subtest whose expectation can't hold here
   skips with its reason: musl's missing locale data (until the §5.1.4
   backends); no sockets, processes, pseudo-terminals or Unix signals;
   IPv6 scope IDs and network interfaces; WasmFS's file-time precision and
   unbounded pipes;
   TZif files read by path (`/GTimeZone/parse-rfc8536`, since zones come
   from `Intl`); and, for `gio-tool.py`, no desktop applications to launch
   and content types without MIME types. The rest are reported on every
   run but don't gate: `testfilemonitor`, since there is no file-change
   notification until §5.1.4's monitor backend, and 12 tests that skip as
   a whole. Also C tests for `libibus-web` (lifecycle, emitters, pump,
   settings backend, the archive extractor) and, if the lazy arity lookup
   is built (§5.1.2), tests for it.
   **The IndexedDB backend** is tested where IndexedDB is, in the browsers.
   `ibusWeb.testing.browserRun` (`tests/browser/`) makes a check that runs
   C and C++ programs linked for a Worker (`ibusWeb.testing.browserLinkFlags`),
   each in a dedicated Worker on a page served with cross-origin isolation,
   in a fresh context of headless Chromium and of Firefox, and fails unless
   every one exits 0 in both; programs named `<prefix>.1`, `<prefix>.2`, …
   run in order in one context, so a later one sees what an earlier one
   stored. `checks.wasmfs-idb` runs the backend's ten: files, directories
   and their persistence across runs; a file read after it is unlinked;
   reads and writes that touch only the chunks they must (counted by a test
   library linked into tests only); sparse files, truncation, chunk
   boundaries and `EFBIG`; `fsync()` making exactly one strict commit, one
   that writes; quota failures, injected, that leave the database the same
   byte for byte; read-only and sealed backends refusing every change with
   `EROFS`; a version change closing every backend, with `EIO` after it; a
   failed open giving its thread back; and the orphan sweep, including one
   that fails. A fresh context is off the record, and Chromium keeps its
   IndexedDB in memory, so these checks say nothing about durability or
   its cost; the spike's measurements use profiles on disk.
   **The Worker host** runs one set of scenarios under Node, with
   `worker_threads` standing in for browser Workers, and through Playwright
   in headless Chromium and Firefox, offline in the Nix sandbox, against a
   Node server that sends COOP/COEP headers on every response: request
   latency from cold and back to back, wakes from other threads, source
   deadlines, thread creation from the host and from other threads while the
   host sleeps, the pool's exhaustion and top-up, threads that end unjoined,
   proxied calls, `fsync()` from a thread, exceptions across modules,
   thread crashes, and storage: the mount and its round trip, the in-memory
   fallback, a closed connection, installing engine data (fresh, found,
   concurrent, interrupted, upgrades running beside old versions, stale and
   changed paths, a torn marker, sealed data, a failed start letting go of
   its locks), one writer per engine, and the backend's costs, measured
   but never gated. The page spins for replies as the keystroke path does,
   and each scenario reports the calls that held it past D6's 40 ms budget.
   Known failures are listed per browser with a matcher for their cause, so
   a known failure that passes or fails another way fails the check.
   `ibusWeb.testing.playwright` supplies nixpkgs' browsers and their
   environment; Chromium keeps its own sandbox unless a builder that forbids
   unprivileged user namespaces turns it off (`chromiumSandbox`), and
   Firefox needs a writable `HOME`. M0.4's spike harness
   (`checks.runtime-spike-node`, `-browser`, `-memory`) holds these until
   M1's Worker host replaces it.
3. **Engine conformance.** A headless harness in Node with `worker_threads`
   and SAB (Node allows `Atomics.wait` on the main thread). Each engine has
   golden key-sequence tests, for example Hangul 2-set `g k s` → preedit `ㅎ`,
   `하`, `한`. The callback audit report must be empty or match the engine's
   committed allow-list.
4. **Keystroke path.** TS tests against an in-process fake Worker that speaks
   the ring protocol: timeouts, the replay queue, crashes, hangs, fragmented
   records, ordering with doorbell output.
5. **Adapters and panel.** Playwright on Chromium, Firefox and WebKit against
   a COOP/COEP server. Playwright's keyboard produces trusted events, so real
   `preventDefault`, commit, undo and preedit rendering are tested.
6. **License boundary.** The CI checks in §9.4.
7. **Performance.** Keystroke round trip (p50, p99) in Playwright;
   `UpdateLookupTable` decoding with 500 candidates, target under 0.5 ms.

## 12. Milestones

|        | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Questions answered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0     | M0.1–M0.5 done; M0.6 closes it. Flake, `emscriptenCache`, `pkgsWasm` and a first `nix flake check`; GLib Emscripten patches rebased onto nixpkgs `glib`; `pkgsWasm.glib` as main module; GLib test subset in Node; minimal `libibus-web`; load a trivial side module and one that starts a pthread; Worker wait loop with Emscripten threads and proxying; WasmFS IndexedDB backend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Does dynamic linking work with threads? Can the Worker block while threads and WasmFS work (R2)? Where do engine data and user files live? All three are answered: yes, with the toolchain's fixes (R3); yes, the host sleeps in the runtime while threads, proxied calls and `fsync()` complete (R2); in IndexedDB, through a WasmFS backend of our own (§5.6)                                                                                                                                                                                                                                                             |
| ↳ M0.1 | **Done, merged.** Plan `docs/plans/2026-09-26-m0-1-toolchain-and-dynlink.md`. Dendritic flake (flake-parts, import-tree, treefmt-nix, devshell, flake-root); prebuilt, frozen Emscripten library cache; `wasmStdenv` (replaced in M0.2); WASM libhangul; dynamic-linking spike                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | R3 answered yes for `-sMAIN_MODULE=1`/`-sNODERAWFS=1` under Node (`docs/spikes/2026-09-26-dynlink.md`); main modules must link with `em++`; Emscripten 6 defaults to legacy WASM exception handling                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ↳ M0.2 | **Done, merged.** Plan `docs/plans/2026-09-29-m0-2-emscripten-cross-set.md`. `pkgsWasm` cross package set replacing `wasmStdenv`; Emscripten-gated overlays; `legacyPackages` outputs; libhangul, zlib and libffi from unmodified recipes; Meson and cross `pkg-config` proven; WasmFS `-sMAIN_MODULE=2` link check; C, C++ and shell formatting; Darwin evaluation restored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | nixpkgs' cross-compilation machinery works with Emscripten as its compiler (R17 resolved); libffi's WASM backend works; the wrapper must drop `-static-libgcc` and `--undefined-version`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ↳ M0.3 | **Done, merged.** Plan `docs/plans/2026-09-29-m0-3-glib.md`. `pkgsWasm.glib` from nixpkgs' `glib` with a 16-patch Emscripten series (Wolthuizen's, Fluendo's `glist` fix, ours); GLib's tools as `.js` programs under Node; patched `gdbus-codegen` for consumers; GLib's own tests under Node with a gating baseline; Meson host system `emscripten`; `-O2` builds; prefixed binutils; WASM dev shell with clangd; REUSE licensing metadata (`LICENSES/`, SPDX headers, `REUSE.toml`) enforced by `checks.reuse`                                                                                                                                                                                                                                                                                                                                                                                                                 | GLib 2.88.3 builds for WASM with GRegex and its tools; 277 of 300 of GLib's own tests pass under Node and gate CI; class handlers work without the arity lookup; the remaining function-pointer gap is user callbacks with fewer parameters (§5.1.2)                                                                                                                                                                                                                                                                                                                                                                        |
| ↳ M0.4 | **Done.** Plan `docs/plans/2026-10-01-m0-4-runtime-skeleton.md`, spike `docs/spikes/2026-10-01-runtime-worker.md`. The `runtime/` component; GLib's wake hook; `libibus-web` skeleton (pump, `ibusweb_wait`, side-module loader, spike dispatcher; GTest under `meson test`); `ibus-runtime.wasm` with `-sMAIN_MODULE=2`, WasmFS, a fixed imported memory and a strict thread pool, and a per-library export manifest; Emscripten patches for blocked main threads' thread cleanup, reused `pthread_t`s and an imported memory's maximum; pnpm workspace built offline in Nix; spike Worker host and wake relay under Node, Chromium and Firefox; Emscripten's minimum versions from Baseline Widely available                                                                                                                                                                                                                    | R2 settled: the host sleeps in the runtime, woken by GLib's hook and a host-side relay; threads come from a pool sized from shares plus spares, strict, topped up while idle. R3 settled for `-sMAIN_MODULE=2`/WasmFS in Node, Chromium and Firefox. Memory is fixed per Worker, since V8 traps atomics on grown shared memory. OPFS is out: engine and user data go to IndexedDB (M0.5)                                                                                                                                                                                                                                    |
| ↳ M0.5 | **Done.** Plan `docs/plans/2026-10-02-m0-5-wasmfs-idb.md`, spike `docs/spikes/2026-10-01-runtime-worker.md`. WasmFS IndexedDB backend (full lazy) in `runtime/wasmfs-idb/`: files as `ArrayBuffer` chunks of 16 KiB, read and written lazily on the backend's own thread, writes write-through, `fsync()` a strict commit that writes, versionchange closing, a seal and a closed flag in its API (§5.6); its JavaScript library type-checked; a reusable browser test runner; the runtime mounts it in browsers, WasmFS's Node backend under Node and the memory backend without IndexedDB; engine data in a database per version, installed from ustar archives under per-version Web Locks, sealed and marked, old versions collected; one writer per engine's user data; Emscripten patches for symlink errors and a backend thread's heartbeat; a Firefox floor of 126; upstream draft `docs/upstream/wasmfs-idb-backend.md` | R2 for the IndexedDB backend: `fsync()` from a pthread completes while the host sleeps, in 4.3 ms in both browsers, within a poll step of the memory backend. A lazy 4 KiB read costs a keystroke 0.2–0.32 ms at 16 KiB chunks, and no read or write waits for the page's spin; 16 KiB is the cheapest of 16, 64 and 256 KiB for it, and chunks stay under 64 KiB, which Chromium stores as Blobs. An empty strict commit syncs nothing in either browser; a synced append costs about 0.5 ms. Chromium lets go of a terminated Worker's locks some 2 s late, so the page waits for the writer lock before a restart (§5.6) |
| ↳ M0.6 | Closing M0: every test structured — GTest for C and C++ (the `wasmfs-idb` browser tests, linked with `-sPROXY_TO_PTHREAD` so the Worker's event loop stays free, with persistence tests kept as numbered programs in one browser context; `checks.emscripten-fixes`' programs), Vitest for TypeScript (`ibus-runtime`'s load harness, GLib's test gate and its tests rewritten from Python, and the spike checks' runtime coverage as it moves out); the browser test runner replaced by a thin Vitest shim that runs each WASM program in Chromium and Firefox and reports each of its GTest cases as a Vitest result — closing the storage paths still untested; JavaScript that Emscripten doesn't read itself rewritten in TypeScript, the JavaScript it does read (JS libraries, pre- and post-js) typed with JSDoc, and one TypeScript check across the whole repository; hk (`hk.pkl`) holding the repository's checks, such as `tsc` in every directory with a `tsconfig.json`, run by the git hooks and by a flake check so both apply the same rules, and holding the formatters too, in place of treefmt (`nix fmt` runs `hk fix`); oxfmt formatting TypeScript and JavaScript in place of prettier and oxlint linting them; Claude Code's language-server plugins set up for the repository (clangd, TypeScript, and Nix), using the dev shell's servers; CI running `nix flake check` with a binary cache (§10.5); the drafts in `docs/upstream/` filed or dropped; check output free of known noise; clangd's configuration following the flake; the JS library checker's loose ends; the milestone plans and spike reports turned into lasting documentation and tests where they still matter, the rest deleted, and the spike checks' runtime coverage moved out before `tests/spikes` goes| What of M0's plans and spikes is still needed, and where it belongs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M1     | Hangul end to end: libhangul and ibus-hangul side module, Worker host, SAB channel, protocol package, minimal router, `<textarea>` adapter, basic panel for Hanja candidates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Cast and callback fix count and layer, and whether the lazy arity lookup is needed; GSettings bridge; decode speed with a synthetic large table                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M2     | Custom table engine (MIT), layout `default`; `contenteditable` adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Router generality; non-GPL engine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M3     | m17n: m17n-lib, ibus-m17n, m17n-db delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Surrounding text; large data sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M4     | libpinyin: C++ side module against the runtime's libc++, database backend, user dictionaries in IndexedDB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | C++ across modules; persistence; large lookup tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M5     | Rime: librime and dependencies, deployer thread, schemas deployed at build time, YAML through the storage API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Threads in a real engine; data size                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| M6     | 1.0: finished facade, docs, generated protocol spec, release pipeline with source bundles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 13. Risks and open questions

- **R1. Arity-tolerant callbacks.** The lazy lookup in §5.1.2 is unproven:
  the cost of a JS call per mismatched callback, and whether `.length` is
  reliable for every table entry Emscripten creates, are measured in M1. If
  the audit finds few mismatches, engine patches replace it.
- **R2. Blocking the Worker. Settled.** The Worker host sleeps inside the
  runtime, in `ibusweb_wait`, so calls other threads proxy to its thread,
  `pthread_create()` among them, run while it sleeps; a host-side relay
  forwards the page's wakes into WASM memory (§5.2.4). Threads come from a
  pool sized for the planned peak plus spares, fail with `EAGAIN` beyond it
  and are topped up while the host is idle (§5.3). Threads that end unjoined
  are reclaimed inside the wait by a toolchain patch to Emscripten, and
  `dlopen()` with live threads needs a second (§10.3); both are tracked by
  drafts in `docs/upstream/`. Calls Emscripten proxies as promises complete
  too: `fsync()` on WasmFS's memory and Node backends doesn't proxy at all,
  and on its OPFS backend, which proxies to the backend's own thread, it
  completes in both browsers while the host sleeps, because the backend's
  thread is notified directly through `Atomics.waitAsync`. All of this was
  measured under Node, Chromium 149 and Firefox 151 (spike
  `docs/spikes/2026-10-01-runtime-worker.md`). So does `fsync()` on the
  IndexedDB backend (§5.6), proxied the same way: 4.3 ms from a pthread
  while the host sleeps, in both browsers, against 4.2 ms on the memory
  backend, where the scenario's 2 ms poll dominates; the host's wakes
  aren't counted there, so that it never woke is shown by the time alone,
  and by the backend's calls running on its own thread. Still open: GLib's
  share covers one `GTask` in flight, and `GTask`s in flight at once can take
  more workers, up to its pool of 10 and beyond, so engines that run them
  concurrently need a rule; and the top-up rests on Emscripten's internal
  `PThread` until Emscripten has a public call to grow the pool.
- **R3. Dynamic linking with pthreads. Settled.** §5.3's thread pool is
  pre-allocated, so its workers exist before `main` runs and side modules
  load after the pool already exists: the harder case for dynamic linking
  with pthreads. The M0.1 spike passed in the `-sMAIN_MODULE=1`/`-sNODERAWFS=1`/Node
  configuration (`docs/spikes/2026-09-26-dynlink.md`), and M0.4's in the
  runtime's own, `-sMAIN_MODULE=2` with WasmFS, under Node and in
  Chromium 149 and Firefox 151: side modules loaded into a runtime whose
  pool already runs, threads on pool Workers calling into them, a C++
  exception thrown in a side module and caught in the runtime, and
  `dlopen()` while other threads run, once Emscripten's race on reused
  `pthread_t`s is patched (§10.3). WebKit isn't run (R13).
- **R4. GLib patch rebases.** The series is rebased from Wolthuizen's
  per-release `wasm-vips-<version>` branches, so each nixpkgs GLib update
  means rebasing from the nearest one. `checks.glib-patches` fails first
  when a nixpkgs update breaks the series. `ibusWeb.toolchain.mesonCrossFlags`
  imports nixpkgs' `pkgs/build-support/lib/meson.nix`, so an update that
  moves that file fails evaluation.
- **R5. The IndexedDB backend. Narrowed.** The backend is built (§5.6) and
  ours to keep until upstream takes it (draft
  `docs/upstream/wasmfs-idb-backend.md`). Its cost is measured: a lazy 4 KiB
  read costs a keystroke 0.2–0.32 ms at 16 KiB chunks in Chromium 149 and
  Firefox 151, and nothing it does waits for the page's spin. Its values
  must stay `ArrayBuffer`s under 64 KiB serialized, since a `Blob` brings
  back Firefox's wait on the page and Chromium wraps larger values as
  `Blob`s. Still open: WebKit's IndexedDB in Workers is unchecked (R13);
  quota failures are injected in the tests, not reached; the figures come
  from one machine's disk; and under Node, where the Node backend stands
  in, read-only mounts and seals aren't enforced and Web Locks don't span
  processes. The fallback is an in-memory mount, its data's size added to
  the runtime's memory, with an event.
- **R6. libpinyin databases in WASM.** nixpkgs builds libpinyin with Kyoto
  Cabinet and ibus-libpinyin with Berkeley DB 5.3 and SQLite. All three must
  build and perform acceptably on WasmFS's IndexedDB backend. Checked in M4.
- **R7. Rime data size.** Prebuilt schemas can be large; lazy download per
  schema may be needed. Decided in M5.
- **R8. Engine patch acceptance.** Cast fixes are UB fixes that upstreams may
  accept, shrinking the patch layers over time. Not required.
- **R9. Toolchain fix.** If `-fwasm-fix-function-bitcasts` or a call-site
  alternative ships in Emscripten, re-evaluate §5.1.1 and remove the cast layer.
- **R10. Decode speed.** If schema decoding exceeds the budget, lazy candidate
  decoding (§6.3).
- **R11. Legal review.** The boundary argument in §9 needs counsel before 1.0.
- **R12. nixpkgs Emscripten's LLVM.** nixpkgs pairs Emscripten with its own
  LLVM, not the revision upstream tests with, and its package runs only a
  hello-world test. Our test suites are the real check; if a codegen issue
  appears, override the Emscripten or LLVM version in the flake. At
  `8ce4ef6`, nixpkgs pairs Emscripten 6.0.9 with LLVM 22.1.8; upstream
  Emscripten expects 24.
- **R13. WebKit in the Nix sandbox.** If WebKit under Playwright is unreliable
  in the build sandbox, that suite runs as `nix develop -c` in CI instead of
  as a flake check.
- **R14. First publish with trusted publishing.** Check whether npm allows
  configuring a trusted publisher before a package's first version exists. If
  not, each package's first version needs a one-time manual publish.
- **R15. Native assumptions in nixpkgs recipes.** Engine recipes include
  desktop features (setup programs, cloud input, notifications) and patches
  for them. Overrides remove them per engine; a nixpkgs update can add new
  ones, which the WASM build or conformance tests will surface.
- **R16. libpinyin binary data.** libpinyin compiles its model into binary
  tables at build time. Building them with the WASM build's tools under Node
  avoids assuming the native format loads under wasm32; if that proves
  impractical, the format's portability must be verified.
- **R17. Platform identity of WASM builds. Resolved.** WASM packages come
  from `pkgsWasm`, whose `hostPlatform` is `wasm32-unknown-none` (static), so
  dependencies are routed by cross splicing and recipes' platform checks see
  WASM. Evaluation succeeds on Darwin again; Darwin builds are not yet
  verified on a Darwin builder.
- **R18. WebAssembly exception encoding.** `-fwasm-exceptions` emits the
  legacy encoding, which Firefox warns is deprecated for every Worker that
  instantiates the runtime. Emscripten's `-sWASM_LEGACY_EXCEPTIONS=0` emits the standard one
  (exnref, `try_table`), a compile and link setting that rebuilds every
  object and the cache. Its support (Chrome 137, Firefox 131, Safari 18.4)
  is Baseline newly available, widely available from about November 2027;
  Node 24.20 was measured to validate it. The switch waits until the minimum
  versions (§10.3) include it: `checks.toolchain-exnref` reads exnref's
  minimum versions from Emscripten's feature matrix
  (`tools/feature_matrix.py`) and fails, asking for the switch, once the
  derived minimum versions all reach them.

## 14. References

- Kleis Auke Wolthuizen's GLib `wasm-vips-<version>` branches:
  https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1
- Fluendo GLib `gst.wasm`:
  https://github.com/GNOME/glib/compare/2.76.0...fluendo:glib:gst.wasm
- Fluendo LLVM `wasm-function-pointers`:
  https://github.com/llvm/llvm-project/compare/main...fluendo:llvm-project:wasm-function-pointers
- LLVM PR #153168 (function bitcasts in Clang):
  https://github.com/llvm/llvm-project/pull/153168
- GLib #3596 (WebAssembly support), MR !4469 (function-pointer cast
  requirements), #3670, MR !4660:
  https://gitlab.gnome.org/GNOME/glib/-/work_items/3596
- GLib toolchain requirements:
  https://gitlab.gnome.org/GNOME/glib/-/blob/main/docs/toolchain-requirements.md
- Emscripten #11066 (GLib port), #23952 and PR #24169 (cast emulation
  deprecation and revert), #22285 (exceptions with `MAIN_MODULE` and cast
  emulation), #15081:
  https://github.com/emscripten-core/emscripten/issues/11066
- xorgproto `keysymdef.h`:
  https://gitlab.freedesktop.org/xorg/proto/xorgproto/-/blob/master/include/X11/keysymdef.h
- Chromium `dom_code_data.inc`:
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/events/keycodes/dom/dom_code_data.inc
- Effect 4 documentation: https://www.effect.website/docs/v4/
- nixpkgs Emscripten package and documentation (at `8ce4ef6`):
  `pkgs/development/compilers/emscripten/default.nix`,
  `doc/languages-frameworks/emscripten.section.md`,
  `pkgs/top-level/emscripten-packages.nix`
