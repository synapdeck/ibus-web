# @ibus-web/module-kit

The authoring API for ibus-web's JavaScript input-method modules. A module is a script whose default export the Worker
host drives; the kit gives its author typed engines, settings, candidate paging and properties, and implements the
module-script contract of [`@ibus-web/protocol`](https://www.npmjs.com/package/@ibus-web/protocol) so the script doesn't
have to. At run time it imports that contract's import-free subpath and the descriptor subpath, which imports only
`effect`, and `effect` itself, a peer dependency, whose `Schema` declares an engine's settings. Details are in
[docs/module-kit.md](https://github.com/synapdeck/ibus-web/blob/master/docs/module-kit.md).

Licensed under MIT OR Apache-2.0, at your option.
