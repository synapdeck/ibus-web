# Hangul demo

From inside the checkout, run:

```sh
nix run .#demo
```

The default address is `http://127.0.0.1:5173`. Pass Vite options after `--` to use another port:

```sh
nix run .#demo -- --port 5174
```

Inside `nix develop`, `pnpm --dir examples/hangul dev --port 5174` uses the same runtime and engine assets. Press Shift+Space to switch to Hangul, type `gks` for 한, and press F9 for Hanja candidates. The checkbox turns ibus-web handling on or off. While the engine starts, the textarea accepts native input.
