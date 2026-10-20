# Pinyin (tone numbers)

An example input-method module, written with [`@ibus-web/module-kit`](../../docs/module-kit.md) and built by each of its
bundler plugins in the `module-kit-bundlers` check. Its one engine turns pinyin typed with tone numbers into tone marks:
`ni3 hao3` gives `nǐ hǎo`. The [demo](../demo/README.md) imports it with `?ibus-module` and types through it, and
[the guide](../../docs/module-kit.md#building-a-module) describes the builds.

The mark goes on the `a` or `e` of a syllable, on the `o` of `ou`, and otherwise on its last vowel. Tone 5 and tone 0
are neutral and take no mark; a syllable without a number stays as typed. Capitals stay capitals.

`ü` is typed `u:` or `v`, or as itself on a layout that has it: the engine reads keys by the character they type, so it
works on any layout. The `v-as-u` setting, a toggle in the panel, turns off reading `v` as `ü`; it is on by default, so
`lv4` gives `lǜ`. Space commits the word.

- `src/pinyin.ts` holds the placement rule and the conversion, tested in `test/pinyin.test.ts`.
- `src/pinyin-tones.module.ts` is the module's entry, which a bundler turns into a module script. The package exports it
  as `@ibus-web/example-pinyin-tones/module`.

`pnpm test` runs the tests, as the `example-pinyin-tones-node` check does.

Licensed under MIT OR Apache-2.0, at your option.
