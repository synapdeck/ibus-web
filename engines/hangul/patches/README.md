# Hangul patches

The engine source and existing setup UI patch come from the pinned nixpkgs
`ibus-engines.hangul` recipe. Local patches apply in two layers, `port` then
`casts`, sorted by filename within each layer. Each is a `git format-patch`
against that source; none has been submitted upstream yet.

The port layer holds behavior fixes demonstrated by the golden tests. The casts
layer gives callbacks their declared function types for WebAssembly calls.

| Layer | Patch | Reason                                                                                                                                                                                   |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| port  | 0001  | Disconnect both GSettings handlers before freeing an engine, preventing changes from calling a destroyed engine.                                                                         |
| port  | 0002  | Consume a digit outside the last Hanja page without setting an invalid candidate cursor.                                                                                                 |
| casts | 0001  | Match `GClassInitFunc`, `GInstanceInitFunc`, and `IBusObjectDestroyFunc`; the first two lacked their second argument, while the destroy callback had a different pointer parameter type. |

The strict cast audit reports these three findings without the patch and none
with it. Signal connections to `settings_changed` already have the full signal
signature; the audit excludes the intentional `GCallback` casts.

The golden lifecycle test observes a cleared weak engine reference and then
checks that neither settings object calls its old handler. The candidate test
presses 9 on an incomplete last page. Both failed before their port patches;
the complete suite also covers composition, settings, surrounding text and
forwarded-key ordering.
