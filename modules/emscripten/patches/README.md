# Emscripten patches

Fixes to nixpkgs' Emscripten (6.0.9) that the toolchain carries until a
release has them. Each one is tracked upstream: by an issue or pull request
where one exists, and otherwise by a draft report under `docs/upstream/`,
whose issue number goes into the patch header once it is filed. They apply
with `patch -p1` after nixpkgs' own Emscripten patches, each on its own as
well as all together, so any one can be dropped.

nixpkgs installs the patched source tree whole under `share/emscripten`.
The system libraries the frozen cache compiles (`system/lib/wasmfs`, ...)
and the JavaScript libraries every link reads (`src/lib`) both come from
there, so changing a patch rebuilds the cache and everything in `pkgsWasm`.
`checks.emscripten-fixes` checks the behaviour each fix restores.

| Patch | Fixes | Upstream | Drop when |
|---|---|---|---|
| `wasmfs-getcwd-mount.patch` | `getcwd()` drops the name of a mount point inside a memory directory | [#18112](https://github.com/emscripten-core/emscripten/issues/18112), fix proposed in [#23756](https://github.com/emscripten-core/emscripten/pull/23756); draft `emscripten-wasmfs-getcwd-mount.md` | a release contains #23756 or another fix for #18112 |
| `wasmfs-poll-regular-file.patch` | `poll()` takes empty regular files, `/dev/null` and `/dev/random` for unreadable; pipes are readable only while they hold data | not filed; draft `emscripten-wasmfs-poll-regular-file.md` | a release contains the fix |
| `wasmfs-search-permission.patch` | path lookup and `chdir()` ignore directory search permission | not filed; draft `emscripten-wasmfs-search-permission.md` | a release contains the fix |
| `wasmfs-create-permission.patch` | `open(O_CREAT)` ignores the parent directory's write permission | [#18033](https://github.com/emscripten-core/emscripten/issues/18033); draft `emscripten-wasmfs-create-permission.md` | a release contains a fix for #18033 |
| `wasmfs-open-noctty.patch` | `open()` with `O_NOCTTY` (musl's `openpty()`) trips `doOpen()`'s flag assertion | not filed; draft `emscripten-wasmfs-open-noctty.md` | a release contains the fix |
| `wasmfs-pipe-fifo-mode.patch` | pipes report `S_IFREG` instead of `S_IFIFO` | not filed; draft `emscripten-wasmfs-pipe-fifo-mode.md` | a release contains the fix |
| `wasmfs-node-fsync.patch` | Node backend: `fsync()` hits `WASMFS_UNREACHABLE` | not filed; draft `emscripten-wasmfs-node-fsync.md` | a release contains the fix |
| `wasmfs-node-rename.patch` | Node backend: a renamed file or directory, and everything already looked up below a directory, keeps its old host path | not filed; draft `emscripten-wasmfs-node-rename.md` | a release contains the fix, for directories too |
| `wasmfs-node-open-close-errors.patch` | Node backend: a host error from `open()` is taken for a file descriptor, and one from `close()` trips an assertion; a new file is opened through the descriptor that created it, since its own mode may refuse a reopen | not filed; draft `emscripten-wasmfs-node-open-close-errors.md` | a release contains the fix |
| `noderawfs-fstat-stdio.patch` | `-sNODERAWFS`: `fstat()` on fds 0–2 throws a `TypeError` | [#27628](https://github.com/emscripten-core/emscripten/issues/27628), fixed by [#27632](https://github.com/emscripten-core/emscripten/pull/27632) (backported without its test); draft `emscripten-noderawfs-fstat-stdio.md` | Emscripten 6.0.10 |

As of 6.0.10 (2026-09-18) only #27632 is in a release; the drafts record
that the code the others change is unchanged there and on `main`.

`wasmfs-node-fsync.patch` adds the new import's signature to `libsigs.js`,
which `other.test_gen_sig_info` and wasm64 builds need. Emscripten's own
`other.test_gen_sig_info`, `other.test_wasmfs_getdents_node` and
`wasmfs.test_fcntl_open_{nodefs,rawfs}` pass with all the patches, and a
96-test WasmFS selection gives the same results as unpatched 6.0.9.

`wasmfs-node-rename.patch` goes further than its draft's first, files-only
hunk: a renamed directory's loaded descendants are rewritten too, with the
moved file and every loaded file below it locked (each before its children)
across the host's rename. An operation already holding one of those files
finishes on the old path first; one that starts afterwards sees the new
one. It adds `Directory::getLoadedChildren()` to `file.h` to reach the
dcache, which is private to `Directory`.

Not carried, by decision: the Node backend's `chmod()` and `utimensat()`,
which don't reach the host; its `EIO` for any failure to create a file;
end of file on a JavaScript-file-system pipe whose writers have closed;
and pipe capacity. Their drafts stay in `docs/upstream/`.
