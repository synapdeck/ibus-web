# Hangul patches

The engine source and existing setup UI patch come from the pinned nixpkgs `ibus-engines.hangul` recipe. Local patches
apply in two layers, `port` then `casts`, sorted by filename within each layer. Each is a `git format-patch` against
that source; none has been submitted upstream yet.

The port layer holds behavior fixes demonstrated by the golden tests. The casts layer gives callbacks their declared
function types for WebAssembly calls. The casts patch also adds the 2026 Synapdeck copyright notice for these changes.
Global settings listeners are installed once during module initialization and owned by the module GSettings objects for
the Worker lifetime; upstream exit releases those objects, but the current module ABI has no shutdown entry point.

`libhangul/` patches the library rather than the engine, and applies to every WebAssembly build of libhangul: `0001`
buffers the Hanja dictionary's two loading scans with a 64 KiB stdio buffer, so reads that would each cross into the
IndexedDB backend's thread and transaction are batched. It is LGPL-2.1-or-later, as libhangul is.

| Layer | Patch | Reason                                                                                                                                                                                                                                                                              |
| ----- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| port  | 0001  | Disconnect both GSettings handlers before freeing an engine, preventing changes from calling a destroyed engine.                                                                                                                                                                    |
| port  | 0002  | Consume a digit outside the last Hanja page without setting an invalid candidate cursor.                                                                                                                                                                                            |
| port  | 0003  | Keep module-global settings synchronized independently of engine lifetimes; instance handlers only update their keyboard context. Settings upstream reads only at initialization, such as `disable-latin-mode`, still take effect only there.                                       |
| port  | 0004  | Treat a `CandidateClicked` index as a position on the visible page, as the IBus panel sends it, instead of as an absolute candidate index, and ignore an index no visible label has.                                                                                                |
| port  | 0005  | Apply a `preedit-mode` change to every live engine at once, committing a composition begun in the old mode first, instead of at the engine's next focus-in or capabilities change.                                                                                                  |
| casts | 0001  | Define the class initializer, instance initializer and destroy callback with their declared `GClassInitFunc`, `GInstanceInitFunc` and `IBusObjectDestroyFunc` types; the first two lacked their second argument, while the destroy callback had a different pointer parameter type. |

The strict cast audit reports these three findings without the patch and none with it. Signal connections to
`settings_changed` already have the full signal signature; the audit excludes the intentional `GCallback` casts.

The audit also compiles the libhangul sources linked into `hangul.wasm`, using that library's configured `config.h`, and
finds no incompatible casts. Its `hangul_ic_connect_callback` takes the callback as `void *`, which the compiler cannot
check; the engine's transition callback has the declared `HangulOnTransition` signature.

The golden lifecycle test finds the module's GSettings objects through a `changed` emission hook and checks that
destroying an engine leaves no handler whose data is that engine, only the module handler on each object. It then
changes `hangul-keyboard`, which a stale handler would apply to the freed context, and composes with the new layout in a
fresh engine. Without port 0001 the handler assertion fails deterministically; when earlier cases leave stale handlers
too, the full suite traps on a later keyboard change. The candidate test presses 9 on an incomplete last page, the click
test pages forward before clicking the second label, and the invalid-click test clicks at the page size and past the end
of the short last page without committing anything. The idle-settings test recreates an engine after changing keyboard
and Hanja hotkey with no live instance, then uses both without resending settings. The settings test changes
`preedit-mode` mid-composition with no refocus and checks the syllable commits and the next word stays in the preedit.
All five bugs failed before their port patches; the complete suite also covers composition, settings, surrounding text
and forwarded-key ordering.

Stock ibus-hangul still treats a clicked index as absolute, so the differential click trace pages back to the first
page, where both readings agree, before it clicks.
