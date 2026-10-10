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

The settings form shows the selected module's settings. A setting at a path that holds an engine's name, such as m17n's
`/org/freedesktop/ibus/engine/m17n/hi/inscript/` for `m17n:hi:inscript`, shows only while that engine is selected.
m17n's input-method variables, at `variables/` below an engine's path, reach every input context made afterwards and an
existing one at its next focus-out or reset; a composition already under way keeps the old value.

A module joins the demo when its Nix module sets `ibusWeb.demo.modules.<name>` to its distribution. The page opens on
the default engine of the first module in name order. Each module's end-to-end tests are in `test/e2e/<name>.spec.ts`,
with their helpers beside them.
