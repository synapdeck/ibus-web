# Upstream reports

Draft reports for the projects ibus-web depends on: Emscripten, V8 and
Node. Each Emscripten draft backs a patch the toolchain carries in
`modules/emscripten/patches/` (its README says which), or explains why none
is carried. A draft keeps its title and body as they would be posted, the
evidence behind them under "Notes for the user", and a status block at the
top: what has been posted where, and the last check against Emscripten's
`main`. Once an issue is filed, its number goes into the matching patch's
header.

Last checked 2026-10-02, against Emscripten `main` 5977ecc (6.0.12-git;
6.0.11 is a0014542110d, marked released that day). The suite-format tests
ran with Emscripten's runner on `main`, using emsdk's toolchain for it
(`test/emsdk_version.txt` dbaebb43: clang 24.0.0git d3e9891b, Binaryen 133)
and Node 24.21.0. The toolchain's own LLVM 22.1.8 can't build `main`'s libc,
or 6.0.10's: `__builtin_wasm_memory_fill` (#27631) is unknown to clang 22
and 23.1.0.

## To post, in order

1. `emscripten-wasmfs-proxy-worker-heartbeat.md`: a **PR** for #27858,
   e.g. "[WasmFS] Stop a ProxyWorker's heartbeat before its thread is
   joined", with `other.test_wasmfs_proxy_worker_exit`. No dependencies.
2. `emscripten-pthread-cleanup-blocked-main.md`: a **PR** for #27840,
   e.g. "[pthread] Reclaim unjoined threads while the main thread is
   blocked" (the draft's two commits and three tests). Link #27841/#27846,
   which it makes easier to hit.
3. `node-web-locks-worker-threads.md`: a **Node issue**
   (github.com/nodejs/node), "Web Locks: an exclusive lock is sometimes
   granted to two worker_threads at once". No dependencies.
4. `emscripten-wasmfs-symlink-errors.md`: an **Emscripten issue**,
   "WasmFS: symlink() reports EPERM for any backend failure (e.g. EACCES
   from the Node backend)", citing #27832, whose fix it builds on.
5. `emscripten-wasmfs-lookup-errors.md`: an **Emscripten issue**, "WasmFS:
   a backend can't fail a lookup with anything but ENOENT (e.g. EACCES from
   the Node backend)", citing #27832 and item 4; its PR goes after theirs.
6. Fixes for issues already filed, as **PRs** once a maintainer has
   answered (each is a patch here, rebased onto `main`):
   - 0010 for #27825; then 0012 for #27832 (it builds on 0010); then 0017
     and 0019 for items 4 and 5 (they build on 0012).
   - 0013 for #27823, after #27844 (0009), 0010 and 0012.
   - 0003 for #27828, 0006 for #27829, 0007 for #18033. No dependencies.
7. `wasmfs-idb-backend.md`: a **comment on #15942** ("WasmFS: IndexedDB
   backend"), not a new issue, then a PR. After its five dependencies:
   #27832, items 4 and 5, 0013's hooks (#27823) and item 1. Rerun its
   `strace` counts against current browsers first, and settle the
   relicensing.

## Not to post

| Draft                                         | Why                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `emscripten-noderawfs-fstat-stdio.md`         | #27628, fixed by #27632, in 6.0.10                                          |
| `emscripten-wasmfs-pipe-fifo-mode.md`         | filed as #27827, fixed by #27842, in 6.0.11                                 |
| `emscripten-imported-memory-maximum.md`       | filed as #27859, fixed by #27862 on `main` (after 6.0.11)                   |
| `emscripten-dlsym-rtld-next.md`               | filed as #27830; PR #27838 approved, not merged                             |
| `emscripten-pthread-finished-mark-reused.md`  | filed as #27841; PR #27846 open                                             |
| `emscripten-wasmfs-node-fsync.md`             | filed as #27822; PR #27844 open                                             |
| `emscripten-wasmfs-node-rename.md`            | filed as #27824; PR #27849 open                                             |
| `emscripten-wasmfs-open-noctty.md`            | filed as #27826; PR #27843 open                                             |
| `emscripten-wasmfs-node-chmod.md`             | filed as #27823; its `futimens()` part (0008) is PR #27845, approved        |
| `emscripten-wasmfs-node-create-eio.md`        | filed as #27832 (PR: item 6)                                                |
| `emscripten-wasmfs-node-open-close-errors.md` | filed as #27825 (PR: item 6); #27847 is a related report with no patch here |
| `emscripten-wasmfs-poll-regular-file.md`      | filed as #27828 (PR: item 6)                                                |
| `emscripten-wasmfs-search-permission.md`      | filed as #27829 (PR: item 6)                                                |
| `emscripten-wasmfs-create-permission.md`      | commented on #18033 (PR: item 6)                                            |
| `emscripten-wasmfs-getcwd-mount.md`           | commented on #18112 and #23756; #23756 is someone else's open fix           |
| `emscripten-pipe-capacity.md`                 | filed as #27831; not carried as a patch                                     |
| `emscripten-pipe-read-eof.md`                 | commented on #26708; not carried as a patch                                 |
| `v8-liftoff-atomics-grown-shared-memory.md`   | V8's own issues 529880019 and 533026477, fixed on V8 `main` (Chrome 157)    |
