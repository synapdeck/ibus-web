# Runtime

The runtime is what runs inside each engine's Worker: `ibus-runtime.wasm`, a
main module that carries libc, libc++, `pkgsWasm.glib` ([glib.md](glib.md)),
libffi, the WasmFS IndexedDB backend ([storage.md](storage.md)) and
`libibus-web`, and the engine's side module, which is loaded into it. The
Worker host ([worker-host.md](worker-host.md)) instantiates the runtime,
drives it through `libibus-web` and sleeps inside it between requests.

Each part has a directory under `runtime/`: `runtime/libibus-web/` (the C
library, Meson), `runtime/ibus-runtime/` (the link, the export list, side
modules and their import check) and `runtime/wasmfs-idb/` (the storage
backend). Runtime-wide options are `ibusWeb.runtime.*`
(`runtime/options.nix`).

M1.1 adds the IBus types, emitters, framed dispatcher and GSettings backend.
The Worker host still uses its test transport; protocol transport and page
integration follow in M1.2–M1.4.

## `libibus-web`

A static library built with `pkgsWasm.stdenv` and Meson
(`ibusWeb.runtime.libibusWeb`, `packages.libibus-web`), LGPL-2.1-or-later.
Its runtime API is marked `IBUSWEB_API` (default visibility); runtime internals
are hidden. The separately built IBus library contributes the public engine API. It
links `gmodule-no-export-2.0`: `gmodule-2.0` adds `--export-dynamic`, which
would export every symbol of the runtime past its export list.

### IBus layer

`libibus-web.a` contains the runtime API and private implementation, built with
hidden visibility. `libibus-web-ibus.a` contains the IBus implementation with
default visibility. `libibus-web.pc` links both; `ibus-1.0.pc` supplies engine
compile flags but no library flags, so a side module imports IBus from the main
module instead of linking another copy.

The public layouts, serializable data types, key helpers and schemas come from
IBus 1.5.34. Explicit callback signatures are adapted to the declared GLib types;
layouts and serialization stay compatible. `IBusService`, `IBusEngine`,
`IBusFactory`, `IBusEngineSimple` and `IBusKeymap` are local implementations
against those headers. There is no bus API. The opaque `IBusBus` declaration
only permits engine init signatures that accept an unused bus pointer.
`IBusEngineSimple` is a minimal base: compose, Ctrl+Shift+U and emoji input are
not implemented. `ibus_keymap_get()` returns `NULL`; keymap lookup returns the
input keyval because the page supplies translated keysyms.

The [source inventory](../runtime/libibus-web/src/ibus/README.md) records each
file's origin and adaptations. To update IBus, compare the new release with the
unchanged vendor-import commits, merge upstream changes into the adapted files,
and preserve public layouts and the callback fixes. Regenerate enums and
marshallers with the cross GLib tools, update the inventory and version, then
run the serialization, export, cast-audit and engine checks. Files marked ours
need an API comparison, not replacement with upstream's D-Bus implementation.

### Protocol, dispatch and output

[`ibus-web/protocol.h`](../runtime/libibus-web/include/ibus-web/protocol.h)
defines the request/record numbers, signatures and protocol version. A request
starts with an eight-byte little-endian header (`u16 kind`, `u16 flags`,
`u32 ic`), followed by one normal-form serialized GVariant tuple. Records have
a sixteen-byte header (`u32 len`, `u16 kind`, `u16 flags`, `u32 ic`, `u32 seq`),
followed by the payload and padding to an eight-byte boundary; `len` counts
only the payload. Flags are currently zero. The sequence starts at one and
wraps at 2^32.

Call `ibusweb_runtime_init`, map the schemas/data, and send `Init` with the
settings snapshot **before loading the engine module**: engine initialization
reads settings. Then create contexts and dispatch their requests. The dispatcher
copies request bytes, validates their framing and payload, and calls the engine
signal. It returns 0/1 for `ProcessKeyEvent`, zero for other successful requests,
or a negative errno. It does not pump; the host pumps and drains output after
each request and on wakes.

Errors include `-EBADMSG` for malformed input, `-ENOSYS` for unknown request
kinds, `-ENOTCONN` before Init, `-EALREADY` for repeated Init, `-EPROTO` for a
version mismatch, `-ENOENT` for an absent context, `-EEXIST` for a duplicate
context, `-ESRCH` for an unregistered engine and `-EPERM` off the pumping thread.
A C++ exception becomes a warning and `-ECANCELED`; this does not undo effects
or cleanup skipped while unwinding through C. JavaScript errors and WASM traps
remain host failures.

Emitters serialize owned snapshots immediately. Calls from other threads queue
those snapshots on the default main context; the pumping thread assigns their
sequence numbers and appends them to a mutex-protected `GByteArray`.
`ibusweb_output_peek` returns complete records, valid until the next runtime
call. `ibusweb_output_consume` accepts only complete-record boundaries and
otherwise logs a critical without dropping data. Peek/consume run on the
pumping thread; `ibusweb_output_last_seq` reports the last appended sequence.

The installed GLib log writer emits `Log` records with level, domain and UTF-8
message, respecting GLib's message/debug filtering. Fatal messages also reach
the default writer and terminate normally for GLib; recording them does not
make them recoverable.

### GSettings

Runtime init registers the `ibus-web` backend at priority 1000. With no explicit
`GSETTINGS_BACKEND` override it is the default. Its per-instance store is keyed
by settings path and key, protected by a mutex, and falls back to schema
defaults. Init snapshots are applied silently. `SettingChanged` validates the
schema, key, type and range; a different value notifies listeners, an equal
value does nothing, and neither echoes a `SettingWritten` record.

Engine writes, resets and delayed write-tree transactions notify listeners and
emit `SettingWritten (ssv)` for the page to persist. A transaction validates all
entries and installs the complete batch before notifying. Unknown schemas/keys
return `-ENOENT`, invalid values `-EINVAL`, and relocatable schemas or a
different selected backend `-ENOTSUP`. The page persister and cross-tab bridge
are M1.4 work. Schemas must exist before GLib first obtains its default schema
source; the Hangul data tree includes both the engine and IBus/panel schemas.

### API

All of it is declared in `ibus-web/runtime.h`. Errors are negative errno
values, as Emscripten's libc numbers them.

| Function                                                               | What it does                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ibusweb_runtime_init(wake_word)`                                      | On the thread that will pump: acquires the default `GMainContext` for good and installs the wake hook on it, which bumps `*wake_word`. `-EINVAL`, `-EALREADY`, or `-EBUSY` if another thread owns the context. |
| `ibusweb_pump()`                                                       | Dispatches ready sources without blocking and returns the delay until pumping is due again (below).                                                                                                            |
| `ibusweb_wait(seen, timeout_ms)`                                       | Sleeps while the wake word holds `seen`, running proxied calls meanwhile (below). `0`, `-ETIMEDOUT`, `-EINVAL` before init, `-EPERM` off the pumping thread.                                                   |
| `ibusweb_load_module(path, out)`                                       | Loads a side module and registers it (Side modules, below). `-ENOENT`, `-ENOEXEC`, or the registration's error.                                                                                                |
| `ibusweb_register_module(name, init, out)`, `ibusweb_module_add_op(…)` | Register a module's operations; a registration either adds all of them or none.                                                                                                                                |
| `ibusweb_test_dispatch(request, len, reply, cap)`                      | The test dispatcher (below).                                                                                                                                                                                   |
| `ibusweb_install_begin/feed/count/end`                                 | A streaming ustar extractor that installs an engine's data through the file system; see [storage.md](storage.md#installing).                                                                                   |

`ibusweb_module_init(IBusWebModule *)` is the entry point every side module
defines; the export list's check expects it to be defined by side modules,
not by the runtime.

### The test dispatcher

`ibusweb_test_dispatch()` retains the Worker host test protocol. A request is
a little-endian `uint32` opcode followed by a payload; the operation
registered for the opcode appends its reply to a `GString`, which is copied
into the caller's buffer. It returns the reply's length, `-EINVAL` for a
request shorter than an opcode, `-ENOSYS` for an unknown opcode, `-ENOBUFS`
for a reply that doesn't fit, or `-ECANCELED` if the operation threw a C++
exception. The opcode table is a locked hash table; registrations and
dispatches happen on the pumping thread.

A C++ frame (`src/call-op.cpp`) wraps every operation, because an exception
leaving it would otherwise unwind through the dispatcher's C frames and out
of the runtime. Under `-fwasm-exceptions`, `catch (...)` catches only the
C++ exception tag, so JavaScript errors, Emscripten's `ExitStatus` and
`"unwind"`, and `longjmp()` pass through to the host. An exception that
unwound through C frames (a GLib signal emission, a vfunc called from C)
skipped their cleanup, so `-ECANCELED` says nothing about the state it left.

The operations themselves live in the Worker host's test side modules
(`packages/worker-host/test/sides/`), one opcode list in `test-ops.h` from
which the build prints the values the TypeScript tests read, so no
TypeScript repeats a C value. They cover arithmetic (`add`), GLib wakes and
timers (`idle-later`/`idle-result`, `timeout`), thread creation from a pump,
from a thread and detached (`spawn`, `spawn-nested`, `spawn-detached`),
calls proxied to the host's thread (`proxy-sync`, `task` for a `GTask`),
holding pool Workers (`hold`/`release`), exceptions and crashes (`throw`,
`crash-thread`), files (`fsync`, `write-file`, `read-file`,
`read-file-rdwr`, `list-tree`), memory (`mem-stress`, `glib-stress`,
`mem-info`, `mem-grow`, `js-heap`) and storage costs (`bench-*`).

### `IBUSWEB_RUNTIME_ABI`

`IBUSWEB_RUNTIME_ABI` is **1**, covering the IBus layer and the runtime/output
API. It also versions the IndexedDB backend API in the export list.

### The pump hook

GLib's patch 0017 ([glib.md](glib.md)) adds, on WebAssembly only,
`g_main_context_wasm_set_wake_hook()`: a C function GLib calls whenever the
context's wakeup is signalled, from whichever thread signals it, after its
own futex wake. A hook rather than a word keeps the choice of word and
memory in `libibus-web`.

`ibusweb_runtime_init()` installs a hook that does an atomic add on the wake
word and `emscripten_futex_wake()`s every waiter on it. It acquires the
default context for the Worker's lifetime because GLib wakes a context for a
source attached from another thread only while the context has an owner;
acquiring is recursive, so the pump's own iterations still work. The hook
also runs on the pumping thread during its own pumps (a ready time or poll
fd changing), and sometimes with the context locked, so it calls nothing in
GLib, and a wake promises only that pumping is worth a try.

### The pump

No `GMainLoop` runs. `ibusweb_pump()` takes an iteration apart (prepare,
query, a zero-timeout poll of any fds, check, dispatch) so that it keeps the
timeout `g_main_context_query()` computes, and repeats it until nothing is
ready. It returns:

- the delay in milliseconds until the next source deadline;
- at most 10 ms while any source polls a file descriptor, since an fd turning
  ready wakes nobody;
- `0` after 64 rounds of sources that stay ready (an idle that never removes
  itself), so the host can serve requests in between;
- `-1` when nothing is due until the next wake;
- `IBUSWEB_PUMP_ERROR` (`INT32_MIN`) when called off the owning thread.

Both constants are unmeasured choices. To sleep without losing a wake, the
host reads the wake word _before_ pumping and waits on the value read: a
source attached after the pump last looked has moved the word, so the wait
returns at once. Exceptions a source's callback throws are not caught; they
reach the host and leave the context mid-dispatch.

### The wait

`ibusweb_wait(seen, timeout_ms)` sleeps in `emscripten_futex_wait()` on the
wake word while it holds `seen`, for at most the pump's delay (for good if
negative). Each futex wait on the runtime's own thread ends by running the
calls other threads have proxied to it (`_emscripten_yield` →
`emscripten_main_thread_process_queued_calls()`), and Emscripten wakes that
thread when a call is queued. So while the host sleeps, `pthread_create()`
from other threads, JavaScript library calls proxied synchronously, and the
cleanup of threads that end unjoined (patch 0014, below) all complete. It
always makes at least one futex wait, even when the word has already moved
or no time is left, so a host woken often doesn't starve those calls. A
JavaScript `Atomics.add`/`Atomics.notify` on the word wakes it as the hook
does. The host treats any result but `0` and `-ETIMEDOUT` as a crash.

### Tests

`checks.libibus-web` builds the library with its tests and runs them under
Node through Meson's exe wrapper, failing unless tests ran and none was
skipped. `test-runtime` (g_test, TAP) covers init, the pump (empty, always
ready, off-thread, wake from another thread, deadlines, fd sources), the
wait (timeout, a stale `seen`, wake, proxied calls, off-thread), module
registration, test-dispatch errors and exceptions, and loading side modules
(present, missing, not a module, no entry point). `test-install` covers the
extractor. The suite also covers serialization, key helpers, emitters, engine
signals and caches (including fresh cursor/capabilities/content values inside
non-chaining subclass callbacks and ordinary connected handlers), protocol
validation, logs and settings (69 C cases in total). The real Hangul side module has its own [golden tests](engines.md#golden-tests).
See [testing.md](testing.md).

## `ibus-runtime.wasm`

`packages.ibus-runtime` holds `ibus-runtime.js`, `ibus-runtime.wasm`,
`exports.txt` and `exports.json`; `ibusWeb.runtime.ibusRuntimeAsserting` is
the same link with `-sASSERTIONS=1`, which every runtime test runs beside
the released one.

### Link

`em++` links the static libraries (`libibus-web`, `gio-2.0`, `gobject-2.0`,
`libffi`, `libwasmfs-idb` and its JavaScript library); the export list
decides what of them is linked. The flags (`ibusWeb.runtime.linkFlags`):

| Flags                                                                                              | Why                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-sMAIN_MODULE=2 -sWASMFS=1 -sEXIT_RUNTIME=0` (`toolchain.runtimeMainFlags`)                       | A main module with an explicit export list; WasmFS for its backends; the runtime never exits. See [toolchain.md](toolchain.md#dynamic-linking) for dynamic linking. |
| `-sEXPORTED_FUNCTIONS=@exports.txt`                                                                | The export list, below.                                                                                                                                             |
| `-sEXPORTED_RUNTIME_METHODS=HEAPU8,PThread`                                                        | The host copies requests through `HEAPU8` and tops the pool up through `PThread`.                                                                                   |
| `-sPTHREAD_POOL_SIZE` (12, derived) `-sPTHREAD_POOL_SIZE_STRICT=2`                                 | A pool sized for the planned peak plus spares; a thread beyond it fails with `EAGAIN` (Threads, below).                                                             |
| `-sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB`                                                | GRegex overflows Emscripten's 64 KiB default stack, on any thread.                                                                                                  |
| `-sALLOW_MEMORY_GROWTH=0 -sIMPORTED_MEMORY=1`, `-sINITIAL_MEMORY` 32 MiB, `-sMAXIMUM_MEMORY` 2 GiB | Fixed memory made by the host, of any size between the two (Memory, below).                                                                                         |
| `-sABORTING_MALLOC=1`                                                                              | A full heap aborts; the remedy is a larger memory from the host.                                                                                                    |
| `-sINCOMING_MODULE_JS_API=instantiateWasm,wasmMemory,noExitRuntime`                                | The settings the host passes. `noExitRuntime` must be named, or the runtime's thread exits after a callback and retires its pthreads' Workers.                      |
| `--pre-js=host-memory.js`                                                                          | Refuses to start without `wasmMemory` from the host, rather than make a memory of the least size.                                                                   |
| `-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node`                                      | An ES module factory the host imports by URL, in browsers and under Node (for tests).                                                                               |

The common flags (`-O2 -fPIC -pthread -fwasm-exceptions -mextended-const`)
and the minimum browser and Node versions come from the toolchain
([toolchain.md](toolchain.md#minimum-browser-and-node-versions)). Of what the minimum versions decide,
growable shared buffers (`-sGROWABLE_ARRAYBUFFERS=2`: Chrome 144, Firefox
145, Safari 26.2, Node 26 in Emscripten's feature matrix) stay off, and the
runtime doesn't grow its memory anyway. extended-const turned on with no
effect on the runtime's WebAssembly: the release `ibus-runtime.wasm`
(4,113,037 bytes at the time) and the side modules were byte for byte the
same, since the main module's data sits at fixed addresses and side modules
import every data address through `GOT.mem`.

### The export list

The runtime exports what side modules may import, derived from the build by
`runtime/ibus-runtime/exports.nix` (`ibusWeb.runtime.exportList`), never by
hand: a probe linked with the runtime's flags tells which system-library
variants and JavaScript functions the link uses, and `llvm-objdump` lists
each library's default-visible symbols. `exports.txt` (the
`-sEXPORTED_FUNCTIONS` file) groups them by library under a header with
each library's version and count; `exports.json` holds the same with the
ABI. A symbol two libraries define belongs to the first.

| Library                                        | Version it is identified by   | What it contributes                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libibus-web`                                  | `IBUSWEB_RUNTIME_ABI`         | its `IBUSWEB_API`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ibus`                                         | IBus 1.5.34                   | the default-visible symbols declared by the headers reachable from `ibus.h`, including generated enums                                                                                                                                                                                                                                                                                                               |
| GLib, GObject, GModule, GIO (the subset built) | GLib's version                | their default-visible symbols (GLib is built hidden too)                                                                                                                                                                                                                                                                                                                                                             |
| libffi                                         | its version                   | what `ffi.h` declares                                                                                                                                                                                                                                                                                                                                                                                                |
| `wasmfs-idb`                                   | `IBUSWEB_RUNTIME_ABI`         | what `ibus-web/wasmfs-idb.h` declares, not its C++ internals                                                                                                                                                                                                                                                                                                                                                         |
| Emscripten's API                               | Emscripten's version          | functions, C or JavaScript, declared by `emscripten.h`, `em_asm.h`, `em_js.h`, `console.h`, `threading.h`, `proxying.h`, `eventloop.h`, `heap.h`, `atomic.h`, `stack.h` and `wasmfs.h` less `wasmfs_create_opfs_backend`; not those that work only with Asyncify (stubs that abort here), nor weak hooks. Listed before libc, so it owns those names. html5, webgl, wget, fetch, websocket and `syscalls.h` are out. |
| libc                                           | musl's version + Emscripten's | the whole of `libc`, `dlmalloc`, `noexit`, `stubs`, `sockets`, and the JavaScript-implemented functions musl's headers declare                                                                                                                                                                                                                                                                                       |
| compiler-rt, libc++, libc++abi, libunwind      | the bundled LLVM release      | the whole library                                                                                                                                                                                                                                                                                                                                                                                                    |

Side modules link no system libraries, so every libc, libc++ and builtin
call an engine makes lands on this list. The OPFS backend is out because, in
Firefox, its reads of a file opened read-only wait for the page's main
thread and its other reads lock the file across the origin
([storage.md](storage.md#not-opfs)).

The runtime's ABI identity is that set of versions plus
`IBUSWEB_RUNTIME_ABI`; an engine's manifest records the identity it was
built against (spec §5.3, §5.4.4). `checks.ibus-runtime-exports` checks that
the two manifest files agree with the runtime's copies, that each library is
at the version the build's inputs carry, and that `libibus-web` and
`wasmfs-idb` export exactly what their headers declare.

### The JavaScript surface

The host also uses Emscripten's JavaScript: `HEAPU8`, and the pool's
`PThread` (`unusedWorkers`, `allocateUnusedWorker()`,
`loadWasmModuleToWorker()`). They lie outside the export list, which holds
only WebAssembly symbols, and so outside the ABI identity. `PThread` is
Emscripten's internal pool, not an API; the host refuses to start without
those members rather than fail at its first top-up. A public Emscripten call
that grows the pool and settles once its Workers can run threads would
replace it ([known-gaps.md](known-gaps.md#runtime)).

### Checks

- `checks.ibus-runtime-load` (Vitest under Node, both builds): refuses to
  start without a memory from the host; loads C, C++ and static-library side
  modules and dispatches to them; replies `-ENOSYS` to an unknown opcode;
  provides the JavaScript functions its export list names and runs side
  modules' calls into them; catches a C++ exception an operation throws;
  lets `_Exit()`'s `ExitStatus` through; takes any memory from the least to
  the most, its heap spanning it; on a memory with room above its size,
  never grows it, and aborts when its heap is full.
- `checks.ibus-runtime-exports`, above.
- `checks.ibus-runtime-side-imports`: the import check over its test side
  modules.

## Side modules

An engine is a side module (`-sSIDE_MODULE=1`, `toolchain.sideModuleFlags`):
the engine's glue and its private libraries, linked statically. It defines
`ibusweb_module_init(IBusWebModule *)`, which registers what the engine
offers (spec §5.4).

`ibusWeb.runtime.mkSideModule { name, src, sources, buildInputs,
pkgConfigModules }` builds one against `libibus-web`'s headers: C with
`$CC`, C++ with `$CXX`, and anything else refused. Static libraries named in
`pkgConfigModules` are linked in; one the runtime already carries, such as
GLib, fails the build, since a second copy would have state of its own. The
result's `passthru.importsCheck` is its import check.

`ibusWeb.runtime.checkSideModuleImports { name, modules }` fails if a side
module imports a symbol the export list lacks. It reads imports with
Emscripten's own reader (`tools/webassembly.py`, the one its linker uses):
function and tag imports from `env`, and every `GOT.mem`/`GOT.func` entry,
less the module's own exports and its weak imports. The loader's own
globals (memory and table bases, the stack pointer) aren't symbols. An
engine that calls an Asyncify-only Emscripten function, or a browser API off
the list, fails here when it is built rather than at run time.

**Loading.** The host writes each side module's bytes into WasmFS, at
`/sides/<name>.wasm`, through the runtime's own libc, so they land on
whatever backs the root, then calls `ibusweb_load_module()`. It
`dlopen()`s with `RTLD_NOW | RTLD_LOCAL` (each module's `dlsym()` then finds
its own `ibusweb_module_init`), registers it, and closes it again on any
failure. Emscripten never actually unloads a side module, so a module lives
as long as its Worker.

**Evidence (R3).** Under Node, Chromium 149 and Firefox 151, with
`-sMAIN_MODULE=2` and WasmFS: side modules load into a runtime whose pool
already runs; threads on pool Workers call into them; a C++ exception thrown
in a side module is caught in the runtime; and `dlopen()` while other
threads run works once Emscripten's race on reused `pthread_t`s is patched
(0015, below).

## Waking the host

The host must sleep on one word and wake for two things: a request from the
page, and a GLib source made ready on another thread. The page never touches
the runtime's memory (spec §9.2).

**The wake word lives in WebAssembly memory.** The host allocates it in the
runtime's heap and passes it to `ibusweb_runtime_init()`. Two things bump it:

- **GLib's hook**, from any thread, when a source becomes ready there (a
  `GTask` finishing, an engine library's thread calling `g_idle_add()`).
- **The wake relay**, for the page. The page only writes the control buffer:
  it posts a request and bumps the buffer's `wake` word. The relay, a small
  module Worker the host starts, sleeps in `Atomics.wait()` on that word and,
  for each change, bumps and notifies the wake word in the runtime's
  memory. It needs no event loop turn after startup. It compares the word
  with the value it last forwarded, never with a re-read: a relay that
  re-reads the word after forwarding loses a wake that lands mid-forward, and
  one built that way hung at request 842 of 1000. The relay holds the runtime's memory, so it is
  host-side (spec §9.2 holds).

The host sleeps in `ibusweb_wait()` on that word, for the pump's delay.

### Why the host sleeps in the runtime

The alternative was to have GLib's hook notify the control buffer's `wake`
word and the host sleep there in `Atomics.wait()`. The hook runs on
whichever thread signals, each pthread a Worker with its own JavaScript
realm, so every realm, including those of Workers made after startup, would
need the buffer. Of the ways tried:

- Passing the buffer in the runtime's settings fails: pthread Workers run the
  factory with no settings, and Emscripten's load message forwards none. In
  the run, 54 hook calls on pthreads found no buffer, and `cross-thread-wake`
  failed (attach to dispatch p50 18.0 ms, max 132.7 ms).
- Putting it in Emscripten's `sharedModules` map, which the load message
  clones to every pthread Worker, wakes correctly (p50 0.11 ms, max 0.40 ms,
  16 Workers created after startup), but rests on an undocumented,
  `MAIN_MODULE`-only variable.
- Posting it to each pthread Worker needs code in the pthread realm and a
  hook into Worker creation: the same internals and more. Not run.

All of them fail whatever delivers the buffer, because **a host asleep
outside the runtime never runs the calls other threads proxy to its
thread.** Emscripten proxies `pthread_create()` from every thread but the one
that instantiated the runtime, which holds the Worker pool
(`__pthread_create_js`, `__proxy: 'sync'`), and that thread runs proxied
calls only from its event loop or inside its own futex waits. With the host
in `Atomics.wait()`, a thread creating threads and a synchronously proxied
call hung until the harness gave up after 3 s; a `GTask` pushed from the
host's own thread completed only because `g_thread_pool_push()` blocks in a C
futex wait, which ran the proxied call. A `GTask` started from another thread
hangs.

### What the relay and the in-runtime sleep cost

Measured against a relay-less mode whose host sleeps in `Atomics.wait()` on
the control buffer (the page wakes it directly), released runtime:

- **Node** (v24.20.0, six runs outside the Nix sandbox, nothing else
  running; medians of each run's percentiles): a request that finds the host
  asleep (`cold-wake`, 300 requests spaced 2 ms apart) takes 14.7 µs at p50
  against 11.1 µs relay-less, and 41.5 against 35.6 µs at p99; back to back
  (`dispatch`), 8.0 against 5.7 µs. The relay and the in-runtime sleep
  together cost about 3 µs at the median and 8–16 µs at p99.
- **Browsers** (Chromium 149, Firefox 151, one run): `cold-wake` means of
  37.6–41.0 µs against 20.5–20.6 µs relay-less, about 20 µs more; back to
  back, 1.1–1.4 µs more. Their clocks step by 5 µs (Chromium) and 20 µs
  (Firefox), so the percentiles can't separate the two.

Against a keystroke budget of 40 ms (spec §6.2.6) this is small, but it is a
cost, not noise. The difference is an upper bound on the relay's hop: the
in-runtime sleep also pays for the call into WebAssembly and
`_emscripten_yield` on each wake. The relay-less mode fails the proxied
calls as above. A host idling in `Atomics.waitAsync()` with its event loop
running also passes every scenario, slightly faster (Node `cold-wake` p50
12.2 µs), and is the fallback should patch 0014 be dropped.

One relay per page could serve every engine, through a page-wide doorbell
word and a sequence word per engine; it would still need every engine's
memory, so it would be host-side, shared by the hosts. It isn't built.

### The control buffer

Each Worker has one dedicated `SharedArrayBuffer`, separate from its
`WebAssembly.Memory` (`packages/worker-host/src/shared/control.ts`): a
64-byte header of `Int32` words, then one slot (64 KiB by default) that
carries the request and then its reply.

| Word       | Index | Written by | Meaning                                                                     |
| ---------- | ----- | ---------- | --------------------------------------------------------------------------- |
| `state`    | 0     | both       | `IDLE` 0, `REQUEST` 1, `REPLY` 2, `CRASHED` 3                               |
| `reqSeq`   | 1     | page       | incremented per request                                                     |
| `reqLen`   | 2     | page       | the request's length in the slot                                            |
| `replyRet` | 3     | host       | `ibusweb_test_dispatch()`'s result: the reply's length, or a negative errno |
| `wake`     | 4     | page       | bumped and notified after each request; the relay forwards it               |

The page writes the request, `reqLen`, `reqSeq`, sets `state = REQUEST`, then
bumps and notifies `wake`. The host dispatches, pumps, copies the reply into
the slot, writes `replyRet`, sets `state = REPLY` and notifies `state`; the
page copies the reply out and sets `IDLE`. `CRASHED` is written by the host
when its runtime stops and by the relay when it fails. The output ring,
`replyOutSeq`, the doorbell and the full-ring wait are M1's (spec §6.2).

## Threads

### The pool

A browser starts a Worker created by a thread only once that thread is back
in its event loop (Chromium), or creates one only while the page's main
thread is free (Firefox). The host never returns to its event loop while it
serves, so it can't wait for a new Worker. Threads therefore run on a pool
of Workers made with the runtime, sized for the threads expected alive at
once plus spares, and `-sPTHREAD_POOL_SIZE_STRICT=2` makes a thread beyond
it fail at once with `EAGAIN` instead of waiting for good. Emscripten makes
the pool, and loads the runtime into each Worker, before the runtime runs;
starting it starts no thread.

The size is derived in Nix (`ibusWeb.runtime.threadPool`, from
`runtime/ibus-runtime/package.nix`) from shares, by what starts the
threads:

| Share      | Threads | How it was counted                                                                                                                                                                                                                                                                                            |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GLib       | 3       | What one `GTask` in flight keeps alive, measured under Node and in both browsers: the worker context's thread (`gmain`, where GTask's pool manager runs) and the thread-pool spawner, kept for good, and a GTask worker, kept 15.5 s after its last task (0.5 s in the pool, then 15 s among unused threads). |
| Storage    | 2       | One thread per IndexedDB backend, from mount, for good; a host mounts two (the engine's own files and its version's data). With both mounted, 10 of 12 Workers are idle in both browsers, 12 of 12 under Node and on the memory backend, which run on the calling thread.                                     |
| Engine     | 4       | The most threads a test side module bursts to (`spawn(4)`). An engine's share is meant to come from its manifest.                                                                                                                                                                                             |
| Planned    | 9       | The sum.                                                                                                                                                                                                                                                                                                      |
| `lowWater` | 3       | Spare Workers: GLib's share.                                                                                                                                                                                                                                                                                  |
| Pool       | **12**  | planned + spares                                                                                                                                                                                                                                                                                              |

The engine's share is fixed at link time for now. The design (spec §5.3)
adds it per Worker: Emscripten writes `-sPTHREAD_POOL_SIZE` into the
runtime's JavaScript verbatim, inside the modularized factory where `Module`
is the host's settings object, so the runtime could link with the Nix base
plus `Module["ibuswebEngineThreads"]` (a probe linked that way, base 2 plus
3, started 5 pool Workers). That isn't wired up
([known-gaps.md](known-gaps.md#runtime)).

**Why spares, and why GLib's share of them.** GLib handles a failed thread
creation badly (GLib 2.88, in the paths the runtime uses):

- `g_thread_new()` aborts; `g_thread_try_new()` returns `NULL` with
  `G_THREAD_ERROR_AGAIN`.
- `g_get_worker_context()` starts `gmain` with `g_thread_new()`, so the first
  `GTask` aborts the runtime if no Worker is idle.
- A `GThreadPool` whose spawner can't start returns `NULL`, which GTask
  asserts against.
- `g_thread_pool_push()` that can't start a worker returns `FALSE` but leaves
  the task queued, and GTask ignores the result: the task waits for a worker
  the pool already has, or for good if it has none.

The first `GTask` needs all three of GLib's threads at once. Starting with 3
spares beyond the planned threads means that whenever the host is idle at
least 3 Workers are free, a thread an engine starts beyond its share takes a
spare rather than a Worker GLib counts on, and the host replaces the spares
taken. Threads within the shares never take one, so the pool grows only on
an overshoot. Workers added stay.

The alternative, a pool of the planned threads alone with a top-up to 3 idle
beyond what the shares reserve, has a reserve-adjusted count of 0 from the
start, so it tops up at its first idle moment anyway: the same Workers and
memory, loaded after "ready" instead of with the runtime, through a 47–60 ms
top-up and, in Firefox, a `new Worker()` window while the page may already
be sending keys. Starting with the spares costs their memory up front (What
a pool Worker costs, below) and 15–30 ms of startup (released runtime, one
sandbox run each, with a pool of 11 against one of 8: Chromium 160–171 against
138–164 ms, Firefox 147–156 against 118–131 ms, Node 184 against 163 ms).
The way to save that memory is fewer spares, not a lazier top-up.

**The top-up.** Whenever no request is pending and fewer than `lowWater`
Workers are idle, the host creates the missing Workers through `PThread` and
waits for requests in `Atomics.waitAsync()` with its event loop running until
they have loaded, serving meanwhile ([worker-host.md](worker-host.md#the-pool-top-up)).
Measured (released runtime, Chromium 149, Firefox 151, Node 24): a top-up of
one Worker takes 47–48 ms in the browsers and 74 ms under Node; of three,
54–60 ms in the browsers (asserting runtime 90–106 ms), of which the three
`new Worker()` calls take 0.2 ms in Chromium and 1.0 ms in Firefox.

**Exhausting the pool** (browsers only: under Node, Emscripten ignores
`PTHREAD_POOL_SIZE_STRICT` and creates a Worker beyond the pool, which starts
there anyway). With top-ups held off and every idle Worker taken, one more
thread fails with `EAGAIN` from a pump in 0.5–1.0 ms and from another thread
(proxied to the host) in 4.1–4.3 ms, and the host goes on answering. The
asserting build also logs "the thread pool is exhausted".

**Bursts within the pool** start without an event-loop turn in both browsers:
`spawn(4)` from a pump and `spawn-nested(3)` from a thread create no Worker.
A pool Worker's first thread is the slow case in Chromium, about 12 ms each
(2–5 ms in Firefox), since each loads the runtime and every side module, so
`spawn(4)` on fresh Workers takes 50 ms there (Firefox 18 ms, Node 72 ms),
past the 40 ms keystroke budget. Running a thread on each pool Worker at
startup would move that out of keystrokes; it hasn't been tried.

### Threads that end unjoined

A thread that ends without a join on the runtime's thread (detached, joined
from another thread, or one of GLib's pool workers, which end after their
idle time) was cleaned up in stock Emscripten only from the runtime thread's
event loop: only there did its Worker go back to the pool and its block (a
1 MiB stack, TLS, `struct pthread`) get freed. A host that never returns to
its event loop leaked both. Five rounds of four detached threads, released
runtime under Node, before the fix: heap in use 11.3, 15.3, 19.3, 23.4,
27.4 MiB and 4 Workers created per round, and the run went on to abort with
"Cannot enlarge memory" at the 32 MiB the runtime then had; after it, 0.18 MiB every round and no Worker created.

The toolchain's Emscripten patch 0014 (`pthread-cleanup-blocked-main`,
draft [`emscripten-pthread-cleanup-blocked-main.md`](upstream/emscripten-pthread-cleanup-blocked-main.md);
upstream's #16763 was closed without a fix) has an exiting thread add itself
to a lock-free list and wake the runtime's thread, which drains the list in
`emscripten_main_thread_process_queued_calls()`, inside every futex wait,
`ibusweb_wait()` included. The message to the event loop is still posted for
an idle main thread. The patch holds cleanups off while `dlopen()`'s sync
walks its list of threads, since a thread freed mid-sync would be synced
through its freed struct.

Reclaiming threads early makes an existing race likelier: with dynamic
linking, a joined thread's late "finished" message can mark a new thread
that reused its `pthread_t`, after which every `dlopen()` skips that thread
and its calls into modules loaded later trap. `ibusweb_load_module()` loads
engines while GLib's pool threads may be alive, so the toolchain carries
0015 (`pthread-finished-mark-reused`, draft
[`emscripten-pthread-finished-mark-reused.md`](upstream/emscripten-pthread-finished-mark-reused.md)),
which marks a thread only if it is still known and has exited. Both are
listed in [toolchain.md](toolchain.md#the-patches) and tested by the toolchain's
Emscripten-fix tests.

## Memory

### Fixed per Worker

Each runtime's memory is fixed, made by the host:

- The runtime is linked without growth, so nothing in it can grow its memory
  whatever maximum the memory was given. It imports its memory and refuses
  to start without one (`host-memory.js`).
- Its import is declared from `ibusWeb.runtime.memory.minimum` (32 MiB) to
  `memory.maximum` (2 GiB), so one runtime takes any memory in between.
  Emscripten's JavaScript reads addresses as signed 32-bit numbers unless
  linked for more, hence 2 GiB.
- The host makes a shared `WebAssembly.Memory` of the engine manifest's
  `memory` bytes, maximum equal to its size, after checking it is whole
  64 KiB pages within the bounds; a value outside is a load failure whose
  message gives the value and the bounds. Without IndexedDB, the host adds
  the data's size, in whole pages, to the memory and its maximum
  ([storage.md](storage.md#without-indexeddb-the-memory-fallback)).
- A full heap aborts (`-sABORTING_MALLOC=1`), `g_try_malloc()` and oversize
  `malloc()`s included, so code that handles a failed try-allocation never
  runs. It reaches the host as a crash.
- Without growth support Emscripten's JavaScript doesn't check its views
  before each access.

The size is a manifest field, not a link per engine, so one compiled runtime
serves every engine and the page compiles it once. The rule for computing it
(the runtime's minimum, the side module's `dylink.0` memory, files in the
memory backend, 1 MiB per thread of its share, the heap its checks peak at,
a quarter more, rounded to whole MiB) is spec §5.3; computing it from build
data is M1's. The runtime starts at about 2.3 MiB of heap, and each running
thread adds about 1 MiB, mostly its stack.

GLib's tests and other Node-run test programs use a fixed 512 MiB
(`ibusWeb.toolchain.testMemoryFlags`; GLib's largest test peaks at 280 MiB),
for the same reason ([toolchain.md](toolchain.md)).

### Why not growth

GLib's tests linked with memory growth lost a pthread now and then to
`RuntimeError: memory access out of bounds` (13 of 300 runs of the
many-thread tests under load), and never with a fixed memory. The cause is
in V8:

**V8 bounds-checks atomic accesses against a stale length.** A reproduction
without Emscripten or GLib: the page grows a shared memory a page at a time
and, after each growth, `Atomics.store`s the new page's last word's address
at address 0; sixteen Workers spin in WebAssembly on an atomic load of
address 0 and increment each new address they see. Every reader touches
only memory a sequentially consistent load told it was grown. Of 20 races of
8192 growths each:

- Node 24.19.0 (V8 13.6.233.17) and Chromium 149 trapped in 20 of 20, for an
  atomic read-modify-write following the load with no call between them;
  never for plain loads and stores, an atomic access in a callee or after a
  JavaScript call, or a memory never grown.
- Node with `--no-liftoff`, Firefox 151 and Bun 1.3.13 (JavaScriptCore) never
  trapped. The same race in C through Emscripten's pthreads trapped in 5 of 5
  runs under Node.

Only Liftoff code traps: each instance kept its own copy of a shared
memory's length for bounds checks, which a plain access doesn't need (it
relies on the guard region) and an atomic one does, and V8 told other
threads of a growth through an interrupt, handled at the next stack check, a
call. V8 tracks it as issues 529880019 and 533026477, fixed on its main
branch by CLs 8466625 and 8480479 (merged 2026-09-29 and -30), first in V8
15.7, so Chrome 157 (stable 2026-11-03); no Node release line has them
(Node 24: V8 13.6, 25: 14.1, 26: 14.6). See
[`v8-liftoff-atomics-grown-shared-memory.md`](upstream/v8-liftoff-atomics-grown-shared-memory.md).

**In the runtime's workloads** (each run a host of its own with 100 threads
alive on a pool of 103; growth linked with `-sGROWABLE_ARRAYBUFFERS=1`,
memory from 32 MiB to 2 GiB; fixed at 512 MiB; Node 6 runs at once, browsers
2 pages at once; 32 cores shared with other work):

| Configuration                                             | Node (of 300) | Chromium (of 50) | Firefox (of 50) |
| --------------------------------------------------------- | ------------- | ---------------- | --------------- |
| fixed: allocation stress, GLib's `1bit-emufutex` workload | 0, 0          | 0, 0             | 0, 0            |
| growth: allocation stress                                 | **3**         | 0                | 0               |
| growth: GLib's workload                                   | 0             | 0                | 0               |

All three Node traps were at one `i32.atomic.rmw.add`, a thread incrementing
a word of a block its neighbour had just allocated. GLib's own
`1bit-emufutex` test, 32 copies at once under Node, trapped in 15 of 300 runs
with growth and 0 of 300 fixed at 104 MiB; built with function names, 9 of
another 300 runs trapped, all at a libc++ `shared_ptr` count in WasmFS's
`OpenFileState::create`, under the `open()` of `/dev/urandom` that
`g_rand_new()` makes as each thread starts. The browsers' workloads didn't
trap in 50 runs, but Chromium's V8 has the same bug: fewer runs give the race
fewer chances. Firefox 151's `=2` build never produced a result, as expected
before Firefox 154, where a growable shared buffer doesn't survive
`postMessage` to a pthread's Worker.

The rule set before the measurement was growth unless it traps in some
engine. It traps in V8, and no Node line has the fix, so memory is fixed.
The current suites run both workloads, at the planned thread count in the
runtime's least memory, as correctness tests ([worker-host.md](worker-host.md#tests)).

**What growth would cost** (one run per build, Chromium 149, Firefox 151, Node
on a loaded machine): the first 64 MiB `malloc()`, which a 32 MiB memory must
grow for, takes 15–26 µs fixed against 240 µs (Chromium), 3.4 ms (Firefox)
and 443 µs (Node) with growth; touching it takes 9–27 ms in any build.
Polling the views for growth (the `=1` path in Firefox and Node) cost nothing
measurable per call into JavaScript next to run-to-run noise.

### The imported memory's maximum

Without growth, Emscripten links with `--no-growable-memory` and lowers
`MAXIMUM_MEMORY` to `INITIAL_MEMORY` with a warning, so an imported memory is
declared with its maximum equal to its initial size and the module takes a
memory of exactly that size. The toolchain's patch 0016
(`imported-memory-maximum`, draft
[`emscripten-imported-memory-maximum.md`](upstream/emscripten-imported-memory-maximum.md))
keeps `MAXIMUM_MEMORY` for an imported memory, so the runtime takes any size
up to it, still without growing it.

### What a pool Worker costs

Every pool Worker holds an instance of the runtime. Adding 20 Workers to a
fixed-memory host's pool, each loading the runtime, then running a first
thread on each (which loads the side modules into it), grew the browser's
processes (proportional set size, from `/proc`) or Node's resident set, per
Worker:

|                           | Chromium 149  | Firefox 151   | Node 24       |
| ------------------------- | ------------- | ------------- | ------------- |
| per added pool Worker     | 17.8–17.9 MiB | 11.7–15.6 MiB | 41.4–41.8 MiB |
| per Worker's first thread | 4.4–4.7 MiB   | 2.8–3.1 MiB   | 9.7–9.8 MiB   |

A pool of 11 then cost about 200 MiB in Chromium and up to 170 MiB in
Firefox, 250 and 200 MiB once each had run a thread, on top of the runtime's
memory. A page's budget for an engine is its memory, touched or not, plus
each pool Worker's cost. These figures were taken with a pool of 11 and a
host without Effect, and want re-measuring once the host's and the runtime's JavaScript settle
([known-gaps.md](known-gaps.md#runtime)).

## Browsers and Node

The runtime and its host run the same code in browser module Workers and in
Node's `worker_threads` (tests only, [worker-host.md](worker-host.md#node-hosts-are-for-tests)).
Where they differ:

- **Starting a Worker from a Worker.** Measured without the runtime (Worker
  A creates Worker C, then blocks in `Atomics.wait()` for 3 s): Chromium
  starts C only once A returns to its event loop (3004 ms), whether or not
  the page is busy. Firefox starts C while A is blocked (13 ms), but
  `new Worker()` on a Worker returns only once the page's main thread is free
  (3001 ms with the page spinning). Hence the pool made in advance, and a
  top-up that calls `new Worker()` only when no request is pending: in
  Firefox a request that lands during those calls (about 1 ms) costs at most
  a replay (spec §6.2.6).
- **Blob reads in Firefox** wait for the page's main thread; see
  [storage.md](storage.md#blobs-wait-for-the-page-in-firefox).
- **The page's main thread can't `Atomics.wait()`** in either browser
  ("Atomics.wait cannot be called in this context"; "waiting is not allowed
  on this thread"), so it spins for a reply. `Atomics.wait()` in module
  Workers and `Atomics.waitAsync()` are present in both; the relay starts as
  a nested module Worker in both.
- **The pool.** Under Node, Emscripten ignores `PTHREAD_POOL_SIZE_STRICT`
  and starts a Worker beyond the pool whenever one is needed.
- **Clocks.** `performance.now()` steps by 5 µs in Chromium and 20 µs in
  Firefox (cross-origin isolated), 0.02 µs in Node, and GLib's monotonic
  clock reads the same.
- **A crash** reaches the host as the pthread Worker's `ErrorEvent`, which
  Emscripten rethrows (under Node, an `Error`); both browsers report the
  trapping thread's error.
- **Exception encoding.** `-fwasm-exceptions` emits the legacy encoding, and
  Firefox warns that `try` is deprecated for every Worker that instantiates
  the runtime. The switch to exnref waits for the minimum versions
  ([toolchain.md](toolchain.md), spec R18).
- **Memory growth** traps only in V8 (above).

The released runtime against Node, one sandbox run each (Node 24.19,
Chromium 149, Firefox 151; a pool of 11 and a host without Effect):

| Scenario                                         | Node             | Chromium         | Firefox          |
| ------------------------------------------------ | ---------------- | ---------------- | ---------------- |
| `dispatch` batch mean (ten batches of 100)       | 11.6 µs          | 6.3 µs           | 10.0 µs          |
| `cold-wake` mean of 300                          | 25.9 µs          | 31.6 µs          | 19.4 µs          |
| `cross-thread-wake` attach → dispatch, p50 / max | 0.050 / 0.091 ms | 0.035 / 0.085 ms | 0.061 / 0.120 ms |
| `deadline` (100 ms timeout), worst deviation     | 0.190 ms         | 0.211 ms         | 0.239 ms         |
| `sync-proxied`: `proxy-sync`, `GTask`            | 557 µs, 2294 µs  | 340 µs, 1491 µs  | 419 µs, 2080 µs  |
| `spawn(4)` on fresh Workers                      | 71.9 ms          | 50.1 ms          | 17.7 ms          |

Batch means and the means of spaced requests are finer than the browsers'
clock steps. Calls that held the page past 40 ms were only pumps starting
threads on fresh Workers (Chromium's `spawn(4)` and a burst of three on new
Workers, 49.5–49.9 ms; Node's `spawn(4)`, 71.7 ms). WebKit hasn't been run
(spec R13).
