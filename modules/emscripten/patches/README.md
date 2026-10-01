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

| Patch                                | Fixes                                                                                                                                                                                                                                                                                                                                                                                                                           | Upstream                                                                                                                                                                                                                     | Drop when                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0001 `noderawfs-fstat-stdio`         | `-sNODERAWFS`: `fstat()` on fds 0–2 throws a `TypeError`                                                                                                                                                                                                                                                                                                                                                                        | [#27628](https://github.com/emscripten-core/emscripten/issues/27628), fixed by [#27632](https://github.com/emscripten-core/emscripten/pull/27632) (backported without its test); draft `emscripten-noderawfs-fstat-stdio.md` | Emscripten 6.0.10                                   |
| 0002 `wasmfs-getcwd-mount`           | `getcwd()` drops the name of a mount point inside a memory directory                                                                                                                                                                                                                                                                                                                                                            | [#18112](https://github.com/emscripten-core/emscripten/issues/18112), fix proposed in [#23756](https://github.com/emscripten-core/emscripten/pull/23756); draft `emscripten-wasmfs-getcwd-mount.md`                          | a release contains #23756 or another fix for #18112 |
| 0003 `wasmfs-poll-regular-file`      | `poll()` takes empty regular files, `/dev/null` and `/dev/random` for unreadable; pipes are readable only while they hold data                                                                                                                                                                                                                                                                                                  | not filed; draft `emscripten-wasmfs-poll-regular-file.md`                                                                                                                                                                    | a release contains the fix                          |
| 0004 `wasmfs-pipe-fifo-mode`         | pipes report `S_IFREG` instead of `S_IFIFO`                                                                                                                                                                                                                                                                                                                                                                                     | not filed; draft `emscripten-wasmfs-pipe-fifo-mode.md`                                                                                                                                                                       | a release contains the fix                          |
| 0005 `wasmfs-open-noctty`            | `open()` with `O_NOCTTY` (musl's `openpty()`) trips `doOpen()`'s flag assertion                                                                                                                                                                                                                                                                                                                                                 | not filed; draft `emscripten-wasmfs-open-noctty.md`                                                                                                                                                                          | a release contains the fix                          |
| 0006 `wasmfs-search-permission`      | path lookup and `chdir()` ignore directory search permission                                                                                                                                                                                                                                                                                                                                                                    | not filed; draft `emscripten-wasmfs-search-permission.md`                                                                                                                                                                    | a release contains the fix                          |
| 0007 `wasmfs-create-permission`      | `open(O_CREAT)` ignores the parent directory's write permission                                                                                                                                                                                                                                                                                                                                                                 | [#18033](https://github.com/emscripten-core/emscripten/issues/18033); draft `emscripten-wasmfs-create-permission.md`                                                                                                         | a release contains a fix for #18033                 |
| 0008 `wasmfs-futimens-null-path`     | `futimens()` hands `utimensat()` a null path, which libc++'s assertions reject                                                                                                                                                                                                                                                                                                                                                  | not filed; a separate fix in draft `emscripten-wasmfs-node-chmod.md`                                                                                                                                                         | a release contains the fix                          |
| 0009 `wasmfs-node-fsync`             | Node backend: `fsync()` hits `WASMFS_UNREACHABLE` (also adds the import's `libsigs.js` signature, which `other.test_gen_sig_info` and wasm64 need)                                                                                                                                                                                                                                                                              | not filed; draft `emscripten-wasmfs-node-fsync.md`                                                                                                                                                                           | a release contains the fix                          |
| 0010 `wasmfs-node-open-close-errors` | Node backend: a host error from `open()` is taken for a file descriptor, and one from `close()` trips an assertion; a new file is opened through the descriptor that created it, since its own mode may refuse a reopen (and a create that opens nothing, `mknod()`, lets it go)                                                                                                                                                | not filed; draft `emscripten-wasmfs-node-open-close-errors.md`                                                                                                                                                               | a release contains the fix                          |
| 0011 `wasmfs-node-rename`            | Node backend: a renamed file or directory, and everything already looked up below a directory, keeps its old host path; renaming a mount point of another backend is `EBUSY`                                                                                                                                                                                                                                                    | not filed; draft `emscripten-wasmfs-node-rename.md`                                                                                                                                                                          | a release contains the fix, for directories too     |
| 0012 `wasmfs-node-create-eio`        | any backend failure to create a file or directory is reported as `EIO`; the Node backend now reports the host's error                                                                                                                                                                                                                                                                                                           | not filed; draft `emscripten-wasmfs-node-create-eio.md`                                                                                                                                                                      | a release contains the fix                          |
| 0013 `wasmfs-node-chmod`             | Node backend: `chmod()`, `fchmod()` and `utimensat()` change only WasmFS's record, never the host's                                                                                                                                                                                                                                                                                                                             | not filed; draft `emscripten-wasmfs-node-chmod.md`                                                                                                                                                                           | a release contains the fix                          |
| 0014 `pthread-cleanup-blocked-main`  | pthreads: a thread that ends without a join on the main runtime thread (detached, or joined by another thread) keeps its stack and its Worker until the main thread's event loop runs, so a main thread that stays blocked never gets them back; it now reclaims them whenever it processes its queued calls, `emscripten_futex_wait()` included; `dlopen()`'s sync skips a thread cleaned up while it waited on an earlier one | [#16763](https://github.com/emscripten-core/emscripten/issues/16763) (closed by its reporter, workarounds only); draft `emscripten-pthread-cleanup-blocked-main.md`                                                          | a release contains the fix                          |
| 0015 `pthread-finished-mark-reused`  | pthreads with dynamic linking: a joined thread's late "finished" message marks a new, running thread that reuses its `pthread_t`, so `dlopen()`'s sync skips that thread for good and its calls into modules loaded later trap                                                                                                                                                                                                  | not filed; draft `emscripten-pthread-finished-mark-reused.md`                                                                                                                                                                | a release contains the fix                          |

As of 6.0.10 (2026-09-18) only #27632 is in a release; the drafts record
that the code the others change is unchanged there and on `main`.

0014 changes `src/lib/libpthread.js` and `system/lib/pthread`, so every
threaded link and the libc the cache builds carry it. A thread that ends
unjoined adds itself to a lock-free list and wakes the main thread, which
drains the list in `emscripten_main_thread_process_queued_calls()`; the
message to its event loop is still sent, for a main thread that is idle
there. Since a wait on the main thread can now free a thread,
`dlopen()`'s sync, which lists the threads and then waits on each in turn,
skips any that are gone by their turn. `checks.emscripten-fixes` runs
rounds of such threads under a blocked main thread and checks that neither
memory nor Workers grow, and has a thread freed and its block reused while
the sync waits on another. On Emscripten's own test runner, a 198-test
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

Not carried, by decision: pipe capacity, and end of file on a
JavaScript-file-system pipe whose writers have closed. Their drafts stay in
`docs/upstream/`.
