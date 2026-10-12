# Rime patches

The sources come from the pinned nixpkgs recipes: `opencc` (OpenCC 1.4.1), `librime` (librime 1.17.0) and
`ibus-engines.rime` (ibus-rime 1.6.1). Local patches apply after nixpkgs' in two layers, `port` then `casts`, each
sorted by filename; a layer with no patch has no directory. Each is a `git format-patch` against that source; none has
been submitted upstream yet.

`opencc/` is Apache-2.0, as OpenCC is.

| Patch            | Reason                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opencc port 0001 | Make segmentation plugins optional (`ENABLE_SEGMENTATION_PLUGINS`). OpenCC loads one, such as Jieba's, with `dlopen` whenever a configuration names a segmentation it doesn't have built in; with the option off, `PluginSegmentation.cpp` isn't built, the library needs no libdl and records no plugin directory, and such a configuration fails as an unknown type does. |
