# GLib patches for Emscripten

These patches let GLib build and run as WebAssembly under Emscripten, with
pthreads and dynamic linking. They target nixpkgs' `glib` recipe (GLib
2.88.3) and apply with `patch -p1`, in file-name order, **after** nixpkgs'
own GLib patches (`glib-appinfo-watch.patch`, `schema-override-variable.patch`,
`elementary-terminal-support.patch`, `split-dev-programs.patch`,
`gdb_script.patch`). `checks.glib-patches` applies both sets in that order.

Every patch keeps its original author, and all of them are licensed like GLib
itself: LGPL-2.1-or-later.

## Sources

| Source | Branch | Base |
|---|---|---|
| Kleis Auke Wolthuizen (wasm-vips) | [`kleisauke/glib` `wasm-vips-2.88.1`](https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1) | upstream `2.88.1` (`d43ba363cb9a`) |
| Fluendo (gst.wasm) | [`fluendo/glib` `gst.wasm`](https://github.com/fluendo/glib/tree/gst.wasm) | upstream `2.76.0` (`8a9ada663923`) |

The series was built by cherry-picking onto a branch made of upstream `2.88.3`
plus nixpkgs' patches, then exported with `git format-patch`. Commit
messages carry `(cherry picked from commit …)` with the source hash.

## The series

| Patch | Author | Source commit |
|---|---|---|
| 0001 Do not build girepository and the fuzzers (partial) | Wolthuizen | `0e5465ae90c6` |
| 0002 Disable NLS | Wolthuizen | `1f4fa40ad026` |
| 0003 Emscripten doesn't always define `__GCC_HAVE_SYNC_COMPARE_AND_SWAP_4` | Wolthuizen | `84981eb5dd31` |
| 0004 Emscripten doesn't implement `pthread_getname_np()` | Wolthuizen | `8ced885eb25b` |
| 0005 Network libs are not available on Emscripten | Wolthuizen | `c6a63fcd426f` |
| 0006 Ensure separate checks are also done for Emscripten | Wolthuizen | `bc4812fd5890` |
| 0007 Use vsnprintf/snprintf/printf from musl libc | Wolthuizen | `c0bb73dd62bf` |
| 0008 Add support for WebAssembly | Wolthuizen | `fc0d03194fb2` |
| 0009 Fix function pointer cast issues | Wolthuizen | `1afd0d285774` |
| 0010 A g_error is a fatal error when run, remove it | Jorge Zapata (Fluendo) | `75de668d3690` |
| 0011 Initial main loop support (partial) | Jorge Zapata (Fluendo) | `4c360061dda3` |
| 0012 gmain: emscripten: Use 0 timeout | Fabian Orccon (Fluendo) | `990ffd85fe41` |
| 0013 glist: Fix function signatures in internals of glist/gslist | Jorge Zapata (Fluendo) | `86387bcf5b85` |
| 0014 gwakeup: Make acknowledging and freeing no-ops on WebAssembly | Alexis Williams | — |
| 0015 Call internally-forwarded callbacks through their own function types | Alexis Williams | — |
| 0016 Resolve references to Unix sources that WebAssembly doesn't build | Alexis Williams | — |
| 0017 Build the tools on Emscripten | Alexis Williams | — |
| 0018 Build the tests on Emscripten | Alexis Williams | — |
| 0019 Call more callbacks through their own function types | Alexis Williams | — |
| 0020 Define the adapters `G_DEFINE_DYNAMIC_TYPE_EXTENDED` registers | Alexis Williams | — |
| 0021 gtestutils: Skip subprocess tests on WebAssembly | Alexis Williams | — |
| 0022 gobject: Call class handlers without user data on WebAssembly | Alexis Williams | — |
| 0023 tests: Give signal handlers the parameters they're called with | Alexis Williams | — |

### Dropped from Wolthuizen's branch

`27a067f6d620` **Remove GRegex pre-emptively** is not included. wasm-vips
removes GRegex because libvips doesn't use it; this runtime keeps GRegex and
builds GLib against pcre2. None of the later commits depended on the removal:
all nine applied without touching a GRegex hunk.

### Rebasing onto 2.88.3 and nixpkgs' patches

Onto plain `2.88.3`, all nine Wolthuizen commits cherry-pick without
conflicts and with patch content identical to the originals
(`git range-diff` shows only the added `cherry picked from` line). The files
they touch that changed between 2.88.1 and 2.88.3 (`gio/gdbusconnection.c`,
`gio/gresourcefile.c`, `gobject/gtype.h`, `gobject/gtypemodule.h`,
`meson.build`) changed in lines the series doesn't touch.

Wolthuizen's "Do not build tools" commit is **ported in part** as 0001. It
also dropped `subdir('girepository')` and `subdir('fuzzing')` from the
top-level `meson.build`, and only that hunk is kept: girepository (a library
plus its own compiler, decompiler and inspector) and the fuzz targets aren't
needed here. The hunks that deleted GLib's tools — `gio`, `gresource`,
`gio-querymodules`, `glib-compile-schemas`, `glib-compile-resources`,
`gsettings`, `gdbus`, `gapplication` in `gio/meson.build`, `gobject-query`
in `gobject/meson.build` and `gtester` in `glib/meson.build`, with the
schema and resource DTDs and the multiarch symlinks — are dropped, so the
tools build as `.js` programs run under Node. Leaving them out also removes
the conflict with nixpkgs' `split-dev-programs.patch`, which adds
`install_dir : get_option('devbindir')` to those executables.

All later patches applied to the nixpkgs-patched tree without conflicts and
with unchanged content (`git range-diff` against the full 0001 shows no
differences), and the exported series applies there with `--fuzz=0`.

### Fluendo's commits

Fluendo's branch starts from the same Wolthuizen series (on 2.76.0). Each of
its own commits was checked against the rebased tree:

| Commit | Decision | Reason |
|---|---|---|
| `75de668d3690` A g_error is a fatal error when run, remove it | **Ported** as 0010, unchanged | `g_wakeup_new()` and `g_wakeup_signal()` still call `g_error()` on `G_PLATFORM_WASM` in the rebased tree. Every `GMainContext` creates a wakeup, so creating any main context aborted, and `g_main_loop_quit()`, `g_main_context_wakeup()` and cross-thread source changes signal it. |
| `4c360061dda3` Initial main loop support | **Ported in part** as 0011 | Kept: skipping `g_wakeup_get_pollfd()`/`g_main_context_add_poll_unlocked()` for the wakeup in `g_main_context_new_with_flags()`, which would otherwise hit `g_error()` in `g_wakeup_get_pollfd()`. Guarded by `G_PLATFORM_WASM` instead of `G_WITH_EMSCRIPTEN`. Dropped: the `emscripten.h` include and running `g_main_loop_run()` through `emscripten_set_main_loop_arg()`; this runtime never hands control back to the browser event loop from its Worker, and pumps the context itself. |
| `89a193f7e7da` emscripten: fix deadlock in GMainContext-related code | **Skipped** | Changes only the `emscripten_set_main_loop_arg()` path dropped from 0011. |
| `990ffd85fe41` gmain: emscripten: Use 0 timeout | **Ported** as 0012 | Guarded by `G_PLATFORM_WASM`; applied to `timeout_usec` in `g_main_context_iterate_unlocked()`, which is what 2.88 calls the timeout. Emscripten's `poll()` sends a zero timeout to a synchronous, non-suspending probe. A non-zero timeout is ignored on the main thread and, from a pthread, becomes an asynchronous call proxied to the main thread, which only completes when that thread returns to its event loop. Consequence: with no wakeup fd and the timeout forced to 0, a blocking `g_main_context_iteration (ctx, TRUE)` or `g_main_loop_run()` busy-spins on WebAssembly, including GLib's own worker-context thread. The runtime only iterates non-blocking. |
| `86387bcf5b85` glist: Fix function signatures in internals of glist/gslist | **Ported** as 0013, all hunks | The Wolthuizen series doesn't touch `glist.c` or `gslist.c`, so none of its hunks were already covered. |
| `b45d3dc05781` Differentiate wasm from emscripten | **Skipped** | Adds a `G_WITH_EMSCRIPTEN` define; the ported hunks use the series' own `G_PLATFORM_WASM`. |
| `93fe7aa6231d` Be able to pass the canvas to the thread creation | **Skipped** | Shares WebGL canvases with new threads (GStreamer/WebGL only). |
| `0e30d1cf504e` Revert "Fix function pointer cast issues" | **Skipped** | Relies on Fluendo's patched Clang; this runtime uses nixpkgs' Emscripten unmodified. |
| `5a0ebc47f6b7` Revert "Remove GRegex pre-emptively" | **Skipped** | The removal is never applied. |

0013 only changes source-level types. The internal calls were already cast
back to `GCompareDataFunc`, so the generated indirect calls are the same.
`g_list_sort()`, `g_slist_sort()`, `g_list_insert_sorted()` and
`g_slist_insert_sorted()` still called a two-argument `GCompareFunc` with
three arguments, and `g_list_free_full()`, `g_slist_free_full()` and
`g_queue_free_full()` still called a `GDestroyNotify` as a `GFunc`. Under
WebAssembly, both kinds of call trap with "function signature mismatch";
0015 fixes them.

### Added here

0014 finishes 0010. The rebased tree still called `g_error()` from
`g_wakeup_free()` and `g_wakeup_acknowledge()`. `g_main_context_unref()`
frees the context's wakeup when the last reference goes, so every context
that was ever freed aborted. On WebAssembly `g_wakeup_new()` returns `NULL`,
so there is nothing to release. 0014 also sets the unregistered wakeup
record's fd to -1; left at 0, a source polling fd 0 would be taken for the
wakeup and `g_wakeup_acknowledge()` called for it (which no longer aborts
either).

`g_wakeup_get_pollfd()` still aborts. The main context no longer calls it,
but `g_cancellable_make_pollfd()` does (after asserting `g_wakeup_new()`,
which returns `NULL`), so **GCancellable file descriptors —
`g_cancellable_make_pollfd()` and `g_cancellable_get_fd()` — are unsupported
on WebAssembly and abort.** Their callers are `gsocket.c`,
`gasynchelper.c`, `gunixinputstream.c` and `gunixoutputstream.c`.

0015 fixes GLib's own calls through mismatched function types. Calling a
function through a pointer type with a different parameter list or return
type is undefined behaviour; native ABIs tolerate it, but WebAssembly checks
every indirect call and traps. Each site now calls the function through its
own type: a direct loop, a small wrapper, or a trampoline that takes the real
function as user data. The fixes apply on every platform and don't change
behaviour, except where noted.

- `glist.c`, `gslist.c`, `gqueue.c`, `gasyncqueue.c`: `g_list_free_full()`,
  `g_slist_free_full()`, `g_queue_free_full()`, `g_queue_clear_full()` and
  `g_async_queue_unref()` called a `GDestroyNotify` as a `GFunc`.
- `glist.c`, `gslist.c`, `garray.c`, `gtree.c`: `g_list_sort()`,
  `g_slist_sort()`, `g_list_insert_sorted()`, `g_slist_insert_sorted()`,
  `g_array_sort()`, `g_ptr_array_sort()` and `g_tree_new()` called a
  `GCompareFunc` as a `GCompareDataFunc`.
- `gtestutils.c`: tests added with `g_test_add_func()`,
  `g_test_add_data_func()` and `g_test_add_data_func_full()` were called as
  `GTestFixtureFunc`, as was the data's `GDestroyNotify`. The test case now
  records them and calls them through their own types.
- `gobject.c`: `g_object_watch_closure()` (used by
  `g_signal_connect_object()`) passed `g_object_ref()`/`g_object_unref()` as
  `GClosureNotify` marshal guards. `g_object_add_weak_pointer()` and
  `g_object_remove_weak_pointer()` passed `g_nullify_pointer()` as a
  `GWeakNotify`; this one is replaced **only on WebAssembly**, because code
  elsewhere may pass `(GWeakNotify) g_nullify_pointer` to
  `g_object_weak_unref()` itself and expect it to match.
- `gbinding.c`, `gdbusserver.c`, `gdbusobjectmanagerclient.c`,
  `gcancellable.c`: one-argument free functions passed as `GClosureNotify`.
  `g_cancellable_connect()` forwarded the caller's `data_destroy_func` as a
  `GClosureNotify`; it is now called from a finalize notifier that carries
  the function and data in a small allocation, since finalize notifiers see
  their own notify data in `closure->data`.
- `gtestdbus.c`: `g_main_loop_quit()` passed as a `GWeakNotify`.
- `gdbusintrospection.c`, `gdbusobjectmanagerclient.c`, `gdbusobjectproxy.c`,
  `gdbusobjectskeleton.c`, `gdbusprivate.c`: ref/unref functions passed to
  `g_list_foreach()`/`g_ptr_array_foreach()` as `GFunc`.
- `gsettingsbackend.c`, `gkeyfilesettingsbackend.c`: `strcmp()` passed to
  `g_tree_new_full()` as a `GCompareDataFunc`.

0016 resolves the symbols that 0008's exclusion of Unix-specific sources
left undefined. A static link garbage-collects their callers, but a main
module (`-sMAIN_MODULE=1`) keeps every function for side modules, so linking
GLib into one failed on them:

- `giounix.c` (`g_io_channel_unix_new()`, called by `gtestutils.c` and
  `gtestdbus.c`) is built again. It is plain POSIX I/O on file descriptors
  and `giochannel.h` declares it on every Unix.
- `g_unix_connection_send_fd()` and the D-Bus command line's stdin used
  `gunixfdmessage.c` and `gunixinputstream.c`. They are guarded like
  `g_unix_connection_receive_fd()` and `GApplicationCommandLine`'s own stdin
  already were: sending an fd reports `G_IO_ERROR_NOT_SUPPORTED`, and stdin
  is `NULL`.
- `gappinfo.c` called the application database's `*_impl` functions from
  `gdesktopappinfo.c`. On WebAssembly they find no applications, and
  `g_app_info_create_from_commandline()` reports `G_IO_ERROR_NOT_SUPPORTED`.

0017 lets the tools link. Three of them call into Unix sources that 0008
excludes; on WebAssembly each reports the feature as unsupported at run
time instead:

- `gtester` opens its report pipe with `pipe()` instead of
  `g_unix_open_pipe()`; spawning the test binary then fails as unsupported.
- `gio info` leaves out the Unix mount line, and `gio launch` reports "not
  currently supported on this platform", as on Windows and macOS.
- `gapplication list` finds no D-Bus activatable applications, and
  `gapplication list-actions` reports that it can't find the application's
  desktop file.

The tools get Node link flags, and Meson links configure's run checks with
them too. Only one result changed: the `/proc/self/cmdline` check passed
under Node, which reads the host's `/proc`, although the library also runs
in browsers, which have none. 0017 takes that result from the
`have_proc_self_cmdline` cross property on Emscripten (default false), as a
cross build without an exe wrapper does, so the libraries build exactly as
before.

0018 lets GLib's own tests configure and build with `-Dtests=true`. It
changes only test sources and test build files (`glib/tests`,
`gobject/tests`, `gio/tests`, `tests/lib`), so the library is built exactly
as before. The tools' own tests (`gobject-query.py`, `gio-tool.py`,
`gdbus-tool.py`) run the `.js` tools: `tests/lib/testprogramrunner.py`
looks for `<tool>.js` and runs it with the Node that
`_G_TEST_PROGRAM_RUNNER_NODE` names, which the gobject and gio test meson
files set on Emscripten from `find_program('node', native : true)`. What it
leaves out on Emscripten, each worth revisiting if the reason goes away:

- The Unix-only blocks in `glib/tests` (`include`, `poll-fdset`, `unix`,
  `gutils-user-database`) and `gio/tests` (the large Unix test block,
  `gdbus-example-unix-fd-client`, the `dbus-launch` helper,
  `GIO_LAUNCH_DESKTOP`): 0008 excludes the Unix sources they test.
- `gio-unix-2.0-pkg-config`: Emscripten has no `gio-unix-2.0`.
- `constructor`: its helpers are shared libraries, which Meson can't link
  for Emscripten.
- `tests/lib`'s `glibconfig.py`: only girepository's tests read it, and
  girepository isn't built (0001).
- `appmonitor`, `gsubprocess`, `unix-fd`: they need `GDesktopAppInfo`,
  process spawning and fd passing.
- `dynamictype`, `dynamictests`: `G_DEFINE_DYNAMIC_TYPE_EXTENDED` refers to a
  `type_name##_init_adapter` that 0009 never defines in `gtypemodule.h`, so
  they don't compile. 0020 defines it and builds them again.
- Subtests calling the glib-unix and gio-unix APIs: mainloop's unix-fd
  tests, closure's `/closure/fd` and `/closure/signal`, pollable's Unix
  stream tests and `/pollable/converter`, and testing's subprocess stdin
  test.
- thread's CPU affinity subtest: it calls `pthread_getaffinity_np()` and
  `pthread_setaffinity_np()` itself, which Emscripten declares but doesn't
  define. The library doesn't: 0008 already makes `g_get_num_processors()`
  return `emscripten_num_logical_cores()` on WebAssembly.

Two tests are adapted instead: `spawn-singlethread` and `test-printf` open
their pipe with `pipe()` instead of `g_unix_open_pipe()`, and `param`'s
custom `instance_init` takes the class data argument that 0009 adds to
`GParamSpecTypeInfo`.

Test code that registers callbacks with the wrong signature is fixed too,
since each such call traps on WebAssembly. Class, instance and interface
init functions take their data argument (`gobject/tests` and GIO's test
converters, TLS backend and proxies), notify handlers in
`properties-refcount*` take their user data, and small wrappers replace
library functions passed through another callback type: `g_strdup` as
`GCopyFunc`/`GDuplicateFunc` (`array-test`, `qdata`), `g_free` as `GFunc`
(`option-context`), `g_usleep` as `GFunc` (`thread-pool-slow`),
`g_main_loop_quit` as `GSourceFunc` (`mainloop`, `resolver`),
`g_cancellable_cancel` as `GThreadFunc` and a one-argument callback
passed to `g_cancellable_connect()` (`cancellable`), and
`g_object_unref` as `GWeakNotify` (`signalgroup`). Two-argument compare
functions get three-argument wrappers (`list`, `slist`, `tree`,
`glistmodel`), `node`'s traversal callback a void one for
`g_node_children_foreach()`, `dataset`'s notify a `GDataForeachFunc`,
`binding` and `bindinggroup` their `GClosureNotify`s, and `hook` swaps
its hooks' functions between `g_hook_list_invoke()` and
`g_hook_list_invoke_check()`, which call them through different types.

0019 fixes the library sites the test run and a cast audit found after
0015. The audit compiled every library source with
`-Wcast-function-type-strict` and kept the casts whose WebAssembly
signatures (parameter count and `i32`/`i64`/`f32`/`f64` types, return
type) differ; the remaining ones are GLib's own round trips, such as a
`GSourceFunc` that the source's dispatch casts back to its real type.

- `gtypemodule.c`: `GTypeModule`'s one-argument `class_init`, so every GIO
  extension point (and any `GTypeModule`) trapped on first use.
- `gbookmarkfile.c`: `g_bookmark_file_copy()` passed `g_strdup()` and
  one-argument copy functions to `g_list_copy_deep()` as `GCopyFunc`.
- `gsourceclosure.c`: `g_closure_ref()`, which returns the closure, as a
  closure source's void-returning ref function.
- `gdbusinterfaceskeleton.c`, `gdbusobjectmanagerserver.c`,
  `gdbusobjectproxy.c`, `gdbusobjectskeleton.c`, `gmemorymonitorbase.c`,
  and the interface init functions `gdbus-codegen` generates: one-argument
  `GInterfaceInitFunc`s.
- `gtester.c`: `g_free()` passed to `g_slist_foreach()` as a `GFunc`.

The `gdbus-codegen` fix only reaches code generated with this GLib's
`gdbus-codegen`, the Python script in `pkgsWasm.glib.dev/bin`. A cross
build runs its tools on the build machine, and the build machine's GLib
(nixpkgs' native `glib`, unpatched) has its own:

- Autotools projects that take the tool from `gio-2.0.pc`
  (`PKG_CHECK_VAR([GDBUS_CODEGEN], [gio-2.0], [gdbus_codegen])`, as IBus
  does) read the host's `gio-2.0.pc`, whose `gdbus_codegen` is
  `${devbindir}/gdbus-codegen`: the patched script.
- Meson's `gnome.gdbus_codegen()` looks the tool up in the host machine's
  cross files first, then in the `gdbus_codegen` variable of the *build*
  machine's `gio-2.0`, then on `PATH`; the last two find the unpatched
  one. `pkgsWasm.glib` therefore installs
  `nix-support/gdbus-codegen-cross.ini`, naming its own script, and a
  setup hook that adds it to `mesonFlagsArray` in every build depending
  on it. `checks.glib-gdbus-codegen` builds a Meson project that way, with
  the native GLib present too, and runs the generated skeletons under
  Node.
- Anything that runs `gdbus-codegen` by name from `PATH` gets the native
  one, and its interface init functions trap on WebAssembly.

0020 defines the instance init adapter `G_DEFINE_DYNAMIC_TYPE_EXTENDED`
registers and adds one for `class_finalize`, which the macro also cast to
the two-argument `GClassFinalizeFunc`, and builds the `dynamictype` and
`dynamictests` tests again.

0021 changes GTest. `g_test_trap_subprocess()` runs the test binary again
as a child, which WebAssembly can't spawn, so the first subprocess test
aborted the whole program. On WebAssembly it now marks the calling test
skipped and `longjmp()`s back to `test_case_run()`, which ends that test
and goes on with the next; returning would leave the caller asserting on
a subprocess that never ran. The rest of the test function, its cleanup
included, doesn't run, so what it allocated leaks. A call from another
thread, or outside a test case, only marks the test skipped.

0022 fixes signal class handlers. A signal's C marshaller calls a
closure's callback with the instance, the signal's parameters *and* the
closure's user data, while class handlers (`klass->activate`,
`klass->notify` and every other signal vfunc registered by offset, and
handlers given to `g_signal_new_class_handler()` or
`g_signal_override_class_handler()`) take no user data. Native ABIs
ignore the extra argument; on WebAssembly emitting any signal whose class
handler was set trapped, in GLib's own classes as in user code. On
WebAssembly only, the closures GLib makes for class handlers
(`g_signal_type_cclosure_new()` and the two class-handler functions) now
get their own marshaller when they are created: the libffi generic
marshaller, and its va form, with the trailing user data left off the
call. A closure that already has a marshaller keeps it when it becomes a
signal's class closure, so the signal's C and va marshallers are never
installed on these; every path that runs a class closure — emission,
`g_signal_chain_from_overridden()`,
`g_signal_chain_from_overridden_handler()` — reaches the handler through
libffi with exactly the instance and the signal's parameters, and returns
its value. Other platforms compile the same code as before. Closures that
callers make themselves and pass to `g_signal_newv()` or
`g_signal_override_class_closure()`, such as `g_cclosure_new (handler,
NULL, NULL)`, may take user data, so they are unchanged, as are connected
handlers.

On Emscripten, libffi's `ffi_call` calls the function from JavaScript,
which pads or drops arguments rather than trapping, so a class handler
declaring fewer parameters than its signal (GLib's `performance` test has
one) still runs. That is libffi's behaviour, not a guarantee of 0022.

0023 fixes test code the same way 0018 did: handlers connected to
`accumulator`'s and `signals`' signals, and the class closures `override`
creates with `g_cclosure_new()`, now take the user data their
marshallers pass, and `performance` connects a handler taking its
signal's arguments to the signal that has them.

Not covered either: callbacks that *users* pass with fewer parameters
than the API documents (including signal handlers connected with
`G_CALLBACK`, which the audit can't see), the one-argument
`iface_init`/`class_init` functions users pass through
`G_IMPLEMENT_INTERFACE` or hand-written `GTypeInfo` (as GLib's tests did),
`(GFunc)` casts in the unbuilt `TEST_COMPLETION` block of
`deprecated/gcompletion.c`, and Windows-, macOS- and Unix-only files
that WebAssembly doesn't build.
