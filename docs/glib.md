# GLib

Engines are GObject code: they subclass `IBusEngine` with `G_DEFINE_TYPE`, use signals and the
main loop, and read their settings through GSettings. So the runtime carries real GLib, GObject and
GIO, built for WebAssembly as `pkgsWasm.glib`: nixpkgs' `glib` recipe (GLib 2.88.3) with an
Emscripten patch series kept in this repository, applied by an overlay, and tested by running
GLib's own test suite under Node. This page covers what the series changes and why, how GLib is
built, and the test run that gates it. The toolchain it is built with is described in
[toolchain.md](toolchain.md).

## The patch series

The series lives in `modules/glib/patches/`, seventeen patches, with a README,
[`modules/glib/patches/README.md`](../modules/glib/patches/README.md), that records each patch's
author and source commit, how the series was rebased, what was taken from each source and what
was left out, and the details of each of our patches. This page summarizes; the README is the
reference.

| Patches   | Source                                                                                                                                  | Content                                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001–0009 | Kleis Auke Wolthuizen's [`wasm-vips-2.88.1`](https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1) branch, the series wasm-vips uses | build support for Emscripten (`G_PLATFORM_WASM`), disabled subsystems (NLS, networking libraries, girepository, the fuzzers), musl's `printf`, and the function-pointer cast fixes, `G_DEFINE_TYPE`'s among them |
| 0010      | Fluendo's [`gst.wasm`](https://github.com/fluendo/glib/tree/gst.wasm) branch                                                            | `glist`/`gslist` internal signatures                                                                                                                                                                             |
| 0011      | ours                                                                                                                                    | calls through each function's own type, class handlers through libffi                                                                                                                                            |
| 0012      | ours                                                                                                                                    | the Unix parts and tools WebAssembly can take; subprocess tests skipped; `g_file_query_exists()`; the program name; no `RTLD_NEXT`                                                                               |
| 0013      | ours                                                                                                                                    | a futex-backed `GWakeup` that blocking iteration sleeps on                                                                                                                                                       |
| 0014      | ours                                                                                                                                    | platform backends: time zones from `Intl`, a memory monitor, content types, the user                                                                                                                             |
| 0015      | ours                                                                                                                                    | characters `iconv()` replaces, reported as GLib reports them elsewhere                                                                                                                                           |
| 0016      | ours                                                                                                                                    | GLib's tests on WebAssembly; test sources and test build files only                                                                                                                                              |
| 0017      | ours                                                                                                                                    | the wake hook the runtime's pump relies on                                                                                                                                                                       |

Every patch keeps its original author. Wolthuizen's commits are rebased from 2.88.1 onto 2.88.3
unchanged, without his GRegex removal (the runtime keeps GRegex, built against `pkgsWasm.pcre2`)
and with his tool removal cut down to girepository and the fuzzers, so GLib's tools build. Of
Fluendo's commits only the `glist`/`gslist` fix is taken: its main-context commits (no-op
wakeups, no wakeup fd in the main context, poll timeouts forced to zero) are superseded by 0013,
and its `emscripten_set_main_loop()` integration has no use in a runtime that pumps the context
itself ([README](../modules/glib/patches/README.md#fluendos-commits)). Our patches are one per
topic, so each says in one place what it changes and why.

### How the series applies

`flake.overlays.glib` appends the series, sorted by file name, after nixpkgs' own `glib` patches,
which are all kept. `checks.glib-patches` applies both sets in the build's order, ours with
`--fuzz=0`, so a nixpkgs update that breaks the series fails there with the conflicting hunk
rather than deep in a build, and a hunk that would only land nearby fails instead of applying in
the wrong place.

The series was made by cherry-picking onto upstream 2.88.3 plus nixpkgs' patches in a scratch
clone of GLib and exporting with `git format-patch`. Each nixpkgs GLib update means rebasing from
Wolthuizen's nearest `wasm-vips-<version>` branch (spec R4).

## Function-pointer casts

WebAssembly checks the type of every indirect call: a function called through a pointer whose
parameter list or return type differs from the function's own traps with "function signature
mismatch". Native ABIs tolerate such calls, and GLib and GObject make them throughout, though they
are undefined behaviour in C. Upstream GLib documents that its build needs them to work, and that
Emscripten builds must use `-sEMULATE_FUNCTION_POINTER_CASTS` (GLib MR !4469); removing the
mismatches was rejected upstream (!4660, #3670), and Emscripten kept the flag for GLib's sake
(emscripten PR #24169).

### Why the mismatches are fixed in source

- **Not cast emulation.** With `-sMAIN_MODULE` it breaks catching C++ exceptions
  ([emscripten#22285](https://github.com/emscripten-core/emscripten/issues/22285), open), and the
  C++ engines need exceptions. It also slows every indirect call.
- **Not Fluendo's Clang.** `-fwasm-fix-function-bitcasts`
  ([llvm#153168](https://github.com/llvm/llvm-project/pull/153168)) is unmerged and contested,
  would need a forked LLVM for everyone who builds an engine, and doesn't cover callbacks stored
  as `gpointer`, which is how `GCClosure` holds signal handlers.
- **Chosen:** the series' source-level fixes. Wolthuizen's 0009 includes the header fixes for
  `G_DEFINE_TYPE` and its relatives, which engines pick up by including GLib's headers. Should a
  toolchain-level fix ship in Emscripten, this choice is revisited (spec R9).

### What the series covers

- **GLib calling through the wrong type** (0009, 0010, 0011). Each call site in the library calls
  the function through its own type: a direct loop, a small wrapper, or a trampoline taking the
  real function as user data. Examples: `g_list_free_full()` calling a `GDestroyNotify` as a
  `GFunc`, `g_list_sort()` calling a `GCompareFunc` as a `GCompareDataFunc`, `GTypeModule`'s
  one-argument `class_init` (every GIO extension point trapped on first use), and the interface
  init functions `gdbus-codegen` generates. The sites came from the test run's traps and from an
  audit that compiled every library source with `-Wcast-function-type-strict` and kept the casts
  whose WebAssembly signatures (parameter count and types, return type) differ. The fixes apply
  on every platform and don't change behaviour, except one replaced only on WebAssembly where
  other code may rely on the old pointer's identity
  ([README](../modules/glib/patches/README.md#0011-function-types)).
- **The dynamic-type macros.** `G_DEFINE_DYNAMIC_TYPE_EXTENDED` as 0009 leaves it names an
  adapter it never defines; 0011 defines it, and one for `class_finalize`.
- **Tools in consumers' builds.** The `gdbus-codegen` fix reaches only code generated by this
  GLib's `gdbus-codegen`; how consumers get it is under [Tools](#tools).

### Callbacks with fewer parameters

Most mismatches an engine meets are callbacks declaring fewer trailing parameters than the caller
passes: signal handlers without `user_data`, `(GFunc) g_free`, and the like. Where GLib is the
caller, `pkgsWasm.glib` is meant to absorb them so the engine needs no patch (spec §5.1.2).

- **Class handlers (built).** Class closures never take `user_data`: the functions in class
  structs that `g_signal_new()` registers by offset, and handlers given to
  `g_signal_new_class_handler()` or `g_signal_override_class_handler()`. A signal's C marshaller
  passes it anyway, so on WebAssembly emitting any signal with a class handler trapped, in GLib's
  own classes as in every GObject library above it (`IBusEngine`'s signals among them). On
  WebAssembly only, the closures GLib makes for class handlers get their own marshaller when they
  are created: GLib's libffi generic marshaller, and its va form, with the trailing user data left
  off. Emission, `g_signal_chain_from_overridden()` and
  `g_signal_chain_from_overridden_handler()` all reach the handler that way, with exactly the
  instance and the signal's parameters. This needs nothing to know about the callee. Closures
  callers make themselves and connected handlers are unchanged; other platforms compile the same
  code as before.
- **Other callbacks: the lazy arity lookup (not built).** A function pointer is an index into the
  WebAssembly function table, and the function there has a JavaScript `.length` equal to its
  parameter count. The design asks for it at GLib's callback call sites through an `EM_JS` helper,
  caches it per pointer, and calls a callee that takes fewer parameters through JavaScript, which
  drops the extra arguments. It is built only if the engine audit shows it pays for itself; with
  few such callbacks, engines' own cast patches fix them instead. See spec §5.1.2 and R1.
- **Not covered by either.** Callees declaring _more_ parameters than passed; mismatches in engine
  code GLib never calls; the one-argument `iface_init`/`class_init` functions users pass through
  `G_IMPLEMENT_INTERFACE` or hand-written `GTypeInfo`. These need engine patches (spec §5.4.2).

libffi's `ffi_call` on Emscripten calls the function from JavaScript, which pads or drops
arguments rather than trapping. That is libffi's behaviour, not a guarantee of the series, and
nothing relies on it.

## Main context and wakeup

The runtime doesn't run a `GMainLoop`: its Worker host pumps the default context with
non-blocking iterations after each request and on source deadlines (spec D4,
[runtime.md](runtime.md)). GLib itself still blocks in places: its worker context
(`g_get_worker_context()`) runs a blocking loop on a thread it starts on first use, which any
`GTask`, and so any GIO asynchronous call, triggers; GDBus's shared thread runs one too; and
engines may iterate a context with `may_block` set. Wolthuizen's 0008 makes every `GWakeup`
function a `g_error()` on WebAssembly, and every `GMainContext` creates one, so any main context
aborted.

0013 gives WebAssembly a real wakeup
([README](../modules/glib/patches/README.md#0013-main-context-and-wakeup)):

- **The wakeup** is two atomic counters, signalled and acknowledged, woken and waited on with
  `emscripten_futex_wake()` and `emscripten_futex_wait()`: eventfd's contract, any number of
  signals acknowledged at once.
- **Blocking iteration** waits on the context's wakeup for the computed timeout instead of calling
  `poll()`, which can't wait there: Emscripten's `poll()` ignores a timeout on the main thread and
  on WasmFS, and from a pthread on the JavaScript file systems it waits for the main thread's
  event loop. With fds to watch, it probes them with a zero timeout and waits on the wakeup in
  slices of at most 10 ms between probes.
- **Why `emscripten_futex_wait()`** and not a bare atomic wait: a sleeping thread is still handed
  work. The main thread runs the calls pthreads proxy to it, and `dlopen()` blocks until every
  thread has loaded the new module; `emscripten_futex_wait()` does that work while it sleeps, and
  a bare wait would deadlock both.
- **Why 10 ms slices:** an fd turning ready signals nothing, so the slice bounds how late it is
  seen, and each probe from a pthread is a call proxied to the main thread, so it also bounds how
  often that thread is interrupted: at most 100 probes a second, and less than a frame of latency.
  fds are rare here, and the common case, no fds, has no slices at all.
- **Non-blocking iteration**, what the pump calls, is unchanged but for one atomic store, the
  acknowledgement in `g_main_context_check()`.
- **A wakeup's poll fd** (`g_cancellable_get_fd()`, `g_cancellable_make_pollfd()`) is a pipe made
  on first request that mirrors the futex. Contexts never ask for one, except one with
  `G_MAIN_CONTEXT_FLAGS_OWNERLESS_POLLING`, which is polled from outside.
- **`g_poll()` with a timeout** probes with a zero timeout and sleeps in 10 ms slices.

`checks.glib` shows the worker context's thread sleeping: after a `GTask` has run, its CPU time
(Node's `process.cpuUsage()`, since Emscripten's `clock()` counts wall time and its `getrusage()`
is a stub) stays under a quarter of wall time, and a blocking iteration with only a 200 ms timeout
source lasts at least 200 ms without spinning. Each of these threads costs a pthread for the life
of the Worker, but no CPU.

**The wake hook** (0017) lets the Worker host, which sleeps on a word of its own between pumps
rather than on the context's futex, hear the default context's wakeup:

```c
void g_main_context_wasm_set_wake_hook (GMainContext *context, GWasmWakeHook hook, gpointer user_data);
```

`g_wakeup_signal()` calls it last, on whichever thread signals, sometimes with the context locked,
so the hook must only wake the host. A context takes one hook for its life, published with a
compare-and-swap; a second call fails with a `g_critical()` that `G_DISABLE_CHECKS` doesn't remove.
GLib wakes a context for a source attached from another thread only while some thread owns it, so
the host's thread holds the default context for as long as it relies on the hook. The pump and
the word the hook bumps are described in [runtime.md](runtime.md); the hook's rules in the
[README](../modules/glib/patches/README.md#0017-the-wake-hook).

## Other changes

- **The Unix parts WebAssembly can take** (0012). 0008 leaves out every Unix source; 0012 builds
  again what works on Emscripten as on other Unixes: `giounix.c` (whose absence left symbols a
  main module, which keeps every function, failed to link on), glib-unix without the signal
  sources, GIO's Unix streams and `gio-unix-2.0`, `g_source_add_unix_fd()` and friends, local files'
  `is-hidden`/`is-backup`, and content types for resources. Sending an fd and the D-Bus command
  line's stdin report themselves unsupported.
- **`g_file_query_exists()`** no longer calls `faccessat()` on WebAssembly: GLib passes
  `AT_SYMLINK_NOFOLLOW`, which Emscripten doesn't honour (its JavaScript file systems assert on
  it), and falls back as on other platforms with the same gap.
- **`g_test_trap_subprocess()`** can't spawn the test binary again. On WebAssembly it marks the
  calling test skipped and returns to the test runner, so the rest of the binary runs.
- **`RTLD_NEXT`.** `HAVE_RTLD_NEXT` stays unset on Emscripten: its `dlfcn.h` defines the macro but
  `dlsym(RTLD_NEXT, …)` finds nothing, and aborts under `-sMAIN_MODULE`
  ([toolchain.md](toolchain.md#dlsymrtld_next)).
- **Characters `iconv()` replaces** (0015). musl's `iconv()` converts a character the target lacks
  to `*` and counts it, rather than failing with `EILSEQ`, and forgets the count when a later
  character in the same call fails. 0015 makes `g_convert()`, `g_convert_with_fallback()` and
  `GCharsetConverter` notice the replacement and report it (or use the caller's fallback), exactly,
  stateful charsets included, while staying linear: 32,000 unrepresentable characters to ASCII
  take 2 ms on Node. Nothing in it is specific to WebAssembly
  ([README](../modules/glib/patches/README.md#0015-characters-iconv-replaces)).
- **GSettings.** GIO is built with GSettings and its tools (`glib-compile-schemas`, `gsettings`).
  The backend the runtime registers, and the registration hook, belong to the settings bridge;
  see spec §5.1.3 and §5.2.5.

## Platform backends

Where Emscripten's libc or GLib's WebAssembly build stubs a facility that browsers (and Node, for
tests) provide, `pkgsWasm.glib` gets a WebAssembly-only backend reaching the JavaScript API through
`EM_JS`, rather than carrying data or accepting the stub. Built today (0014,
[README](../modules/glib/patches/README.md#0014-platform-backends)):

- **Time zones from `Intl`.** Where GLib would read a zone's TZif file, it gets TZif data
  synthesized from `Intl.DateTimeFormat` for 1800–2100 and parses it as it would a file;
  past 2100 a POSIX rule continues the zone where its pattern fits one. The local zone is the one
  `Intl` resolves unless `TZ` is set. Abbreviations are `Intl`'s short English names where it has
  them (`PST`), else numeric (`+0100`). Why: a page has no zoneinfo files, and the JavaScript
  engine already carries the data, so the runtime ships no tzdata. Each zone costs some 20,000
  `formatToParts()` calls, 40–70 ms under Node, once per zone for the life of the program. Checked
  against nixpkgs' tzdata 2026c on the 15th of every month from 1850 to 2099, thirteen zones
  (Los Angeles to São Paulo) give the same offsets throughout; Casablanca differs from late 2026,
  where Node's ICU and tzdata disagree about Morocco.
- **A memory monitor** that never warns, since nothing in a browser reports memory pressure;
  without one, `g_memory_monitor_dup_default()` passed `NULL` to `g_object_ref()`.
- **Content types:** every type but an inode is also `application/octet-stream`, as with
  shared-mime-info.
- **The user:** `g_get_user_name()`, `g_get_real_name()` and `g_get_home_dir()` skip Emscripten's
  stub user database, which always failed and warned (fatally, in tests); the fallbacks are the
  same.

The rest of spec §5.1.4 (language and locale from `navigator.languages`, collation through
`Intl.Collator`, localized dates and eras, legacy-charset decoding through `TextDecoder`, a
`GFileMonitor` on WasmFS, network state, a synthesized user and host) lands with the first
milestone whose engine needs each one. Each moves the GLib subtests it fixes from the skips below
into the gate.

## Building GLib

`pkgsWasm.glib` is nixpkgs' recipe built by the cross set ([toolchain.md](toolchain.md)), with
Meson told the host is `emscripten` through the toolchain's second cross file. GLib's patches and
Meson's `.js` executable suffix both key on that.

### The overlay

`flake.overlays.glib` (`modules/glib/overlay.nix`) changes only what WebAssembly needs:

- **Inputs removed:** `bash-interactive`, `gnum4`, `libsysprof-capture`, `gettext` and `libiconv`.
  Emscripten's musl provides iconv and gettext; the rest only serve a native install. Each name
  must be present to be removed, so a rename in nixpkgs fails evaluation instead of letting the
  input back in.
- **Features off:** NLS, sysprof, documentation (and with it the `devdoc` output, which would stay
  empty), tests, and xattr, since Emscripten's libc has no `getxattr`.
- **Executables' link:** GLib's tools (and its tests, when enabled) only ever run under Node, so
  they link with `-sNODERAWFS=1 -sEXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=8 -sALLOW_MEMORY_GROWTH=1
-sSTACK_SIZE=1048576 -sASSERTIONS=1`. Static libraries don't see link arguments, so the
  libraries are unaffected. The stack: Emscripten's default 64 KiB is too small for the regex
  test, which needs between 448 and 480 KiB; 1 MiB leaves room, and the runtime links its threads
  with the same.
- Edits to nixpkgs' install scripts assert that what they edit is there.

### Optimisation

Every object is compiled at `-O2` by the cross set's wrapper. nixpkgs' Meson hook builds with
`--buildtype=plain`, which adds no `-O`, so GLib was compiled unoptimized until the wrapper added
it; a package's own `-O` still wins. `-O2` over `-Os`, because engine data, not code, dominates
download size and keystrokes have a latency budget. The runtime links with `-sMAIN_MODULE=2`,
which drops GLib code nothing exports.

### Tools

GLib's tools (`glib-compile-schemas`, `glib-compile-resources`, `gio`, `gsettings`,
`gobject-query`, …) are built for WebAssembly as `<tool>.js` and `<tool>.wasm`, each with a
`<tool>` wrapper beside it that runs it with the build machine's Node, so the paths in
`gio-2.0.pc` and `glib-2.0.pc` run this GLib's tools. The list is what the build installs, every
`.js` with a `.wasm` beside it, not a hand-kept one, and the build checks that every tool variable
in the `.pc` files names an installed program. Features the tools reach through Unix facilities
WebAssembly doesn't have (`gio launch`, `gtester`'s report pipe, `gapplication list`) report
themselves unsupported.

The tools keep Emscripten's `-sNODERAWFS` rather than WasmFS, because WasmFS's stdout turns a NUL
byte into a line break (`gresource extract` of `a\0b\nc` prints `a\nb\nc\n`).

**In consumers' builds.** A cross build runs its tools on the build machine, whose GLib is
nixpkgs' native, unpatched one: its `gdbus-codegen` emits one-argument interface init functions,
which WebAssembly traps on calling. So:

- `pkgsWasm.glib` installs `nix-support/glib-tools-cross.ini`, naming every tool its `.pc` files
  name, and a setup hook (`glib-tools-hook.sh`) that hands it to Meson in every build depending on
  this GLib. Meson's gnome module looks a tool up in the host machine's cross files before the
  build machine's GLib, so it runs these. The gnome module also chooses tool options by the build
  machine's GLib version, read through a build-machine `pkg-config`, and assumes 2.54 without
  one; the hook points it at the build platform's `pkg-config` and GLib, so consumers need no
  `depsBuildBuild` for it. A tool two `.pc` files both name fails the build, since Meson would
  reject the repeated key in every consumer.
- Autotools consumers that take a tool from the `.pc` variables (`PKG_CHECK_VAR`, as IBus does)
  get this GLib's.
- Anything that runs a tool by plain name from `PATH` gets the native one.

`checks.glib-meson-tools` builds a Meson project calling each helper, with the native GLib on
`PATH` too, and runs what they generate; `checks.glib-autotools-tools` compiles a schema and a
resource through `PKG_CHECK_VAR` and reads them back.

### Checks

| Check                  | What it checks                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glib-patches`         | nixpkgs' patches, then the series with no fuzz, apply to nixpkgs' GLib source                                                                                               |
| `glib`                 | a program linked with `testMainFlags` exercising GLib, GObject, GIO and GRegex, the wakeup and wake hook, class handlers, casts, time zones, a compiled resource and schema |
| `glib-meson-tools`     | a Meson consumer runs this GLib's tools                                                                                                                                     |
| `glib-autotools-tools` | an Autotools consumer runs this GLib's tools                                                                                                                                |
| `glib-tests`           | GLib's own tests under Node, gated by the baseline                                                                                                                          |
| `glib-tests-gate`      | the gate's test selection and report, against Meson on a small project                                                                                                      |

## GLib's tests

`checks.glib-tests` builds `pkgsWasm.glib`'s recipe again with `-Dtests=true` and runs GLib's own
suite with `meson test`, under Node, in the build. nixpkgs never runs `checkPhase` when the build
machine can't execute host binaries, so the check runs them itself.

### How they run

- **On WasmFS, the file system the runtime ships.** The tests' link replaces the overlay's
  `-sNODERAWFS=1` with `ibusWeb.toolchain.nodeHostFsFlags`: WasmFS rooted at the host's `/`
  through its Node backend, starting in Node's working directory. Why: results on Emscripten's
  JavaScript file systems describe a file system the runtime doesn't use. On them, a pthread's
  `fsync()` is a promise proxied to the main thread, which never completes while the main thread
  sleeps in `g_main_loop_run()`, so `async-splice-output-stream` hung; WasmFS implements `fsync()`
  in C. The Node backend's own bugs that the suite met are fixed by the toolchain's Emscripten
  patches, so each test keeps its files in a `TMPDIR` of its own on the host.
  The root itself is WasmFS's, not the host's: its mode isn't copied from the host, so creating a file
  there fails with the host's own error, while `stat("/")` and `access("/", W_OK)` report WasmFS's fixed
  `0777` rather than the host root's mode.
- **With a fixed memory.** The tests link with
  `ibusWeb.toolchain.testMemoryFlags`, a fixed 512 MiB, in place of growth. Under a 32-way load,
  `1bit-emufutex` died with an out-of-bounds access on a pthread in about 1 run in 20 to 25
  (13 of 300) with growth, at varying sites, and 0 of 300 linked with a fixed memory just above its
  peak. No GLib-free reproduction has been found. Measured with growth, the largest peaks are
  `mainloop` 280 MiB, `gvariant` 265 MiB, `slice` 149 MiB, `thread-pool-slow` 140 MiB and the
  many-thread tests around 103 MiB; everything else stays under 52 MiB. The evaluation asserts the
  overlay's link still names both settings it replaces.
- **Output through files.** Node makes its stdout non-blocking once a program starts its thread
  pool, and a write that meets a full pipe fails with `EAGAIN` instead of waiting, so a test
  writing faster than Meson reads lost TAP lines (`unicode` failed for that alone). The tests' own
  exe wrapper runs Node with stdout and stderr in files and replays them when the test exits or
  when Meson's timeout kills it, and dies of the same signal as the test so Meson reports it as one.
- Meson's timeouts are multiplied by 4, and the `pkg-config` tests use the unwrapped `pkg-config`,
  since nixpkgs' wrapper replaces the search path they set.
- GLib's tool tests (`gobject-query.py`, `gio-tool.py`, `gdbus-tool.py`) run the `.js` tools under
  Node, and expect status 1 where an `abort()` would end a native program with `SIGABRT`.

### The gate

Which tests gate the build is recorded in `modules/glib/checks/tests/baseline.toml`:

- `[must_pass] tests` lists the tests that must pass (`OK` or `EXPECTEDFAIL`) for the build to
  succeed.
- `[excluded]` maps each test that is never run to the reason it can't run on Emscripten.
- Every other test runs and is reported but doesn't gate.

The rule for the lists: a test is excluded only if no part of it can run on Emscripten; every
test that passes gates. Inside a gating test, a subtest whose expectation can't hold here skips
with `g_test_skip()` and its reason (0016), so the rest of the test still gates.

The gate, `gate.ts` (`@ibus-web/glib-tests-gate`, reading the TOML with `smol-toml`), works from
Meson's introspection data rather than its formatted log names:

1. `runnable` prints the `meson test` invocations that together run every test not excluded.
   Some test names repeat across suites, and `meson test` selects by `<project>:<name>` alone, so
   a name with an excluded holder runs alone, narrowed with `--suite` to a suite the others aren't
   in. Every invocation excludes the default test setup's excluded suites itself (read from
   Meson's build data by `setup-excludes.py`), since `--suite` sets them aside. Excluded tests are
   never started: several busy-wait until the timeout and would hold cores the others need.
2. The selection runs in parallel on every core.
3. `failing` prints the invocations that rerun, one at a time, the `must_pass` tests that ran and
   failed. A test that passes alone counts as passed and is reported as flaky: tests that assert
   wall-clock bounds can miss them under the parallel run's load.
4. `report` writes `summary.txt` and `proposed-baseline.toml` (every test's result from this run)
   to the output and fails on any `must_pass` test that still fails or is missing. A test in both
   tables is refused; an excluded test that isn't in the build is a warning.

`checks.glib-tests-gate` tests the gate's selection against Meson itself, on a small project whose
test names collide in the ways GLib's do, and its report.

**Updating the baseline.** Build `checks.<system>.glib-tests` and read `summary.txt` and
`proposed-baseline.toml` in its output. Move a test into `must_pass` once it has passed in three
runs; exclude one, with a precise reason, only if no part of it can run on Emscripten. A test that
starts failing for a new reason is a bug to fix or a subtest to skip with its reason in 0016, not
a test to drop from `must_pass`.

### Results

Of GLib 2.88.3's 301 tests, 290 run and 11 are excluded. 277 pass and all of them gate; none is
flaky. The rest don't gate:

- **Excluded (11):** the four `spawn-*` tests, `protocol` and `io-channel-basic`, which spawn
  processes; `gdbus-server-auth`, `iptosmessage`, `proxy-test`, `socket-listener` and
  `socket-service`, which need sockets (WasmFS's `socket()` fails with `ENOSYS`).
- **Skipped as a whole (12):** subprocess tests (`mem-overflow`, `deprecated-properties`,
  `network-monitor-race`, `tls-bindings`, gobject's `testing`), Windows-only console output
  (`print`), `gdbus-address-get-session` (whose subtests nixpkgs' recipe comments out),
  `gdbus-tool.py` (needs PyGObject) and the four lint scripts.
- **Failing (1):** `testfilemonitor`: Emscripten has no file-change notification, until spec
  §5.1.4's WasmFS monitor backend.

Subtests skipped inside gating tests, by reason: musl's locales exist in name only (collation,
`option-context`'s decimal comma, Polish month names, `gdatetime`'s `en_GB` and `de_DE` formats
and eras), until the §5.1.4 locale backends; no sockets, process spawning, pseudo-terminals or
Unix signals; IPv6 scope IDs and network interfaces; WasmFS's millisecond file times and
unbounded pipes; TZif files by path (`/GTimeZone/parse-rfc8536`, since zones come from `Intl`);
and for `gio-tool.py`, no desktop applications and no MIME types. Where musl's output is right but
different (`strftime()` padding years and lacking `%k`, `%l`, `%P`), the tests expect musl's.

### What the test run found

The suite was the main test of the series, and its failures were root-caused one by one:

- **GLib bugs on WebAssembly**, fixed in the series: the calls through mismatched types and class
  handlers (0011); symbols missing from a main-module link, `faccessat()` flags, the subprocess
  trap, `RTLD_NEXT` (0012); the aborting `GWakeup` and busy-spinning loops (0013); IANA time zones,
  the missing memory monitor, content types, the warning user lookup (0014); musl `iconv()`'s
  replacements (0015); a stack too small for GRegex (the overlay).
- **Test bugs**, fixed in 0016: callbacks with the wrong signature throughout the tests; a
  completion test that assumed one file system's directory order; credentials assumed on every
  Unix; and a race on every platform in `asyncqueue`'s threads test, which pushed its items before
  all ten consumers were running and expected each to get some. Under load a pthread can start
  25–560 ms after it is created, once the queue has drained: the old test failed 23 of 100 runs
  alone at 32-way concurrency, the fixed one, which waits for every consumer, 0 of 300. The
  runtime shouldn't rely on a new thread running promptly.
- **Emscripten bugs**, fixed by the toolchain's patches (each tracked by a draft):
  [`getcwd()` under a mount](upstream/emscripten-wasmfs-getcwd-mount.md),
  [`poll()` of files and devices](upstream/emscripten-wasmfs-poll-regular-file.md),
  [pipes as FIFOs](upstream/emscripten-wasmfs-pipe-fifo-mode.md),
  [`O_NOCTTY`](upstream/emscripten-wasmfs-open-noctty.md),
  [directory search permission](upstream/emscripten-wasmfs-search-permission.md),
  [create permission](upstream/emscripten-wasmfs-create-permission.md), and in the Node backend
  [`fsync()`](upstream/emscripten-wasmfs-node-fsync.md),
  [host errors from `open()` and `close()`](upstream/emscripten-wasmfs-node-open-close-errors.md),
  [renames](upstream/emscripten-wasmfs-node-rename.md),
  [create errors](upstream/emscripten-wasmfs-node-create-eio.md) and
  [`chmod()`/`utimensat()` reaching the host](upstream/emscripten-wasmfs-node-chmod.md) (with
  `futimens()`'s null path); and, backported from 6.0.10, `-sNODERAWFS` `fstat()` on the standard
  streams ([draft](upstream/emscripten-noderawfs-fstat-stdio.md)). Each removed a workaround or a
  skip from GLib's tests. The full list is in the
  [patches' README](../modules/emscripten/patches/README.md).
- **Emscripten behaviour not carried as fixes:** pipes have no capacity
  ([draft](upstream/emscripten-pipe-capacity.md)); a pipe on the JavaScript file systems whose
  writers have closed reads as `EAGAIN`, not end of file
  ([draft](upstream/emscripten-pipe-read-eof.md)); `dlsym(RTLD_NEXT)` aborts under
  `-sMAIN_MODULE` ([draft](upstream/emscripten-dlsym-rtld-next.md)); WasmFS's stdout turns a NUL
  byte into a line break. Open items are collected in [known-gaps.md](known-gaps.md#glib).
