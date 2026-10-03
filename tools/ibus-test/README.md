<!-- SPDX-FileCopyrightText: 2026 Synapdeck, Inc. -->
<!-- SPDX-License-Identifier: MIT OR Apache-2.0 -->

# IBus test adapter protocol

`types.ts` defines the version 1 trace and JSON Lines transcript. The native
executable is available on Linux as `packages.ibus-test-native`; its tests are
`checks.ibus-test-native`. Run it with `--address ADDRESS --destination NAME
--factory PATH --timeout-ms N`. Supply one validated trace on stdin. The session
runner applies `settings` before launching the engine; the adapter does not apply
settings. Engine object paths remain internal; contexts are symbolic names.

Every created context must have an explicit `destroy` step before a trace ends.
The shared validator rejects open contexts. Create, destroy, wait, and unit calls
reply with JSON null; `ProcessKeyEvent` replies with a boolean. Other reply bodies
retain their typed GVariant representation. `SetContentType` takes `(uu)` and
maps to `org.freedesktop.DBus.Properties.Set` on the engine's `ContentType`.

The native driver preserves incoming D-Bus message order, including signals
preceding method replies and signals emitted during factory creation. Values use
JSON-GLib and GLib's annotated `g_variant_print` text plus the exact signature;
there is no replacement IBus implementation or custom variant codec involved.

If creation fails, buffered signals for known contexts still appear before the
terminal creation error. Signals whose paths cannot be resolved appear as error
diagnostics at their original positions, retaining path, name, signature, and
payload. Draining continues after such a diagnostic, and the original factory
failure remains the final error record.

Each event belongs to the step that observes it. A `wait` consumes the earliest
unconsumed matching context/name event, including an event already observed
while executing an earlier call. Its original transcript position and step stay
unchanged. Nonmatching events are retained. Destroying a context clears its
unconsumed checkpoints so reusing a symbolic name cannot consume old events.

Method replies and matching events are explicit bounded checkpoints. Destroy's
reply closes the context lifetime, and a final `Peer.Ping` on the factory is the
ordered end-of-trace barrier. Signals through that barrier are processed; an
engine signal on an unknown or destroyed path is an error. An engine must stop
emitting context output after destruction. A barrier cannot make claims about an
engine that violates that lifetime after the barrier itself. No idle-loop or
sleep heuristic declares success. Errors produce a JSON error record at the
active step and exit status 1; invalid CLI arguments exit with status 2.

## Private native sessions

`withNativeSession(config, settings, use, options?)` in `session.ts` owns a native
reference session. `NativeEngineConfig` supplies argv arrays for `sessionBus`
(dbus-daemon), `daemon` (ibus-daemon), `engine`, `adapter`, `gdbus`, `gsettings`,
and optionally `configService.command` with its well-known `destination`.
It also supplies `daemonDestination`, the engine `destination`, `factory`, schema/data `env`, and
`timeoutMs`. No command is interpreted by a shell.

The session appends `--nofork --address=ADDRESS` to `sessionBus`, `--address
ADDRESS` to `daemon`, and the native adapter's address/destination/factory/timeout
arguments to `adapter`. Configure a private D-Bus config file with no activation
service directories. Configure ibus-daemon with `--single
--emoji-extension=disable`, and launch any required config service explicitly.
All service commands must remain in the foreground and retain their owned
process group. The runner owns each daemon separately; it never discovers or
replaces a desktop IBus instance.

Every invocation creates private bus sockets, an IBus address file, and XDG
config/cache/runtime/data/state directories. These reserved values and the
`keyfile` GSettings backend override inherited/configured environment values.
`HOME` is preserved, overrides of it are rejected, and display/portal discovery
variables are removed. The private DConf profile uses only a private user DB;
initial engine settings are written using native `gsettings set` to the persistent
keyfile backend before the engine launches. General live-settings parity is
not part of this interface.

`use` receives `env`, `adapterCommand`, `artifactDir`, `resourceDir`, `signal`,
and `run(trace)`. Use `run` for automatic adapter cancellation and per-run
artifacts; lower-level `runAdapter` also accepts an explicit `env`. The startup
sequence and each adapter run have `timeoutMs` deadlines. An optional parent
`signal`, service death, callback failure, or timeout triggers cleanup. Callbacks
that do additional asynchronous work must honor `session.signal`. Cancellation
signals immediately, but the runner waits for the callback to settle, including
asynchronous `finally` work, before stopping remaining services or removing
private resources. If interruption wins the race, a later callback cleanup error
does not replace that interruption error. A callback that ignores cancellation
can therefore delay session settlement indefinitely; its lifetime has no forced
timeout. After callback settlement, each owned process group receives TERM,
then KILL after a bounded grace period if needed; all direct children are reaped
before private resources are removed.

`options.artifactDir` chooses the retained diagnostics directory; otherwise the
runner creates one in the temporary directory. It contains the explicit config,
owned process commands/status and private paths in `session.json`, seeded
`settings.json`, numbered service/helper stdout/stderr files, and `run-N/` adapter
artifacts. It does not dump the caller's environment. Artifacts survive failure;
private sockets and settings are removed on every exit path.

The generic CLI runs one trace and prints its JSON Lines transcript:

```sh
node tools/ibus-test/cli.ts --native-config CONFIG.json --trace TRACE.json --artifacts DIRECTORY
```

SIGINT/SIGTERM cancel the session. On Linux, Nix provides
`packages.ibus-test-hangul-config` using the pinned stock Hangul engine's actual
libexec executable, native libibus and real ibus-dconf service. It does not use
the setup UI or the repository's replacement IBus library. Run the controlled
fixture and stock Hangul session integration suite with
`nix build .#checks.x86_64-linux.hangul-native-session --no-link`.
Native-specific packages and checks are omitted on unsupported platforms.
