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
| 0001 Do not build tools | Wolthuizen | `0e5465ae90c6` |
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

Applying nixpkgs' `split-dev-programs.patch` first conflicts with 0001: that
patch adds `install_dir : get_option('devbindir')` to the `gresource`,
`gio-querymodules`, `glib-compile-schemas`, `glib-compile-resources` and
`gobject-query` executables that 0001 deletes.

- `gio/meson.build`, `gobject/meson.build`: resolved by deleting the same
  blocks as the original commit, now including nixpkgs' `install_dir` lines.
  0001 therefore removes three more lines than upstream's version; no hunk of
  its intent was dropped.
- `glib/meson.build`: the `gtester` hunk (`else` → `elif host_system !=
  'emscripten'`) applies unchanged; nixpkgs' `install_dir` line sits inside
  the block it skips.

All later patches applied to the nixpkgs-patched tree without conflicts, and
the exported series applies there with `--fuzz=0`.

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
on WebAssembly and abort.** Their callers include `gsocket.c`,
`gpollableutils.c`, `gasynchelper.c`, `gthreadedresolver.c`,
`gunixinputstream.c` and `gunixoutputstream.c`.

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

Not covered: callbacks that *users* pass with fewer parameters than the
API documents, `(GFunc)` casts in the unbuilt `TEST_COMPLETION` block of
`deprecated/gcompletion.c`, and Windows- and macOS-only files.
