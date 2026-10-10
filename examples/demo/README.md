# The demo

One page for every input method module the repository builds. Its picker lists each module's engines.

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

A module joins the demo when its Nix module sets `ibusWeb.demo.modules.<name>` to its distribution. The page opens on
the default engine of the first module in name order. Each module's end-to-end tests are in `test/e2e/<name>.spec.ts`,
with their helpers beside them.
