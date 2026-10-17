# M6 Phase 6a: Data safety and storage

## Goal

No silent loss of a user's data, and the storage API the design spec promised (spec
`docs/specs/2026-10-12-m6-release.md`, "6a: Data safety and storage", and its Testing section): a module that can't
write its user data knows it and works without it, no recovery path deletes a database, a failed held write reaches
LevelDB, a stored setting one module's schema rejects no longer fails another's start, m17n's `Init` stops growing with
its instance count, a closed connection is reported at once, the memory fallback counts WasmFS's per-file cost, and the
facade gains `storage.usage()`, `storage.export()`, `storage.reset()` and `quota` events. Runtime ABI and protocol
version stay 1. The branch is `typedrat/m6a-data-safety`, from `typedrat/m6b-runtime-api`.

## Tasks

Each task is summarized with the checks that prove it, not spelled out step by step.

1. **Init says whether user data is writable.** `Init` gains `userDataWritable`; the runtime keeps it and exposes
   `ibusweb_user_data_writable()`; the page sends `false` after the host reported `storage: read-only`. Proven by
   `protocol-node` (signature), `libibus-web-tests` (`/dispatch/protocol` reads it back), `core-node` (the registry's Init
   after a read-only start) and `protocol-parity`.
2. **Settings declared by pattern.** Settings metadata gives a relocatable schema an optional `pattern`, which
   `mkEngineManifest`'s `settingsPatterns` declares and checks against its paths; `Init` gains `patterns`, and carries
   a patterned schema's instances only where values are stored; the runtime's backend accepts a path a pattern matches.
   m17n and Rime declare theirs. An `Init` past the slot fails with a `ProtocolError` naming both sizes. Proven by
   `libibus-web-tests` (settings by pattern), `engines-settings-metadata`, `core-node` (Init contents, the error) and
   `m17n-host` (many stored instances in one `Init`).
3. **Stored settings a schema rejects.** The page passes stored records through without validating them against the
   schema, so the runtime's backend skips one it rejects with one warning naming path and key, and `settings.get`
   returns the default for it. Proven by `core-browser` (settings) and `libibus-web-tests` (a rejected Init value).
4. **Read-only Rime.** Told its user data isn't writable, the module disables every user database class, starts no
   maintenance and writes no patches. Proven by `rime-host`: a second host on the same storage, read-only, types, opens
   no user dictionary, schedules no recovery and resets no session.
5. **Read-only Mozc.** Told the same, the module keeps Mozc's config in memory, writes no IBus config and makes the
   engine's `Sync` do nothing. Proven by `mozc-host`: a read-only host converts, learns within its life and leaves the
   user directory byte for byte as the writer left it.
6. **Rime's recovery.** librime port patch 0005: an open that fails for anything but corruption disables that user
   dictionary until Rime restarts and logs a warning; only `Corruption` schedules the repair; a failed repair moves the
   database aside under a timestamped name and starts empty, and never deletes one. Proven by `rime-userdb` (an I/O
   error, a corrupt database repaired, a repair that fails).
7. **Held log writes.** A held log write that fails is kept, and every later write, flush, sync and close of that file
   returns it. Proven by `rime-userdb` (a failed held write: the next commit fails and nothing more reaches the log).
8. **Quota events.** The IndexedDB backend counts changes that failed with `ENOSPC`
   (`wasmfs_idb_backend_quota_failures()`); the host posts `storage: quota` when either mount's count grows; the
   registry and the facade pass it on. Proven by `wasmfs-idb-browser` (`errors`), `worker-host-node` (the check) and
   `core-node`.
9. **Closed storage without a wake.** The page keeps a connection to each of the module's databases and, on
   `versionchange`, closes it and posts the host `check-storage` through the mail word; the host waits briefly for its
   backends to close and posts `storage: closed`. Proven by `worker-host-browser` (`storage-closed`, the host idle) and
   `core-browser` (a real host).
10. **Memory fallback headroom.** Each manifest archive gains `files`, its entry count; `constants.json` gains
    `memoryFileBytes`, measured from WasmFS's memory backend; the fallback's memory adds one allowance per entry.
    Proven by `protocol-node`, `tools-engine-manifest`, `ibus-runtime-load` and `worker-host-node` (the allowance
    against a measured install of many entries).
11. **The host storage API.** A storage Worker beside the host (`storage.js`) reads the module's databases in
    read-only transactions; core's `ModuleStorage` and the facade's `storage` object give `usage()`, `export(module)`
    and `reset(module)`. Proven by `worker-host-browser` (usage and export over real databases) and `ibus-web-browser`
    (the facade: usage per engine, an export's tar, a reset restarting the module empty).
12. **Hand-off.** `nix run .#write-files` with no drift, `nix flake check -L`, `nix build .#integration-checks -L`,
    `nix develop -c hk check --all`.

## Decisions this phase makes where the spec is silent

- **Init's wire shape** is `(uba(ssa{sv})a(ss))`: `version`, `userDataWritable`, `settings` (schema id, path, stored
  values), `patterns` (schema id, pattern). A schema with a pattern declares only its instances that have stored values
  in `settings`; every other schema declares each path, as before.
- **A pattern** is a settings path in which `{name}` stands for one or more characters other than `/`; a key path's
  instance is everything up to its last `/`. Literal declarations win over patterns. The runtime refuses a pattern for a
  schema with a fixed path. m17n declares `/org/freedesktop/ibus/engine/m17n/{lang}/{name}/` and Rime
  `/org/freedesktop/ibus/engine/rime/{schema}/`.
- **Writable** is false only for a host that reported `storage: read-only`. The memory fallback and Node hosts are
  writable. `ibusweb_user_data_writable()` is true until `Init` has run.
- **Read-only Rime** wraps `userdb`, `plain_userdb`, `tabledb` and `stabledb` so every database they make starts
  disabled; it starts no maintenance, so it uses what the writer last deployed; it writes no patches and so takes a
  settings change only at its next start.
- **Read-only Mozc** keeps what it learns for the Worker's life; nothing is saved.
- **A disabled user dictionary** stays disabled while any session holds it; once none does, the next session tries
  again. A database moved aside is named `<name>.userdb.corrupt-<UTC yyyymmddThhmmss>`; a move that fails leaves the
  dictionary disabled.
- **`quota`** is posted each time the host finds either mount's count higher than when it last looked, which it does
  as it checks for a closed connection.
- **`check-storage`** waits at most `closeWaitMs` (1 s, `HostConfig`) for a backend to report its close.
- **`files`** counts an archive's directories, files and links, the entries the installer makes.
- **Storage API.** `usage()` covers every module the facade was given, each module's current version only: `data`, the
  installed bytes of its version (base and every installed path), `userData`, the sizes of its files, and per engine
  the installed bytes of its own paths; a module never started reports zeros. `export(module)` has the module's writer
  write what it keeps in memory (`Persist`) first, this tab's Worker if it may write, or else, when another holds the
  writer lock, every tab whose Worker may write, asked over a `BroadcastChannel` and waited for up to 5 s, then tars
  the user database in one read-only transaction, which is the snapshot; the archive's entries are relative to the
  module's directory. `reset(module)` unloads the module through `router.reload`, whose shutdown sends `Persist` and
  `Shutdown` before the Worker ends, deletes `ibus-web/<name>`, then gives back the page's selection and each field's
  override that named the module, and starts it again if it was running for neither. All three reject with the tagged
  errors, `StorageUnavailable` when IndexedDB is missing or fails.

## Departures from the spec

- **The injected `EIO`** is an `EISDIR`: under Node no backend can be made to return `EIO`, and LevelDB turns every
  errno of an open into the same `IOError` status, which is what the patch decides on.
- **A held write's error** is returned from the file's every later write and flush as well as its sync and close:
  LevelDB 1.23 syncs a log only for a synchronous write, which Rime never makes, and deletes its logs without closing
  them, so an error kept for `Sync` and `Close` alone would never reach it. Once a write is lost the log's blocks no
  longer line up, so nothing more is written to it.
- **The corrupted log** case is a database whose `CURRENT` is broken and whose log is torn, which LevelDB reports as
  `Corruption`; a log damaged alone opens without error, since Rime opens without paranoid checks.

## What the spike proved and what it didn't

There was no spike to work from: the scratch clone named for it (`m6a-spike`) and every `m6a-*` scratch directory were
absent when this phase started, and no planner's notes for 6a survived. Nothing here rests on spike evidence. What was
read before writing: librime 1.17.0 (`user_dictionary.cc`, `level_db.cc`, `user_db_recovery_task.cc`, `db.h`), LevelDB
1.23 (`db_impl.cc`, `log_writer.cc`), Mozc (`config_handler.cc`, `session_handler.cc`, `engine.cc`,
`ibus_config.cc`, `user_history_predictor.cc`) and the repository's runtime, host, core and engine sources. Each task's
test is written and run as the task is done.
