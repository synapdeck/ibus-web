# Pinyin conversion comparison

Compares the long-sentence conversion of libpinyin, with ibus-libpinyin's default options, and Rime, with `rime-ice`'s
`rime_ice` schema, both from the pinned nixpkgs, over one corpus of Mandarin sentences.

## The corpus

`corpus.tsv` holds 1,000 sentences from [Tatoeba](https://tatoeba.org/)'s Mandarin export of 10 October 2026
(`https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2`, SHA-256
`91ded8d50ee05db5aca76e23dd9c7f2eeb2e948bcb538fa301cc82f8f4d8048e`), under CC BY 2.0 FR. Each row is a sentence's
Tatoeba id (its page is `https://tatoeba.org/sentences/show/<id>`), the sentence in simplified characters, and its
toneless pinyin without separators, ü written `v`.

`generate-corpus.py` made it. It converts each sentence with OpenCC's `t2s`, removes punctuation, symbols and spaces,
and leaves out any sentence holding a letter or digit that isn't a Han character, rather than cutting the Latin text or
digits out of it. Of the sentences of 8 characters or more, it keeps the first by id of each distinct sentence, spells
each with pypinyin, leaves out any with a syllable that has no vowel (pypinyin's `n` for `嗯`, `m` for `呣`), and
samples 1,000 in an order fixed by a hash of their ids. pypinyin's mistakes on characters with several readings reach
both engines alike.

Tatoeba replaces its exports every week, so the corpus is generated once and committed, never rebuilt. To generate it
again from a newer export:

```sh
curl -LO https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2
nix run .#pinyin-compare-corpus -- cmn_sentences.tsv.bz2 > tools/pinyin-compare/corpus.tsv
```

and update the date and hash above.
