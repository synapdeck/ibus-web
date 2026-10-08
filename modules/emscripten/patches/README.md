# Emscripten patches

Fixes to nixpkgs' Emscripten (6.0.9) that the toolchain carries until a
release has them. Each one is tracked upstream: by an issue or pull request
where one exists, and otherwise by a draft report under `docs/upstream/`,
whose issue number goes into the patch header once it is filed.

They are a stack: each applies exactly (no offset, no fuzz), with
`patch -p1` or `git apply`, on top of nixpkgs' own Emscripten patches and
every lower-numbered one. Several touch the same files, and the later Node
backend ones build on earlier ones: 0012 and 0013 extend 0010's handling
of a newly created file, and 0012's `doOpen()` change sits next to 0007's.
To drop one, regenerate the ones above it.

nixpkgs installs the patched source tree whole under `share/emscripten`.
The system libraries the frozen cache compiles (`system/lib/wasmfs`, ...)
and the JavaScript libraries every link reads (`src/lib`) both come from
there, so changing a patch rebuilds the cache and everything in `pkgsWasm`.
`checks.emscripten-fixes` checks the behaviour each fix restores.

| Patch                                | Fixes                                                                                                                                                                                                                                                                                                                                                                                                                                      | Upstream                                                                                                                                                                                                                                      | Drop when                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0001 `noderawfs-fstat-stdio`         | `-sNODERAWFS`: `fstat()` on fds 0–2 throws a `TypeError`                                                                                                                                                                                                                                                                                                                                                                                   | [#27628](https://github.com/emscripten-core/emscripten/issues/27628), fixed by [#27632](https://github.com/emscripten-core/emscripten/pull/27632) (backported without its test); draft `emscripten-noderawfs-fstat-stdio.md`                  | Emscripten 6.0.10                                   |
| 0002 `wasmfs-getcwd-mount`           | `getcwd()` drops the name of a mount point inside a memory directory                                                                                                                                                                                                                                                                                                                                                                       | [#18112](https://github.com/emscripten-core/emscripten/issues/18112), fix proposed in [#23756](https://github.com/emscripten-core/emscripten/pull/23756); draft `emscripten-wasmfs-getcwd-mount.md`                                           | a release contains #23756 or another fix for #18112 |
| 0003 `wasmfs-poll-regular-file`      | `poll()` takes empty regular files, `/dev/null` and `/dev/random` for unreadable; pipes are readable only while they hold data                                                                                                                                                                                                                                                                                                             | [#27828](https://github.com/emscripten-core/emscripten/issues/27828); draft `emscripten-wasmfs-poll-regular-file.md`                                                                                                                          | a release contains the fix                          |
| 0004 `wasmfs-pipe-fifo-mode`         | pipes report `S_IFREG` instead of `S_IFIFO`                                                                                                                                                                                                                                                                                                                                                                                                | [#27827](https://github.com/emscripten-core/emscripten/issues/27827), fixed by [#27842](https://github.com/emscripten-core/emscripten/pull/27842) (in 6.0.11); draft `emscripten-wasmfs-pipe-fifo-mode.md`                                    | Emscripten 6.0.11                                   |
| 0005 `wasmfs-open-noctty`            | `open()` with `O_NOCTTY` (musl's `openpty()`) trips `doOpen()`'s flag assertion                                                                                                                                                                                                                                                                                                                                                            | [#27826](https://github.com/emscripten-core/emscripten/issues/27826), fix proposed in [#27843](https://github.com/emscripten-core/emscripten/pull/27843); draft `emscripten-wasmfs-open-noctty.md`                                            | a release contains the fix                          |
| 0006 `wasmfs-search-permission`      | path lookup and `chdir()` ignore directory search permission                                                                                                                                                                                                                                                                                                                                                                               | [#27829](https://github.com/emscripten-core/emscripten/issues/27829); draft `emscripten-wasmfs-search-permission.md`                                                                                                                          | a release contains the fix                          |
| 0007 `wasmfs-create-permission`      | `open(O_CREAT)` ignores the parent directory's write permission                                                                                                                                                                                                                                                                                                                                                                            | [#18033](https://github.com/emscripten-core/emscripten/issues/18033); draft `emscripten-wasmfs-create-permission.md`                                                                                                                          | a release contains a fix for #18033                 |
| 0008 `wasmfs-futimens-null-path`     | `futimens()` hands `utimensat()` a null path, which libc++'s assertions reject                                                                                                                                                                                                                                                                                                                                                             | fix proposed in [#27845](https://github.com/emscripten-core/emscripten/pull/27845) (the end of #27823); draft `emscripten-wasmfs-node-chmod.md` (its closing `futimens()` section)                                                            | a release contains the fix                          |
| 0009 `wasmfs-node-fsync`             | Node backend: `fsync()` hits `WASMFS_UNREACHABLE` (also adds the import's `libsigs.js` signature, which `other.test_gen_sig_info` and wasm64 need)                                                                                                                                                                                                                                                                                         | [#27822](https://github.com/emscripten-core/emscripten/issues/27822), fix proposed in [#27844](https://github.com/emscripten-core/emscripten/pull/27844); draft `emscripten-wasmfs-node-fsync.md`                                             | a release contains the fix                          |
| 0010 `wasmfs-node-open-close-errors` | Node backend: a host error from `open()` is taken for a file descriptor, and one from `close()` trips an assertion; a new file is opened through the descriptor that created it, since its own mode may refuse a reopen (and a create that opens nothing, `mknod()`, lets it go)                                                                                                                                                           | [#27825](https://github.com/emscripten-core/emscripten/issues/27825); draft `emscripten-wasmfs-node-open-close-errors.md`                                                                                                                     | a release contains the fix                          |
| 0011 `wasmfs-node-rename`            | Node backend: a renamed file or directory, and everything already looked up below a directory, keeps its old host path; renaming a mount point of another backend is `EBUSY`                                                                                                                                                                                                                                                               | [#27824](https://github.com/emscripten-core/emscripten/issues/27824), fix proposed in [#27849](https://github.com/emscripten-core/emscripten/pull/27849); draft `emscripten-wasmfs-node-rename.md`                                            | a release contains the fix, for directories too     |
| 0012 `wasmfs-node-create-eio`        | any backend failure to create a file or directory is reported as `EIO`; the Node backend now reports the host's error                                                                                                                                                                                                                                                                                                                      | [#27832](https://github.com/emscripten-core/emscripten/issues/27832); draft `emscripten-wasmfs-node-create-eio.md`                                                                                                                            | a release contains the fix                          |
| 0013 `wasmfs-node-chmod`             | Node backend: `chmod()`, `fchmod()` and `utimensat()` change only WasmFS's record, never the host's                                                                                                                                                                                                                                                                                                                                        | [#27823](https://github.com/emscripten-core/emscripten/issues/27823); draft `emscripten-wasmfs-node-chmod.md`                                                                                                                                 | a release contains the fix                          |
| 0014 `pthread-cleanup-blocked-main`  | pthreads: a thread that ends without a join on the main runtime thread (detached, or joined by another thread) keeps its stack and its Worker until the main thread's event loop runs, so a main thread that stays blocked never gets them back; it now reclaims them whenever it processes its queued calls, `emscripten_futex_wait()` included; `dlopen()`'s sync holds those cleanups off until it has been through its list of threads | [#27840](https://github.com/emscripten-core/emscripten/issues/27840) (and [#16763](https://github.com/emscripten-core/emscripten/issues/16763), closed by its reporter, workarounds only); draft `emscripten-pthread-cleanup-blocked-main.md` | a release contains the fix                          |
| 0015 `pthread-finished-mark-reused`  | pthreads with dynamic linking: a joined thread's late "finished" message marks a new, running thread that reuses its `pthread_t`, so `dlopen()`'s sync skips that thread for good and its calls into modules loaded later trap                                                                                                                                                                                                             | [#27841](https://github.com/emscripten-core/emscripten/issues/27841), fix proposed in [#27846](https://github.com/emscripten-core/emscripten/pull/27846); draft `emscripten-pthread-finished-mark-reused.md`                                  | a release contains the fix                          |
| 0016 `imported-memory-maximum`       | without memory growth, a `MAXIMUM_MEMORY` set for an imported memory is dropped with a warning and the import's maximum tied to `INITIAL_MEMORY`, so the module takes a memory of exactly that size; it now takes any size up to `MAXIMUM_MEMORY`, still without growing it                                                                                                                                                                | [#27859](https://github.com/emscripten-core/emscripten/issues/27859), fixed by [#27862](https://github.com/emscripten-core/emscripten/pull/27862) (after 6.0.11); draft `emscripten-imported-memory-maximum.md`                               | a release contains #27862 (6.0.12)                  |
| 0017 `wasmfs-symlink-errors`         | any backend failure to make a symlink is reported as `EPERM`; the Node backend now reports the host's error                                                                                                                                                                                                                                                                                                                                | not filed; draft `emscripten-wasmfs-symlink-errors.md`                                                                                                                                                                                        | a release contains the fix                          |
| 0018 `wasmfs-proxy-worker-heartbeat` | WasmFS backends on a thread of their own (OPFS, fetch, or any built on `ProxyWorker`): the thread's 50 ms heartbeat timer outlives it, so once the backend is destroyed, at exit or before, the Worker its thread ran on runs the freed queue from the pool, failing an assertion when idle and touching freed memory otherwise                                                                                                            | [#27858](https://github.com/emscripten-core/emscripten/issues/27858); draft `emscripten-wasmfs-proxy-worker-heartbeat.md`                                                                                                                     | a release contains the fix                          |
| 0019 `wasmfs-lookup-errors`          | any backend failure to look up a file is reported as `ENOENT`, so `mkdir()`, `symlink()` and `open(O_CREAT)` go on to create it; the Node backend now reports the host's error, and the OPFS backend its `EIO` or `ENOTDIR`                                                                                                                                                                                                                | not filed; draft `emscripten-wasmfs-lookup-errors.md`                                                                                                                                                                                         | a release contains the fix                          |

As of 6.0.11 (marked released 2026-10-02) #27632 (0001, since 6.0.10) and
#27842 (0004) are in a release, and #27862 (0016) is on `main` for the next
one. Checked against `main` 5977ecc on 2026-10-02: 0001 and 0004
reverse-apply, the rest apply in order without 0001, 0004 and 0016 with
offsets only, and the suite-format tests of 0014, 0015, 0018 and 0019 fail
on `main` and pass with that stack (each draft's status, and
`docs/upstream/README.md`).

0014 changes `src/lib/libpthread.js` and `system/lib/pthread`, so every
threaded link and the libc the cache builds carry it. A thread that ends
unjoined adds itself to a lock-free list and wakes the main thread, which
drains the list in `emscripten_main_thread_process_queued_calls()`; the
message to its event loop is still sent, for a main thread that is idle
there. Since a wait on the main thread can now free a thread,
`dlopen()`'s sync, which lists the threads and then proxies to each in
turn, holds those cleanups off until it is through the list, then runs
them; a proxy can wait between checking the list and touching a thread. A
sync that ends in an exception releases the hold without running them.
`checks.emscripten-fixes` runs rounds of such threads under a blocked main
thread and checks that neither memory nor Workers grow, and has a thread
end while the sync is held up on another thread and while it waits on the
dlopen queue's mutex; the thread must not be freed until `dlopen()` is
done. On Emscripten's own test runner, a 198-test
pthread selection under Node gives the same results with and without it.
Both drafts carry tests in the suite's format, also as `*.tests.patch`
beside them.

0015 is independent of 0014 (it applies to 6.0.9 alone) but sits on top of
it, since both change `libpthread.js`, `library_pthread.c` and
`threading_internal.h`. 0014 makes its race likelier: joins on other
threads now clean up as early as joins on the main thread always did.
`checks.emscripten-fixes` reproduces the race: it joins a thread on the main
thread, creates a new one at the same address before the event loop runs,
then `dlopen`s a side module the new thread calls into.

0016 changes only emcc's link (`tools/link.py`, `tools/building.py`) and
the setting's documentation (`src/settings.js` and the settings reference
generated from it). With `IMPORTED_MEMORY` and a `MAXIMUM_MEMORY` set on the
command line, a link without growth passes `--max-memory` to `wasm-ld`
instead of `--no-growable-memory`; everything else is as without growth:
`emscripten_resize_heap()` fails or aborts, `getHeapMax()` is the memory's
size, a memory Emscripten makes itself has its maximum at its initial size,
and `CAN_ADDRESS_2GB` follows the maximum as it does with growth.
`checks.emscripten-fixes` links with `-Werror=unused-command-line-argument`,
which the unpatched warning fails, gives the module memories of the
initial size, between it and the maximum, and the maximum, and checks the
heap spans each on every thread and an allocation past it fails without
growing it; a memory above the maximum is a `LinkError`. Its draft carries
`other.test_imported_memory_maximum_no_growth` in the suite's format (also
as `*.tests.patch` beside it), which fails on stock 6.0.9 and passes with
the stack; the 202-test pthread selection gives the same results with
0016 as without it.

Tested beyond `checks.emscripten-fixes`, with the whole stack on Emscripten's
own test runner: `other.test_gen_sig_info`, `other.test_wasmfs_getdents_node`
and `wasmfs.test_fcntl_open_{nodefs,rawfs}` pass, and a 96-test WasmFS
selection (stat, chmod, utime, access, links, `fcntl_open`, readdir,
`unistd_*`, `other.test_wasmfs_*`, ...) gives the same results as unpatched
6.0.9. `test_stat_chmod`, which skips on WasmFS with the Node backend,
still fails there when un-skipped: it opens a write-only (`0200`) file with
`O_WRONLY`, which the Node backend opens as `"r+"`.

0011 goes further than its draft's first, files-only hunk: a renamed
directory's loaded descendants are rewritten too, with the moved file and
every loaded file below it locked (each before its children) across the
host's rename. An operation already holding one of those files finishes on
the old path first; one that starts afterwards sees the new one. It adds
`Directory::getLoadedChildren()` to `file.h` to reach the dcache, which is
private to `Directory`.

0012 and 0013 are carried together: with 0013 alone, making a directory
with its parents was seen to fail with `EIO`. 0013 changes WasmFS's record
of a mode or time only once the host has accepted the change; an omitted
time (`UTIME_OMIT`) is read back from the host and set again, since Node
can't leave one alone. Symlinks themselves aren't covered.

0017 gives `insertSymlink()` the `MaybeFile` return 0012 gave the other
inserts, so it sits on 0012. A backend that returns plain null still gets
`EPERM`, which is what `symlink()` says for a file system without symlinks,
and the OPFS backend, which has none, now says so itself.
`checks.emscripten-fixes` makes a symlink in a directory the host won't
let it write and expects `EACCES`.

0018 changes `system/lib/wasmfs/thread_utils.h`, which backends include,
and `src/lib/libwasmfs.js` (with the new import's signature in
`libsigs.js`). A Worker hosts one thread at a time, so the heartbeat's
timer is kept in one variable per Worker. `~ProxyWorker()` clears it with
a synchronous call proxied to the thread, the only one that can reach its
Worker's timers, before it cancels and joins the thread, so no tick can
follow the queue being freed. The thread runs its queue only from its
event loop, which it enters after starting the heartbeat, so the stop
can't come before the start; it does wait behind whatever the thread is
running, so the destructor lets that work finish before it cancels the
thread. While the program runs, that destructor is the only way a
ProxyWorker's thread ends; at exit the runtime terminates the Workers.
`checks.emscripten-fixes` destroys a `ProxyWorker` and leaves
its Worker idle, then busy with other threads, for several heartbeats
each; unpatched, the first tick on the idle Worker fails
`emscripten_proxy_execute_queue()`'s `pthread_self()` assertion, every
time.

0019 gives `Directory::getChild()` and its handle the `MaybeFile` return
0012 gave the inserts, so it sits on 0012 and 0017. Null with no error code
still means there is no such file, so a backend that returns plain null
behaves as before. Path lookup, `unlinkat()`, the unmount syscall and
`rename()` pass a backend's error on; `open()`, `mkdir()`, `symlink()` and
`rename()`'s target fail with it instead of taking the file for missing.
`FS.writeFile` fails instead of creating the file, but without the code:
`_wasmfs_write_file` returns 0 for any failure. The Node backend's
`_wasmfs_node_get_mode` now returns the host's errno, or `EIO` for a host
code with none (`src/lib/libwasmfs_node.js`); its signature is unchanged.
The preload loop in `wasmfs.cpp` still only asks whether a child exists.
It runs at start-up, before anything is mounted, so it only looks in the
root directory's backend, the memory backend unless a program supplies its
own root, whose lookups can't fail. The IndexedDB backend
relies on it so that a lookup in a closed database is `EIO`, never
`ENOENT`. `checks.emscripten-fixes` looks up a file in a directory the
host won't let it search, with `stat()` and `open()`, and expects
`EACCES`; its draft carries `other.test_wasmfs_node_lookup_errors` in the
suite's format (also as `*.tests.patch` beside it), which fails on stock
6.0.9 and passes with the stack.

Not carried, by decision: pipe capacity, and end of file on a
JavaScript-file-system pipe whose writers have closed. Their drafts stay in
`docs/upstream/`.
