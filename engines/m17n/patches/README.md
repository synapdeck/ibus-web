# m17n patches

The sources come from the pinned nixpkgs recipes: `m17n_lib` (m17n-lib 1.8.6) and `ibus-engines.m17n` (ibus-m17n
1.4.40). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each sorted by filename; a layer with
no patch has no directory. Each is a `git format-patch` against that source; none has been submitted upstream yet.

`m17n-lib/` patches the library and applies to every WebAssembly build of m17n-lib. It is LGPL-2.1-or-later, as
m17n-lib is.

| Patch              | Reason                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| m17n-lib port 0001 | Check for pkg-config outside configure's GUI block. `AM_CONDITIONAL([HAVE_PKG_CONFIG])` sat inside it, so `--without-gui` stopped configure with an undefined conditional.                                                                                                                                                                                |
| m17n-lib port 0002 | Check for `dlopen` outside the GUI block too, and without it fail every external module's load, as a missing module file already fails. The overlay answers `ac_cv_search_dlopen=no`, so the library imports nothing of the dynamic loader and keeps no module directory, and an input method that needs a module (`ja:anthy`, `en:ispell`) doesn't load. |

m17n-lib's cast audit reports seven casts through `M17NFunc`, the type m17n stores every function as. Each is in
`../m17n-lib-cast-audit.jsonc` with its reason: the function is stored from, and called as, its real type, and the
three calls of external-module functions can't be reached, since no module loads.
