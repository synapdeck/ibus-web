# Hangul patches

The engine source and existing setup UI patch come from the pinned nixpkgs
`ibus-engines.hangul` recipe. Local patches apply in two layers, `port` then
`casts`, sorted by filename within each layer. Each is a `git format-patch`
against that source; none has been submitted upstream yet.

The port layer holds behavior fixes demonstrated by the golden tests. The casts
layer gives callbacks their declared function types for WebAssembly calls.
The casts patch also adds the 2026 Synapdeck copyright notice for these changes.
Global settings listeners are installed once during module initialization and
owned by the module GSettings objects for the Worker lifetime; upstream exit
releases those objects, but the current module ABI has no shutdown entry point.

| Layer | Patch | Reason                                                                                                                                                                                   |
| ----- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| port  | 0001  | Disconnect both GSettings handlers before freeing an engine, preventing changes from calling a destroyed engine.                                                                         |
| port  | 0002  | Consume a digit outside the last Hanja page without setting an invalid candidate cursor.                                                                                                 |
| port  | 0003  | Keep module-global settings synchronized independently of engine lifetimes; instance handlers only update their keyboard context.                                                        |
| casts | 0001  | Match `GClassInitFunc`, `GInstanceInitFunc`, and `IBusObjectDestroyFunc`; the first two lacked their second argument, while the destroy callback had a different pointer parameter type. |

The strict cast audit reports these three findings without the patch and none
with it. Signal connections to `settings_changed` already have the full signal
signature; the audit excludes the intentional `GCallback` casts.

The golden lifecycle test finds the module's GSettings objects through a
`changed` emission hook and checks that destroying an engine leaves no handler
whose data is that engine, only the module handler on each object. It then
changes `hangul-keyboard`, which a stale handler would apply to the freed
context, and composes with the new layout in a fresh engine. Without port 0001
the handler assertion fails deterministically; when earlier cases leave stale
handlers too, the full suite traps on a later keyboard change. The candidate
test presses 9 on an incomplete last page. The idle-settings test recreates an
engine after changing keyboard and Hanja hotkey with no live instance, then uses
both without resending settings. All three bugs failed before their port patches;
the complete suite also covers composition, settings, surrounding text and
forwarded-key ordering.
