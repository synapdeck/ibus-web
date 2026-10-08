# GLib patches for Emscripten

These patches let GLib build and run as WebAssembly under Emscripten, with
pthreads and dynamic linking. They target nixpkgs' `glib` recipe (GLib
2.88.3) and apply with `patch -p1`, in file-name order, **after** nixpkgs'
own GLib patches (`glib-appinfo-watch.patch`, `schema-override-variable.patch`,
`elementary-terminal-support.patch`, `split-dev-programs.patch`,
`gdb_script.patch`). `checks.glib-patches` applies both sets in that order.

Every patch keeps its original author.

## Sources

| Source                            | Branch                                                                                         | Base                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| Kleis Auke Wolthuizen (wasm-vips) | [`kleisauke/glib` `wasm-vips-2.88.1`](https://github.com/kleisauke/glib/tree/wasm-vips-2.88.1) | upstream `2.88.1` (`d43ba363cb9a`) |
| Fluendo (gst.wasm)                | [`fluendo/glib` `gst.wasm`](https://github.com/fluendo/glib/tree/gst.wasm)                     | upstream `2.76.0` (`8a9ada663923`) |

The series was built by cherry-picking onto a branch made of upstream `2.88.3`
plus nixpkgs' patches, then exported with `git format-patch`. Commit
messages of the ported commits carry `(cherry picked from commit …)` with
the source hash.

## The series

| Patch                                                                                | Author                 | Source commit  |
| ------------------------------------------------------------------------------------ | ---------------------- | -------------- |
| 0001 Do not build girepository and the fuzzers (partial)                             | Wolthuizen             | `0e5465ae90c6` |
| 0002 Disable NLS                                                                     | Wolthuizen             | `1f4fa40ad026` |
| 0003 Emscripten doesn't always define `__GCC_HAVE_SYNC_COMPARE_AND_SWAP_4`           | Wolthuizen             | `84981eb5dd31` |
| 0004 Emscripten doesn't implement `pthread_getname_np()`                             | Wolthuizen             | `8ced885eb25b` |
| 0005 Network libs are not available on Emscripten                                    | Wolthuizen             | `c6a63fcd426f` |
| 0006 Ensure separate checks are also done for Emscripten                             | Wolthuizen             | `bc4812fd5890` |
| 0007 Use vsnprintf/snprintf/printf from musl libc                                    | Wolthuizen             | `c0bb73dd62bf` |
| 0008 Add support for WebAssembly                                                     | Wolthuizen             | `fc0d03194fb2` |
| 0009 Fix function pointer cast issues                                                | Wolthuizen             | `1afd0d285774` |
| 0010 glist: Fix function signatures in internals of glist/gslist                     | Jorge Zapata (Fluendo) | `86387bcf5b85` |
| 0011 Call callbacks through their own function types                                 | Alexis Williams        | —              |
| 0012 Build the tools and the Unix parts WebAssembly can take                         | Alexis Williams        | —              |
| 0013 gmain, gwakeup: Wait on a futex-backed GWakeup on WebAssembly                   | Alexis Williams        | —              |
| 0014 Give WebAssembly time zones, a memory monitor, content types and a user         | Alexis Williams        | —              |
| 0015 gconvert, gcharsetconverter: Report characters `iconv()` replaces               | Alexis Williams        | —              |
| 0016 tests: Build and run GLib's tests on WebAssembly                                | Alexis Williams        | —              |
| 0017 gmain, gwakeup: Call a hook when a context's wakeup is signalled on WebAssembly | Alexis Williams        | —              |
| 0018 gsettingsbackend: Call listeners through their declared types                   | Alexis Williams        | —              |

Each of 0011–0018 covers one topic, described in its message and below.
0016 holds every change to GLib's tests, and nothing else.

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

The other Wolthuizen commits and 0010 applied to the nixpkgs-patched tree
without conflicts and with unchanged content (`git range-diff` against the
full 0001 shows no differences), and the series applies there with
`--fuzz=0`.

### Fluendo's commits

Fluendo's branch starts from the same Wolthuizen series (on 2.76.0). Each of
its own commits was checked against the rebased tree. The main-context work
is Jorge Zapata's (`75de668d3690`, `4c360061dda3`) and Fabian Orccon's
(`990ffd85fe41`); none of their lines remain, but 0013 follows the path they
opened, and it is credited here:

| Commit                                                                     | Decision                      | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `75de668d3690` A g_error is a fatal error when run, remove it              | **Superseded** by 0013        | 0008 makes every `GWakeup` function a `g_error()` on WebAssembly, and every `GMainContext` creates, signals and frees a wakeup, so any main context aborted. This commit made `g_wakeup_new()` return `NULL` and `g_wakeup_signal()` do nothing; 0013 gives WebAssembly a working wakeup instead, and none of its lines remain.                                                                                                                                                                                                                         |
| `4c360061dda3` Initial main loop support                                   | **Superseded** by 0013        | It skipped registering the wakeup's poll fd in `g_main_context_new_with_flags()`, and ran `g_main_loop_run()` through `emscripten_set_main_loop_arg()`. 0013 waits on the wakeup instead of polling it, and registers its fd only for ownerless-polling contexts. This runtime never hands control back to the browser event loop from its Worker, and pumps the context itself, so the `emscripten_set_main_loop_arg()` path has no use here.                                                                                                          |
| `89a193f7e7da` emscripten: fix deadlock in GMainContext-related code       | **Skipped**                   | Changes only the `emscripten_set_main_loop_arg()` path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `990ffd85fe41` gmain: emscripten: Use 0 timeout                            | **Superseded** by 0013        | It forced every poll's timeout to zero. Emscripten's `poll()` sends a zero timeout to a synchronous, non-suspending probe; a non-zero timeout is ignored on the main thread and, from a pthread, becomes an asynchronous call proxied to the main thread, which only completes when that thread returns to its event loop. With no wakeup and the timeout forced to 0, a blocking `g_main_context_iteration (ctx, TRUE)` or `g_main_loop_run()` busy-spun, GLib's own worker-context thread included. 0013 keeps the real timeout and waits on a futex. |
| `86387bcf5b85` glist: Fix function signatures in internals of glist/gslist | **Ported** as 0010, all hunks | The Wolthuizen series doesn't touch `glist.c` or `gslist.c`, so none of its hunks were already covered.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `b45d3dc05781` Differentiate wasm from emscripten                          | **Skipped**                   | Adds a `G_WITH_EMSCRIPTEN` define; the series uses its own `G_PLATFORM_WASM`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `93fe7aa6231d` Be able to pass the canvas to the thread creation           | **Skipped**                   | Shares WebGL canvases with new threads (GStreamer/WebGL only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `0e30d1cf504e` Revert "Fix function pointer cast issues"                   | **Skipped**                   | Relies on Fluendo's patched Clang; this runtime uses nixpkgs' Emscripten unmodified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `5a0ebc47f6b7` Revert "Remove GRegex pre-emptively"                        | **Skipped**                   | The removal is never applied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

0010 only changes source-level types. The internal calls were already cast
back to `GCompareDataFunc`, so the generated indirect calls are the same.
`g_list_sort()`, `g_slist_sort()`, `g_list_insert_sorted()` and
`g_slist_insert_sorted()` still called a two-argument `GCompareFunc` with
three arguments, and `g_list_free_full()`, `g_slist_free_full()` and
`g_queue_free_full()` still called a `GDestroyNotify` as a `GFunc`. Under
WebAssembly, both kinds of call trap with "function signature mismatch";
0011 fixes them.

## 0011: function types

Calling a function through a pointer type with a different parameter list
or return type is undefined behaviour; native ABIs tolerate it, but
WebAssembly checks every indirect call and traps. 0011 makes each site in
the library call the function through its own type: a direct loop, a small
wrapper, or a trampoline that takes the real function as user data. The
fixes apply on every platform and don't change behaviour, except where
noted.

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
- `gtypemodule.h`: `G_DEFINE_DYNAMIC_TYPE_EXTENDED` registers a
  `type_name##_init_adapter` that 0009 never defines, so code using the
  macro (GLib's `dynamictype` and `dynamictests` tests among it) didn't
  compile. 0011 defines it and adds an adapter for `class_finalize`, which
  the macro also cast to the two-argument `GClassFinalizeFunc`.

The sites came from the test run's traps and from a cast audit, which
compiled every library source with `-Wcast-function-type-strict` and kept
the casts whose WebAssembly signatures (parameter count and
`i32`/`i64`/`f32`/`f64` types, return type) differ; the remaining ones are
GLib's own round trips, such as a `GSourceFunc` that the source's dispatch
casts back to its real type.

**Class handlers.** A signal's C marshaller calls a closure's callback
with the instance, the signal's parameters _and_ the closure's user data,
while class handlers (`klass->activate`, `klass->notify` and every other
signal vfunc registered by offset, and handlers given to
`g_signal_new_class_handler()` or `g_signal_override_class_handler()`) take
no user data. Native ABIs ignore the extra argument; on WebAssembly
emitting any signal whose class handler was set trapped, in GLib's own
classes as in user code. On WebAssembly only, the closures GLib makes for
class handlers (`g_signal_type_cclosure_new()` and the two class-handler
functions) get their own marshaller when they are created: the libffi
generic marshaller, and its va form, with the trailing user data left off
the call. A closure that already has a marshaller keeps it when it becomes
a signal's class closure, so the signal's C and va marshallers are never
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
libffi's behaviour, not a guarantee of 0011; nothing in this series
relies on it.

**`gdbus-codegen`'s reach.** Its fix only reaches code generated with this
GLib's `gdbus-codegen`, the Python script in `pkgsWasm.glib.dev/bin`. A
cross build runs its tools on the build machine, and the build machine's
GLib (nixpkgs' native `glib`, unpatched) has its own. So that consumers
run this GLib's tools:

- Autotools projects that take a tool from the host's `.pc` files
  (`PKG_CHECK_VAR([GDBUS_CODEGEN], [gio-2.0], [gdbus_codegen])`, as IBus
  does) get this GLib's: the `.pc` tool variables name its scripts and
  the Node wrappers of its `.js` tools. `checks.glib-autotools-tools`
  builds and reads back a schema and a resource that way.
- Meson's gnome module looks each tool (`gdbus-codegen`,
  `glib-compile-resources`, `glib-compile-schemas`, `glib-genmarshal`,
  `glib-mkenums`, `gio-querymodules`) up in the host machine's cross files
  first, then in the variable of the _build_ machine's `gio-2.0` or
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

Not covered: callbacks that _users_ pass with fewer parameters than the
API documents (including signal handlers connected with `G_CALLBACK`,
which the audit can't see), the one-argument `iface_init`/`class_init`
functions users pass through `G_IMPLEMENT_INTERFACE` or hand-written
`GTypeInfo` (as GLib's tests did), `(GFunc)` casts in the unbuilt
`TEST_COMPLETION` block of `deprecated/gcompletion.c`, and Windows-, macOS-
and Unix-only files that WebAssembly doesn't build.

## 0012: the Unix parts and the tools

0008 leaves out every Unix-specific source and guards out every Unix
path. 0012 brings back what works on WebAssembly as on other Unixes,
builds the tools, and works around what Emscripten lacks.

**Symbols the excluded sources left undefined.** A static link
garbage-collects their callers, but a main module (`-sMAIN_MODULE=1`)
keeps every function for side modules, so linking GLib into one failed on
them:

- `giounix.c` (`g_io_channel_unix_new()`, called by `gtestutils.c` and
  `gtestdbus.c`) is built again. It is plain POSIX I/O on file descriptors
  and `giochannel.h` declares it on every Unix. `g_source_set_closure()`
  takes `GIOChannel` watches again, which 0008 left out of source closures
  while `giounix.c` wasn't built.
- `g_unix_connection_send_fd()` and the D-Bus command line's stdin used
  `gunixfdmessage.c` and `gunixinputstream.c`. They are guarded like
  `g_unix_connection_receive_fd()` and `GApplicationCommandLine`'s own stdin
  already were: sending an fd reports `G_IO_ERROR_NOT_SUPPORTED`, and stdin
  is `NULL`.
- `gappinfo.c` called the application database's `*_impl` functions from
  `gdesktopappinfo.c`. On WebAssembly they find no applications, and
  `g_app_info_create_from_commandline()` reports `G_IO_ERROR_NOT_SUPPORTED`.

**glib-unix and GIO's Unix streams.** `glib-unix.h`'s functions were
declared but failed to link, and there was no `GUnixInputStream`,
`GUnixOutputStream` or `GFileDescriptorBased`. Emscripten's file
descriptors (files, pipes, `/dev/null`) take them as they are.

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
  `ENOSYS`, and its `poll()` only follows pipes and sockets; anything else
  it reports ready at once. So `_g_fd_is_pollable()` takes a FIFO or a
  socket for pollable, which needs the toolchain's Emscripten fix that
  gives WasmFS's pipes `S_IFIFO`.

**Restored paths.**

- `g_source_add_unix_fd()`, `g_source_modify_unix_fd()`,
  `g_source_remove_unix_fd()` and `g_source_query_unix_fd()`, which
  `gmain.h` declares on every Unix, weren't built, so callers failed to
  link. They only add fds to a source's poll set, which 0013's loop
  probes.
- Local files get `standard::is-hidden` (dotfiles and names in the
  directory's `.hidden` file) and `standard::is-backup` (names ending in
  `~`) again. Lost+found directories aren't looked for: that needs the
  Unix mount table, which isn't built. Reading `.hidden` caches it for a
  few seconds with a timeout on GLib's worker context, whose thread 0013
  lets sleep.
- Files in a `GResource` get a content type again, guessed from the name
  and data as for local files.

The rest of 0008's WebAssembly guards were reviewed for 0012; the ones
worth revisiting are listed in the plan's follow-ups.

**The tools.** The overlay installs each as `<tool>.js` and `<tool>.wasm`
with a `<tool>` wrapper beside them that runs it under the build machine's
Node, so the paths `gio-2.0.pc` and `glib-2.0.pc` give exist. Three of the
tools reach features WebAssembly doesn't have; each reports them as
unsupported at run time instead:

- `gtester` opens its report pipe with `pipe()`; spawning the test binary
  then fails as unsupported. Its comment says `glib-unix.c` isn't built,
  which no longer holds: `g_unix_open_pipe()` would do, as it would for
  the tests that use `pipe()` (see 0016).
- `gio info` leaves out the Unix mount line, and `gio launch` reports "not
  currently supported on this platform", as on Windows and macOS.
- `gapplication list` finds no D-Bus activatable applications, and
  `gapplication list-actions` reports that it can't find the application's
  desktop file.

The tools get Node link flags, and Meson links configure's run checks with
them too. Only one result changed: the `/proc/self/cmdline` check passed
under Node, which reads the host's `/proc`, although the library also runs
in browsers, which have none. 0012 takes that result from the
`have_proc_self_cmdline` cross property on Emscripten (default false), as a
cross build without an exe wrapper does, so the libraries build exactly as
before.

**Subprocess tests.** `g_test_trap_subprocess()` runs the test binary
again as a child, which WebAssembly can't spawn, so the first subprocess
test aborted the whole program. On WebAssembly it now marks the calling
test skipped and `longjmp()`s back to `test_case_run()`, which ends that
test and goes on with the next; returning would leave the caller asserting
on a subprocess that never ran. The rest of the test function, its cleanup
included, doesn't run, so what it allocated leaks. A call from another
thread, or outside a test case, only marks the test skipped.

**File existence.** `g_file_query_exists()` no longer calls `faccessat()`
on WebAssembly. GLib asks for `AT_EACCESS | AT_SYMLINK_NOFOLLOW`, but
Emscripten doesn't honour `AT_SYMLINK_NOFOLLOW`: its JavaScript
filesystems assert that the flags are 0 or `AT_EACCESS` (so with runtime
assertions every `g_file_query_exists()` aborted) and otherwise ignore it,
and WasmFS ignores it too, so a dangling symlink can be reported missing.
GLib already leaves `query_exists` unset on platforms with the same gap
(Android, Solaris, the BSDs); the fallback queries the file's type, which
reports a dangling symlink as existing. `access()`, `g_access()` and
`g_file_test()` pass no flags and are unaffected. Under Node's raw
filesystem (`-sNODERAWFS`, which the tools use), path lookups never follow
symlinks, so `access()` finds a dangling symlink; WasmFS, which the tests
and the browser use, is not affected by that.

**The program name.** `g_option_context_parse()` with no argv names the
program from the platform's record of its first argument. On WebAssembly
that is Emscripten's `program_invocation_name`, which its libc sets from
the script Node runs, or in a page from `Module.thisProgram`, which is
`./this.program` unless the runtime sets it.

**`RTLD_NEXT`.** `HAVE_RTLD_NEXT` stays unset on Emscripten. Its `dlfcn.h`
defines `RTLD_NEXT`, but `dlsym(RTLD_NEXT, …)` finds nothing there: a
static link's `dlsym()` fails for every handle, and with dynamic linking
`RTLD_NEXT` is unsupported and aborts. Only tests use it, to wrap a libc
function.

## 0013: main context and wakeup

0008 turns every `GWakeup` function into a `g_error()` on WebAssembly,
and every `GMainContext` creates, signals and frees a wakeup. 0013 gives
`GMainContext` a wakeup it can sleep on, so a blocking
`g_main_context_iteration (ctx, TRUE)` or `g_main_loop_run()` neither
aborts nor busy-spins. It replaces Fluendo's three main loop commits (see
above).

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
  computed timeout on, and `g_main_context_poll_unlocked()` hands it to a
  WebAssembly-only loop instead of `poll()`/`ppoll()`. With no fds it
  waits on the context's wakeup until it is signalled or the deadline
  passes, rechecking the deadline after early returns (a futex wait also
  ends when the thread is handed proxied work). With fds, it probes them
  with `poll_func (fds, n, 0)` and waits on the wakeup between probes in
  slices of at most 10 ms, until an fd is ready, the wakeup is signalled
  or the deadline passes. `g_main_context_check()` acknowledges the
  wakeup, since it isn't among the fds.
- **The slice.** An fd turning ready signals nothing, so the slice bounds
  how late it is noticed. Each probe from a pthread is a call proxied to
  the main thread, so the slice also bounds how often that thread is
  interrupted. 10 ms keeps a probing thread to 100 probes a second
  (negligible CPU) and the added latency below one frame; fds are rare
  here (sockets, pipes and ttys are mostly unsupported), so the common
  case is the no-fd wait, which has no slices.
- **Non-blocking iteration** (`g_main_context_iteration (ctx, FALSE)`,
  what the runtime's pump calls) probes fds once with a zero timeout, and
  with none nothing is called. Only the acknowledgement in
  `g_main_context_check()` is added, an atomic store.
- **Custom poll functions** (`g_main_context_set_poll_func()`) are only
  ever asked to probe, with a zero timeout; the wait is on the wakeup.
- **A pipe to poll.** The first `g_wakeup_get_pollfd()` on a wakeup
  creates a pipe and publishes it with a compare-and-swap; a thread that
  loses the race closes its own. From then on `g_wakeup_signal()` also
  writes a byte to it, and `g_wakeup_acknowledge()` drains it before
  acknowledging the futex, so a signal landing in between leaves a
  spurious byte rather than a signalled wakeup that doesn't poll ready. A
  signal racing with the pipe's creation either sees the pipe or bumped
  the counter before the creator checks it, and the creator then writes
  the byte itself. So `g_cancellable_make_pollfd()` and
  `g_cancellable_get_fd()` work, and their callers (`gsocket.c`,
  `gasynchelper.c`) don't abort.
- **Emscripten's pipes.** WasmFS's `pipe2()` takes no flag but
  `O_CLOEXEC`, so `O_NONBLOCK` is set with `fcntl()`. Neither file system
  blocks on a pipe: an empty pipe reads as `EAGAIN` on the JavaScript file
  systems, even after every writer has closed (while `poll()` reports
  `POLLHUP`), and as 0 on WasmFS. The drain stops at either, and never
  waits for end of file.
- **Who gets the pipe.** `g_wakeup_wait()` and main contexts sleep on the
  futex, so a context has no wakeup fd among its poll fds, except one made
  with `G_MAIN_CONTEXT_FLAGS_OWNERLESS_POLLING`: that one is polled by
  someone outside it, who can only see a wakeup through an fd, so it adds
  the pipe to its poll fds. Other contexts never get a pipe. The loop
  above still probes a context's fds between waits on its wakeup, which a
  signal ends at once.
- **`g_poll()` with a timeout** waited on nothing: Emscripten's `poll()`
  ignores the timeout on the main thread and on WasmFS, and from a pthread
  on the JavaScript file systems it waits for the main thread to return to
  its event loop. On WebAssembly `g_poll()` probes the fds with a zero
  timeout and sleeps in 10 ms slices (`g_usleep()`, which serves proxied
  calls) until one is ready or the timeout passes. A cancellable's fd
  turning ready is noticed within a slice.
- **The pump hook**, for a host that sleeps outside GLib, is 0017's.

With the wakeup in place, the thread `g_get_worker_context()` starts
(for `GTask`, among others) and GDBus's shared thread sleep in their
loops instead of spinning. `checks.glib-smoke` measures it with Node's
`process.cpuUsage()`, since Emscripten's `clock()` counts wall time and
its `getrusage()` is a stub.

## 0014: platform backends

**Time zones.** 0014 gives `GTimeZone` IANA zones on WebAssembly from
JavaScript's `Intl` API rather than from zoneinfo files. 0008 left out
every TZif path, so only fixed offsets and POSIX rule strings worked, IANA
names such as `America/Recife` failed, and the default zone was always
`UTC0`. A page has no zoneinfo files, and the JavaScript engine already
carries the data (browsers and nixpkgs' Node have full ICU), so nothing is
bundled:

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
`/GTimeZone/parse-rfc8536`, which loads TZif files by path and which 0016
skips on WebAssembly.

**The memory monitor.** No memory monitor was registered on WebAssembly,
so `g_memory_monitor_dup_default()` passed `NULL` to `g_object_ref()`. A
new `GMemoryMonitorWasm` (`gio/gmemorymonitorwasm.c`), which never warns,
is registered at priority 0. Nothing in the browser reports memory
pressure.

**Content types.** `g_content_type_is_a()` in 0008's WebAssembly content
type backend only compared for equality; every type but an inode is now
also an `application/octet-stream`, as with the shared-mime-info backend.

**The user.** 0014 skips the user database lookup in `g_get_user_name()`,
`g_get_real_name()` and `g_get_home_dir()` on WebAssembly. Emscripten's
`getpwnam_r()`, `getpwuid_r()` and `getpwuid()` are stubs that report
`ENOENT`, so the lookup always failed and warned (a fatal warning in
tests); the result is the same fallback, "somebody" and "Unknown", without
the warning. `g_get_home_dir()` still takes `HOME`, which Emscripten's
default environment sets.

## 0015: characters `iconv()` replaces

0015 makes GLib notice a character `iconv()` replaces. musl's `iconv()`
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
  the others go through the main converter, so each character costs
  three `iconv()` calls: the second converter's reset, the check and the
  conversion. Whether a character has a representation doesn't depend
  on the target's shift state, so no further restart is needed and the
  conversion stays linear: 32,000 unrepresentable characters to ASCII
  take 2 ms on Node. If the second converter can't be opened, the
  conversion fails with that error rather than keep a replacement
  unreported. glibc only starts over for an irreversible conversion it
  counts.
- **Context-independent encoders.** The check assumes that whether a
  character has a representation doesn't depend on the characters around
  it, which holds for musl's encoders. glibc's context-dependent ones
  (BIG5-HKSCS, TSCII, CP1258's composition) don't fit it, but they report
  a character they lack with `EILSEQ` and count no replacement, so they
  never take that path.
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

## 0016: tests

0016 lets GLib's own tests configure and build with `-Dtests=true`, and
makes them pass where WebAssembly can do what they test. It changes only
test sources and test build files (`glib/tests`, `gobject/tests`,
`gio/tests`, `tests/lib`), so the library is built exactly as without it.

**Running the tools' tests.** `gobject-query.py`, `gio-tool.py` and
`gdbus-tool.py` run the `.js` tools: `tests/lib/testprogramrunner.py`
looks for `<tool>.js` and runs it with the Node that
`_G_TEST_PROGRAM_RUNNER_NODE` names, which the glib, gobject and gio test
meson files set on Emscripten from `find_program('node', native : true)`.
Where the Python tests expect `abort()` to end the program with
`SIGABRT`, they expect status 1 under Node, which is how Emscripten's
`abort()` ends it.

**Left out on Emscripten**, each worth revisiting if the reason goes away:

- The Unix-only blocks in `glib/tests` (`include`, `poll-fdset`, `unix`,
  `gutils-user-database`) and `gio/tests` (the large Unix test block,
  `gdbus-example-unix-fd-client`, the `dbus-launch` helper,
  `GIO_LAUNCH_DESKTOP`): most need Unix sources 0012 doesn't build;
  `unix` also tests the Unix signal sources, which stay out, and GIO's
  `unix-streams` reads pipes WasmFS never blocks on.
- `constructor`: its helpers are shared libraries, which Meson can't link
  for Emscripten.
- `tests/lib`'s `glibconfig.py`: only girepository's tests read it, and
  girepository isn't built (0001).
- `appmonitor`, `gsubprocess`, `unix-fd`: they need `GDesktopAppInfo`,
  process spawning and fd passing.
- testing's subprocess stdin test, which spawns a subprocess with a pipe
  on its stdin.
- thread's CPU affinity subtest: it calls `pthread_getaffinity_np()` and
  `pthread_setaffinity_np()` itself, which Emscripten declares but doesn't
  define. The library doesn't: 0008 already makes `g_get_num_processors()`
  return `emscripten_num_logical_cores()` on WebAssembly.

**Function types in tests.** Test code that registers callbacks with the
wrong signature is fixed, since each such call traps on WebAssembly.
Class, instance and interface init functions take their data argument
(`gobject/tests` and GIO's test converters, TLS backend and proxies), and
`param`'s custom `instance_init` the class data argument that 0009 adds
to `GParamSpecTypeInfo`; notify handlers in `properties-refcount*` take
their user data; and small wrappers replace library functions passed
through another callback type: `g_strdup` as `GCopyFunc`/`GDuplicateFunc`
(`array-test`, `qdata`), `g_free` as `GFunc` (`option-context`),
`g_usleep` as `GFunc` (`thread-pool-slow`), `g_main_loop_quit` as
`GSourceFunc` (`mainloop`, `resolver`), `g_cancellable_cancel` as
`GThreadFunc` and a one-argument callback passed to
`g_cancellable_connect()` (`cancellable`), and `g_object_unref` as
`GWeakNotify` (`signalgroup`). Two-argument compare functions get
three-argument wrappers (`list`, `slist`, `tree`, `glistmodel`), `node`'s
traversal callback a void one for `g_node_children_foreach()`,
`dataset`'s notify a `GDataForeachFunc`, `binding` and `bindinggroup`
their `GClosureNotify`s, and `hook` swaps its hooks' functions between
`g_hook_list_invoke()` and `g_hook_list_invoke_check()`, which call them
through different types. Handlers connected to `accumulator`'s and
`signals`' signals, and the class closures `override` creates with
`g_cclosure_new()`, take the user data their marshallers pass, and
`performance`'s signal with arguments gets a class handler and a
connected handler that take them. filenamecompleter connected
`g_main_loop_quit()` through `g_signal_connect_swapped()` to a signal with
two parameters.

**The wakeup.** `gwakeuptest` checks that a WebAssembly wakeup's poll fd
agrees with `g_wakeup_wait()`, and waits with `g_wakeup_wait()`, since its
threaded test passes tokens far too often for 10 ms slices.

**Skipped where the expectation can't hold**, each with its reason: musl
has no locale data (collate's lists that sort differently under `en_US`,
option-context's decimal comma, date's Polish month names, gdatetime's
`en_GB` formats, `de_DE` month names and eras); WasmFS has no sockets
(`socket()` fails with `ENOSYS`); Emscripten can't spawn or fork
processes, parse an IPv6 scope ID or list network interfaces, and nothing
can send it a signal; WasmFS keeps file times as a double count of
milliseconds and gives pipes no capacity; TZif files aren't read by path
(`/GTimeZone/parse-rfc8536`); `gio launch` needs desktop applications, and
WebAssembly content types know no MIME types.

**musl's output expected** where it is right but different: `strftime()`
pads years to four digits (`%C`, `%F`, `%G`, `%Y`, `%c`), has no `%k`, `%l`
or `%P`, and prints nothing for a bare `%E` or `%O`; `g_convert()`'s
illegal-sequence error comes after the input is consumed. mainloop
expects no wakeup fd in a context that polls with an owner, and
option-argv0 a program named after its `.js` script.

**Built because 0012 builds glib-unix and GIO's Unix streams**: pollable's
pipe, file, `/dev/null` and converter tests, mainloop's and closure's fd
sources, and the `gio-unix-2.0` pkg-config test.

**Test bugs fixed**: filenamecompleter expected completions in one file
system's directory order; gdbus-peer's credentials test assumed
credentials on every Unix; messages-low-memory's `malloc()` looked up the
real one with `dlsym(RTLD_NEXT)`, and calls `emscripten_builtin_malloc()`
on WebAssembly, where it is built without `HAVE_RTLD_NEXT`.

**A race on every platform**: asyncqueue's threads test pushed its items
as soon as it had created its ten consumers and expected each to get
some. Under load a pthread can start 200–560 ms after it is created, once
the queue has drained (about one run in four or five under the suite's
parallel load, 23 in 100 run alone at 32-way concurrency, failed
`sums_i > 0`), so the test waits until every consumer is running.

**Workarounds for the platform**: spawn-singlethread and test-printf open
their pipe with `pipe()` instead of `g_unix_open_pipe()` (written before
0012 built `glib-unix.c`; now unnecessary, see the plan's follow-ups), and
test-printf's reader waits for its writer to finish, since Emscripten's
pipe reads never block.

**Left to the toolchain's Emscripten fixes**: mainloop's `nfds`,
`unix-file-poll` and `unix-fd-priority`, closure's `fd` and pollable's
`/dev/null` test poll empty files and devices; fileutils' `chdir()` and
read-only-directory checks rely on directory search and write
permission, and its `stdio-wrappers` test on `chmod()` reaching the
host; pollable's pseudo-terminal test fails to open one cleanly
and skips as upstream does ("Unable to open PTY").

Tests and tools link with runtime assertions on, so threaded tests print
`received "…" command from terminated worker` as their pthread workers
shut down at exit. It is Emscripten's diagnostic, not a GLib failure.

## 0017: the wake hook

The runtime's Worker host sleeps in `ibusweb_wait()`, a futex wait on a
word of its own, between non-blocking iterations of the default context, so it neither
waits on the context's futex nor polls a wakeup fd. 0017 lets it hear the
wakeup anyway:

```c
typedef void (*GWasmWakeHook) (gpointer user_data);
void g_main_context_wasm_set_wake_hook (GMainContext  *context,
                                        GWasmWakeHook  hook,
                                        gpointer       user_data);
```

- **A hook, not a word.** GLib calls a C function rather than bumping a
  word it is handed, so which word the host waits on, and in which
  memory, stays the runtime's choice.
- **When it runs.** `g_wakeup_signal()` calls it last, after bumping and
  waking the futex and writing the pipe if there is one, on whichever
  thread signals. That is sometimes with the context locked (an attach, a
  ready time or fd change, `g_main_loop_quit()`), so the hook must not
  call into the context; it should only wake the host.
- **On the owner's thread too.** A ready time or fd change and
  `g_main_loop_quit()` signal whichever thread makes them, owner or not,
  so the hook also runs on the host's own thread in the middle of its own
  iteration. It must be safe to run re-entrantly there, and the host must
  tolerate wakes that find no new work.
- **Publication.** The hook and its data are one immutable record,
  published with a compare-and-exchange of the wakeup's record pointer
  from `NULL`; a signal loads the pointer once and calls
  `record->hook (record->user_data)`, so it never pairs one setter's hook
  with another's data. A hook can be set once per context and is never
  replaced or removed: a later setter loses the exchange, frees its
  record and reports a `g_critical()`, which `G_DISABLE_CHECKS` doesn't
  remove. The record is freed with the wakeup. A signal racing with the
  setter may or may not call it.
- **Ownership.** GLib wakes a context for a source attached from another
  thread only while some other thread owns it (`g_source_attach_unlocked()`
  checks `context->owner`), so the host's thread must acquire the default
  context for as long as it relies on the hook. Acquiring is recursive,
  so its non-blocking iterations still work; a context acquired and
  released around each iteration is unowned between pumps, and an
  attach then calls no hook. `checks.glib-smoke` checks both, and that a second
  hook is refused while the first keeps firing (`wakehook 1 0 1`).
- **Where it is declared.** `gmain.h`, under `#ifdef G_PLATFORM_WASM`,
  beside the context's other low-level functions and in the same way
  `gmain.h` declares its Unix-only API, so it is installed with GLib and
  reached through `glib.h`. The setter on the `GWakeup` it calls is
  private (`gwakeup.h`).

Waiting, acknowledging and every other platform are unchanged.

## 0018: settings listener function types

The settings backend queued every listener as a five-argument function, although
`GSettingsListenerVTable` also has three- and four-argument callbacks. A custom
backend calling `g_settings_backend_changed()` therefore trapped on WebAssembly.
Each queued closure now retains a typed copy of the listener table and calls the
selected member with its declared arguments. The public backend API is unchanged.

`checks.glib-settings-listeners` exercises all five notification paths through
GLib's memory backend, both directly and queued from another thread. Its sources
and schema live in `modules/glib/checks/settings-listeners`. The libibus-web
settings tests separately cover its backend's notifications and delayed writes
through `g_settings_apply()`.
