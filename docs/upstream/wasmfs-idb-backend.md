# WasmFS: an IndexedDB backend, `wasmfs_create_idb_backend`

**Draft: proposal, as a feature request and then a PR.** Not posted, and
not yet searched for an existing issue (see the notes). It depends on five
of the toolchain's other drafts (below), which go first.

## Issue title

WasmFS: add an IndexedDB backend that reads and writes files lazily, a chunk at a time (`wasmfs_create_idb_backend`)

## Issue body

---

WasmFS has no backend that keeps files in IndexedDB. The legacy file
system's IDBFS syncs whole trees between memory and IndexedDB, and the
OPFS backend, the persistent backend WasmFS has, doesn't serve one use
well: reading files from a Worker while the page's main thread is busy,
in every browser, with several tabs reading the same files at once.

- **Firefox reads a `Blob` only while the page's main thread is free.** A
  Worker that reads an OPFS `File` (`getFile()`, then `arrayBuffer()` of a
  slice), a `Blob` stored in IndexedDB, or a cached `Response` gets the
  bytes only once the page's main thread returns to its event loop. With
  the page busy for 200 ms, Firefox 151 finished 64 reads of 64 KiB in
  206–209 ms, every one waiting for the page; Chromium 149 in 9–16 ms.
  WasmFS's OPFS backend reads a file opened read-only through its `Blob`.
- **Sync access handles lock across the origin.** The other OPFS read path
  doesn't wait, but `createSyncAccessHandle()` takes an exclusive lock on
  the file in Firefox (and, by the standard, Safari; only Chromium has
  shared read-only handles), so a second tab can't open the file at all
  (`NoModificationAllowedError`).
- **IndexedDB values that are `ArrayBuffer`s never wait.** The bytes come
  back with the `get()` itself, in both browsers, whatever the page does,
  as do opening a database, writes and commits; and read-only transactions
  run side by side across Workers and tabs.

So we wrote one: `wasmfs_create_idb_backend()`, a WasmFS backend over one
IndexedDB database, which stores each file as chunks whose values are
`ArrayBuffer`s and reads and writes them lazily, a chunk at a time, on a
thread of its own, as the OPFS backend does. Every Worker running our
WebAssembly runtime mounts it, and we propose it for Emscripten. It is
about 590 lines of C++ and 1,330 of JavaScript, much of the latter
comments and JSDoc types.

**API** (`emscripten/wasmfs.h` upstream; ours is a header of its own):

```c
// Opens (creating if needed) the IndexedDB database `database` and returns
// a backend whose root is that database's root directory. Must be called on
// a pthread or a Worker's main thread, never the browser's main thread.
// Returns NULL if IndexedDB is unavailable or the database can't be opened,
// and reports why on stderr.
backend_t wasmfs_create_idb_backend(const char *database, uint32_t flags);

// The backend refuses every change with EROFS.
#define WASMFS_IDB_READ_ONLY 0x1u
```

**Layout.** One database per backend, at version 1, with four object stores:

| Store     | Key                    | Value                                                                                               |
| --------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `meta`    | string                 | `format` (1), `chunkSize` (bytes, fixed when the database is created), `nextIno`, `root` (1)        |
| `inodes`  | inode number           | `{ kind: 1 file / 2 directory / 3 symlink, mode, size, atime, mtime, ctime, target? }`, times in ms |
| `entries` | `[parent inode, name]` | the child's inode number; a directory's entries are one key range                                   |
| `chunks`  | `[inode, index]`       | an `ArrayBuffer` of at most `chunkSize` bytes                                                       |

- A missing chunk reads as zeros, so files may be sparse, and no chunk holds
  bytes past its file's size, so a file truncated and grown again never
  shows old bytes. Sizes go up to 2^53 − 1 (a JavaScript number); beyond is
  `EFBIG`.
- Every operation that touches more than one record is one transaction, so
  a failure leaves nothing half done.
- Values are copied out of the module's memory (`slice()`), never views of
  it: a shared memory's view can't be stored, and a `Blob` would bring back
  Firefox's wait.
- An unlinked file stays readable while open; its inode and chunks go at its
  last close. Inodes no directory holds, which a page that closed with a
  file unlinked but open leaves behind, are swept, in one transaction, when
  a read-write backend is created; a sweep that fails is logged and the
  backend mounts anyway, unless it failed because the connection closed,
  which fails the open.
- WasmFS keeps file identity in its own cache (`maintainsFileIdentity()` is
  false), and each file's constructor loads its stored mode and times.

**Chunk size: 16 KiB, at most 63 KiB.** A read gets whole the chunks it
touches and a write rewrites whole the chunks it covers in part, so small
chunks keep random reads and appends cheap. Chromium stores a value whose
serialized form exceeds 64 KiB (`kIDBWrapThreshold`) as a `Blob` of its own
(`IDBValueWrapper`), which costs two to three times as much to read or
write: reads unwrap it in the requesting context and the browser process,
never on the page's thread, so it costs time but no wait for the page.
Firefox keeps values in the database far beyond that (in Firefox 151 one of
768 KiB stayed; one of 896 KiB went to a file of its own). The backend
creates databases with 16 KiB chunks, `static_assert`ed against a 63 KiB
cap, the margin for the serialization's own bytes; a database keeps the
size it was created with, and any positive size stored is read.

**Threading.** IndexedDB is asynchronous and its callbacks need an event
loop, so the backend owns an `emscripten::ProxyWorker`, as the OPFS backend
does, and every backend method is one call proxied to that thread with
`proxySyncWithCtx()`. On the thread, an asynchronous JavaScript import runs
one IndexedDB transaction, writes its results through the out-pointers it
was given and calls `_emscripten_proxy_finish(ctx)`, which releases the
blocked caller. Calls from several threads overlap on the backend's thread,
each in its own transaction, and IndexedDB orders them. Nothing on that
thread calls back into WasmFS; directory entries and symlink targets come
back through two exported helpers that only fill a `std::vector` or a
`std::string`, as `_wasmfs_opfs_record_entry` does. Offsets and sizes cross
as `double`s and inode numbers as `uint32_t`, so no import needs
`__i53abi`. The database's state lives in a `HandleAllocator` on the
backend's thread; the C++ objects hold its handle and their inode numbers.

**Writes are write-through.** Each `write()` is one read-write transaction,
with the browser's default durability, that reads only the edge chunks it
partly overwrites, puts the new chunks, updates the size and times, and has
committed before it returns. A read gets only the chunks it covers, with one
key range.

**`fsync()` is a strict commit that writes.** `flush()` (what `fsync()` and
`fdatasync()` call) runs a read-write transaction over `inodes` and
`chunks` with `{ durability: "strict" }` that puts the file's inode record
back as it is, and returns once it completes. A strict commit makes every
earlier change to the database durable, but only if it writes. We counted
the sync system calls of every browser process under
`strace -f -e trace=fsync,fdatasync,sync_file_range,syncfs`, on a profile on
disk, for 50 rounds of a relaxed write transaction followed by a strict
one, from a plain page:

| 50 rounds of a relaxed write, then           | Chromium 149   | Firefox 151  |
| -------------------------------------------- | -------------- | ------------ |
| nothing                                      | no sync call   | no sync call |
| an empty strict transaction                  | no sync call   | no sync call |
| a strict transaction that puts a record back | 50 `fdatasync` | 50 `fsync`   |

So an empty strict transaction, the obvious barrier, makes nothing durable
in either browser. A backend created read-only commits nothing on
`fsync()`. WasmFS flushes regular files only, so a rename or a new entry
becomes durable with the next `fsync()` of any file in the database.

**Errors.** `QuotaExceededError` is `ENOSPC`, with nothing changed (the
operation's transaction aborts; the backend takes the abort's error, since
every request after the failing one fails with `AbortError`);
`ConstraintError` is `EEXIST`; `ReadOnlyError` and the read-only flag are
`EROFS`; a closed connection (`InvalidStateError`, `VersionError`, the
`AbortError` of the transactions a close aborts) is `EIO`; anything else is
`EIO`, logged. A failed open logs its cause and returns `NULL`, its thread
given back to the pool.

**Version changes.** Adding object stores or deleting the database waits
until every other connection closes, so the backend closes its connection
on `versionchange`, logs it, and fails every later call with `EIO`,
lookups included, so a caller never takes a closed database for a missing
file. It never reopens: a newer version means a newer program owns the database.

**Measurements.** Chromium 149 and Firefox 151, headless, profiles on disk
(ZFS), 16 KiB chunks, five runs; each figure is the median of the runs'
medians, timed on the calling thread with `emscripten_get_now()`, so each
includes the proxied round trip to the backend's thread:

|                                 | Chromium 149 | Firefox 151 |
| ------------------------------- | ------------ | ----------- |
| random 4 KiB read               | 120–155 µs   | 140–160 µs  |
| random 64 KiB read              | 215 µs       | 200–220 µs  |
| 64 KiB `write()`, sequential    | 300–360 µs   | 360–380 µs  |
| 64-byte append `write()`        | 275–415 µs   | 300–360 µs  |
| its `fsync()`                   | 475–570 µs   | 460–500 µs  |
| `fsync()` after a 4.1 MiB write | 1.4–1.5 ms   | 5.0–5.1 ms  |

Ranges are over the page idle and the page busy in a spin loop: no read or
write waited for the page in any of 30 runs with it spinning. A random
4 KiB read costs 2.4–3 times as much with 64 KiB chunks in Chromium (where
65,536-byte chunks cross the Blob threshold; 65,000-byte ones cost what
16 KiB ones do) and 1.6–1.7 times in Firefox, and 3–4.2 times with 256 KiB
chunks. Storage once settled is the file's size plus a few percent; between
compactions, Chromium's LevelDB and Firefox's write-ahead log hold every
rewritten chunk (100 synced appends of 64 bytes added 2.3 to 3.3 MiB
before the browser closed). An `fsync()` from a pthread while the main
thread is blocked completes in both browsers, since the backend's thread
runs it.

**Tests.** Ten programs, run in a dedicated Worker in Chromium and Firefox
(our runner; upstream they would be `btest_exit` tests, like
`test_wasmfs_opfs`, with a second run for persistence):

- files, directories, renames, unlinks and their persistence across two
  runs (`basic.1`, `basic.2`); a file read after it is unlinked
  (`open-unlinked`);
- laziness: reading 1 byte of a 64-chunk file reads one chunk record, and
  writing a whole aligned chunk reads none, counted by a test-only library
  that wraps `IDBObjectStore` (`lazy`);
- sparse files, truncation down mid-chunk and up again, `O_APPEND`,
  `O_TRUNC`, files of exactly N chunks and of N chunks and a byte, and
  `EFBIG` (`sizes`);
- `fsync()`, `fdatasync()` and an `O_RDONLY` descriptor's `fsync()` each
  make one strict commit over the file's stores, one that writes, finished
  before the call returns, and writes make none (`fsync`);
- quota failures, injected into a write (at a chunk and at the inode), a
  truncation down and up, a `chmod()`, a create, a `mkdir()`, a `rename()`
  and a `symlink()`, each `ENOSPC` with the database unchanged byte for
  byte; a read-only backend
  refusing every change with `EROFS` while reads work; a version change
  from a post-js closing both backends, with `EIO` after it, from lookups
  (`stat()`, `open()` with and without `O_CREAT`) too, and the log line on
  stderr; failed opens giving their thread back (`errors`);
- the orphan sweep after a program that ended with a file unlinked but
  open, a sweep that fails, and a read-only backend that doesn't sweep
  (`sweep.1`, `sweep.2`);
- `wasmfs_idb_backend_seal()`, our own call (below): a sealed backend
  refusing every change with `EROFS`, even through a descriptor opened for
  writing before, while reads work (`seal`).

**Depends on five fixes** we carry as patches to 6.0.9, each with a draft
of its own:

- `insertDataFile()` and `insertDirectory()` returning a `MaybeFile`, so a
  backend's `ENOSPC`, `EROFS` or `EEXIST` reaches `open(O_CREAT)` and
  `mkdir()` instead of `EIO` (draft "WasmFS: backend failures to create a
  file or directory are reported as EIO");
- the same for `insertSymlink()`, which otherwise reports every failure as
  `EPERM` ("WasmFS: backend failures to create a symlink are reported as
  EPERM");
- `getChild()` returning a `MaybeFile` too, so a lookup in a closed
  database is `EIO` rather than `ENOENT`, which callers would take for a
  missing file and create, or fall back to defaults ("WasmFS: backend
  failures to look up a file are reported as ENOENT");
- `File::setMode()` and `setTimes()` hooks, so `chmod()` and `utimensat()`
  are stored and can be refused (part of "WasmFS Node backend: chmod() and
  utimensat() never reach the host");
- `ProxyWorker`'s heartbeat stopping before its thread is joined, without
  which a destroyed backend (a failed open, or every backend at exit) leaves
  a timer running the freed queue on a pooled Worker ("WasmFS: a destroyed
  ProxyWorker's heartbeat keeps running its freed queue").

**What would change for upstream:**

- The declarations move into `emscripten/wasmfs.h`, the sources into
  `system/lib/wasmfs/backends/` and `src/lib/libwasmfs_idb.js` (listed with
  the other WasmFS libraries in `src/modules.mjs`), the imports' signatures
  into `libsigs.js`, and the license header to Emscripten's.
- Our copy has two calls of its own: `wasmfs_idb_backend_seal(backend)`,
  which makes a backend read-only in place (we seal data once it is
  installed), and `wasmfs_idb_backend_closed(backend)`, an atomic flag set
  when the connection closes, which our host polls to report it. Either
  could go upstream, or stay out.
- Like the OPFS backend's pthread path, it can't run on the browser's main
  thread. The OPFS backend also runs under JSPI or Asyncify without
  pthreads; this one would need that path too, or document its absence.
- Our JavaScript library is plain JavaScript, without Emscripten's
  preprocessor, type-checked with `tsc` against types from `--emit-tsd`;
  upstream it would use the usual `{{{ }}}` macros (`makeGetValue`,
  `asyncIf`) and drop the JSDoc.
- The test-only libraries (chunk counts, injected faults, strict-commit
  counts) would become `--js-library` or `--post-js` files of the tests.
- Open counts are per connection, so a file one tab has open and another
  unlinks is deleted at once; a single-writer rule (we use a Web Lock) is
  the caller's.

---

## Notes for the user

- **Where it lives here.** `runtime/wasmfs-idb/` (`include/ibus-web/wasmfs-idb.h`,
  `src/idb_backend.{cpp,h}`, `src/libwasmfs_idb.js`, `tests/`), checked by
  `checks.wasmfs-idb` and `checks.wasmfs-idb-types`; spec §5.6.
- **The measurements** are the M0.5 spike's (`docs/spikes/2026-10-01-runtime-worker.md`,
  "What it costs" and "IndexedDB and Cache Storage under the spin"), on one
  machine. The `strace` counts were taken by hand and the traces not kept;
  rerun them before posting.
- **Licensing.** The code is ours, `MIT OR Apache-2.0`; contributing it
  means relicensing it under Emscripten's MIT and University of
  Illinois/NCSA licenses, which the company has to agree to.
- **Order.** Post the five dependency drafts first; the PR needs them.
  Before posting, check `main` for an IndexedDB backend and for changes to
  `ProxyWorker`, `MaybeFile` and the OPFS backend's shape, and search issues
  for "IndexedDB" and "wasmfs idb".
- **Not run upstream.** Emscripten's own test suite wasn't run with the
  backend; the tests above run on our toolchain (6.0.9 with patches
  0001–0019).
