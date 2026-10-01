# GLib patches for Emscripten

These patches let GLib build and run as WebAssembly under Emscripten, with
pthreads and dynamic linking. They target nixpkgs' `glib` recipe (GLib
2.88.3) and apply with `patch -p1`, in file-name order, **after** nixpkgs'
own GLib patches (`glib-appinfo-watch.patch`, `schema-override-variable.patch`,
`elementary-terminal-support.patch`, `split-dev-programs.patch`,
`gdb_script.patch`). `checks.glib-patches` applies both sets in that order.

Every patch keeps its original author.

## Sources

| Source | Branch | Base |
|---|---|---|
| Kleis Auke Wolthuizen (wasm-vips) | [`kleisauke/glib` `wasm-vips-2.88.1`](https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1) | upstream `2.88.1` (`d43ba363cb9a`) |
| Fluendo (gst.wasm) | [`fluendo/glib` `gst.wasm`](https://github.com/fluendo/glib/tree/gst.wasm) | upstream `2.76.0` (`8a9ada663923`) |

The series was built by cherry-picking onto a branch made of upstream `2.88.3`
plus nixpkgs' patches, then exported with `git format-patch`. Commit
messages carry `(cherry picked from commit …)` with the source hash, or
`(adapted from commit …)` on 0011 and 0012, whose hunks differ from the
originals.

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
| 0024 gio: Don't query file existence through `faccessat()` on WebAssembly | Alexis Williams | — |
| 0025 gmain: Wait on a futex-backed GWakeup on WebAssembly | Alexis Williams | — |
| 0026 tests: Wait on GWakeup without its poll fd on WebAssembly | Alexis Williams | — |
| 0027 gtimezone: Take zones from Intl on WebAssembly | Alexis Williams | — |
| 0028 gutils: Don't look the user up on WebAssembly | Alexis Williams | — |
| 0029 gio, gobject: Fill gaps WebAssembly's GIO build left | Alexis Williams | — |
| 0030 glib: Give a WebAssembly GWakeup a pipe to poll | Alexis Williams | — |
| 0031 glib, gio: Restore Unix paths WebAssembly can take | Alexis Williams | — |
| 0032 gconvert, gcharsetconverter: Report characters `iconv()` replaces | Alexis Williams | — |
| 0033 gmain: Give an ownerless-polling context a wakeup fd on WebAssembly | Alexis Williams | — |
| 0034 glib, gio: Build glib-unix and GIO's Unix streams on WebAssembly | Alexis Williams | — |
| 0035 goption: Take the program name from Emscripten on WebAssembly | Alexis Williams | — |
| 0036 tests: Skip what WebAssembly can't do, and fix what it showed up | Alexis Williams | — |

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
| `990ffd85fe41` gmain: emscripten: Use 0 timeout | **Ported** as 0012 | Guarded by `G_PLATFORM_WASM`; applied to `timeout_usec` in `g_main_context_iterate_unlocked()`, which is what 2.88 calls the timeout. Emscripten's `poll()` sends a zero timeout to a synchronous, non-suspending probe. A non-zero timeout is ignored on the main thread and, from a pthread, becomes an asynchronous call proxied to the main thread, which only completes when that thread returns to its event loop. With no wakeup fd and the timeout forced to 0, a blocking `g_main_context_iteration (ctx, TRUE)` or `g_main_loop_run()` busy-spun, including GLib's own worker-context thread; 0025 restores the timeout and waits on a futex instead. |
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
that was ever freed aborted. With 0010's `g_wakeup_new()` returning `NULL`
there was nothing to release. 0014 also set the unregistered wakeup
record's fd to -1, so that a source polling fd 0 wasn't taken for the
wakeup. 0025 replaces all of this with a real wakeup and drops the fd -1
record, which nothing compares against any more.

`g_wakeup_get_pollfd()` still aborted after 0025, since a futex can't be
polled; 0030 gives it a pipe.

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

0017 lets the tools link. The overlay installs each as `<tool>.js` and
`<tool>.wasm` with a `<tool>` wrapper beside them that runs it under the
build machine's Node, so the paths `gio-2.0.pc` and `glib-2.0.pc` give
exist. Three of the tools call into Unix sources that 0008 excludes; on
WebAssembly each reports the feature as unsupported at run time instead:

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
- `gio-unix-2.0-pkg-config`: Emscripten had no `gio-unix-2.0`; 0036 runs
  it again now that 0034 builds it.
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
  test. 0036 builds all but the last again, now that 0034 builds the APIs.
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
(nixpkgs' native `glib`, unpatched) has its own. So that consumers run
this GLib's tools:

- Autotools projects that take a tool from the host's `.pc` files
  (`PKG_CHECK_VAR([GDBUS_CODEGEN], [gio-2.0], [gdbus_codegen])`, as IBus
  does) get this GLib's: the `.pc` tool variables name its scripts and
  the Node wrappers of its `.js` tools. `checks.glib-autotools-tools`
  builds and reads back a schema and a resource that way.
- Meson's gnome module looks each tool (`gdbus-codegen`,
  `glib-compile-resources`, `glib-compile-schemas`, `glib-genmarshal`,
  `glib-mkenums`, `gio-querymodules`) up in the host machine's cross files
  first, then in the variable of the *build* machine's `gio-2.0` or
  `glib-2.0`, then on `PATH`; the last two find the native ones.
  `pkgsWasm.glib` therefore installs `nix-support/glib-tools-cross.ini`,
  naming every tool its `.pc` files name, and a setup hook that adds it
  to `mesonFlagsArray` in every build depending on it. Meson also reads
  the build machine's GLib version to choose tool options, through a
  build-machine pkg-config, and assumes 2.54 (with a warning) without
  one; the hook sets `PKG_CONFIG_FOR_BUILD` and
  `PKG_CONFIG_PATH_FOR_BUILD` to the build platform's pkg-config and
  GLib, so consumers need no `depsBuildBuild` for it.
  `checks.glib-meson-tools` builds a Meson project calling each helper,
  with the native GLib on `PATH` too, and runs what they generate under
  Node.
- Anything that runs a tool by name from `PATH` gets the native one, and
  the interface init functions its `gdbus-codegen` emits trap on
  WebAssembly.

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
declaring fewer parameters than its signal would still run. That is
libffi's behaviour, not a guarantee of 0022; nothing in this series
relies on it.

0023 fixes test code the same way 0018 did: handlers connected to
`accumulator`'s and `signals`' signals, and the class closures `override`
creates with `g_cclosure_new()`, now take the user data their
marshallers pass, and `performance`'s signal with arguments gets a class
handler and a connected handler that take them.

0024 stops `g_file_query_exists()` from calling `faccessat()` on
WebAssembly. GLib asks for `AT_EACCESS | AT_SYMLINK_NOFOLLOW`, but
Emscripten doesn't honour `AT_SYMLINK_NOFOLLOW`: its JavaScript
filesystems assert that the flags are 0 or `AT_EACCESS` (so with runtime
assertions every `g_file_query_exists()` aborted) and otherwise ignore
it, and WasmFS ignores it too, so a dangling symlink can be reported
missing. GLib already
leaves `query_exists` unset on platforms with the same gap (Android,
Solaris, the BSDs); the fallback queries the file's type, which
reports a dangling symlink as existing. `access()`, `g_access()` and `g_file_test()` pass
no flags and are unaffected. Under Node's raw filesystem
(`-sNODERAWFS`, which the tools use), path lookups never follow
symlinks, so `access()` finds a dangling symlink; WasmFS, which the
tests and the browser use, is not affected by that.

0025 gives `GMainContext` a wakeup it can sleep on, so a blocking
`g_main_context_iteration (ctx, TRUE)` or `g_main_loop_run()` no longer
busy-spins. It supersedes the wakeup parts of 0010, 0011, 0012 and 0014
without editing them:

- **The wakeup.** On WebAssembly a `GWakeup` holds two atomic counters.
  `g_wakeup_signal()` increments `signals` and wakes every waiter on it
  with `emscripten_futex_wake()`; `g_wakeup_acknowledge()` copies
  `signals` into `acknowledged`; the new `g_wakeup_wait (wakeup,
  timeout_usec)` sleeps with `emscripten_futex_wait()` while `signals`
  still equals `acknowledged`, and says whether it moved. That is
  eventfd's contract (signalled until acknowledged, any number of signals
  acknowledged at once), and comparing only for equality makes wrapping
  harmless. `g_wakeup_new()` allocates one and `g_wakeup_free()` frees it.
- **Why `emscripten_futex_wait()`** rather than a bare
  `emscripten_atomic_wait_u32()`: other threads hand a sleeping thread
  work and wait for it. The main thread runs the calls pthreads proxy to
  it (file system calls and `poll()` among them), and with dynamic
  linking `dlopen()` blocks until every thread has loaded the new module.
  `emscripten_futex_wait()` is woken for both and does the work before
  returning; a bare atomic wait would deadlock them. On a browser's main
  thread it busy-waits, but GLib never runs there in this runtime. What
  it can't do is finish a call Emscripten proxies as a promise
  (`fsync()`, which the JavaScript file systems' `fd_sync` resolves
  asynchronously with pthreads; WasmFS implements it in C and is not
  affected): that needs the main thread back in its event loop, so on the
  JavaScript file systems a pthread's `fsync()` waits as long as the main
  thread blocks, in a GLib loop or anywhere else. On them, GLib's
  `async-splice-output-stream` test hangs that way: its threaded-output
  case replaces an existing file from a `GTask` thread, which GLib
  `fsync()`s before the rename, while the main thread sleeps in
  `g_main_loop_run()`. The tests run on WasmFS, where it completes.
- **The main context.** `g_main_context_iterate_unlocked()` passes the
  computed timeout on again (0012's forced zero is gone), and
  `g_main_context_poll_unlocked()` hands it to a WebAssembly-only loop
  instead of `poll()`/`ppoll()`. With no fds it waits on the context's
  wakeup until it is signalled or the deadline passes, rechecking the
  deadline after early returns (a futex wait also ends when the thread is
  handed proxied work). With fds, it probes them with `poll_func (fds, n,
  0)` and waits on the wakeup between probes in slices of at most 10 ms,
  until an fd is ready, the wakeup is signalled or the deadline passes.
  `g_main_context_check()` acknowledges the wakeup, since it isn't among
  the fds.
- **The slice.** An fd turning ready signals nothing, so the slice bounds
  how late it is noticed. Each probe from a pthread is a call proxied to
  the main thread, so the slice also bounds how often that thread is
  interrupted. 10 ms keeps a probing thread to 100 probes a second
  (negligible CPU) and the added latency below one frame; fds are rare
  here (sockets, pipes and ttys are mostly unsupported), so the common
  case is the no-fd wait, which has no slices.
- **Non-blocking iteration** (`g_main_context_iteration (ctx, FALSE)`,
  what the runtime's pump calls) is unchanged: fds are probed once with a
  zero timeout, and with none nothing is called. Only the acknowledgement
  in `g_main_context_check()` is new, an atomic store.
- **Custom poll functions** (`g_main_context_set_poll_func()`) are only
  ever asked to probe, with a zero timeout; the wait is on the wakeup.
- **The pump hook** (the runtime's Worker host waits on its own request
  word, and `g_wakeup_signal()` on the pumped context's wakeup must also
  bump and notify that word) fits without changing any of this: add a
  `gint *` to the WebAssembly `GWakeup`, set for the default context's
  wakeup through a private setter (a `GLibPrivateVTable` entry or a small
  WebAssembly-only function in `gmain.c`), and have `g_wakeup_signal()`
  increment and `emscripten_futex_wake()` that word after its own. Waiting
  and acknowledging don't change, since the host never waits on the
  wakeup's own counter. GLib only signals a context's wakeup for a source
  attached from another thread when some other thread owns the context
  (or it polls without an owner), so the pump's thread must acquire the
  default context once for the Worker's lifetime; acquiring is recursive,
  so its non-blocking iterations still work. A context acquired and
  released around each iteration is unowned between pumps, and a source
  attached then would never wake the host.

With the wakeup in place, the thread `g_get_worker_context()` starts
(for `GTask`, among others) and GDBus's shared thread sleep in their
loops instead of spinning. `checks.glib` measures it with Node's
`process.cpuUsage()`, since Emscripten's `clock()` counts wall time and
its `getrusage()` is a stub.

0026 makes `gwakeuptest` check and wait for a signal with
`g_wakeup_wait()` on WebAssembly, where `g_wakeup_get_pollfd()` aborted
until 0030.

0027 gives `GTimeZone` IANA zones on WebAssembly from JavaScript's `Intl`
API rather than from zoneinfo files. 0008 left out every TZif path, so
only fixed offsets and POSIX rule strings worked, IANA names such as
`America/Recife` failed, and the default zone was always `UTC0`. A page
has no zoneinfo files, and the JavaScript engine already carries the
data (browsers and nixpkgs' Node have full ICU), so nothing is bundled:

- **TZif from Intl.** Where GLib would read a zone's TZif file
  (`zone_info_unix()`), WebAssembly synthesizes version 2 TZif data for
  the identifier from `Intl.DateTimeFormat` (an `EM_JS` helper) and hands
  it to GLib's own parser. An identifier Intl rejects (`RangeError`) gives
  no data, so it fails as a missing file does and callers fall back to
  UTC. Paths (`TZ=:/etc/localtime`, an absolute file name) aren't read.
  Data that TZif's single-byte indexes can't hold (over 256 types or 255
  bytes of abbreviations) is refused the same way.
- **Names.** Intl accepts zone names in any case. A name it accepts that
  differs from its own spelling only in case is looked up and named by
  Intl's spelling, so `europe/berlin` and `Europe/Berlin` are one zone
  named `Europe/Berlin` and cached once. Other names keep the spelling
  they were asked for, because Intl maps aliases to other zones' names
  (`Asia/Kolkata` to `Asia/Calcutta`, `US/Pacific` to
  `America/Los_Angeles`, `EST` to `America/Panama`), which a caller
  asking for one zone by name doesn't expect back.
- **Transitions.** The offset at an instant is the formatted local time
  minus the instant, exact to the second (Intl keeps local mean time
  offsets such as -07:52:58). It is sampled weekly from 1800, before any
  zone left local mean time, to 2101, and each change is narrowed down to
  the second by bisection: about 20,000 `formatToParts()` calls, 40–70 ms
  per zone under Node. Two changes less than a week apart that cancel out
  are missed; tzdata has none such in the zones checked. Before 1800 a
  zone keeps its local mean time.
- **After 2100.** Transitions are listed up to 2100; the year after is
  sampled only so the last ones get their DST flag. The footer then
  carries the 2090s on as a POSIX TZ rule when they fit one: a fixed
  offset, or one change to DST and one back each year on a
  month-week-weekday date at a local time, checked against all ten years
  (Sydney: `<+1000>-10<+1100>-11,M10.1.0/2,M4.1.0/3`). Zones whose
  changes don't fit keep their last offset after 2100, with an empty
  footer: Chile's (the first Sunday on or after the 2nd), Greenland's
  (at 22:00 the day before) and any that follow a lunar calendar.
- **DST and abbreviations.** A period counts as daylight saving time when
  its offset is above the lowest offset in both the year before and the
  year after it began, a stricter test than the surrounding year alone.
  Requiring both keeps a zone that moved to a new
  standard offset for good (Istanbul in 2016) out of permanent summer time,
  at the cost of calling war time that lasted over a year standard time.
  Abbreviations are Intl's short `en-US` names where alphabetic (`PST`,
  `PDT`, `GMT`), which ICU has only for some zones and only since 1970;
  elsewhere they are numeric (`+0100`, `-075258`) or `UTC`, where tzdata
  has `CET`, `LMT` and the like.
- **The local zone.** With `TZ` unset, the default zone is
  `Intl.DateTimeFormat().resolvedOptions().timeZone`; `TZ` is still
  honoured first.
- **Caching.** GLib caches a `GTimeZone` only while it is referenced, so
  the synthesized data is kept per identifier for the life of the
  program, under a lock, and Intl runs once per zone. The helper hands
  its bytes back through a second call on the same thread, because
  Emscripten can't make `malloc()` callable from a C library's `EM_JS`.

Checked against nixpkgs' tzdata 2026c on the 15th of every month from
1850 to 2099, Los Angeles, New York, London, Berlin, Moscow, Istanbul,
Tehran, Kolkata, Tokyo, Lord Howe, Apia, Recife and São Paulo give the
same offsets throughout. Casablanca differs from late 2026, where Node's
ICU (tzdata 2026a) and tzdata 2026c disagree about Morocco. DST flags
differ mostly for war time (1940–1945), which lasted over a year and so
reads as standard time, and for a handful of one-off changes. Of GLib's
`GTimeZone` and `GDateTime` tests, all pass except
`/GTimeZone/parse-rfc8536`, which loads TZif files by path and which 0036
skips on WebAssembly.

0028 skips the user database lookup in `g_get_user_name()`,
`g_get_real_name()` and `g_get_home_dir()` on WebAssembly. Emscripten's
`getpwnam_r()`, `getpwuid_r()` and `getpwuid()` are stubs that report
`ENOENT`, so the lookup always failed and warned (a fatal warning in
tests); the result is the same fallback, "somebody" and "Unknown", without
the warning. `g_get_home_dir()` still takes `HOME`, which Emscripten's
default environment sets.

0029 fills three gaps 0008 left in GIO and GObject:

- `g_content_type_is_a()` in 0008's WebAssembly content type backend only
  compared for equality; every type but an inode is now also an
  `application/octet-stream`, as with the shared-mime-info backend.
- No memory monitor was registered on WebAssembly, so
  `g_memory_monitor_dup_default()` passed `NULL` to `g_object_ref()`. A
  new `GMemoryMonitorWasm` (`gio/gmemorymonitorwasm.c`), which never
  warns, is registered at priority 0. Nothing in the browser reports
  memory pressure.
- `g_source_set_closure()` refused `GIOChannel` watches, because 0008 left
  `g_io_watch_funcs` out of source closures while `giounix.c` wasn't
  built; 0016 builds it again.

0030 gives a WebAssembly `GWakeup` an fd to poll, so
`g_cancellable_make_pollfd()` and `g_cancellable_get_fd()` work, and their
callers (`gsocket.c`, `gasynchelper.c`) no longer abort:

- **The pipe.** The first `g_wakeup_get_pollfd()` on a wakeup creates a
  pipe and publishes it with a compare-and-swap; a thread that loses the
  race closes its own. From then on `g_wakeup_signal()` also writes a byte
  to it, and `g_wakeup_acknowledge()` drains it before acknowledging the
  futex, so a signal landing in between leaves a spurious byte rather than
  a signalled wakeup that doesn't poll ready. A signal racing with the
  pipe's creation either sees the pipe or bumped the counter before the
  creator checks it, and the creator then writes the byte itself.
- **Emscripten's pipes.** WasmFS's `pipe2()` takes no flag but
  `O_CLOEXEC`, so `O_NONBLOCK` is set with `fcntl()`. Neither file system
  blocks on a pipe: an empty pipe reads as `EAGAIN` on the JavaScript file
  systems, even after every writer has closed (while `poll()` reports
  `POLLHUP`), and as 0 on WasmFS. The drain stops at either, and never
  waits for end of file.
- **Waiting is unchanged.** `g_wakeup_wait()` and main contexts still
  sleep on the futex, and main contexts only ask for the fd when they are
  polled without an owner (0033), so the rest never get a pipe; 0025's loop still probes a context's fds between
  waits on its wakeup, which a signal ends at once.
- **`g_poll()` with a timeout** waited on nothing: Emscripten's `poll()`
  ignores the timeout on the main thread and on WasmFS, and from a pthread
  on the JavaScript file systems it waits for the main thread to return to
  its event loop. On WebAssembly `g_poll()` now probes the fds with a zero
  timeout and sleeps in 10 ms slices (`g_usleep()`, which serves proxied
  calls) until one is ready or the timeout passes. A cancellable's fd
  turning ready is noticed within a slice.
- `gwakeuptest` checks the poll fd again on WebAssembly, and that it
  agrees with `g_wakeup_wait()`; it still waits with `g_wakeup_wait()`,
  since its threaded test passes tokens far too often for 10 ms slices.

0031 restores three Unix paths 0008 left out that work on WebAssembly as
they do elsewhere:

- `g_source_add_unix_fd()`, `g_source_modify_unix_fd()`,
  `g_source_remove_unix_fd()` and `g_source_query_unix_fd()`, which
  `gmain.h` declares on every Unix, weren't built, so callers failed to
  link. They only add fds to a source's poll set, which 0025's loop
  probes.
- Local files get `standard::is-hidden` (dotfiles and names in the
  directory's `.hidden` file) and `standard::is-backup` (names ending in
  `~`) again. Lost+found directories aren't looked for: that needs the
  Unix mount table, which isn't built. Reading `.hidden` caches it for a
  few seconds with a timeout on GLib's worker context, whose thread 0025
  lets sleep.
- Files in a `GResource` get a content type again, guessed from the name
  and data as for local files.

The rest of 0008's WebAssembly guards were reviewed with 0031; the ones
worth revisiting are listed in the plan's follow-ups.

0032 makes GLib notice a character `iconv()` replaces. musl's `iconv()`
(like NetBSD's) converts a character the target charset lacks to `*` and
counts it as an irreversible conversion instead of failing with
`EILSEQ`, and forgets the count when a later character ends the same
call with an error: no room for the output (`E2BIG`), an incomplete
character at the end of the input (`EINVAL`) or an invalid one
(`EILSEQ`). `g_convert()` has reported a positive count as an illegal
sequence since 2018, but only when the call that made it succeeded;
`g_convert_with_fallback()` kept the `*` where the caller asked for its
fallback; and `GCharsetConverter` neither reported `INVALID_DATA` nor
used its fallback.

- **Which `iconv()`.** Whether `iconv()` replaces is probed once, by
  converting `½` to ASCII. glibc's fails with `EILSEQ` instead.
- **`GCharsetConverter`**, where `iconv()` replaces, converts its input a
  character at a time from the start, with no bulk call first, and stops
  at a replaced character as at `EILSEQ`: the fallback replaces it, or the
  error reports it after the text before it. A character is found by
  feeding `iconv()` one byte more each time until it stops reporting an
  incomplete character; a shift sequence or byte order mark consumed on
  the way stays consumed. Nothing is converted twice, so stateful source
  charsets (ISO-2022-JP, UTF-16 with a byte order mark) read exactly as
  in one call. Elsewhere the converter is unchanged.
- **`g_convert_with_fallback()`** starts again once from a reset
  converter, a character at a time, when a call reports a replacement or,
  where `iconv()` replaces, runs out of output room after converting
  something. Starting over rather than rewinding keeps a stateful target
  from losing a shift sequence to discarded output, on any `iconv()`.
  From then on each character, of the string and of the fallback, is
  first converted alone on a second converter, reset for it; one that
  fails or comes back replaced there is treated as `EILSEQ`, so the
  fallback replaces it (or a fallback that has one is refused), and only
  the others go through the main converter. Whether a character has a
  representation doesn't depend on the target's shift state, so no
  further restart is needed and the conversion stays linear: 32,000
  unrepresentable characters to ASCII take 2 ms on Node. glibc only
  starts over for an irreversible conversion it counts.
- **`g_convert_with_iconv()`** (and so `g_convert()`), where `iconv()`
  replaces, starts again from a reset converter when a call fails after
  converting something, with room for all the output or with only the
  complete characters, so that one call converts everything and reports
  the count.

A target that asks for transliteration (`//TRANSLIT`), where glibc counts
its replacements the same way, still gets them. Nothing here is specific
to WebAssembly, and it could go upstream. convert and converter-stream
test a replaced character followed by an incomplete one and by a full
output buffer, UTF-16 with a byte order mark and ISO-2022-JP across calls
and a full buffer, and a fallback between kanji in ISO-2022-JP.

0033 gives a main context made with `G_MAIN_CONTEXT_FLAGS_OWNERLESS_POLLING`
its wakeup's fd again on WebAssembly. 0025 stopped contexts polling the
wakeup, since they wait on it, but an ownerless-polling context is polled
by someone outside it, who can only see a wakeup through an fd. Such a
context now adds the pipe 0030 provides to its poll fds; other contexts
still have none.

0034 builds `glib-unix.c` and GIO's Unix streams on WebAssembly, which
0008 left out: `glib-unix.h`'s functions were declared but failed to
link, and there was no `GUnixInputStream`, `GUnixOutputStream` or
`GFileDescriptorBased`. Emscripten's file descriptors (files, pipes,
`/dev/null`) take them as they are.

- **glib-unix** is built without the Unix signal sources, which
  `glib-unix.h` no longer declares there either, since `gmain.c` handles
  no signals on WebAssembly (no other process can send one).
  `g_unix_fd_query_path()` fails with `G_FILE_ERROR_NOSYS`: Emscripten's
  file systems have no `/proc` nor another way to name an fd's file.
  `GUnixFDSource` takes closures again.
- **GIO** builds `gfiledescriptorbased.c`, `giounix-private.c` and the
  Unix input and output streams, and installs their headers and
  `gio-unix-2.0.pc`. The rest of the Unix sources need mounts, desktop
  files or D-Bus.
- **Pollable fds.** Emscripten declares epoll but fails every call with
  `ENOSYS`, and its `poll()` only follows pipes; for other files it
  reports readiness from the open mode and the size alone. WasmFS gives a
  pipe a regular file's type but no seeking, so `_g_fd_is_pollable()`
  takes a FIFO, or an unseekable file that isn't a character device, for
  pollable.

0035 gives `g_option_context_parse()` a program name on WebAssembly when
it has no argv: Emscripten's libc sets `program_invocation_name` from the
script Node runs, or in a page from `Module.thisProgram`, which is
`./this.program` unless the runtime sets it.

0036 changes only tests, so that what WebAssembly can do gates:

- **Skipped where the expectation can't hold**, each with its reason:
  musl has no locale data (collate's lists that sort differently under
  `en_US`, option-context's decimal comma, date's Polish month names,
  gdatetime's `en_GB` formats, `de_DE` month names and eras); WasmFS has no
  sockets (`socket()` fails with `ENOSYS`); Emscripten can't spawn or fork
  processes, open a pseudo-terminal, parse an IPv6 scope ID or list
  network interfaces, and nothing can send it a signal; WasmFS keeps file
  times as a double count of milliseconds, checks no directory's search
  permission, gives pipes no capacity, and takes an empty file or device
  for unreadable in `poll()`; TZif files aren't read by path
  (`/GTimeZone/parse-rfc8536`); `gio launch` needs desktop applications,
  and WebAssembly content types know no MIME types.
- **musl's output expected** where it is right but different: `strftime()`
  pads years to four digits (`%C`, `%F`, `%G`, `%Y`, `%c`), has no `%k`,
  `%l` or `%P`, and prints nothing for a bare `%E` or `%O`;
  `g_convert()`'s illegal-sequence error comes after the input is
  consumed. mainloop expects no wakeup fd in a context that polls with an
  owner, and option-argv0 a program named after its `.js` script.
- **Subtests built again** with 0034: pollable's pipe, file, `/dev/null` and
  converter tests, mainloop's and closure's fd sources, and the
  `gio-unix-2.0` pkg-config test.
- **Test bugs fixed**: filenamecompleter connected `g_main_loop_quit()`
  through `g_signal_connect_swapped()` to a signal with two parameters
  (which traps) and expected completions in one file system's directory
  order; gdbus-peer's credentials test assumed credentials on every Unix;
  socket-listener's mocks and messages-low-memory's `malloc()` looked up
  the real function with `dlsym(RTLD_NEXT)`, which finds nothing in a
  static WebAssembly link although Emscripten's `dlfcn.h` defines
  `RTLD_NEXT`; `glib/tests` never set `_G_TEST_PROGRAM_RUNNER_NODE` for its
  Python tests, which also expected `abort()` to end Node with `SIGABRT`
  rather than status 1.
- **Workarounds for the platform**: test-printf's reader waits for its
  writer to finish, since Emscripten's pipe reads never block; mainloop's
  `nfds` test writes a byte to its file, and its `unix-fd-priority` test
  and closure's `fd` test read a pipe holding a byte instead of
  `/dev/random` or `/dev/null`, since WasmFS's `poll()` only takes a file
  or device for readable while it holds data (`/mainloop/unix-file-poll`,
  which tests exactly that, skips); and fileutils'
  `stdio-wrappers` test works in a temporary directory, since `chmod()`
  on WasmFS's Node backend doesn't reach the host directory.

Tests and tools link with runtime assertions on, so threaded tests print
`received "…" command from terminated worker` as their pthread workers
shut down at exit. It is Emscripten's diagnostic, not a GLib failure.

Not covered either: callbacks that *users* pass with fewer parameters
than the API documents (including signal handlers connected with
`G_CALLBACK`, which the audit can't see), the one-argument
`iface_init`/`class_init` functions users pass through
`G_IMPLEMENT_INTERFACE` or hand-written `GTypeInfo` (as GLib's tests did),
`(GFunc)` casts in the unbuilt `TEST_COMPLETION` block of
`deprecated/gcompletion.c`, and Windows-, macOS- and Unix-only files
that WebAssembly doesn't build.
