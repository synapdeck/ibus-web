# The demo

One page for every input method module the repository builds. Its picker lists each module's engines: one group per
module, or one per language for a module whose engines span several languages, as m17n's do.

From inside the checkout, run:

```sh
nix run .#demo
```

The default address is `http://127.0.0.1:5173`. Pass Vite options after `--` to use another port:

```sh
nix run .#demo -- --port 5174
```

Inside `nix develop`, `pnpm --dir examples/demo dev --port 5174` uses the same runtime and module assets. Pick an input
method in the picker; <kbd>Ctrl+Space</kbd> turns input methods off and back on. The checkbox turns ibus-web handling on
or off. While a module starts, the fields accept native input.

The status line's Data field shows an engine's own data downloading the first time the engine is selected, as Rime's
dictionaries do, and what it installed; a later selection, in the same page or after a reload, installs nothing.

Opened as `/?properties=page` (`http://127.0.0.1:5173/?properties=page`), the page places none of the panel's properties
and draws the focused engine's toggle properties as switches of its own beside the picker, as a page that styles its own
controls would: Hangul's input and Hanja modes, or a Rime schema's switches such as simplified and traditional output. A
switch sends the property's other state to the engine through the facade's panel action and takes the state the engine
reports back. It takes no focus, so the action reaches the field's input context. Each picker option carries its
engine's name in `data-engine`.

The settings form shows the selected module's settings. A setting at a path that holds an engine's name, such as m17n's
`/org/freedesktop/ibus/engine/m17n/hi/inscript/` for `m17n:hi:inscript`, shows only while that engine is selected.
m17n's input-method variables, at `variables/` below an engine's path, reach every input context made afterwards and an
existing one at its next focus-out or reset; a composition already under way keeps the old value.

A module joins the demo when its Nix module sets `ibusWeb.demo.modules.<name>` to its distribution. The page opens on
the default engine of the first module in name order. Each module's end-to-end tests are in `test/e2e/<name>.spec.ts`,
with their helpers beside them.
