# Storage

Every module Worker has a WasmFS file system. A module's own files (user dictionaries, deployed data, user
configuration) and its installed, read-only data live in IndexedDB, behind a WasmFS backend of our own,
`runtime/wasmfs-idb/`. This page covers that backend, why it is IndexedDB, how engine data is installed once per
version, who may write an engine's files, the fallbacks, and what it all costs. The host's side of it, its scopes and
their order, is in [worker-host.md](worker-host.md); the thread pool share the backends take is in
[runtime.md](runtime.md). GSettings values are not stored here; the settings bridge hands them to the host (spec
§5.2.5).

## What is mounted where

| Path               | Browser                                                 | Without IndexedDB     | Node (tests)                              |
| ------------------ | ------------------------------------------------------- | --------------------- | ----------------------------------------- |
| `/engines/<name>/` | IndexedDB backend over `ibus-web/<name>`                | WasmFS memory backend | Node backend over `<dir>/user/`           |
| `/nix/store/`      | IndexedDB backend over `ibus-web/<name>/data/<version>` | the same memory mount | Node backend over `<dir>/data/<version>/` |

`/engines` and `/nix` are created in memory. The engine's own files are at `/engines/<encodeComponent(name)>`, one
directory under `/engines` whatever the name holds. The version's data backend is mounted at `/nix/store`, separate from
its user backend, and every archive is extracted at the mount's root, its entries named from the store, so each lands at
its exact store path. Without IndexedDB, data is installed under the same store paths in WasmFS memory. Engine builds
retain their Nix paths; no FHS mapping is applied. Once the store is mounted, and before any `Init`, the host sets
`GSETTINGS_SCHEMA_DIR` to the manifest's `settingsSchemaDir` and `HOME` to the engine's own directory with the runtime's
`setenv`, since GLib caches its default schema source and the home directory on their first lookup. Each version still
installs its own whole closure; a shared store is [future work](known-gaps.md#storage).

The engine's name and version are encoded in every database, lock and directory name (`encodeURIComponent`, with
`!'()*.~` also escaped), so neither holds `/` or `:` and neither is `.` or `..`; one engine's or version's names can
never run into another's. The names are in `packages/worker-host/src/shared/naming.ts` and never change, since stored
data is found by them. A manifest without a version fails the host's start.

## The IndexedDB backend

### C API

`ibus-web/wasmfs-idb.h`, the `wasmfs-idb` section of the runtime's export list, so side modules reach the API and
nothing else of the backend:

- `wasmfs_create_idb_backend(database, flags)` opens the database, creating it if needed, and returns a backend whose
  root is the database's root directory, or `NULL` with the cause on stderr. It must be called on a pthread or a
  Worker's main thread: the backend's thread starts synchronously, which would deadlock on the browser's main thread, so
  there it returns `NULL`.
- `WASMFS_IDB_READ_ONLY` (`0x1`): the backend starts with its window shut (below), so every change fails with `EROFS`,
  and it doesn't sweep (below).
- `wasmfs_idb_backend_seal(backend)` makes a backend read-only in place: every change started after it fails with
  `EROFS`, descriptors already open for writing included, while reads, closes and `fsync()` still work. The last close
  of a file unlinked before the seal still deletes what it stored. A change another thread has already started may still
  complete, so seal once nothing else writes. Sealing makes nothing durable; `fsync()` first.
- `wasmfs_idb_backend_set_writable(backend, writable)` opens or shuts the backend's window for changes. While it is shut
  every change fails with `EROFS`, as through a sealed backend, descriptors already open for writing included; while it
  is open the backend takes changes. A backend starts with it open, or shut if created with `WASMFS_IDB_READ_ONLY`.
  Opening a sealed backend's fails with `-EROFS`: a seal is for good. A backend that has ever been open commits on
  `fsync()`. The window makes no backend the database's only writer; the caller coordinates writers, as the host does
  with its install locks ([below](#an-engines-own-data)).
- `wasmfs_idb_backend_closed(backend)` says whether the database's connection has closed under the backend. It is an
  atomic load, cheap whatever the backend's thread is doing.

### How it plugs into WasmFS

The backend is C++ in the shape of WasmFS's OPFS backend (`src/idb_backend.cpp`), compiled against the patched
Emscripten's internal WasmFS headers (`-I<emscripten>/system/lib/wasmfs`, from the same tree the cache was built from),
plus an Emscripten JS library (`src/libwasmfs_idb.js`) that links with `--js-library`.

- **One thread per backend.** IndexedDB is asynchronous and its callbacks need an event loop, so each backend owns an
  `emscripten::ProxyWorker`: a pool pthread that lives in its JS event loop for as long as the runtime, since WasmFS
  never destroys a backend. It holds the backend's connection. Every backend method is one call proxied to that thread;
  there an asynchronous JS import runs one IndexedDB transaction, writes its results through the out-pointers it was
  given and calls `_emscripten_proxy_finish(ctx)`, which releases the blocked caller. Calls from several threads overlap
  on the backend's thread, each in its own transaction, and IndexedDB orders them. A host mounts two backends, so the
  pool's storage share is 2 ([runtime.md](runtime.md)).
- **Nothing on the backend's thread calls back into WasmFS.** WasmFS calls a backend method with that file's recursive
  lock held and the caller blocked, so the backend's thread may take no file lock and make no file system call.
  Directory entries and symlink targets come back through two exported helpers, `_wasmfs_idb_record_entry` and
  `_wasmfs_idb_set_string`, that only fill a `std::vector` or a `std::string`.
- **State.** The JS side keeps each open database in a `HandleAllocator` on the backend's thread; the C++ objects
  (`IdbFile`, `IdbDirectory`, `IdbSymlink`) hold its handle and their inode numbers. Each file's constructor loads its
  stored mode and times in place of the ones WasmFS makes up. WasmFS keeps file identity in its own cache
  (`maintainsFileIdentity()` stays false). That cache holds the entries lookups found, never an entry's absence, and a
  directory's listing is read from the database each time, so a file another connection creates after a lookup missed it
  is found by the next.
- **Offsets and sizes cross as `double`s** and inode numbers as `uint32_t`, so no import needs `__i53abi`; each import
  declares its `__sig`.
- **Toolchain patches it relies on** ([the patch series](../modules/emscripten/patches/README.md)): 0012 and 0019 make
  `insertDataFile()`, `insertDirectory()` and `getChild()` return a `MaybeFile`, so a backend's `ENOSPC`, `EROFS`,
  `EEXIST` or `EIO` reaches `open(O_CREAT)`, `mkdir()` and lookups instead of WasmFS's blanket `EIO` or `ENOENT`; 0017
  does the same for `insertSymlink()` (otherwise always `EPERM`); 0013 adds `File::setMode()`/`setTimes()`, so `chmod()`
  and `utimensat()` are stored and can be refused; 0018 stops a `ProxyWorker`'s heartbeat before its thread is joined,
  without which a backend whose open failed leaves a timer running its freed queue on a pooled Worker. Drafts:
  [create errors](upstream/emscripten-wasmfs-node-create-eio.md),
  [lookup errors](upstream/emscripten-wasmfs-lookup-errors.md),
  [symlink errors](upstream/emscripten-wasmfs-symlink-errors.md),
  [chmod/utimensat](upstream/emscripten-wasmfs-node-chmod.md),
  [ProxyWorker heartbeat](upstream/emscripten-wasmfs-proxy-worker-heartbeat.md).

The backend is a candidate for Emscripten as `wasmfs_create_idb_backend`;
[upstream/wasmfs-idb-backend.md](upstream/wasmfs-idb-backend.md) is the proposal, with what would change for upstream.

### Database layout

One database per mount, at version 1, with four object stores, created when the database is:

| Store     | Key              | Value                                                                                                            |
| --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `meta`    | string           | `format` (1), `chunkSize` (bytes, fixed at creation), `nextIno`, `root` (1), and engine data's markers           |
| `inodes`  | inode number     | `{ kind, mode, size, atime, mtime, ctime, target? }`: kind 1 file, 2 directory, 3 symlink (WasmFS's numbers); ms |
| `entries` | `[parent, name]` | the child's inode number; a directory's entries are the key range `[[p, ""], [p, []]]`                           |
| `chunks`  | `[inode, index]` | an `ArrayBuffer` of at most `chunkSize` bytes                                                                    |

- Inode 1 is the root, made with the database (mode 0777). Inode numbers go up to 2^32 − 1; past that, a create is
  `ENOSPC`.
- A missing chunk reads as zeros, so files may be sparse; growing a file only changes its size. No chunk holds bytes
  past its file's size (truncation deletes the chunks past the end and trims the last), so a file truncated and grown
  again never shows its old bytes. The last chunk may be short.
- File sizes go up to 2^53 − 1, the largest integer a JavaScript number holds exactly; beyond it is `EFBIG`.
- Every operation that touches more than one record is one transaction, so a failure leaves nothing half done.
- `meta.installed` and `meta.paths/<storePath>` are the host's ([below](#installing)); the backend reserves those keys
  and never reads them.
- A database is read only if its `format` is 1 and its `chunkSize` a positive integer; anything else fails the open with
  `EIO`.

### Reads and writes

- **Lazy reads.** A read gets the inode and then only the chunks it covers, with one key range over
  `[ino, first]..[ino, last]`, in one read-only transaction, and copies them into the caller's buffer, zeros for holes.
- **Write-through writes.** Each `write()` is one read-write transaction, with the browser's default durability, that
  reads only the edge chunks it partly overwrites and that hold bytes the file keeps, puts the new chunks, updates size
  and times, and has committed before `write()` returns. A write over whole aligned chunks, or past the file's end,
  reads nothing.
- **`ArrayBuffer`s, copied.** Values are copied out of the module's memory, never views of it (a view of shared memory
  can't be stored), and never `Blob`s ([why](#blobs-wait-for-the-page-in-firefox)).
- **Opens.** Every `open()` costs one read-only transaction, which checks the inode still exists. A read-only backend
  refuses opens for writing with `EROFS`.
- **Unlinked files.** An unlinked file stays readable while open: open counts are kept per backend, the entry goes at
  once, the inode and its chunks at the last close. WasmFS looks a file up and opens it under different locks, so an
  unlink can fall between; the open counts itself in the same task that creates the transaction checking the inode, so
  an earlier unlink makes the open fail as if it came later, and a later one leaves the inode to the last close.
- **The sweep.** Inodes no directory holds, which a page that ended with a file unlinked but open leaves, are deleted
  with their chunks, in one transaction, when a read-write backend is created and before it opens anything. A read-only
  backend doesn't sweep: only the database's one writer may ([below](#one-writer-per-modules-user-data)). A sweep that
  fails is logged and the backend mounts anyway, unless the connection closed, which fails the open.
- **Renames** stay within one database; overwriting follows POSIX `rename()`, in one transaction.

### `fsync()`

`fsync()` and `fdatasync()` (WasmFS's `flush()`) are the durability barrier: a read-write transaction over `inodes` and
`chunks` with `{ durability: "strict" }` that **puts the file's inode record back as it is**, and returns once it
completes. Every write has already committed, so once a strict commit after them completes, every earlier change to the
database is on disk.

Why the transaction must write: counted under `strace -f` across every process of the browser (`fsync`, `fdatasync`,
`sync_file_range`, `syncfs`), on a profile on disk, a page running rounds of a relaxed write transaction followed by a
strict one sees one sync call per strict commit that writes — `fdatasync` in Chromium 149, `fsync` in Firefox 151 — and
none for an empty strict transaction, nor for the relaxed writes alone. An empty strict transaction, the obvious
barrier, makes nothing durable in either browser. The harness, page, counts and traces are in
[`docs/upstream/evidence/idb-sync-calls/` at `c35ef8e`](https://github.com/synapdeck/ibus-web/tree/c35ef8e281ab9e048797f4a44dfb86d898065866/docs/upstream/evidence/idb-sync-calls).
Through the runtime, the same change to `fsync()` raised the sync calls of a run of the cost workload
([below](#what-it-costs)) by about one per `fsync()` it made, in both browsers. The backend's `fsync` tests count that
each `fsync()` and `fdatasync()` makes exactly one strict commit over the file's stores and that it writes; they fail
against an empty one.

- A backend whose window has never been open commits nothing on `fsync()`; it has written nothing. A sealed backend, or
  one whose window has shut, still commits, since it may have written before.
- WasmFS flushes only regular files, so `fsync()` on a directory does nothing, and a rename or a new entry has no
  barrier of its own: it is durable once a later `fsync()` of any file in the same database completes.

### Errors

| Cause                                                                                                         | errno                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `QuotaExceededError`                                                                                          | `ENOSPC`, nothing changed (the operation's one transaction aborts) |
| `ConstraintError` (a name already taken)                                                                      | `EEXIST`                                                           |
| `ReadOnlyError`, a shut window, a seal                                                                        | `EROFS`                                                            |
| a closed connection: `InvalidStateError`, `VersionError`, the `AbortError` of the transactions a close aborts | `EIO`                                                              |
| anything else                                                                                                 | `EIO`, logged                                                      |

A failed write aborts its transaction with its error, and every request after it fails with `AbortError`; the backend
reports the abort's error, the cause. A lookup in a closed database is `EIO` too, never `ENOENT`, since callers take
`ENOENT` as leave to create a file or fall back to defaults (patch 0019). Quota failures are tested by injecting the
error into a write, a truncation, a `chmod()`, a create, a `mkdir()`, a `rename()` and a `symlink()`, each leaving the
database unchanged byte for byte; a real quota isn't reached in tests ([known gaps](known-gaps.md#storage)).

### Version changes

Adding or removing object stores, or deleting a database, waits until every other connection closes. So every connection
the runtime and the host make closes on `versionchange`: the backend's thread hears it from its event loop, sets the
backend's closed flag (before closing, so whoever waits for the close sees it), logs
`wasmfs-idb: <database> closed for a version change`, and fails every later call with `EIO`. A connection the browser
closes on its own (`close` event) does the same. Nothing reopens it: a newer version means a newer program owns the
database.

The host checks `wasmfs_idb_backend_closed()` for both mounts each time it wakes and posts `storage: closed` once (spec
§8). It notices only when it next wakes for a request or a GLib source; the close itself doesn't wake it
([known gaps](known-gaps.md#storage)).

### The page keeps out

The page opens no transaction on a module's databases; with spec §9.2 it reaches the module's storage only through the
protocol. A transaction commits on the thread that made it, so one the page had made and hadn't seen commit when it
began to spin held up the backend's writes to the same store until the spin ended: in a test that read the user
database's `meta` store just before a request, the reply came only once the page's 1 s spin gave up, in both browsers.
Waiting for the transaction's `complete` before the request removed it.

### Tests

`checks.wasmfs-idb-browser` runs the backend's GoogleTest programs in Chromium and Firefox ([testing.md](testing.md)):
`basic.1`/`basic.2` (files, directories, renames, unlinks, modes and times, and their persistence into a second program
in the same browser storage), `open-unlinked`, `lazy` (chunk records read and written per call, counted by a test-only
library wrapping `IDBObjectStore`: one byte of a 64-chunk file reads one record; a whole aligned chunk write reads
none), `sizes` (holes, truncation, `O_APPEND`, `O_TRUNC`, exact chunk multiples, `EFBIG`), `fsync` (strict commit
counts), `errors` (injected quota failures, read-only refusals, a version change from a post-js, failed opens giving
their thread back), `sweep.1`/`sweep.2`, `seal`, `writable` (a shut window refusing every change, through a descriptor
opened while it was open too, and leaving the database as it was; an open one taking changes, on a backend created
read-only as well, whose `fsync()` then commits; a sealed backend's never opening) and `visibility` (a file another
backend creates after this one's lookup missed it, found and listed; a directory moved onto such a name, found whole; a
failed move leaving the directory where it was; a move onto a directory another backend filled, refused). Each test
program's pool is one thread plus one per backend its cases create, strictly, so a miscount fails the case. The host's
storage and engine-data scenarios run in `checks.worker-host-node` and `checks.worker-host-browser`.

## Chunk size

**16 KiB for the databases the backend creates, and at most 63 KiB.** A database keeps the size it was created with, in
`meta`; the backend reads any positive size stored, larger ones included.

- **Why 16 KiB.** A read gets whole every chunk it touches, and a write rewrites whole every chunk it covers in part, so
  small chunks keep random reads and appends cheap. Through the backend, a random 4 KiB read, the read lookups make on
  the keystroke path, cost 120–155 µs at 16 KiB chunks in Chromium against 365–380 µs at 64 KiB and 500–585 µs at 256
  KiB; in Firefox 140–160 µs against 240–260 µs and 480 µs. 16 KiB was also the cheapest or as cheap for appends and
  sequential writes, and 64 KiB reads, served from four records, were still the cheapest. Conditions and the full
  figures are under [What it costs](#what-it-costs).
- **What 16 KiB costs.** More records per file (263 for a 4,200 KiB file); some 3% more storage in Firefox once settled;
  in Chromium more LevelDB churn between compactions and a dearer `fsync()` after a large write (1.4–1.5 ms against
  0.57–0.69 ms at 64 KiB).
- **Why at most 63 KiB.** Chromium stores a value whose serialized form exceeds 64 KiB (`kIDBWrapThreshold`) as a `Blob`
  of its own (`IDBValueWrapper`), and a read unwraps it by reading that Blob in the requesting context and the browser
  process, never on the page's thread: it costs time, not a wait for the page. At 64 KiB chunks Chromium was two to
  three times slower than at 16 KiB, for reads and writes alike; two more runs placed the cliff at 64 KiB itself:
  65,000-byte chunks cost what 16 and 32 KiB ones do (4 KiB reads 135–140 µs against 295–300 µs at 65,536 bytes; 64 KiB
  writes 270–295 µs against 800–830 µs). The cap is a `static_assert` on the default; the margin covers the bytes the
  serialization adds. The cliff is attributed to Blink's value wrapping from the threshold, not traced. Firefox keeps a
  value in its database far beyond that: in Firefox 151 one of 768 KiB stayed and one of 896 KiB went to a file of its
  own (`dom.indexedDB.dataThreshold`, measured, not read from its default).

## Why IndexedDB

The constraint is the keystroke path: the page spins on the control buffer for up to 40 ms waiting for the engine's
answer (D6, spec §6.2.6), and nothing the Worker does for a request may wait for the page's main thread. Engine data
must also be readable by every tab and engine instance at once. Decided: engine and user data live in IndexedDB, as
chunks whose values are `ArrayBuffer`s, behind our own lazy backend (D13).

The evidence below comes from a harness without the runtime, in headless Chromium 149 and Firefox 151 under Playwright,
offline in the Nix sandbox, cross-origin isolated: a Worker filled a store with 4 MiB of random bytes while the page was
free, then the page sent one command and either stayed free or spun for 200 ms (five times D6's 40 ms) while the Worker
ran it, reads awaited one at a time as a lazy backend would; three runs per case, each in a fresh browser context.

### Blobs wait for the page in Firefox

In Firefox a Worker reads a `Blob`'s bytes only once the page's main thread is free, whatever store handed it the Blob.
With the page spinning 200 ms, 64 reads of 64 KiB took:

| Firefox 151, 64 × 64 KiB                                   | Page free    | Page spins         |
| ---------------------------------------------------------- | ------------ | ------------------ |
| IndexedDB, `ArrayBuffer` values, connection open           | 12.2–13.3 ms | 12.8–14.2 ms       |
| IndexedDB, `Blob` values, then each Blob's `arrayBuffer()` | 9.1–12.8 ms  | **206.5–207.9 ms** |
| Cache Storage, `match()` and `Response.arrayBuffer()`      | 19.3–24.3 ms | **220.9–226.9 ms** |
| OPFS, `getFile()`, then slices' `arrayBuffer()`            | 7.1–8.5 ms   | **207.3–209.2 ms** |
| OPFS, sync access handle                                   | 4.2–22.1 ms  | 3.6–3.8 ms         |

In each Blob case the gets, `open()`, `getFile()` or the first `match()` finished within 5 ms and the first byte read
came at 200.6–201.1 ms, just after the spin. `ArrayBuffer` values come back with the `get()` itself and never wait, nor
do a 4 MiB value, `indexedDB.open()`, writes or their commits. Why Firefox routes Blob reads through the page's thread
wasn't investigated. Chromium waited in no case (every row 2.6–16.8 ms either way).

### Not OPFS

WasmFS's OPFS backend works: it mounts, writes, `fsync`s and reads back from the host's thread and from pthreads while
the host sleeps. But its read paths each fail one requirement.

- A file opened `O_RDONLY` is read through its `File` (`getFile()`, then `blob.slice().arrayBuffer()`), which waits for
  the page in Firefox (above).
- A file opened for writing is read through a sync access handle, which doesn't wait, but takes an exclusive lock on the
  file across the origin. The WHATWG standard has no handle modes; Chromium's `read-only` and `readwrite-unsafe` modes
  (since 121) share among themselves, but Firefox 151 refuses a second handle in every mode with
  `NoModificationAllowedError` and silently takes an exclusive, writable handle when asked for `read-only`, and Safari
  has none by the standard. So a second tab or engine instance couldn't open the same data. An upstream change opening
  read-only files with `{ mode: "read-only" }` would share handles in Chromium only, and in Firefox turn every read-only
  open into an exclusive writable lock, with no feature test to tell the two apart.
- Blob reads take no lock (any number of runtimes read a file while one holds a handle), so OPFS would have forced a
  choice in Firefox between a replay on every keystroke that reads data and locks that keep a second tab out.

The runtime's export list leaves `wasmfs_create_opfs_backend` out for these reasons.

### Not Cache Storage

Cache Storage hands back `Response` bodies, Blob-backed, so it waits in Firefox like any Blob (above); in Chromium it
never waited (11.4–15.5 ms for 64 × 64 KiB, spinning or not), and two Workers read the same 64 responses at once in both
browsers (18.6–20.3 ms). It has no partial update, so it could serve read-only data at most.

### IndexedDB across Workers and tabs

IndexedDB never refuses a reader. Read-only transactions ran side by side across Workers of one page and Workers of two
pages, with the page free or spinning (14–20 ms for 64 × 64 KiB each, both browsers); a read-only transaction over a
store a read-write one holds waits for its commit rather than failing (28 ms against 15–22 ms for the writer). The one
exclusive operation is a version change: a second connection asking for version 2 stayed `blocked` until the first, told
by `versionchange`, closed 300 ms later, in both browsers. Replacing data inside a version needs no upgrade.

Random reads in the Worker itself, without the backend's round trip (page free, 256 reads, one run; Firefox's clock
steps by 20 µs, so compare means): a 4 KiB IndexedDB read cost 42 µs mean in Chromium and 58 µs in Firefox with a
transaction per read, 27 and 44 µs in one transaction — about a sync access handle's cost in Chromium (44 µs) and three
to four times it in Firefox (15 µs). At 64 KiB IndexedDB cost 157–300 µs against a handle's 8–56 µs.

### The alternatives weighed

- **Load engine data into memory at engine start.** Works from any store, Blob paths included, since engine start isn't
  under the spin; no lock. 4 MiB read in 3–25 ms. Rejected for its cost: a copy in every runtime instance's fixed memory
  and in every engine start.
- **Accept D6 replays** and keep OPFS's Blob path: no lock, and Chromium never waits, but in Firefox every keystroke
  that reaches a Blob not read before spins the full 40 ms and replays, however little it reads.
- **A WasmFS IndexedDB backend** (chosen): `ArrayBuffer` reads complete during the spin and nothing takes an exclusive
  lock. Its conditions: values stay `ArrayBuffer`s under 64 KiB serialized; it is new code outside Emscripten, ours
  until upstream takes it; each read pays IndexedDB plus the proxied round trip; data must be written into IndexedDB at
  install; connections must close on `versionchange`.
- **Not ZenFS**: its IndexedDB support plugs into Emscripten's legacy JavaScript file system rather than WasmFS, its
  synchronous path loads everything up front, and it is LGPL-3.0. **Not IDBFS**: legacy file system too, and it syncs
  whole trees between memory and IndexedDB.

## Engine data: a database per version

Read-only engine data (m17n-db, Hangul's Hanja tables, Rime's prebuilt schemas) is listed in the engine manifest as
archives (`storePath`, `url`, unpacked `size`, `encoding`), fetched, installed once per version and read lazily like any
other file. The archives an engine's descriptor names in its `data` are that engine's own, installed when a page first
prepares the engine ([below](#an-engines-own-data)); the rest are the version's base data, installed at start. The
protocol lives in `packages/worker-host/src/worker/install/`.

### Names and locks

Each version's data is a database of its own, `ibus-web/<name>/data/<version>`, apart from the module's own files
(`ibus-web/<name>`) and from every other version, so installing one never touches another in use. Three Web Locks per
module:

- `ibus-web:data:<name>:<version>`, **shared**, held by every host using that version for its life; the first lock a
  host waits for. Taken exclusively, it is the right to delete that version.
- `ibus-web:install:<name>:<version>`, **exclusive**, for deciding and installing; versions install independently.
- `ibus-web:writer:<name>`, the [writer lock](#one-writer-per-modules-user-data), which covers the module's own files
  only. Every host installs a missing version, writer or not.

### Installing

At engine start, before the engine accepts requests, the host:

1. takes the version's data lock, then its install lock;
2. reads the version's marker, `meta.installed` = `{ version, files, bytes }`, on a short connection that **doesn't
   create the database**: opening a database that doesn't exist would create it at version 1, so the probe aborts the
   upgrade, which leaves no database in Chromium 149 or Firefox 151, as the standard says;
3. **with a marker**, mounts the version with its window shut (`WASMFS_IDB_READ_ONLY`);
4. **without one**, deletes the version's database (a deletion still blocked after 10 s fails the start), mounts a
   backend over a new one with its window shut, opens the window, extracts every base archive into it, shuts the window,
   and writes the marker last in a strict transaction on a connection of its own;
5. lets go of the install lock, posts `install`, collects old versions and posts `collect`.

Any host may later install an engine's own data into the version, so no host seals its data backend while it runs; each
seals it as it closes, while the runtime can still be called.

So an install starts from empty storage: no partial tree, no other version's file and no stale one survives it. No host
reads a version before its marker exists, so the deletion has no reader to wait for. An interrupted install leaves no
marker and the next host redoes it; a second host waiting on the lock finds the marker and mounts. Every host mounts one
data backend, created read-only, since a backend's thread lasts as long as the runtime; created read-only, it doesn't
sweep a database other hosts install into.

**The marker.** Every file was `fsync()`ed by the installer, so the data has committed; the directory entries made after
a file's last `fsync()` committed relaxed, and the marker's strict commit makes them durable too, since a strict commit
that writes makes every earlier change to the database durable. A marker whose value isn't one for this version counts
as none, so the version is installed again rather than every start failing.

**The installer.** Archives are Brotli-compressed pax, POSIX's extension of ustar, one per store path, its entries named
from `/nix/store` (`<hash>-<name>/…`, or the bare file for a store path that is one); how they are built is
[engines.md](engines.md#archives-and-serving)'s. The host streams native `DecompressionStream("brotli")` output, where
construction succeeds, or a `brotli-dec-wasm` fallback with its WASM embedded in a separate decoder script, imported by
URL only without native support. Plain tar (`encoding: "identity"`) remains available for fixtures. Serve the archives
without `Content-Encoding: br` to avoid fetch decoding them twice; a decoding failure's message says so, while a failure
of the response body itself passes through unlabelled.

Decompressed bytes are re-cut into at most 64 KiB pieces and piped through `modern-tar`'s `createTarDecoder()`, strict,
and the host's installer (`src/worker/install/`) writes each entry as the decoder gives it, through WasmFS's JavaScript
`FS` (`mkdir`, `lstat`, `chmod`, `symlink`, `unlink`, `open`, `fchmod`, `ftruncate`, `write`, `close`) and libc's
`fsync`, which the runtime exports, into the mounted file system, so the stored layout has one writer: the host's
installer. A file's data goes in as it arrives, in pieces of at most 64 KiB, each a `write()`; neither an archive nor a
file is ever held whole. The decoder refuses a header whose checksum doesn't match, a lone zero block, an archive that
ends before its two end-of-archive blocks, mid-header or mid-file, and anything but zeros after them. It applies pax
extended (`x`) and global (`g`) headers and GNU's long names (`L`, `K`), so a name or link target has no length limit.

The installer takes regular files, directories and symbolic links, a link keeping its target unresolved; a hard link
fails with `EOPNOTSUPP`; devices, FIFOs, absolute names, `..`, a pax `size` record, a name or target holding a NUL or a
newline, and a link with no target fail with `EINVAL`. Each archive is extracted at the root of the data mount, and an
entry outside the archive's own store path is refused before anything of it is written, so one archive can't replace
another's files. Nothing is written through a link: an entry under one fails with `ENOTDIR`, a file or link replaces a
link already at its name, a link also replaces a file, and a link or file where there is a directory fails with
`EISDIR`. Each entry takes the archive's mode plus its owner's read and write (and search, for a directory), new or
there already, so a later install can redo it; existing directories are kept, existing files truncated and rewritten,
missing parents made. Each regular file is sized from its header (`ftruncate`) before its data is written, so a file in
memory is allocated once, and `fsync()`ed once written. A failure reports the entry and the negative errno, as
`install <url>: "<entry>": -<errno>`, and closes the file it was writing.

The installer refuses, with `EFBIG`, a regular file that would take the bytes written past the manifest's `size` for the
archive, before creating its parents or the file, and the host requires the bytes written to equal `size` exactly before
it writes the marker. Metadata and decompressor buffers are outside this budget.

**Waiting and progress.** A host waiting for the data or install lock gives up, failing its start, after 120 s without
word from the holder. The installer sends progress every second for as long as it holds the install lock, on a
`BroadcastChannel` named after that lock, including asynchronous mount, fetch, decoder setup, marker commit and sealing.
The timer starts when the lock is acquired and stops before release. It runs only during asynchronous bootstrap, never
in the synchronous request loop. Synchronous runtime calls or OS starvation can still delay timer delivery, and each
word starts a waiter's 120 s over, so a long install holds no one up for good. An archive that sends nothing for 30 s
fails its installer's start, which lets go of the lock. In Firefox a response body waits while the page spins;
installing is off the request path, so that only delays startup. Each wait is made of 1 s requests, each made again when
it times out, because Node 24 grants a request already queued for a terminated `worker_thread`'s lock only once another
request for it arrives (a queued host got the lock at 1,001 ms). The limits are the host's configuration Layer
(`lockLimitMs`, `lockRoundMs`, `progressIntervalMs`, `archiveIdleMs`, `deleteLimitMs`), which tests shorten.

### An engine's own data

An engine's descriptor may name store paths of the module's data as its own (`data`,
[engines.md](engines.md#an-engines-own-data)). They are installed into the version's database, beside its base data,
when a page first prepares the engine: `PrepareEngine` ([worker-host.md](worker-host.md#messages)), which the page sends
before the engine's first `CreateEngine` in a Worker. A host prepares several engines at once.

1. The host reads each of the engine's paths' markers, `meta.paths/<storePath>` = `{ files, bytes }`, on a short
   connection of its own; a path with one is there, since its marker is written last.
2. For each path without one it joins the install of that path already running in this Worker, if there is one, so that
   two engines sharing a path fetch it once; otherwise it starts one. An install takes the path's own install lock,
   `ibus-web:install:<name>:<version>:<storePath>` (encoded as the other names), and says it is still going on the
   lock's channel while it holds it, so that a host waiting on the path waits rather than gives up. Under the lock it
   reads the marker again, since another host may have installed the path meanwhile; if it is still missing, it installs
   the path whole (below) and writes the marker in a strict transaction, last.
3. It posts `prepare-progress`, the bytes written of the engine's missing paths, a `path-install` for each path,
   `present` or `installed`, and `prepared`, with the reason if an install failed.

- **Installs run at once.** Different store paths install concurrently, in one Worker or several, each under its own
  lock: inodes come from `meta.nextIno` inside the one read-write transaction that makes an entry, which IndexedDB
  serializes against every other over the same stores, whatever the connection; entries are keyed by parent and name,
  chunks by inode and index; and each extraction has a handle of its own. The base install keeps the version's install
  lock, and no host prepares an engine before its version's base data is marked.
- **The window** is shared: it opens as the first extraction starts and shuts as the last ends. The data backend takes
  changes only while one runs. An engine thread in the same Worker could write to `/nix/store` while it is open; none
  does. This is weaker than the seal ([known gaps](known-gaps.md#storage)).
- **The host's own transactions.** An extraction's writes block the host's thread until the backend's transaction
  commits, and IndexedDB holds that transaction until every earlier one over the same stores has ended, the host's
  marker reads and writes on its own connection included, which end only in the host's event loop. So the installer
  waits, before each write, until the host has none of its own open.
- **A path appears whole.** The installer extracts the archive, with the checks of any archive (its own `size` limit,
  entries confined to its store path), under a staging name beside the store path, `/nix/store/.staging-<hash>-<name>`,
  then renames the staging tree onto the store path. Nix refuses a store path's name that starts with a dot, and an
  archive's entries lie under its own store path, so no store path or archive entry has that name. The IndexedDB backend
  makes the rename one read-write transaction (`_wasmfs_idb_move`: the old entry deleted and the new one put, or
  neither), and the Node backend one `rename(2)`. So a reader finds no store path or the whole of it: an engine thread
  in the same Worker, such as Rime's deployer walking schemas and opening dictionaries while it maintains its data at
  start, and any other Worker, which finds the moved directory by lookup. WasmFS refuses to rename onto a directory that
  holds anything (`ENOTEMPTY`) but would replace an empty one, and the backend's move replaces whatever entry is at the
  name, so the installer checks the store path is absent itself, under the path's install lock, which no other host's
  install of the path can hold meanwhile.
- **An install cut short** leaves no marker for its path. Cut short before the rename, it leaves a staging tree and no
  store path: the next install of the path, under its lock, removes that tree before extracting. Cut short after it, it
  leaves the whole path, since only the rename makes it: the next install counts the path's files and bytes, checks the
  bytes against the manifest's `size`, and writes the marker without fetching the archive again. An install that fails
  while the runtime can still be called removes its own staging tree, so no Worker's WasmFS keeps a cached staging tree
  that another host's later install replaces.
- **Hosts that mounted the version first** find a path another host installed by lookup, since WasmFS keeps no entry's
  absence ([above](#how-it-plugs-into-wasmfs)); preparing the engine then finds its marker and installs nothing.
- **Memory mounts.** Without IndexedDB the data lives in the runtime's memory, which is sized at start and can't grow,
  so such a host installs every archive at start, sized as now, and a prepare finds nothing to do.

The scenarios run under Node and in both browsers, on the asserting and the released runtime: a lazy install, a marker
already present, two engines' paths installing at once with the window opened once, two engines sharing a path with one
fetch, two hosts racing for one path (browsers only), a path another host installed after this one mounted, an install
killed mid-path (its staging tree swept), one killed between its rename and its marker (marked without a fetch), a
reader in the installing host polling the path and never finding it partial, the window shut after an install and after
a failed one, a memory mount installing everything at start, and a distribution `mkEngineManifest` built with an
engine's own data. The backend's own tests check that a directory moved onto a name another backend missed is found
there whole, that a failed move leaves it where it was, and that a move onto a directory another backend filled is
refused.

### Old versions

Once it has installed or found its version, the host lists the engine's other versions (`indexedDB.databases()`, which
Firefox has only from 126: hence the toolchain's one-way Firefox floor, [toolchain.md](toolchain.md)) and, for each,
requests its data lock exclusively with `ifAvailable`. Granted, no host uses that version and none can start to until
the lock is let go, so it deletes the database. Collection is best-effort: a failure is reported in `collect.error` and
never fails the start.

### `install` and `collect`

Two host messages report it (`src/shared/messages.ts`; spec §5.6, §8).

- `install`: `state` (`installed` or `present`), `version`, `files` and `bytes` as the marker records them,
  `lockWaitMs`, `lockedAt` and `releasedAt` (when the install lock was taken and let go, in `Date.now()` ms, which hosts
  share) and `installMs`. A memory mount installs at every start with no lock (`lockWaitMs` 0).
- `collect`: `removed` and `inUse` (encoded versions) and `error`, if listing or deleting failed.

### Failed starts

The host keeps every lock it holds in one set, and a start that fails, or a runtime that crashes after it, lets go of
them all, so a failed host never keeps others from installing, collecting or writing; it stays alive to report. Its
runtime, and any engine thread already started, may still write through its read-write backends, so it seals them before
letting go of the writer lock; a runtime that can no longer be called (a trap) keeps the writer lock until the page
terminates the Worker. An install that fails shuts the data backend's window as it fails, and the data backend is sealed
as the host closes, so nothing writes into an unmarked version once the host is closing. A host that dies outright has
no chance to seal; it relies on its locks going only with the Worker, and on the runtime's threads, nested Workers,
going with it. The scopes and the failure classification are in [worker-host.md](worker-host.md).

### Why a database per version

A first protocol kept every version's data in the engine's one database, behind a marker. An upgrade then left an older
host, still running, reading a half-new tree, and files the new version dropped, or turned into directories (`ENOTDIR`
for good), survived. A database per version, emptied before each install and collected only when its data lock is free,
removes both. The engine-data scenarios run under Node and in both browsers, on the asserting and the released runtime:
fresh, present, two hosts at once, interrupted (also while the next host was queued, and over a stray partial tree), an
upgrade beside a running old version, an interrupted upgrade followed by the old version, a stale file and one that
became a directory, a torn marker, sealed data refusing writes, a failed start letting go of every lock, a deletion
blocked past its limit, a stray Node `.marking`, and a waiter outliving its limit on the installer's word, or failing
once the word stops. Each failed against the first protocol or with its defence removed.

## One writer per module's user data

Every tab or Worker running a module mounts the same user database. IndexedDB serializes transactions but not files: two
writers would interleave writes to one file, and each writer's sweep would delete the other's open, unlinked files. So
one host writes and the others read.

- Before it creates the user backend, the host requests `ibus-web:writer:<name>` exclusively with `ifAvailable`.
  Granted, it holds it for the Worker's life and mounts read-write; refused, it mounts with `WASMFS_IDB_READ_ONLY`,
  which also skips the sweep, and posts `storage: read-only`.
- Hosts don't queue for it: a backend can't become writable, so a host that starts read-only stays so, and the page
  restarts it to get a writer.
- The memory fallback is the host's alone and takes no lock. Engine data needs none: it is read-only to every host once
  marked.
- The writer seals its backend before the writer lock goes ([failed starts](#failed-starts)).

In the `writer-lock` scenario two hosts start at once: exactly one writes, the other's writes fail with `EROFS` and it
reads the writer's file through its own backend; once the writer is terminated, the next host takes the lock and writes,
and the reader stays read-only. Before the lock both hosts wrote and both swept, under Node and in both browsers.

Open counts are per connection, so a writer that unlinks a file a reader in another tab has open deletes its inode at
once, and the reader's next read fails with `ENOENT`; engine data, which no one unlinks, isn't affected
([known gaps](known-gaps.md#storage)).

### Restarts

Chromium lets go of the locks of a Worker terminated while it sleeps in `Atomics.wait()`, as the host does between
requests, only some 2 s after `terminate()` (2.0 s in two runs; a host idling in `Atomics.waitAsync()`, its event loop
running, let go at once, its successor ready 0.22 s after). Firefox lets go at once, Node once `terminate()`'s promise
settles. A host started in between would find the writer lock taken and run read-only for good. So the page, having
terminated a host that didn't report `storage: read-only`, waits for the module's writer lock with a queued request it
lets go of at once, bounded at 10 s (after which another tab holds it legitimately), before starting the next host: the
next host was ready 2.2–2.3 s after the terminate in Chromium, 0.2–0.35 s in Firefox and Node. The page package doesn't
exist yet; the test harnesses do this wait (spec §5.6, §8 Restart). A host that dies without the page terminating it
(its renderer out of memory, its Worker crashing) gets no such wait, so in Chromium a restart within those 2 s may come
up read-only.

## Without IndexedDB: the memory fallback

A browser lacks IndexedDB only for an opaque origin (a sandboxed iframe without `allow-same-origin`, a `data:` URL,
where `indexedDB.open()` throws `SecurityError`), where the user or an enterprise policy blocks site data, or where a
third-party iframe is denied storage. Private browsing has it in every browser at the Baseline floor, cleared when the
session ends.

The runtime's memory is fixed once made ([runtime.md](runtime.md)), so the host probes IndexedDB before making it: it
opens the module's database without creating it and closes it at once. If that fails, the module's directory is WasmFS's
memory backend, and the host makes the runtime's memory, and its maximum, larger than the manifest's `memory` by the
data's size: the sum of the manifest's data sizes (unpacked bytes), rounded up to whole 64 KiB pages. That covers the
files' contents, since the installer sizes each file before writing it, so the memory backend allocates each file once
at its size; per-file metadata (WasmFS's file objects and directory entries) comes out of the spare in the manifest's
base memory. A memory this takes past the runtime's maximum fails the memory check, a load failure. The data is
installed at every start, with no lock, and the host posts `storage: ephemeral` with the reason IndexedDB couldn't be
opened; user data lasts only as long as the Worker. A backend that fails to open after the probe succeeded is a load
failure, not this fallback: the memory has been made by then. The memory and Node backends run on the calling thread and
take no pool thread.

## Node hosts

Node, where the runtime runs for tests, has no IndexedDB; that is not the fallback. There `/engines/<name>/` is WasmFS's
Node backend (`wasmfs_create_node_backend`) over `<dir>/user/` of a directory the Node host is given, and each version's
data over `<dir>/data/<version>/`. The backend runs `fs.*Sync` on the calling thread, so nothing is proxied and no pool
thread is taken, and works from pthreads under `worker_threads`. Its limits (32-bit file sizes, `O_WRONLY` opening
`"r+"`) don't matter to engine data.

- **The marker** is the file `<version>.installed` beside the version's directory, outside the tree the engine sees:
  written as `<version>.marking`, synced, renamed over it, the directory synced after where the platform allows. One
  that doesn't parse counts as absent; removal deletes the markers first, so a removal cut short leaves none. A store
  path of an engine's own data has its marker in `<version>.paths/`, `<hash>-<name>.installed`, written the same way.
  Collection lists versions from directories, markers, `.paths` directories and stray `.marking` files alike.
- **Read-only is reported, not enforced.** The host takes the same locks and posts the same states, but the Node backend
  has no read-only mode, so neither a read-only mount, a shut window nor a seal refuses writes.
- **Locks.** Web Locks coordinate the threads of one Node process only, and not reliably even those: Node 24.21.0
  granted one exclusive lock to two `worker_threads` racing for it in about 3% of races (12 of 300 with `ifAvailable`, 8
  of 300 queued; Node 24.21.0) ([upstream/node-web-locks-worker-threads.md](upstream/node-web-locks-worker-threads.md)).
  Node hosts sharing a directory must not start concurrently; the Node suites start their two `writer-lock` hosts one at
  a time and run `install-concurrent` only in the browsers.

## What it costs

### `fsync()` from a thread while the host sleeps

An `fsync()` from a pthread while the host sleeps in `ibusweb_wait` (polling every 2 ms) completes in both browsers: 4.3
ms on the IndexedDB mount in Chromium 149 and Firefox 151, against 4.2 ms on the memory backend, where the poll
dominates. The pthread's create, write, `fsync()` and close are proxied to the backend's own thread, never to the
sleeping host, which is notified directly through `Atomics.waitAsync`. With IndexedDB mounted, 10 of the pool's 12
Workers stayed idle (12 of 12 under Node and in memory): one Worker per backend, the storage share.

### Through the backend

The cost workload is an engine-like dictionary file in the engine's directory: 4,200 KiB, written in 64 KiB `write()`s
and `fsync()`ed, then read at random (4 KiB and 64 KiB reads at aligned offsets), then appended to in 100 64-byte
records, each `fsync()`ed; bytes that look random so no store compresses them, every read checked. Each call was made on
the host's thread from a side module and timed there with `emscripten_get_now()`, so it includes the proxied round trip
and the transaction; single reads were also requested one at a time from the page and timed there. Conditions: released
runtime, Chromium 149 and Firefox 151 headless, each run in a browser of its own with its profile on disk (a shared
browser's contexts are off the record, and Chromium keeps their IndexedDB in memory) on one host's ZFS, five runs per
browser, chunk size and page mode; each figure is the median over runs of each run's median, page spinning / page idle
(`Atomics.waitAsync()`).

| 16 KiB chunks                       | Chromium 149     | Firefox 151      |
| ----------------------------------- | ---------------- | ---------------- |
| random 4 KiB read                   | 155 / 120 µs     | 160 / 140 µs     |
| random 64 KiB read                  | 215 / 215 µs     | 220 / 200 µs     |
| 4 KiB read, page round trip         | 280 / 205 µs     | 280 / 320 µs     |
| 64 KiB read, page round trip        | 480 / 425 µs     | 560 / 640 µs     |
| 64 KiB `write()`, sequential        | 360 / 300 µs     | 380 / 360 µs     |
| 64-byte append `write()`            | 415 / 275 µs     | 300 / 360 µs     |
| its `fsync()`                       | 570 / 475 µs     | 460 / 500 µs     |
| `fsync()` after the 4,200 KiB write | 1,475 / 1,370 µs | 5,100 / 4,960 µs |

- **A lazy 4 KiB read costs a keystroke 0.2–0.32 ms.** No read or write waited for the page's spin: in 30 runs with the
  page spinning, the only late reply came 1.06 s after a 1 s spin, during a disk stall (a single read took 163 ms, 100
  synced appends 2 s), late through the disk, not the page. The calls that held the page past D6's 40 ms were the
  batched ones (the whole write, 256 reads, 100 appends in one request). The longest single read from the page took 24
  ms in Chromium and 21 ms in Firefox.
- The clocks' steps (5 µs in Chromium, 20 µs in Firefox) bound these; means run 10–40% above the medians, and a run's
  mean can be twice another's. A page round trip includes checking the bytes. Reads at unaligned offsets straddle chunks
  more often the smaller the chunk, so aligned reads, if anything, favour larger chunks.
- The `fsync()` rows are a disk sync on ZFS. The first set of runs, whose `fsync()` was an empty strict commit, gave the
  same reads, writes and storage within the runs' spread.
- At 64 and 256 KiB chunks: see [Chunk size](#chunk-size). Random 4 KiB reads were 1.6–3 times dearer at 64 KiB and
  3–4.2 times at 256 KiB; 64 KiB sequential writes 935/905 and 1,820/1,775 µs in Chromium, 380/380 and 700/700 µs in
  Firefox.

### Storage overhead

Measured from the files the browser keeps IndexedDB in (Chromium's `estimate()` agreed; Firefox's leaves out some 280
KiB of its own), the same in every run. Each append rewrites the file's last chunk whole, so 100 appends wrote 0.8, 4
and 10 MiB at 16, 64 and 256 KiB chunks, and the stores keep the rewrites until they compact: the 100 appends (6.25 KiB
of data) added 2.3 MiB in Chromium and 3.2 MiB in Firefox at 16 KiB chunks before the browser closed. Firefox's
write-ahead log holds them until a checkpoint, which closing the browser makes; settled, the whole profile (the file,
its appends and the installed test data) took 5,448 KiB at 16 KiB chunks against 5,328 at 64 KiB (120 KiB, 2.9% of the
file, more) and 5,312 at 256 KiB. Chromium's LevelDB keeps every rewrite until it compacts, which hadn't happened when
the browser closed (7,495 KiB at 16 KiB, 6,661 at 64 KiB, 5,377 at 256 KiB, where it apparently had; one 64 KiB run in
five closed at 14,648 KiB).

### Installing

The installer writes each file's data as it arrives, a 64 KiB piece at a time from the file's start, each `write()` one
write transaction. At the 16 KiB chunks the backend creates, each piece covers four chunks whole, so only a file's last
chunk is written in part. Installing is off the request path, so its cost only delays startup.

## Not built yet

The host API's usage report, export (a tar of the engine directory) and reset, and the `storage` usage events spec §8
gives for quota, are spec §5.6 and §8 for later milestones. WebKit's IndexedDB in Workers is unchecked (spec R5, R13).
Open items are collected in [known-gaps.md](known-gaps.md#storage).
