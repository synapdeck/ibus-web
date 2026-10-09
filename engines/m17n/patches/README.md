# m17n patches

The sources come from the pinned nixpkgs recipes: `m17n_lib` (m17n-lib 1.8.6) and `ibus-engines.m17n` (ibus-m17n
1.4.40). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each sorted by filename; a layer with
no patch has no directory. Each is a `git format-patch` against that source; none has been submitted upstream yet.

`ibus-m17n/` patches the engine, GPL-2.0-or-later as ibus-m17n is. `m17n-lib/` patches the library and applies to
every WebAssembly build of m17n-lib. It is LGPL-2.1-or-later, as m17n-lib is.

| Patch                | Reason                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ibus-m17n port 0001  | Terminate the UTF-8 buffer `ibus_m17n_mtext_to_ucs4` converts. Without it, a lookup table built from an M-text candidate group gained candidates made of whatever the allocation held.                                                                                                                                                                    |
| ibus-m17n casts 0001 | Define the class initializer, instance initializer and destroy callback with their declared `GClassInitFunc`, `GInstanceInitFunc` and `IBusObjectDestroyFunc` types. The first two lacked their second argument, which trapped the first `CreateEngine`; the destroy callback had a different pointer parameter type.                                     |
| m17n-lib port 0001   | Check for pkg-config outside configure's GUI block. `AM_CONDITIONAL([HAVE_PKG_CONFIG])` sat inside it, so `--without-gui` stopped configure with an undefined conditional.                                                                                                                                                                                |
| m17n-lib port 0002   | Check for `dlopen` outside the GUI block too, and without it fail every external module's load, as a missing module file already fails. The overlay answers `ac_cv_search_dlopen=no`, so the library imports nothing of the dynamic loader and keeps no module directory, and an input method that needs a module (`ja:anthy`, `en:ispell`) doesn't load. |

The engine's cast audit, over `m17nutil.c`, `engine.c` and the module's sources, finds nothing with the casts patch
applied; signal connections already have their full signatures, and the audit excludes the intentional `GCallback`
casts. m17n-lib's reports seven casts through `M17NFunc`, the type m17n stores every function as. Each is in
`../m17n-lib-cast-audit.jsonc` with its reason: the function is stored from, and called as, its real type, and the
three calls of external-module functions can't be reached, since no module loads.
