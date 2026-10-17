# Worker host

`@ibus-web/worker-host` (`packages/worker-host/`, MIT OR Apache-2.0) is the TypeScript that runs in each module's
Worker. It makes the runtime's memory, instantiates `ibus-runtime.wasm` ([runtime.md](runtime.md)), starts the wake
relay, mounts storage and installs the module's data ([storage.md](storage.md)), mounts the Nix store view, and serves
requests, asleep inside the runtime between them. Effect 4 builds the resource scopes; the production request loop is
synchronous TypeScript. The first successful `Init` applies the settings snapshot before the host loads the engine
module, pumps and drains its output, and publishes the reply.

The host implements the output ring and ordered replies. The production [page core](core.md) owns key capture, replay
and client preedit policy; the test Page separately exercises the transport.

## Package and bundles

| Export                          | File                     | What it is                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ibus-web/worker-host`         | `dist/shared/index.js`   | What the page imports: the control buffer's helpers (`createControl`, `postRequest`, `takeReply`, `postMail`), the host messages, the storage names, `HostConfigValues`; with declarations. `Word`, `State`, `ReqMode` and the transport layout live in `@ibus-web/protocol`. |
| `@ibus-web/worker-host/worker`  | `dist/worker/index.js`   | The host's Worker script. It exports nothing; its declarations (`types/worker.d.ts`) give `HostWorker`, a Worker typed to take a `HostInit` and post `HostMessage`s.                                                                                                          |
| `@ibus-web/worker-host/relay`   | `dist/worker/relay.js`   | The wake relay's Worker script, which the host starts from beside its own. It exports nothing (`types/relay.d.ts`).                                                                                                                                                           |
| `@ibus-web/worker-host/storage` | `dist/worker/storage.js` | The storage Worker's script, which the page starts from beside the host's to read, export or reset a module's databases ([storage.md](storage.md#the-host-api)). It exports nothing (`types/storage.d.ts`).                                                                   |

The host also ships `dist/worker/brotli-fallback.js` (291 KB), a separate decoder bundle that the host imports by URL
from beside its own script only when the environment has no native Brotli `DecompressionStream`. Its WASM is embedded in
the script by Rolldown's binary loader, so it needs no adjacent `.wasm` or second fetch. The fallback uses
`brotli-dec-wasm`'s streaming decoder.

`tsdown` builds them (`tsdown.config.ts`), ESM, platform-neutral, with source maps. **Each Worker script is one
self-contained module, Effect bundled in, sharing no chunk with another**: a Worker loads by URL as the file is on disk,
so it can't resolve a bare import, and a page's bundler copies a script found by `new URL(…, import.meta.url)` as it is,
without the chunks it imports. The host finds the relay with `new URL("./relay.js", import.meta.url)`. `dist/shared/`
keeps `effect` external (it imports nothing from it) and gets its declarations from oxc's isolated-declarations
generator, since TypeScript 7 has no compiler API. `effect` is a peer dependency, `^4.0.0` from the workspace catalog.
The test build (`dist/test/worker/`) is the same host with its instruments and a relay that fails on purpose; no export
names it and the package's `files` leave it out. The Worker entries' declarations import the bundled `dist/shared/`
ones, so the build checks them afterwards (`tsconfig.types.json`, with a page's use of `HostWorker` in
`types/usage.ts`).

## Starting a host

A page starts one host per module:

1. The page is cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Embedder-Policy: require-corp` on every response), which `SharedArrayBuffer` needs.
2. It compiles `ibus-runtime.wasm` once (`WebAssembly.compileStreaming`) and sends the `WebAssembly.Module` to every
   host, each of which instantiates its own copy in its own memory.
3. It creates the host's control buffer (`createControl()`) and starts the host by URL,
   `new Worker(url, { type: "module" })`, never inlined into its bundle (spec §9.2).
4. It posts one `HostInit` and waits for `ready` or `error`.

| `HostInit` field            | What it is                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtimeUrl`                | `ibus-runtime.js`, which the host imports.                                                                                                                   |
| `wasm`                      | The compiled runtime; without it Emscripten fetches the `.wasm` itself.                                                                                      |
| `manifest` or `manifestUrl` | Exactly one: an engine manifest (validated again by the host) or the URL of its JSON. Relative module/archive URLs resolve against the fetched manifest URL. |
| `control`                   | The transport SAB; its layout is specified in [PROTOCOL.md](../packages/protocol/PROTOCOL.md#transport).                                                     |
| `layout`                    | Optional slot/ring sizes, matching the buffer; defaults to 64 KiB and 256 KiB.                                                                               |
| `storage`                   | `{ kind: "browser" }` (IndexedDB, or memory without it), `{ kind: "node", hostPath }` (tests), or `{ kind: "none" }`.                                        |
| `test`                      | Read only by the test build; the host as released ignores it.                                                                                                |

The host reads `constants.json` from beside `runtimeUrl` before validating the engine manifest. This runtime
distribution file carries the runtime ABI and identity, protocol version, errno values (`-ECANCELED`, `-ETIMEDOUT`),
pump error, IndexedDB read-only flag, memory bounds, `memoryFileBytes` (what the memory fallback allows each entry of
the data beside its bytes), and `poolLowWater` (the idle Workers the host tops the pool up to). Missing or malformed
constants fail startup with a diagnostic naming `constants.json`.

The page touches only the control buffer and `postMessage`, never the runtime's memory, and no message carries a pointer
into it. What else the page owes its hosts:

- **Spin, then let go.** The page's main thread can't `Atomics.wait()`, so it spins on `state` for a reply, for at most
  its budget (40 ms by default, spec §6.2.6), then waits asynchronously and replays.
- **A reply timeout.** A relay killed without running its own code is silent to a sleeping host; only the page's hang
  detection catches it (spec §8). Ordinary requests use a 2,000 ms inactivity budget; Init alone defaults to 30,000 ms.
  Both require no reply and no ring movement; this does not promise a startup deadline.
- **The writer lock after a terminate.** Chromium lets go of the locks of a Worker terminated while it sleeps in
  `Atomics.wait()` only some 2 s after `terminate()`. Having terminated a host that didn't report `storage: read-only`,
  the page waits for that module's writer lock to come free (a queued request it lets go of at once, bounded at 10 s)
  before starting the module's next host ([storage.md](storage.md#restarts)).
- **No transactions on engine databases.** A transaction the page hasn't seen commit when it starts to spin holds up the
  backend's writes until the spin ends ([storage.md](storage.md#the-page-keeps-out)).

## Messages

After `HostInit` the page posts two kinds of message (`PageMessage`). `PrepareEngine`
(`{ type: "prepare-engine", engine }`) has the host install the engine's own data, where the version's storage lacks it,
before the engine is first made ([storage.md](storage.md#an-engines-own-data)); the host answers each with `prepared`.
`CheckStorage` (`{ type: "check-storage" }`) says one of the module's databases was asked to close for a version change:
the host waits, for at most `closeWaitMs`, until a backend's connection has closed and posts `storage: closed`
([storage.md](storage.md#version-changes)). They travel outside the request slot and the ring, so requests and keys go
on meanwhile. A host asleep in the runtime runs no event loop to hear them, so the page counts each message in the
control buffer's `mail` word too, with `postMail()`, which bumps `mail` and `wake`: the host wakes, sees `mail` changed
and goes to its event loop to take the messages.

A `HostInit` with `install: { engines }` starts a host that only installs, for preloading
([core.md](core.md#layers-and-page-lifetime)): it plans its storage as any host does, but refuses to start, with
`refused: "writer"`, when another host holds the module's writer lock, and with `refused: "ephemeral"` when its storage
would be memory, which would keep nothing. Otherwise it starts its runtime at its least memory with no engine threads,
fetches no engine module, installs the base data as any host does and each engine's own as a `PrepareEngine` would,
answering each with `prepared`, and closes every scope, letting go of every lock, before it posts `preloaded`. It never
posts `ready`, and the page then ends its Worker.

`HostMessage`, every message the host posts:

| `type`             | When                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`            | Bootstrap is complete; storage is mounted and the loop accepts requests. The engine loads on Init. Carries `startupMs`.                                                                                                                                                                                         |
| `storage`          | `ephemeral` (mounted in memory for want of IndexedDB, with why), `read-only` (another host holds the writer lock), `closed` (an IndexedDB connection closed under the host; posted once, when it next wakes or the page has it check), or `quota` (changes failed with `ENOSPC`, with how many since the last). |
| `install`          | How the engine's data was found: `installed` or `present`, with the marker's `files` and `bytes`, the install lock's wait and its `lockedAt`/`releasedAt`, and `installMs`.                                                                                                                                     |
| `collect`          | Other versions' data: `removed`, `inUse`, and `error` if it couldn't look or delete. Collecting never fails a start.                                                                                                                                                                                            |
| `prepare-progress` | While a `PrepareEngine` installs: `engine`, `bytes` of file data written and `total`, the size of the engine's store paths the storage lacked; `bytes` reaches `total` only once every path is installed.                                                                                                       |
| `path-install`     | One store path of the engine's own data: `engine`, `storePath`, `installed` or `present`, with its marker's `files` and `bytes`, `installMs`, and its install lock's `lockWaitMs`, `lockedAt` and `releasedAt` (0 when its marker was there before the lock).                                                   |
| `prepared`         | The end of a `PrepareEngine`: `engine`, and `error` if an install failed. A failure leaves the host serving.                                                                                                                                                                                                    |
| `doorbell`         | A coalesced notification to drain the ring and check reply state.                                                                                                                                                                                                                                               |
| `error`            | The host failed to start; it serves nothing, and stays alive to say why.                                                                                                                                                                                                                                        |
| `crashed`          | The runtime stopped after `ready`; the control buffer already says `CRASHED`, and this says why.                                                                                                                                                                                                                |
| `preloaded`        | An install-only host installed what `HostInit.install` named, or said in `prepared` why not, and has let go of every lock.                                                                                                                                                                                      |

The storage names (`encodeComponent`, `engineDatabase`, `engineDataDatabase`, `engineInstallLock`, `engineWriterLock`,
`engineDataLock`, `engineDir`, `engineDataRoot`) are in `src/shared/naming.ts`; stored data is found by them, so they
never change. Their layout is [storage.md](storage.md)'s.

## The program and its scopes

The host is a scoped Effect program (`src/worker/host.ts`): each resource a `Layer`, each scope inside the last, closed
in reverse.

| Scope           | Acquire                                                                                                                                                                                                                                                                                                          | Release                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker          | Control buffer views; the `Logger` that writes ring `Log` records; an uncaught-error listener, registered up front because a thread's error may already be queued by the time the host stops.                                                                                                                    | With a failure: before `ready`, posts `error`; after it, writes the `Crashed` record if the ring has room, then `CRASHED`, and posts `crashed`. |
| Planned storage | Probes IndexedDB (opens the module's database without creating it, closes it at once), takes the writer lock `ifAvailable`, decides the mount, and sizes the memory from the plan.                                                                                                                               | Lets go of every lock, the writer lock only once the user backend is sealed or was never mounted read-write.                                    |
| Runtime         | Checks the memory's size, makes it, imports and instantiates the runtime, checks its JavaScript surface, allocates the wake word and the request and reply buffers, calls `ibusweb_runtime_init()`.                                                                                                              | Nothing: the runtime ends with the Worker.                                                                                                      |
| Wake relay      | Starts the relay Worker, which bumps a word in the runtime's memory, so it follows the runtime.                                                                                                                                                                                                                  | Terminates the relay.                                                                                                                           |
| Storage         | Mounts the module's own files at `/engines/<encodeComponent(name)>`, posts `storage` events, installs or finds the version's base data and mounts it at `/nix/store`, posts `install` and `collect`, and sets `GSETTINGS_SCHEMA_DIR` to the manifest's `settingsSchemaDir` and `HOME` to the module's own files. | Seals the backends, while the runtime can still be called; their threads and connections end with the Worker.                                   |
| Engine module   | Writes the side modules into WasmFS and loads them after successful `Init`, then warms the pool (The pool top-up, below).                                                                                                                                                                                        | Nothing: side modules are never unloaded, and the page, not the host, sends `Shutdown`.                                                         |

**The storage plan comes before the runtime** because the memory can't grow later: without IndexedDB the data is
installed into a memory backend, and the memory must be made larger by the data's size. **The relay comes after the
runtime** because the word it bumps lives in the runtime's memory. **The schema directory and home are set before any
`Init`**: the host calls the runtime's `setenv("GSETTINGS_SCHEMA_DIR", settingsSchemaDir)` once the store is mounted,
because GLib caches its default schema source on its first lookup, which is `Init`'s, and
`setenv("HOME", "/engines/<encodeComponent(name)>")`, because GLib caches the home directory too. An engine that keeps
files under its home, or under `g_get_home_dir()`, finds its own mount there.

Each successful `CreateEngine` opens an instance scope keyed by `ic`, and `DestroyEngine` closes it synchronously.
Closing the host with the runtime intact dispatches `DestroyEngine` for every open instance, then pumps up to eight
rounds, stopping at the first that leaves nothing due at once, so the engines' finalizers can finish work they queued
without the host chasing a source that keeps itself due; it drains what that wrote and rings the doorbell if it wrote
records, since they belong to no request. A trap skips runtime cleanup; a `DestroyEngine` that returns `-ECANCELED`
drains what the runtime wrote before the fault and stops there. The engine-module scope has no release action: the page
has the modules release what they hold with `Shutdown` (below).

**Finalizers inspect the `Exit`.** After a trap the runtime's memory can't be trusted, so a finalizer that calls into
the runtime (`runtimeFinalizer`, the seals) runs only while the runtime is intact; JavaScript-side cleanup and crash
reporting always run. Whether a failure left the runtime intact is decided **by call site, not by error type**: a
failure outside the runtime (importing or instantiating it, the locks, the probe, the memory check) is a plain
`StartupFailed`; anything thrown from a block that calls into the runtime (a trap, an abort, a WebAssembly exception, a
stack overflow, an error in Emscripten's glue, an `ExitStatus`, `"unwind"`) counts as trapped, unless it is a
`RuntimeRefused`, which the host throws itself for an error the runtime returned or a refusal before a call. After
`ready`, any call into the runtime that throws is a `RuntimeStopped`.

**Nothing depends on finalizers for correctness.** A hang ends in `terminate()`, which runs none; the IndexedDB
connections live on the backends' threads, pool Workers nested in the host's Worker, and close when it ends. What an
engine keeps only in memory, the page has it write with a `Persist` request before it ends the Worker, then has the
modules release what they hold with `Shutdown` ([core.md](core.md#layers-and-page-lifetime)); the host dispatches both
as any other.

### Startup failures

The host fails its start, posting `error`, when:

- the manifest fails to decode as a `ModuleManifest` (the rules are [engines.md](engines.md#distribution-manifest)'s) or
  its numeric runtime ABI or protocol version mismatches (`RuntimeAbiMismatch` or `ProtocolMismatch`);

- the memory isn't whole pages within the runtime's bounds (the message gives the value and the bounds), rather than as
  a `LinkError` or, for a size that isn't whole pages, a silently rounded memory;
- the runtime fails to import or instantiate: a failed `WebAssembly.instantiate()` inside Emscripten's `instantiateWasm`
  hook, which Emscripten never hears of, ends the wait for the runtime instead of leaving the host waiting;
- the runtime lacks `HEAPU8` or the `PThread` members the host uses: better to refuse at once than fail at the first
  top-up after an Emscripten update;
- `malloc()` for the wake word or the buffers fails, `ibusweb_runtime_init()` fails, or the runtime refuses
  initialization;
- storage fails: IndexedDB found but the backend won't open, a lock not granted within the lock limit of the last word
  from its holder, a fetch error or an archive idle too long, an install the installer refuses, a deletion blocked past
  its limit, or a manifest with no version.

A failed host lets go of every lock it took, seals first if it can.

## The request loop

The loop (`src/worker/loop.ts`) is plain functions run as **one synchronous section**: a thread asleep in
`ibusweb_wait()` runs no other fiber, timer or promise, so nothing in it may rely on them, and GLib's time is the wait's
timeout. The section is a single `Effect.try`, so a throw becomes `RuntimeStopped` and writes the `Crashed` record and
`CRASHED` before anything else runs. Each step:

1. If the control buffer's `mail` word differs from the messages taken, leave the section to take them (below). Read the
   wake word, then `state`. Reading the word first means a wake that lands after the state or the pump looked has
   changed it, and the sleep on it returns at once.
2. `CRASHED` means the relay failed (only the relay writes it while the host runs).
3. `REQUEST`: copy the framed request into the runtime's heap and call `ibusweb_dispatch()`. A successful `Init` loads
   the module; successful create/destroy requests update instance scopes. Pump, drain complete output to the ring,
   publish `replyRet` and `replyOutSeq`, set `REPLY` and notify, then apply the `reqMode` doorbell rule. Ring space may
   delay publication, but no pump runs during that wait.
4. Otherwise pump; if no request arrived meanwhile, the host is idle with the pump's delay.
5. Idle with fewer than `poolLowWater` idle Workers (and no failed top-up): leave the section to top up. Otherwise
   `ibusweb_wait(seen, delay)`; any result but `0` and `-ETIMEDOUT` throws.

Before each step the host checks whether either IndexedDB backend's connection has closed, and posts `storage: closed`
the first time one has, and whether more changes through them have failed with `ENOSPC` than when it last looked,
posting `storage: quota` with how many (`src/worker/storage/watch.ts`).

### The ring and replies

The generated [Transport section](../packages/protocol/PROTOCOL.md#transport) is authoritative for the twelve control
words and buffer layout. The ring's size is a power of two from 64 bytes (`MIN_RING_BYTES`) to 2³¹ (`MAX_RING_BYTES`),
so it divides the byte counters' 2³² wrap and a full ring never reads as empty. A framed record never wraps: both sides
skip a tail shorter than a record header (16 bytes, `RECORD_HEADER_BYTES`); otherwise the writer fills an unusable tail
with kind-0 padding, which the reader discards.

When a frame exceeds current free space, the writer emits the largest fragment that fits. Every fragment but the last
carries `CONTINUATION` and at least 8 payload bytes (`MIN_FRAGMENT_PAYLOAD_BYTES`), a multiple of 8, so the next
fragment stays aligned and each makes progress; the last carries the rest of the payload, which may be shorter. The
writer never shortens a fragment to fit before the ring's end: it pads to the end and writes the fragment at the start.
Consecutive fragments keep `seq`, `ic` and `kind`; only padding may separate them. A full write returns `needBytes`, the
least free space with which the next write publishes a fragment, counting any padding or skip before the ring's end. The
reader concatenates fragments before `decodeRecord`. Counts and `replyOutSeq` refer to records, never fragments.

`drainOutput` copies the runtime's whole output batch out of its memory before writing any of it: the pointer
`ibusweb_output_peek()` returns lasts only until the next runtime call, and the full-ring wait is one, inside which a
call another thread proxied to the host can append a record and move the buffer. The host consumes the runtime's output
only once every record of the batch is published.

**The full-ring wait.** The host sets `ringWaiting` to 1, rings the doorbell, reads the runtime's wake word as `seen`,
then checks free space and `ringWaiting` again. It calls `ibusweb_wait(seen, -1)` only if space is still short and
`ringWaiting` is still 1; otherwise, or once it wakes, it starts over from setting `ringWaiting`. The second check of
`ringWaiting` is what keeps partial reads from losing a wake: a page read that lands between setting the flag and
sampling `seen` clears it and spends its wake before the sample, and later reads see the flag clear and bump nothing, so
sleeping on `seen` then would never wake. The host never pumps during the wait. The page advances `ringRead`, clears a
set `ringWaiting`, and bumps and notifies the control `wake`. A relay failure found during this wait is reported at once
with reason `RELAY`.

**`replyOutSeq`** is the `seq` of the last runtime record the host published to the ring for the request, or unchanged
if none; it never comes from `ibusweb_output_last_seq()`. A record a proxied call appends during a full-ring wait isn't
in the batch being drained, so it reaches the ring with the next drain, after the reply, and the reply doesn't count it.

Doorbells are `{ type: "doorbell" }`, posted only when swapping the control `doorbell` word from 0 to 1. The page clears
that word **before** draining. The host rings after output from an idle pump or from the pumps at shutdown, before a
full-ring wait, and after publishing a reply whose `reqMode` is `ASYNC` (1) or `ABANDONED` (2). A synchronous page
writes `SYNC` (0); on timeout it compare-exchanges that to `ABANDONED` and rereads `state`. Either the host sees
abandonment or the page sees the reply, so neither side can miss completion.

Test operations occupy request kinds `0xff00`–`0xffff`. Only test instruments intercept them and call
`ibusweb_test_dispatch()`, placing reply bytes in the slot. The production loop sends every kind to
`ibusweb_dispatch()`, which rejects those reserved test operations with `-ENOSYS`.

### Excursions

The loop leaves its synchronous section for two kinds of work that need the event loop: topping the pool up, and the
page's messages. In both the host serves and pumps as it would asleep, but waits with `Atomics.waitAsync()` on the wake
word, raced against the work, and returns to the section once the work is done.

**The page's messages.** The host takes each as it arrives, as many as `mail` counts, and prepares its engine at once,
beside the prepares still running: each of the engine's store paths that lacks a marker is installed under a lock of its
own, one install serving every engine that needs the path, posting `prepare-progress` and a `path-install` for each
path, then `prepared` (`src/worker/install/prepare.ts`). It returns to its section once every prepare has ended and no
message waits. The loop checks `mail` only after reading the wake word, so a message posted after the check has moved
the word the host then sleeps on. Requests are served between the installs' steps, so the keys of the engines already
made go on. A call into the runtime that throws while installing stops the host as any trap does; every other failure is
the install's, reported in `prepared.error`.

### The pool top-up

The top-up runs only while no request is pending. Threads beyond the pool fail with `EAGAIN`
([runtime.md](runtime.md#threads)), and a browser starts (Chromium) or creates (Firefox) a Worker only while its
creator's event loop runs, so the host adds Workers from its event loop:

- `PThread.allocateUnusedWorker()` creates each Worker; the host takes it straight back out of `PThread.unusedWorkers`,
  since `pthread_create()` hands out any Worker there, loaded or not, and a thread on one that hasn't loaded would wait
  for an event loop the host then blocks.
- `PThread.loadWasmModuleToWorker()` sends it the runtime; once it reports loaded, the Worker joins the pool.
- Meanwhile the host serves and pumps as it would asleep (above), its waits raced against the loads.
- A top-up that hasn't finished within `topUpLimitMs` (10 s) is logged as an error, and the host tops up no more;
  Workers that load later still join.
- Once a top-up's Workers have joined, and once the engine module has loaded, the host runs a thread on every idle
  Worker with `ibusweb_warm_pool()`, so a Worker's first thread, about 12 ms in Chromium, never falls in a request
  ([runtime.md](runtime.md#the-pool)). The test instruments don't count those threads among the engine's.

Measured: one Worker in 47–48 ms in Chromium 149 and Firefox 151, 74 ms under Node; three in 54–60 ms in the browsers
([runtime.md](runtime.md#the-pool)).

### The wake relay

`src/worker/relay.ts` and `forward.ts`. The relay gets the control buffer's `wake` word and the runtime's wake word,
says `ready`, then loops for good: `Atomics.wait()` on `wake` against the value it last forwarded; on a change, bump and
notify the runtime's word. Changes that land while it forwards fold into one wake, which is all a waiter needs. Why the
host sleeps in the runtime rather than on the control buffer is [runtime.md](runtime.md#waking-the-host).

If the relay throws, it writes `CRASHED` to the control buffer and bumps both words, so a host asleep on either wakes,
finds `CRASHED` and reports `relay: …`; a host asleep in the runtime would never hear the relay's `error` event. An
`error` event the host does hear in its event loop (during a top-up) is handled the same way.

## Crashes

After `ready`, a failure writes a `Crashed (us)` record, if the ring has room without waiting, then sets
`state = CRASHED` and notifies, and posts `crashed`. The control state is authoritative; the record comes first so that
a page draining once on seeing `CRASHED` finds it. The exception is `RELAY`: the relay itself sets `CRASHED` before the
host hears of the failure, so the record follows it. The reasons:

| Reason  | Value | When                                                                   |
| ------- | ----- | ---------------------------------------------------------------------- |
| `TRAP`  | 1     | A runtime call threw: a trap, an abort, or another thread's crash.     |
| `FAULT` | 2     | An engine threw a C++ exception, which the runtime caught.             |
| `RELAY` | 3     | The wake relay failed.                                                 |
| `LOAD`  | 4     | The engine module failed to load after a successful `Init`.            |
| `HOST`  | 5     | The host itself failed, for instance runtime output it couldn't frame. |

The record's message is what is known at once; for a thread's crash, which reaches the host as `"unwind"`, it says only
"a thread crashed". The `crashed` message waits briefly (`crashWaitMs`) in the event loop for the thread's own error and
carries the full report. Host-written `Log` and `Crashed` records have `seq = ic = 0` and do not advance `replyOutSeq`;
runtime sequences skip zero when they wrap. The protocol's decoder rejects a `Crashed` record with another reason
(`SchemaError`) or with a nonzero `seq` or `ic` (`CodecError`).

**Faults.** On `-ECANCELED` the host drains the output the runtime already wrote, publishes the reply under the
`reqMode` doorbell rule, then writes `Crashed` with `FAULT` and sets `CRASHED`, so the page reads the request's records,
then its reply, then the crash. An engine that faults outside a request, in a source on the host's thread or a handler
on another, ends the host the same way once the pump that finds it has drained the output. Either way the message is
`an engine threw: <what()>`, from `ibusweb_fault_reason()`, and the runtime's own warning precedes it in the ring. No
dispatch or pump runs after it. A module the runtime refuses to load likewise has its output drained before the `LOAD`
crash, so the runtime's account of the failure precedes the record. A trap skips runtime finalizers; JavaScript cleanup
still runs. A relay killed outright cannot report itself, so page-side hang detection is still needed. Restart uses the
same bootstrap and `Init`-then-load order.

## Storage and engine data in the host

What is stored and how, the locks' meanings and the measurements behind them are [storage.md](storage.md)'s. The host's
part (`src/worker/storage/`, `src/worker/install/`):

- **Plan** (`plan.ts`): `browser` storage probes IndexedDB first; without it (an opaque origin, blocked site data, a
  denied third-party iframe), the mount is memory and the memory grows by the data's size, in whole pages
  (`memoryWithData`), with `memoryFileBytes` for each entry of the data besides. With it, or with `node` storage, the
  host requests the module's writer lock `ifAvailable`; refused, the user backend is mounted read-only
  (`WASMFS_IDB_READ_ONLY`, which also skips the backend's sweep). Hosts don't queue for the writer lock: a backend can't
  become writable, so the page restarts a host to get a writer.
- **Locks** (`held.ts`, `locks.ts`): every lock goes into one `Held` set, released together, the writer lock only once
  the user backend is sealed.
- **Install** (`provide.ts`): the version's data lock, shared, for the host's life; then its install lock, exclusive;
  the marker read; if absent, the version's storage cleared; a mount with its window shut; if the marker was absent, the
  window opened, the base archives streamed in 64 KiB pieces through the tar decoder and written entry by entry through
  `FS`, the window shut, and the marker written last. The install lock goes as soon as the data is there; the host then
  collects other versions whose data lock it gets exclusively at once. A memory mount installs every archive at every
  start with no lock. The data backend is sealed as the host closes.
- **Preloads** (`preloaded.ts`): the module's `.wasm` and every archive come from the page's preload cache when it holds
  them for this version, and from the network otherwise; collecting other versions deletes their preloaded files
  ([storage.md](storage.md#preloaded-files)).
- **Prepare** (`prepare.ts`, `staging.ts`): each of the engine's store paths' markers read, and each path without one
  installed under its own install lock and progress channel, joining an install of it already running in this Worker:
  extracted under a staging name beside the store path and moved onto it by one rename, then marked; the window, shared
  by overlapping extractions, open while any runs.
- **Progress**: an installer says it is still going, every `progressIntervalMs` for as long as it holds the install
  lock, from acquiring it to releasing it, on a `BroadcastChannel` named after the install lock. A host waiting for that
  lock gives up only after `lockLimitMs` without word, so a slow install is waited for and a dead one isn't.
- **Lock waits** are requests of `lockRoundMs` each, made again when they time out, because Node grants a request
  already queued for a terminated `worker_thread`'s lock only once another request arrives.

## Configuration

Every limit the host keeps is in `HostConfig`, an Effect service provided as a `Layer`, never module constants, so tests
can shorten them. `HostConfig.layer` holds the defaults; `HostConfig.layerWith(overrides)` replaces some.

| Value                | Default | What it bounds                                                                                        |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `topUpLimitMs`       | 10 s    | A pool top-up, from its first new Worker to its last loaded; far longer than one takes (under 0.2 s). |
| `crashWaitMs`        | 1 s     | The wait for a crashed thread's error, or the relay's.                                                |
| `lockRoundMs`        | 1 s     | Each request of a lock wait.                                                                          |
| `lockLimitMs`        | 120 s   | A lock wait without word from its holder.                                                             |
| `progressIntervalMs` | 1 s     | The interval at which an installer says it is going, while the install lock is held.                  |
| `archiveIdleMs`      | 30 s    | An archive that sends nothing for this long fails its install.                                        |
| `deleteLimitMs`      | 10 s    | A database deletion blocked by a connection that doesn't close when asked.                            |
| `closeWaitMs`        | 1 s     | A `CheckStorage`'s wait for a backend's connection to close.                                          |

`Instruments` (`instruments.ts`) is a `Context.Reference` whose default does nothing: hooks where a test build observes
and steers the host (stats, event-loop turns, holding top-ups, stalling an install or a path's marker, the staging trees
it sweeps, making a seal throw). The production entry (`src/worker/index.ts`) provides `HostConfig.layer` and no
instruments, and never reads `HostInit.test`; the test entry (`test/worker/host.ts`) reads it for configuration
overrides and provides the instruments. Nothing a manifest or a page puts in `HostInit` reaches them in the released
host, and a test checks that it ignores `test`.

## Node hosts are for tests

The host runs under Node's `worker_threads` only for tests (`storage: { kind: "node" }`, WasmFS's Node backend over a
host directory). Under Node:

- **Web Locks don't reliably exclude.** Two `worker_threads` that request the same exclusive lock at the same moment are
  both granted it in about 3% of races (12 of 300 with `ifAvailable`, 8 of 300 queued; Node 24.21.0); draft
  [`node-web-locks-worker-threads.md`](upstream/node-web-locks-worker-threads.md). Two Node hosts started together can
  then both become writer, or both install one version. The Node suites start hosts that share storage one at a time,
  and `install-concurrent` runs only in browsers. Web Locks under Node span one process only in any case.
- **Nothing enforces read-only.** The Node backend has no read-only mode or seal: the writer lock and
  `storage: read-only` are reported, but a reader's writes succeed, and a Node mount never holds the writer lock back
  after a trap.
- **No IndexedDB**, so no `storage: closed`; the memory fallback is exercised by a host told to mount browser storage.
- **Emscripten ignores `PTHREAD_POOL_SIZE_STRICT`**, so the pool can't be exhausted.

## Tests

`checks.worker-host-node` runs the deterministic Node units: archive, decompression, held locks, host output, install
lifetime/progress, naming, scopes, startup, storage plan and storage watch. `checks.worker-host-browser` runs
`protocolRoundtrip` and `replySequence` with real Workers on both runtime builds in Chromium and Firefox, eight smoke
cases.

The complete matrices run as `packages.worker-host-node-integration` and `packages.worker-host-browser-integration`,
also included in `packages.integration-checks`. Node integration retains every `test/node/*.test.ts`, including the
runtime matrices `engine.test.ts`, `protocol.test.ts`, `ring.test.ts` and `scenarios.test.ts`. Browser integration
retains `engine.test.ts`, `layers.test.ts`, `protocol.test.ts`, `ring.test.ts` and `scenarios.test.ts`; the new
`smoke.test.ts` runs only in the default gate. These matrices preserve the contention, tight heartbeat timing and stress
scenarios. Run both with `nix build .#worker-host-node-integration .#worker-host-browser-integration -L`. CI runs the
extended aggregate separately and requires both tiers before publication.

All host targets use a selected workspace containing the host and its protocol and test-programs dependencies.
Source-only edits to other packages do not rebuild them. The integration and browser smoke configurations use Chromium
and Firefox (Playwright's headless builds from nixpkgs), against the asserting and released runtime. Nix hands them a
manifest (`IBUS_WEB_WORKER_HOST_TESTS`): both runtimes, the test side modules and engine manifests, the constants the C
side defines, Emscripten's errno values, the install test archives, the pool's size, shares and `lowWater`, and the
stress workloads' sizes. `checks.worker-host-side-imports` checks the side modules' imports. Frameworks and running them
locally are [testing.md](testing.md).

The tests play the page: a blocking client spins up to 1 s for each reply, then waits up to 30 s more, and a reply that
needed the page to let go fails the test as a late reply. Under Node the host runs in a `worker_thread` given a
browser-shaped `Worker`. Expected output is asserted and never printed: every line the host's threads print is captured
(Node: `fs.writeSync` on fds 1 and 2 redirected into a file, since a sleeping host's `process.stderr` never flushes;
browsers: Workers' console messages), each test takes the lines it expects, and anything else fails it.

| Group                     | Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| One host, in order        | `dispatch`, `cold-wake`, `thread-create-blocked`, `pool-top-up`, `thread-exit-blocked`, `cross-thread-wake`, `deadline`, `sync-proxied`, `exceptions`; `pool-exhausted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | all; `pool-exhausted` in browsers                                                                                                       |
| Hosts of their own        | `thread-crash`, `heap-full`, `mem-stress`, `glib-stress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | all; `heap-full` under Node                                                                                                             |
| The host                  | fails to start when instantiation fails; refuses a memory the runtime can't take; reports a failing relay as a crash; logs a top-up that doesn't finish in time and tops up no more                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | all                                                                                                                                     |
| Storage                   | `storage-roundtrip`, `promise-proxied-fsync`, `storage-costs` (correctness only), `storage-fallback`, `storage-closed`, `storage-closed` without a wake (a version change while the host sleeps, which `CheckStorage` reports), the storage Worker over what a host stored (its usage, an older version's data among it, its export whole across chunks, its reset closing the host's connection), `writer-lock`; lock release on a crash with the runtime intact, a seal that throws, a trap, a failed start                                                                                                                                                                                                                                                          | all; both `storage-closed`, the storage Worker and the throwing seal in browsers                                                        |
| An engine's own data      | `prepare-fresh`, `prepare-skip`, `prepare-concurrent`, `prepare-shared`, `prepare-race`, `prepare-after-mount`, `prepare-interrupted`, `prepare-moved-unmarked`, `prepare-whole`, `prepare-window-shut`, `prepared-distribution`, `prepared-in-memory`, `preloaded-files`, `preload-collected`, `install-only`, `install-only-writer-held`                                                                                                                                                                                                                                                                                                                                                                                                                             | all; `prepare-race`, the preloads and `install-only-writer-held` in browsers; the window's refusals only recorded under Node            |
| Engine data               | `install-fresh`, `install-skip`, `install-concurrent`, `install-interrupted`, `install-interrupted-queued`, `install-interrupted-stray`, `install-torn-marker`, `upgrade-while-running`, `interrupted-upgrade-then-old`, `stale-file`, `failed-start-releases-locks`, `data-read-only`; a blocked deletion; a stray `<V>.marking`; a lock wait that outlives its limit while progress arrives, and one that fails when it stops                                                                                                                                                                                                                                                                                                                                        | all; `install-concurrent` and the blocked deletion in browsers, the stray marking under Node; `data-read-only` only recorded under Node |
| The installer             | on a memory mount of its own, through `HostOp.install` and `HostOp.fs`: the test tree whole in pieces of 7 bytes to 1 MiB, its counts, and over a half-written tree, and an archive of pax headers byte by byte; refused archives (absolute, `..`, outside the store path, hard link, FIFO); malformed ones (a broken checksum, cut short mid-header, mid-file, between members and before the end-of-archive blocks, a lone zero block, trailing bytes, a signed checksum); the size limit; modes; symbolic links; a name and a link target longer than ustar's; never writing through a link; its directory; a 16 MiB file in its own size; 451 small entries within `memoryFileBytes` each beyond their data; each `FS` call it makes, failing, giving libc's errno |
| The host as released      | `dispatch`, `thread-crash`, `relay-failure`, and that it ignores `HostInit.test`, on the shipped `dist/worker/` files (served raw in browsers, as a page would serve them)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | all                                                                                                                                     |
| Units                     | `Held`'s release rules; what the storage watcher posts of closed connections and quota failures; the storage names' encoding; what `modern-tar`'s strict decoder refuses and takes; the installer's checks of each entry, its 64 KiB writes, and closing a file after an errno but not after a trap                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Node                                                                                                                                    |
| Layers (`@effect/vitest`) | `HostConfig`'s defaults and overrides; `runtimeFinalizer` after a normal close, an intact failure, and each kind of throw; the Worker scope's reports (failed start, crash with `CRASHED` written, the thread's error after `"unwind"`, one that never arrives, a foreign uncaught error left alone, log records, defects)                                                                                                                                                                                                                                                                                                                                                                                                                                             | browsers                                                                                                                                |

Each scenario's criterion is its assertion: every sum right in `dispatch`; in `cold-wake` spaced requests finding the
host asleep; `cross-thread-wake` every source dispatched, never before its attach and within 500 ms of it, with
`-ENOENT` before any work and `-EBUSY` for work already pending; `deadline` never before 100 ms and within 200 ms;
bursts within the pool creating no Worker and taking no event-loop turn; `pool-top-up` growing the pool only past the
planned threads, back to `lowWater` idle; flat heap over rounds of detached threads; GLib keeping exactly its share
after a `GTask`; `-ECANCELED` for a thrown exception and a working host after; the memory workloads at the planned
thread count in the runtime's least memory with no trap, corruption or refused allocation. Where a criterion is a time,
the suites assert only its one-sided part under a bound generous enough for a loaded machine, since CI runs them beside
other builds; the design's tighter figures (`cold-wake` at least 95% asleep, `cross-thread-wake` at most 20 ms at the
median, `deadline` within 10 ms) aren't asserted, and every run records the measured figure for each, as it does all
other timings. In the Nix sandbox, with the suites running in parallel, round trips took 15–65 µs at the median and the
pool's top-up of one Worker 45–140 ms, a few times the quieter figures in [runtime.md](runtime.md). `storage-costs`
checks correctness only: its bench requests each do many keystrokes' worth of I/O, so they hold the page for as long as
they take (up to 60 s) rather than the 1 s budget, and nothing in it is timed.

Bounds that wait for something to happen (a lock's release, a crash report, a printed line) are 10 s or more, reached
only when it never happens. A test build's host waits 10 s for a crashed thread's own error (`crashWaitMs`); the host as
released waits its default 1 s, so its crash report isn't required to carry the error, whether a thread's or, in
`relay-failure`, the relay's, only to say which failed. Printed output is settled by a round trip, not a sleep: under
Node the threads' writes are synchronous, and in a browser a line printed by a Worker started for the purpose arrives
after every line printed before it.

### Transport and Hangul conformance

The host checks include ordered replies, idle-pump output, coalesced doorbells, SYNC/ASYNC/ABANDONED completion, padding
and fragment reassembly, repeated full-ring waits, partial-read wake races, a record appended during a full-ring wait
(`fullRingAppend`: the reply names only the request's commit, and the appended record follows it), faults and relay
failure during back-pressure. The abandoned-reply case orders itself by the test build's `replied` instrument, which
reports each published reply with the `reqMode` the host read for it, so the page gives up spinning only after the host
has read `SYNC`. Manifest mismatch and native/forced-fallback archive cases use the same bootstrap as production; the
test build reports which Brotli decoder each archive went through.

`checks.hangul-host` runs the real Hangul distribution through a Node Worker and the test Page, ten cases on each
runtime build. It checks composition, Hanja paging and page-relative clicks, Init settings and later changes, context
recreation/independence, surrounding text, forwarding, focus, and repeated lifecycle resource use. Each request checks
decoded record ordering and `replyOutSeq`; GLib warning/error/critical records fail. Hanja paging uses
`ProcessKeyEvent`, matching the golden path. A test-only action performs a real GSettings write because upstream Hangul
exposes no suitable writing action; it verifies `SettingWritten` transport, not an upstream UI action.

An engine module's suite, `test/engines/<suite>.test.ts`, runs under Node in place of the host's own suites when
`IBUS_WEB_MODULE_TESTS` names its description: the module distributions it starts hosts from, the heap and pool it is
held to, and texts its build computed. Its `PageSession` takes the Init settings, the engine each context creates and
what follows creation; a critical or error record fails the exchange that brought it, and so does a warning unless it
falls within a deployment, which the options name by the messages the module logs as one starts and ends, and which the
module's first start counts as; `deploymentWarnings` keeps those. Every record through a reply's `replyOutSeq` must have
been read with it, and one past it may have been: the host keeps pumping after it publishes a reply, so a record another
thread emitted meanwhile reaches the ring before the page takes the reply. `key` expects the engine to consume a press,
and `press` reports whether it did, for a key the engine may decline. `checks.hangul-host`, `checks.table-host`,
`checks.mozc-host`, `checks.m17n-host` and `checks.rime-host` are such suites; a suite's `PageSession` prepares an
engine with data of its own before creating it, as the page does.

The heap's measured peak (`mallinfo()`'s `usmblks`, the most the allocator has taken from the heap's base, side modules'
static data included) was 1,624,192 bytes asserting and 1,626,368 released, below the 6 MiB `heapBytes` declaration,
which the harness checks it against as `heapPeak`. The initial and peak pool size was eight, and checked-out pthread
peak was zero, supporting a zero engine-thread declaration for this workload. These are Node storage workload results,
not universal heap or browser pthread bounds. The harness uses reserved test instruments for statistics; it never reads
WASM memory from the page. The golden C harness remains separate: 16 behavior cases and a run-completion check, 17
reported tests.
