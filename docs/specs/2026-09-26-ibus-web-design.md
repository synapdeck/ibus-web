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

| # | Decision | Chosen | Main alternatives rejected |
|---|---|---|---|
| D1 | Deployment | Library inside host-owned pages | Browser extension; canvas remote desktop |
| D2 | Engine targets | Hangul, m17n, libpinyin, Rime, custom table engine | Arbitrary engines from day one |
| D3 | Engine compatibility | Real GLib/GObject/GIO subset; engine glue compiles with small, layered patches | Source-unmodified (forces a full GIO port); porting guide with a GObject-free API |
| D4 | Main loop | No `GMainLoop`; pump the default context after each dispatch and on source deadlines | Real `GMainLoop` |
| D5 | Where engines run | One Worker per engine module, keeping GPL code out of the page | Main thread; Worker per input context; one Worker for everything |
| D6 | Keystroke answer | Main thread spin-waits on a SAB reply with a time budget; consume-and-replay on timeout | Always consume and re-implement editing; predict from composition state |
| D7 | Instances | One engine instance per input context via `IBusFactory` | Shared instance |
| D8 | Linking | Shared `ibus-runtime.wasm` main module; engines as side modules | Static GLib in every engine |
| D9 | GLib base | nixpkgs `glib` plus Wolthuizen's per-release Emscripten patches, rebased onto nixpkgs' GLib, as a patch series; nixpkgs Emscripten with small fixes tracked upstream, no forked compiler or LLVM | `EMULATE_FUNCTION_POINTER_CASTS`; Fluendo GLib + patched Clang |
| D10 | Settings | GSettings backend bridge and API only | Generated forms; per-engine UI |
| D11 | UI | Headless core plus separate default panel package | Headless only; built-in themed panel |
| D12 | Surfaces | Adapter contract; `<input>`/`<textarea>` and `contenteditable` built in | Textarea only; CodeMirror adapter in v1 |
| D13 | Storage | WasmFS with the OPFS backend per Worker, one directory per engine | Host-managed storage only |
| D14 | Wire format | IBus Engine D-Bus methods and signals, GVariant-encoded | Custom CBOR mapping |
| D15 | Output transport | One sequenced, variable-length, back-pressured output ring per Worker | Fixed-size ring with eviction; ring of descriptors into a shared heap |
| D16 | TypeScript stack | Effect 4 throughout, including the Worker host; the keystroke path and the Worker request loop are synchronous sections | Plain TypeScript; Effect 3 |
| D17 | Protocol definition | Effect Schema as the source of truth, with a GVariant byte codec | Hand-written codec and separate docs |
| D18 | First milestone | Hangul spike end to end | libpinyin or Rime first |
| D19 | Build orchestration | Nix flake for toolchain, every artifact, checks and the release set; dependencies, engines and data come from a nixpkgs cross package set for wasm32-unknown-none with Emscripten as its compiler; CI only builds outputs and uploads them | emsdk plus scripts; per-language build tools orchestrated by CI |
| D20 | npm registry | npmjs.com with trusted publishing from GitHub Actions | GitHub Packages |

## 4. Architecture

### 4.1 Components

```
 Page (MIT OR Apache-2.0)                     Worker, one per engine module (engine's GPL)
┌─────────────────────────────────────┐      ┌──────────────────────────────────────────┐
│ Host app                            │      │ Worker host (Effect)                     │
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
└─────────────────────────────────────┘      │ OPFS: /engines/<name>/…                  │
                                             └──────────────────────────────────────────┘
```

| Component | Language | Runs in | Package or artifact | License |
|---|---|---|---|---|
| `pkgsWasm.glib` | C | Worker | nixpkgs `glib` plus a patch series in this repo; built into the runtime | LGPL-2.1-or-later |
| `libibus-web` | C | Worker | built into the runtime | LGPL-2.1-or-later |
| `ibus-runtime.wasm` | WASM | Worker | release asset | LGPL-2.1-or-later (combined) |
| Engine side modules | WASM | Worker | release asset per engine | engine's own license |
| Worker host | TS | Worker | `@ibus-web/worker-host` | MIT OR Apache-2.0 |
| Protocol | TS | Page and tests | `@ibus-web/protocol` | MIT OR Apache-2.0 |
| Router and services | TS | Page | `@ibus-web/core` | MIT OR Apache-2.0 |
| Facade | TS | Page | `ibus-web` | MIT OR Apache-2.0 |
| Surface adapters | TS | Page | in `@ibus-web/core` | MIT OR Apache-2.0 |
| Default panel | TS | Page | `@ibus-web/panel` | MIT OR Apache-2.0 |

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
main-context fixes and our own. Built with nixpkgs Emscripten and Meson
cross files (§10). D-Bus,
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
- **Not covered.** Callees declaring *more* parameters than passed, and
  mismatches in engine code that GLib never calls. Those need engine patches.
- **Audit output.** Debug builds log every absorbed mismatch with the callee's
  name and the call site. That log is the engine audit report (§11.3).
- **Only if needed.** The lookup is built when the engine audit shows it pays
  for itself. If the target engines have only a few such callbacks, they are
  fixed in each engine's `patches/casts` instead and the lookup is not built.

#### 5.1.3 Other `pkgsWasm.glib` changes

- Hooks for the pump (§5.2.4) and GSettings backend registration (§5.2.5).
  The pump hook includes the context wakeup: on WebAssembly,
  `g_wakeup_signal` (reached through `g_main_context_wakeup`) also bumps
  and notifies an atomic word the Worker host waits on, besides the
  wakeup's own futex.
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
- From Fluendo's `gst.wasm` branch: wakeups that no longer abort and the
  main context skipping the wakeup's poll fd. Its zero poll timeouts are
  replaced by the futex wait above. Its `emscripten_set_main_loop`
  integration and the deadlock fix that only concerns it are not taken;
  the runtime pumps the context itself.
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
  reload user dictionaries or configuration when they change. Changes made to
  OPFS from another tab need `FileSystemObserver` or a message from that tab.
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
FALSE)` until nothing is pending, after every dispatch. Between requests, the
Worker host waits on the request word with a timeout equal to the next source
deadline from `g_main_context_query`, and pumps when the timeout expires. JS
timers are never needed in the Worker, which matters because a Worker blocked
in `Atomics.wait` never runs its event loop.

Sources can also become ready on other threads: a `GTask` finishing in the
thread pool, or an engine library's own thread calling `g_idle_add`. GLib
announces these by signalling the context's wakeup, which on WebAssembly also
notifies the word the host waits on (§5.1.3), so the host wakes and pumps then
rather than at the next request or deadline. GLib signals for a source attached
from another thread only when the context has an owner, so the pump's thread
acquires the default context once for the Worker's lifetime; acquiring is
recursive, so its non-blocking iterations still work. A test attaches a source from another thread
while the host waits and checks that it is dispatched promptly.

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
- **Build.** `-sMAIN_MODULE=2` with an explicit, versioned export list.
  Everything is compiled with `-fPIC`. Threads are enabled with a
  pre-allocated pool (`-sPTHREAD_POOL_SIZE`), so creating a thread never has to
  yield to the event loop (§13, R2). GRegex overflows Emscripten's 64 KiB
  default stack, so the link sets `-sSTACK_SIZE` to at least 1 MiB, and
  `-sDEFAULT_PTHREAD_STACK_SIZE` too if GLib runs on a pthread.
- **ABI version.** The export list's version is the runtime ABI version. Every
  engine manifest records the version it was built against, and a mismatch is
  a load failure (§8).
- **Memory.** Memory growth with pthreads is unresolved. In GLib's tests a
  pthread of a test with many threads occasionally faulted out of bounds
  (13 of 300 runs under load); the same test linked with a fixed memory
  just above its peak never did (0 of 300), but a GLib-free reproduction
  hasn't shown it yet. GLib's tests and the other Node-run checks now link
  with a fixed 512 MiB (`ibusWeb.toolchain.testMemoryFlags`; the largest
  test, `mainloop`, peaks at 280 MiB), so a fault can't hide behind the
  gate's rerun; GLib's tools still grow. The runtime's link chooses fixed
  memory per Worker, sized for the side modules it loads later (R3), or
  growth with a mitigation found by then.
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
  "version": "1.5.4+ibusweb.1",
  "license": "GPL-2.0-or-later",
  "runtimeAbi": 1,
  "protocol": 1,
  "module": "hangul.wasm",
  "data": [{ "path": "/usr/share/libhangul", "url": "hangul-data.tar" }],
  "engines": [{
    "name": "hangul",
    "longname": "Korean",
    "language": "ko",
    "layout": "us",                 // "us" or "default" (§7.1.1)
    "passthroughKeys": ["F1", "F2"],  // DOM key names that skip the round trip
    "symbol": "한"
  }],
  "settingsSchemas": ["org.freedesktop.ibus.engine.hangul"],
  "source": "hangul-src.tar.zst"
}
```

### 5.5 Worker host

TypeScript on Effect 4. Loaded by URL as its own file, never inlined into the
page bundle (§9.2).

1. Receives the compiled runtime module, the SAB and the manifest by
   `postMessage`.
2. Builds the Worker's resources in nested scopes (below): instantiates the
   runtime, mounts storage (§5.6), fetches and installs data files, loads the
   side module and calls `ibusweb_module_init`.
3. Enters the request loop: `Atomics.wait` on the request word with the pump
   deadline as timeout, dispatch or pump, write the reply, repeat.
4. Wraps every dispatch and pump in a handler for WASM traps (§8).

#### 5.5.1 Resource scopes

| Scope | Acquire | Release on normal close | Release after a trap |
|---|---|---|---|
| Worker | SAB views, `Logger` layer | final `Log` records flushed | crash record written |
| Runtime | instantiate `ibus-runtime.wasm` | none (freed with the Worker) | none |
| Storage | WasmFS mounts, data archives | flush and unmount OPFS | close OPFS handles from JS only |
| Engine module | load side module, `ibusweb_module_init` | module shutdown call | skipped |
| Engine instance (one per input context, child of the module scope) | `CreateEngine` | `DestroyEngine` (`g_object_unref`) | skipped |

- **Finalizers inspect the `Exit`.** After a trap the WASM heap cannot be
  trusted, so finalizers that call into the runtime run only on a normal close;
  JS-side cleanup and crash reporting always run.
- **Nothing depends on finalizers for correctness.** A hang ends in
  `worker.terminate()`, which runs no finalizers; the browser releases OPFS
  access handles when the Worker ends. Emscripten side modules are not
  actually unloaded, so the module scope is bookkeeping; the Worker is the
  unit that frees memory.

#### 5.5.2 The request loop and the Effect runtime

The request loop is a single synchronous section inside the scoped program. A
thread blocked in `Atomics.wait` runs no other fibers, so nothing in the
Worker may rely on concurrent fibers or Effect timers while the loop runs; GLib
time is handled by the wait timeout (§5.2.4). Engine-instance scopes are opened
and closed synchronously from the loop as `CreateEngine` and `DestroyEngine`
arrive.

#### 5.5.3 Logging

The Worker's `Logger` layer writes `Log` records into the output ring, and the
GLib log handler (§8) feeds the same logger. The page re-emits them through
its own loggers with engine and domain annotations (§7.4).

### 5.6 Storage

- **Filesystem.** WasmFS with the OPFS backend, mounted at `/engines/<name>/`,
  for user dictionaries (libpinyin, Rime), Rime's deployed data and user YAML.
  GSettings values are not stored here; the settings bridge hands them to the
  host (§5.2.5).
- **Data files.** Read-only engine data (m17n-db, Hangul Hanja tables, Rime's
  prebuilt schemas) is fetched as archives listed in the manifest and
  unpacked into an in-memory directory, cached by the browser's HTTP cache.
- **Fallback.** Where OPFS is unavailable, the mount is in-memory and the host
  receives a `storage: ephemeral` event (§8).
- **Host API.** Usage report, export (a tar of the engine directory) and reset.

## 6. The Worker-boundary protocol

### 6.1 Messages

#### 6.1.1 Wire format

Messages are the methods and signals of IBus's `org.freedesktop.IBus.Engine`
D-Bus interface, with payloads in GVariant serialization, which is how IBus
already puts `IBusText`, `IBusLookupTable` and `IBusProperty` on the wire. All
per-instance messages carry an input-context ID (`u`).

#### 6.1.2 Requests (page → Worker)

| Message | Signature (after IC ID) | Reply |
|---|---|---|
| `ProcessKeyEvent` | `(uuu)` keyval, keycode, state | `b` |
| `FocusIn`, `FocusOut`, `Reset`, `Enable`, `Disable` | `()` | none |
| `SetCursorLocation` | `(iiii)` | none |
| `SetCapabilities` | `(u)` | none |
| `PageUp`, `PageDown`, `CursorUp`, `CursorDown` | `()` | none |
| `CandidateClicked` | `(uuu)` index, button, state | none |
| `PropertyActivate` | `(su)` name, state | none |
| `SetSurroundingText` | `(vuu)` text, cursor, anchor | none |
| `SetContentType` | `(uu)` purpose, hints | none |

#### 6.1.3 Lifecycle and settings requests

| Message | Payload | Notes |
|---|---|---|
| `Init` | protocol version, settings snapshot | exact protocol-version match required |
| `CreateEngine` | IC ID, engine name | |
| `DestroyEngine` | IC ID | |
| `SettingChanged` | schema, key, `v` | |

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

| Region | Size (default) | Contents |
|---|---|---|
| Control header | 64 bytes | `Int32` words: `state` (IDLE, REQUEST, REPLY, CRASHED), `reqSeq`, `reqLen`, `replyRet`, `replyOutSeq`, `ringWrite`, `ringRead`, `doorbell` |
| Request slot | 64 KB | one encoded request |
| Output ring | 256 KB | framed records |

Sizes are configurable per Worker.

#### 6.2.2 Records and back-pressure

- **Framing.** `seq` (u32), `ic` (u32), `kind` (u16), `flags` (u16), `len`
  (u32), then the payload, padded to 8 bytes.
- **No overwriting.** The page advances `ringRead` only after decoding a
  record.
- **Full ring.** The Worker posts a doorbell, then `Atomics.wait`s on
  `ringRead`. The page drains and `Atomics.notify`s; notifying is allowed on
  the main thread.
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

1. Write the request, store `reqLen`, set `state = REQUEST`, notify.
2. Loop: drain available ring records into a pending batch. Stop when
   `state == REPLY` and every record up to `replyOutSeq` is drained; or when
   `state == CRASHED`; or when the time budget runs out.
3. On reply, set `state = IDLE` and apply the batch.

Worker:

1. Wake on `state == REQUEST`; dispatch; pump; flush output to the ring
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
  readonly capabilities: Capabilities;   // preedit, auxText, lookupTable, surroundingText
  contentType(): ContentType;

  surrounding(maxUnits: number): { text: string; cursor: number; anchor: number };
  caretRect(): DOMRect | null;           // viewport coordinates

  batch(fn: () => void): void;           // one host transaction, one undo step
  commit(text: string): void;            // insert at the caret as user input
  deleteSurrounding(offset: number, length: number): void;
  setPreedit(p: Preedit | null): void;   // text, attributes, cursor; null clears
  replayKey(e: KeyboardEvent): void;     // apply a declined key after a timeout
}

interface KeySink {
  key(e: KeyboardEvent): "consumed" | "passthrough";  // synchronous
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

| | `<input>` / `<textarea>` | `contenteditable` |
|---|---|---|
| Commit | `setRangeText`, then an `input` event | `execCommand('insertText')`, which keeps native undo |
| Preedit | positioned overlay; caret found with a mirror element | non-editable inline `<span>` at the caret, removed before each commit |
| Replay | insert character or perform the editing action manually | same, via `execCommand` |

#### 7.2.4 CodeMirror 6 check (not in v1)

| Contract | CodeMirror 6 |
|---|---|
| `attach` | `EditorView.domEventHandlers` at high precedence |
| `batch`, `commit`, `deleteSurrounding` | one `view.dispatch` with `changes` and `userEvent: "input.type"` |
| `setPreedit` | `Decoration.widget` at the cursor through a `StateField` |
| `caretRect` | `view.coordsAtPos(head)` |
| `surrounding` | `state.doc.sliceString` around the selection |

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

| Package | Contents | Uses Effect |
|---|---|---|
| `@ibus-web/protocol` | GVariant codec, schemas, SAB layout | yes (Schema) |
| `@ibus-web/core` | router, services, adapters, keystroke path | yes, except the keystroke path |
| `ibus-web` | entry package: facade plus re-exports (§7.4.1) | facade uses it internally; `ibus-web/effect` exposes it |
| `@ibus-web/panel` | default panel | through the facade |
| `@ibus-web/worker-host` | Worker bootstrap, resource scopes, request loop | yes, except the request loop |

#### 7.4.1 The `ibus-web` entry package

Hosts install one package. `ibus-web` depends on the scoped packages and
exposes them through subpath exports:

| Import | Contents |
|---|---|
| `ibus-web` | the non-Effect facade |
| `ibus-web/effect` | re-exports of the Effect surface: `@ibus-web/core` (services, layers, streams, tagged errors, adapters) and the public schemas and types from `@ibus-web/protocol` |
| `ibus-web/panel` | re-export of `@ibus-web/panel` |
| `ibus-web/worker` | the Worker script's URL only, for `new Worker(new URL(…, import.meta.url))`; never its code (§9.2) |

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

| Failure | Detection | Handling | Host sees |
|---|---|---|---|
| Trap (signature mismatch, `abort`, `g_error`, out of bounds) | Worker host catches `RuntimeError` | Writes `CRASHED` and notifies. In-flight key passes through. Preedit cleared and panel hidden for the module's input contexts. Restart per policy. | `EngineCrashed` with message and symbolized stack in debug builds |
| Hang | no progress for 2 s, or replay queue over 64 | `worker.terminate()`, then treated as a crash | `EngineHung` |
| Restart | policy `Schedule` | Immediate retry, then exponential backoff; after 3 crashes in 60 s the module is failed and the router returns to direct input. On restart, `Init` with the current settings and lazy instance recreation. Composition is lost; committed text and OPFS data are not. | engine state `failed` after the limit |
| Load failure | fetch, compile, instantiate, data install | Engine never enabled; router stays in direct input | `EngineLoadFailed` |
| ABI or protocol mismatch | manifest check; `Init` version check | as load failure | `RuntimeAbiMismatch`, `ProtocolMismatch` |
| No OPFS | mount fails | in-memory mount | `storage: ephemeral` |
| Quota | write errors surface in the engine | engine-specific | `storage` usage events, logs |
| Undecodable record | protocol decode | dev builds throw; production drops and logs | `ProtocolError` log |
| GLib warnings and criticals | GLib log handler | forwarded as `Log` records; test builds use `G_DEBUG=fatal-criticals` | log entries |
| Detached surface | adapter detach | `DestroyEngine`; later output for the context dropped | nothing |

## 9. Licensing

### 9.1 Licenses

| Part | License |
|---|---|
| Page-side packages and Worker host | MIT OR Apache-2.0 |
| `libibus-web` | LGPL-2.1-or-later |
| `pkgsWasm.glib` | LGPL-2.1-or-later (GLib's) |
| Engine recipes and patches | the engine's license |
| Engine artifacts | the engine's license, covering the combined work in that Worker |

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
   protocol never carries pointers into it.
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
`checks/<name>/default.nix` with its files beside it. An engine is a
component too, living at the repository root in `engines/<name>/` with the
same shape plus its manifest template and data; `flake.nix` passes both
`./modules` and `./engines` to import-tree.

```
ibus-web/
├─ flake.nix, flake.lock           inputs: nixpkgs, flake-parts, import-tree, treefmt-nix, devshell, flake-root, systems
├─ modules/
│  ├─ flake/                       systems, formatting (treefmt-nix), dev shell, CI outputs
│  ├─ toolchain/                   pkgsWasm (Emscripten cross package set), emscriptenCache, wrapper hooks, probes
│  │  └─ checks/                   checks of the toolchain itself
│  ├─ <component>/                 overlay.nix, patches/, checks/ for one component (glib, libhangul, …)
│  ├─ runtime/                     libibus-web and ibus-runtime
│  ├─ engines/                     side-module packaging, data, source bundles
│  ├─ typescript/                  pnpm workspace builds, npm tarballs, protocol spec
│  └─ release.nix                  the release set
├─ docs/                           specs, plans, spike reports
├─ runtime/libibus-web/            C sources and ibus.h-compatible headers
├─ engines/<name>/                 one component per engine: overlay.nix, patches/{port,casts}, checks/, manifest template, data
├─ packages/                       protocol, core, ibus-web, panel, worker-host
└─ tests/                          conformance harness, Playwright suites, benchmarks, spikes
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

| Artifact | nixpkgs recipe (at `8ce4ef6`) | Build system | Notes |
|---|---|---|---|
| `pkgsWasm.glib` | `glib` 2.88.3 | Meson | Emscripten patch set on top of nixpkgs' `glib` (§10.3) |
| `pkgsWasm.libffi` | `libffi` 3.8.0 | autotools | upstream WASM backend |
| `pkgsWasm.libhangul` | `libhangul` 0.2.0 | autotools | |
| `engine-hangul` | `ibus-engines.hangul` 1.5.5 | autotools | GPL-2.0-or-later |
| `pkgsWasm.m17n_lib` | `m17n_lib` 1.8.6 | autotools | |
| `engine-m17n` | `ibus-engines.m17n` 1.4.40 | autotools | GPL-2.0-or-later |
| `pkgsWasm.libpinyin` | `libpinyin` 2.11.91 | autotools | Kyoto Cabinet backend, as nixpkgs configures it |
| `engine-libpinyin` | `ibus-engines.libpinyin` 1.16.5 | autotools | GPL-3.0-or-later; also Berkeley DB 5.3 (Sleepycat), SQLite, OpenCC |
| `pkgsWasm.librime` | `librime` 1.17.0 | CMake | Boost, LevelDB, marisa-trie, OpenCC, yaml-cpp, glog, each from nixpkgs |
| `engine-rime` | `ibus-engines.rime` 1.6.1 | CMake | GPL-3.0-or-later |

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
  pipes as FIFOs, `futimens()`, a backend's error when creating a file),
  its Node backend (`fsync()`, renames, host errors from `open()` and
  `close()`, `chmod()` and `utimensat()` reaching the host) and,
  backported from 6.0.10, `-sNODERAWFS` `fstat()` on the standard
  streams. nixpkgs installs the patched tree, so
  the cache and every link see them; `checks.emscripten-fixes` checks
  each one's behaviour.
- **`emscriptenCache`.** nixpkgs precompiles system libraries only for non-PIC
  variants, and builds otherwise use a per-build cache, so every PIC build
  would recompile libc and libc++. A dedicated derivation fills the cache by
  compiling probe programs with the project's compile flags and link
  settings, at `-O0` and `-O2`, so Emscripten's own link step populates the
  cache with the variants those flags select, rather than running
  `embuilder`. All other builds use it as a frozen, read-only cache.
- **`pkgsWasm`.** `import nixpkgs` with `crossSystem` set to nixpkgs'
  `wasm32-unknown-none` example plus `isStatic = true` and
  `useEmscripten = true`, and
  `config.replaceCrossStdenv` swapping the compiler:
  - `emcc` and `em++` are wrapped by nixpkgs' `cc-wrapper` as a clang
    (`stdenv.cc.isClang`), with its version taken from the clang Emscripten
    is built against. The wrapper adds `-O2 -fPIC -pthread -fwasm-exceptions`
    to every compile and link. `-O2` goes before the command's own arguments,
    so a package's own `-O` wins. An `-O2` link turns Emscripten's runtime
    assertions off, so every check and test link adds `-sASSERTIONS=1` itself.
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
  - **Series.** 37 patches. Kleis Auke Wolthuizen's series from his
    `wasm-vips-<version>` branches of GLib (the one wasm-vips uses), rebased
    from 2.88.1 onto 2.88.3, without its GRegex removal and with its tool
    removal cut down to girepository and the fuzzers. Fluendo's main-context
    fixes from `gst.wasm` (no-op wakeups, the context skipping its wakeup
    fd, zero poll timeouts) and its `glist`/`gslist` signature fixes, but
    not its `emscripten_set_main_loop` integration. Ours: a futex-backed
    `GWakeup` that blocking iteration sleeps on (§5.1.3), replacing the
    no-op wakeups and zero timeouts; GLib's own calls through mismatched function types,
    including the interface init functions `gdbus-codegen` generates; class
    handlers called without `user_data`, through libffi (§5.1.2); the
    adapters the dynamic-type macros refer to; Unix sources WebAssembly
    doesn't build; `g_file_query_exists` without the `faccessat` flags
    Emscripten doesn't support; subprocess tests skipped; and test-only
    fixes.
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
    other Node-run checks the same way.
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
- **TypeScript.** One pnpm workspace; dependencies are a fixed-output
  derivation (`fetchPnpmDeps`, installed offline with `pnpmConfigHook`). The
  Playwright npm version is pinned to match nixpkgs' `playwright-driver`
  (1.61.1 at `8ce4ef6`), whose Chromium, Firefox and WebKit builds the tests
  use.

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

- TypeScript unit and keystroke-path tests (Vitest)
- `libibus-web` C tests and the GLib test subset, under Node
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
   settings backend) and, if the lazy arity lookup is built (§5.1.2),
   tests for it.
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

| | Scope | Questions answered |
|---|---|---|
| M0 | Flake, `emscriptenCache`, `pkgsWasm` and a first `nix flake check`; GLib Emscripten patches rebased onto nixpkgs `glib`; `pkgsWasm.glib` as main module; GLib test subset in Node; minimal `libibus-web`; load a trivial side module and one that starts a pthread; Worker wait loop with Emscripten threads and proxying | Does dynamic linking work with threads? Can the Worker block while threads and WasmFS work (R2)? |
| ↳ M0.1 | **Done, merged.** Plan `docs/plans/2026-09-26-m0-1-toolchain-and-dynlink.md`. Dendritic flake (flake-parts, import-tree, treefmt-nix, devshell, flake-root); prebuilt, frozen Emscripten library cache; `wasmStdenv` (replaced in M0.2); WASM libhangul; dynamic-linking spike | R3 answered yes for `-sMAIN_MODULE=1`/`-sNODERAWFS=1` under Node (`docs/spikes/2026-09-26-dynlink.md`); main modules must link with `em++`; Emscripten 6 defaults to legacy WASM exception handling |
| ↳ M0.2 | **Done, merged.** Plan `docs/plans/2026-09-29-m0-2-emscripten-cross-set.md`. `pkgsWasm` cross package set replacing `wasmStdenv`; Emscripten-gated overlays; `legacyPackages` outputs; libhangul, zlib and libffi from unmodified recipes; Meson and cross `pkg-config` proven; WasmFS `-sMAIN_MODULE=2` link check; C, C++ and shell formatting; Darwin evaluation restored | nixpkgs' cross-compilation machinery works with Emscripten as its compiler (R17 resolved); libffi's WASM backend works; the wrapper must drop `-static-libgcc` and `--undefined-version` |
| ↳ M0.3 | **Tasks done; in final review.** Plan `docs/plans/2026-09-29-m0-3-glib.md`. `pkgsWasm.glib` from nixpkgs' `glib` with a 26-patch Emscripten series (Wolthuizen's, Fluendo's main-context fixes, ours); GLib's tools as `.js` programs under Node; patched `gdbus-codegen` for consumers; GLib's own tests under Node with a gating baseline; Meson host system `emscripten`; `-O2` builds; prefixed binutils; WASM dev shell with clangd; REUSE licensing metadata (`LICENSES/`, SPDX headers, `REUSE.toml`) enforced by `checks.reuse` | GLib 2.88.3 builds for WASM with GRegex and its tools; 237 of 300 of GLib's own tests pass under Node and gate CI; class handlers work without the arity lookup; the remaining function-pointer gap is user callbacks with fewer parameters (§5.1.2) |
| M1 | Hangul end to end: libhangul and ibus-hangul side module, Worker host, SAB channel, protocol package, minimal router, `<textarea>` adapter, basic panel for Hanja candidates | Cast and callback fix count and layer, and whether the lazy arity lookup is needed; GSettings bridge; decode speed with a synthetic large table |
| M2 | Custom table engine (MIT), layout `default`; `contenteditable` adapter | Router generality; non-GPL engine |
| M3 | m17n: m17n-lib, ibus-m17n, m17n-db delivery | Surrounding text; large data sets |
| M4 | libpinyin: C++ side module against the runtime's libc++, database backend, OPFS user dictionaries | C++ across modules; persistence; large lookup tables |
| M5 | Rime: librime and dependencies, deployer thread, schemas deployed at build time, YAML through the storage API | Threads in a real engine; data size |
| M6 | 1.0: finished facade, docs, generated protocol spec, release pipeline with source bundles | |

## 13. Risks and open questions

- **R1. Arity-tolerant callbacks.** The lazy lookup in §5.1.2 is unproven:
  the cost of a JS call per mismatched callback, and whether `.length` is
  reliable for every table entry Emscripten creates, are measured in M1. If
  the audit finds few mismatches, engine patches replace it.
- **R2. Blocking the Worker.** The Worker host blocks in `Atomics.wait`
  outside the Emscripten runtime. Thread creation and work that Emscripten
  proxies back to the Worker's thread (some filesystem and OPFS operations)
  may need that thread to yield or to process its proxy queue. Options, in
  order: pre-allocated thread pool and a wait loop in C that processes the
  queue; running each engine on a pthread with the Worker's own thread left
  free. A wait loop in C only covers calls proxied synchronously: calls
  Emscripten proxies as promises (`fsync()` on the JavaScript file systems)
  need the thread back in its JS event loop, which the request loop never
  returns to. The M0 test includes one such call from a pthread while the host
  waits. Settled in M0.
- **R3. Dynamic linking with pthreads.** Weakest area of Emscripten dynamic
  linking. §5.3's thread pool is pre-allocated, so its workers exist before
  `main` runs and side modules load after the pool already exists: the
  harder case for dynamic linking with pthreads. The M0.1 spike tested that
  case in the `-sMAIN_MODULE=1`/`-sNODERAWFS=1`/Node configuration, and all
  five probes passed, including a side module running on a pool thread
  created before its `dlopen` and a C++ exception thrown in a side module
  caught in the main module. See `docs/spikes/2026-09-26-dynlink.md`.
  The same spike also passes with WasmFS under Node. Settled for those
  configurations; open for §5.3's `-sMAIN_MODULE=2`/WasmFS/browser
  configuration, which the runtime plan must test.
- **R4. GLib patch rebases.** The series is rebased from Wolthuizen's
  per-release `wasm-vips-<version>` branches, so each nixpkgs GLib update
  means rebasing from the nearest one. `checks.glib-patches` fails first
  when a nixpkgs update breaks the series. `ibusWeb.toolchain.mesonCrossFlags`
  imports nixpkgs' `pkgs/build-support/lib/meson.nix`, so an update that
  moves that file fails evaluation.
- **R5. OPFS in Workers across browsers.** Synchronous access handles need
  checking on current WebKit. Fallback is in-memory with an event.
- **R6. libpinyin databases in WASM.** nixpkgs builds libpinyin with Kyoto
  Cabinet and ibus-libpinyin with Berkeley DB 5.3 and SQLite. All three must
  build and perform acceptably on WasmFS/OPFS. Checked in M4.
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
