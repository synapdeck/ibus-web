# Rime patches

The sources come from the pinned nixpkgs recipes: `opencc` (OpenCC 1.4.1), `librime` (librime 1.17.0) and
`ibus-engines.rime` (ibus-rime 1.6.1). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each
sorted by filename; a layer with no patch has no directory. Each is a `git format-patch` against that source; none has
been submitted upstream yet.

`opencc/` is Apache-2.0, as OpenCC is; `librime/` is BSD-3-Clause, as librime is.

| Patch             | Reason                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencc port 0001  | Make segmentation plugins optional (`ENABLE_SEGMENTATION_PLUGINS`). OpenCC loads one, such as Jieba's, with `dlopen` whenever a configuration names a segmentation it doesn't have built in; with the option off, `PluginSegmentation.cpp` isn't built, the library needs no libdl and records no plugin directory, and such a configuration fails as an unknown type does. |
| librime port 0001 | Log a missing dictionary source at INFO. Deploying over prebuilt tables without their sources, which reuses the tables, logged an error for every dictionary; a missing source is an error only without a prebuilt table, which the compiler reports on its own.                                                                                                            |
| librime port 0002 | Let a front end filter the schema list (`Switcher::SetSchemaListFilter`): the entries the switcher's menu offers and a new session starts with. A front end that offers each schema as an input method of its own, and switches between them itself, wants the menu to offer only the current schema.                                                                       |
