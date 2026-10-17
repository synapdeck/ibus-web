# M6 Phase 6d: Startup and preloading

Branch `typedrat/m6d-startup-preload`, from `typedrat/m6b-runtime-api`. Spec: `docs/specs/2026-10-12-m6-release.md`,
"6d: Startup and preloading" and the Testing section's 6d line.

## Goal

m17n starts without reading every input method, Rime's settings changes compile only what is open and change the page
size without compiling at all, and a page can fetch, or install, the engines it will want before it selects them.

## Tasks

1. **m17n's index.** The Nix build runs native m17n-lib over m17n-db and writes an `mdb.dir` that names each input
   method's file explicitly, so looking one up no longer reads every `.mim`'s header; the descriptor program writes the
   engine list as IBus engine XML (`engines.xml`), which an ibus-m17n port patch makes the listing read; the variables
   are configured at start only where the page stored a value. Proved by a new check, `m17n-index`, which builds the
   listing both ways (from the index and from every `.mim`) and compares them, checks that `mdb.dir` names every `.mim`
   once, plus `m17n-golden`, `m17n-engines`, `m17n-host` (its recorded start) and `m17n-descriptors` passing.
2. **Rime's live page size.** A librime port patch adds `Schema::set_page_size`; the module stops writing
   `menu/page_size` into `default.custom.yaml` and sets each session's page size when it selects its schema and when the
   setting changes. Proved by `rime-host`: a `page-size` change starts no deployment and the context's next lookup table
   has the new page size.
3. **Rime's lazy compiling.** A settings change writes the patches, then compiles only the schemas of the engines open
   in the Worker and their dependencies; every other schema is stale, recorded per schema by a fingerprint of the
   patches it was compiled with, and compiled when an engine selects it, which an engine does only once its
   dictionaries are installed. An ibus-rime port patch lists every engine's schema, whether or not it holds a session.
   The start deploys every schema only when the shared data isn't the store path the record names. Proved by
   `rime-host`: a change with `rime:rime_ice` open compiles its schemas only, `rime:luna_pinyin` made afterwards compiles
   its own, the Deploy property still compiles everything, and a host restarted over the same user directory deploys
   nothing at start; and by `rime-golden` and `rime-deploy`.
4. **Preloading by fetch.** `preload(entries, options?)` on the facade and the registry: when the page is idle, each
   entry's manifest, `.wasm` and data archives are fetched at low priority into the `ibus-web-preload` cache, keyed by
   URL and the manifest's version, with `preload` events; the Worker's module and archive fetches look in that cache
   first; a module's start deletes other versions' entries. Proved by `core-browser` (cache filled, events, no Worker,
   no storage), `worker-host-browser` (a cached archive is installed with no network fetch, and a start deletes another
   version's entries) and `core-node` (entries validated, unknown module and engine rejected).
5. **Preloading by install.** With `install: true`, a short-lived install-only host per module installs the base data
   and the entries' engine data into IndexedDB and exits, holding the writer lock; a module another tab holds is
   skipped, one this page runs installs through its own Worker. Proved by `worker-host-node` and `worker-host-browser`
   (the install-only host installs and ends with every lock let go, and skips when the writer lock is held) and
   `core-browser` (a later selection installs nothing).
6. **Both modes and m17n's start in the browsers.** The demo gains ahead-of-time Fetch and Install controls, and
   Playwright specs: a Rime engine fetched ahead has its dictionaries in the page's cache and types once selected, one
   installed ahead installs nothing once selected; m17n's start from IndexedDB is re-measured. Proved by
   `integration-checks`' Playwright run; the figures go into `docs/m17n.md`. That a host reads the cache rather than the
   network is proved in task 4 (`preloaded-files`).
7. **Verify the phase.** `nix run .#write-files` (no drift), `nix flake check -L`, `nix build .#integration-checks -L`,
   `nix develop -c hk check --all`.

## Decisions this phase makes where the spec is silent

- **m17n's index format** is IBus's own engine XML, what `ibus-engine-m17n --xml` prints on the desktop
  (`ibus_component_output_engines`), installed as `engines.xml` beside `default.xml`. It holds each engine descriptor
  whole (name, language, description, icon, rank, layout, symbol, …), as the listing builds it after `default.xml`'s
  ranks and the charset filter. The patched listing reads it when it exists and falls back to parsing every `.mim` when
  it doesn't, which is how the descriptor program and the check still get the parsed listing.
- **Explicit `mdb.dir` entries.** m17n-db's `(input-method * "*.mim")` makes m17n read every `.mim` up to its end the
  first time any input method is looked up, so even with the index the first engine would read 2.5 MB. The build
  replaces that line with one entry per input method (`(input-method LANG NAME "file.mim" (version …))`), generated by
  native m17n-lib, so a lookup opens only the files it needs.
- **m17n's variables** are configured at start only where the page stored a value; m17n's own default is the schema's
  default, so an unstored variable needs no call, and each call would read its input method's file.
- **Rime's staleness** is recorded by the module, not read from the compiled configs: librime is built without
  timestamps, so its own check calls every config stale. `build/ibus_web_compiled.txt` maps each schema to a SHA-256 of
  `default.custom.yaml`'s and its own patch's contents when it was last compiled; a schema it doesn't list is as
  prebuilt, with no patches. A full deployment (the first start, a new version, the Deploy property) records every
  schema.
- **"Open"** is the schema of every Rime engine in the Worker, and its dependencies as its compiled config names them,
  whether or not the engine holds a session: a deployment's end ends every session, and the engine makes its next at
  its next key. ibus-rime's port patch 0006 lists them.
- **Rime's start** deploys every schema only when the shared data isn't the store path the record names. librime's own
  check compares file times, and WasmFS gives a file the time at which it first sees it, so it fired at every start.
- **A schema compiled as its engine selects it** holds the engine's keys, as any deployment does, until it ends;
  `rime-golden`'s harness waits for such a compile when it makes an engine.
- **"Its dictionaries finish installing"**: the module hears of an install only through the engine selection that
  follows it, so a stale schema is compiled when an engine selects it, which is after the page has prepared its data.
- **Preload's cache key** is the asset's URL with an `ibus-web-preload` search parameter of the encoded manifest name and
  version (the manifest's `version` is its content identity). The manifest itself is cached the same way; hosts still
  read the manifest from the network, since it names the version every other key needs.
- **Preload progress** counts the bytes of what is fetched or installed, of the total the cache or storage lacked, in
  the manifest's sizes: a `.wasm`'s size, and an archive's unpacked size, credited in proportion to its body as it
  arrives where the response gives a length, so `bytes` and `total` mean what `install` events' do.
- **Idle** is `requestIdleCallback`, or a 1 s timeout where it is missing (WebKit). Entries are fetched one file at a
  time with `priority: "low"`.
- **Errors.** A failed manifest, module or base-data fetch rejects with `EngineLoadFailed`, a failed engine-data fetch
  with `PrepareEngineError`, a refused manifest with `ProtocolMismatch` or `RuntimeAbiMismatch`; an unknown module rejects
  with a plain `Error` before anything is fetched, and an unknown engine before anything but its module's manifest, as
  the other calls do.
- **Install mode's host** is the Worker host started with `HostInit.install`: it runs at the runtime's minimum memory
  with no engine threads, never loads the side module, posts `preloaded` once every scope has closed, and refuses with
  new `StartupRefusal`s, `writer` and `ephemeral`. Without IndexedDB it can't keep anything, so the module's entries
  are fetched into the cache instead. A module whose Worker this page already runs installs through that Worker's
  `prepare`, since its writer lock is this page's; a start of a module waits for its install-only Worker, which holds
  the writer lock the module's own would otherwise go without for good.
- **Cached entries stay** after the data is installed, until a start of their module with another version deletes them.

## Departures from the spec

- **"Runs m17n natively":** the engine index comes from the module's own m17n build under Node (the descriptor
  program), not a native one; native m17n-lib, which loads external modules, would list `ja:anthy` and `en:ispell`,
  which the module can't load. Native m17n-lib generates the explicit `mdb.dir`, where only the files' headers matter.
- **The page size patch** is in librime (`Schema` has no setter); the module sets it on each session.
- **The manifest is not read from the cache by hosts** (above): its version is what every other entry is keyed by.
- **Rime's start deploys less than before**, beyond what the spec asks: only a new user directory or new shared data
  deploys every schema at start (above). Without it, settings changes compiled lazily would all be compiled at the next
  start.

## What the spike proved and what it didn't

The planner's spike clone (`m6d-spike`) and every `m6d-*` scratch directory were gone when this phase started, so
nothing here rests on it. While planning, sources were read, not built: m17n-lib 1.8.6's `database.c` (wildcard
expansion reads each `.mim` to its end in `register_databases_in_files`; `find_database` expands on the first lookup)
and `input.c` (`minput_config_variable` loads the input method), ibus-m17n 1.4.40's listing, librime's deployment tasks
(`ConfigNeedsUpdate` is always true without timestamps; `Schema` has no page size setter), the runtime's factory, the
host's layers and the core registry. Every claim about cost is measured in the tasks, not assumed.
