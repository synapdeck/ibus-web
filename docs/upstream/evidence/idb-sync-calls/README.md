# IndexedDB strict commits: sync system calls

Whether an IndexedDB transaction with `{ durability: "strict" }` makes the
browser sync to disk, counted as the system calls that do it. Evidence for
the `fsync()` design of the WasmFS IndexedDB backend
([`../../wasmfs-idb-backend.md`](../../wasmfs-idb-backend.md)).

## What is measured

A plain page (`page.html`, served from `127.0.0.1`) opens a database with
two object stores, `inodes` and `chunks`, and then runs 50 rounds of a
read-write transaction with the default durability that puts a 16 KiB chunk
of random bytes and an inode record, each followed by one of:

| Variant        | After each relaxed write                                                    |
| -------------- | --------------------------------------------------------------------------- |
| `relaxed-only` | nothing                                                                     |
| `empty-strict` | a strict read-write transaction over both stores with no requests           |
| `put-strict`   | a strict read-write transaction that gets the inode record and puts it back |
| `baseline`     | no database at all: the page loads and the browser idles for 5 s            |

`measure.ts` launches each browser through `strace-browser.sh`, which runs
it under

    strace -f -ttt -e trace=fsync,fdatasync,sync_file_range,syncfs -o TRACE -- BROWSER ARGS…

so every process of the browser is traced, and nothing else. Each run is a
fresh browser with a fresh profile on disk (`launchPersistentContext()`;
Chromium keeps an off-the-record context's IndexedDB in memory). The calls
are counted in three spans by their timestamps: from launch until the
window opens (the database's creation, then 1 s to settle), the window (the
50 rounds, or the baseline's 5 s idle), and after it (2 s idle, then the
browser's shutdown). Each variant ran 3 times per browser.

## Conditions

- Chromium 153.0.8010.12 (headless shell) and Firefox 155.0 (Playwright's
  build), from nixpkgs' `playwright-driver` 1.63.0, as the repository's
  browser checks use them; Chromium without its sandbox.
- Playwright 1.63.0 (the workspace's), Node v24.20.0 running `measure.ts`
  with its type stripping, strace 7.2.
- Linux 6.18.52-xanmod1, x86_64. Profiles on ZFS (`stat -f`: `zfs`), on
  the same pool as the repository.
- 2026-10-03 (UTC).

`results.json` holds every run's counts with these conditions; `traces/`
holds the full trace of each browser's first run of each variant.

## Results

Sync calls in the window, all three runs of each variant alike:

| 50 rounds of a relaxed write, then           | Chromium 153           | Firefox 155        |
| -------------------------------------------- | ---------------------- | ------------------ |
| nothing                                      | 0, 0, 0                | 0, 0, 0            |
| an empty strict transaction                  | 0, 0, 0                | 0, 0, 0            |
| a strict transaction that puts a record back | 50, 50, 50 `fdatasync` | 50, 50, 50 `fsync` |

The windows lasted 19–54 ms in Chromium and 27–82 ms in Firefox. The
browsers' own syncs don't reach them: in the baseline, Chromium makes none
in 5 s of idle, and Firefox's 12 are one burst some 2.9 s after launch,
which in the database variants falls after the window. The counts above are
therefore net of background syncs as well as raw. Every span outside the
window was the same from run to run (Chromium 59 before and 3 after with no
database, 74 and 8 with one; Firefox 212 and 21, 244–245 and 47, whichever
variant ran): after the last relaxed commit, neither browser syncs within
2 s, and the database's extra syncs after the window come at shutdown.

A strict transaction that writes syncs once per commit; one with no
requests syncs nothing, in either browser.

## Rerunning

From this directory, with the browsers and strace from the flake's nixpkgs:

```sh
nixpkgs='(builtins.getFlake (toString ../../../..)).inputs.nixpkgs.legacyPackages.${builtins.currentSystem}'
browsers=$(nix build --no-link --print-out-paths --impure --expr \
  "$nixpkgs.playwright-driver.browsers.override { withChromium = false; withWebkit = false; withFfmpeg = false; }")
strace=$(nix build --no-link --print-out-paths --impure --expr "$nixpkgs.strace.out")/bin/strace
mkdir -p ~/idb-sync-profiles
PLAYWRIGHT_BROWSERS_PATH=$browsers PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 IDB_SYNC_STRACE=$strace \
  node measure.ts --profile-root ~/idb-sync-profiles --out results.json --traces traces
```

`--profile-root` must be on disk, not a tmpfs; `--runs` and `--rounds`
change the defaults of 3 and 50. strace needs to trace its own children,
which a Yama `ptrace_scope` of 0 or 1 allows.
