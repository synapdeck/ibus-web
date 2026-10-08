# @ibus-web/core

ibus-web's page-side client. It translates DOM key events to IBus key events, routes them to
engines running in Workers, applies their preedit and commits to text surfaces through adapters,
and reports panel state. It imports only the host's shared transport definitions: Worker, runtime
and engine code load by URL and never enter the page bundle.

`@ibus-web/core` exports the Effect services (`Router`, `EngineRegistry`, `CoreConfig`,
`SettingsSource`, `SettingsApi`, `Logger`, `PanelEvents`) and the textarea adapter;
`@ibus-web/core/keys` exports key translation alone. `effect` 4 is a peer dependency.

Most applications use [`ibus-web`](../ibus-web/README.md), which wraps this package in a promise
API. The design and the layer wiring are in
[docs/core.md](https://github.com/synapdeck/ibus-web/blob/master/docs/core.md).

Licensed under MIT OR Apache-2.0, at your option. The generated key tables come from xorgproto,
Chromium and xkeyboard-config; their licenses and notices are in `LICENSES/`.
