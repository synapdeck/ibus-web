# Pinyin conversion comparison

Compares the long-sentence conversion of libpinyin, with ibus-libpinyin's default options, and Rime, with `rime-ice`'s
`rime_ice` schema, both from the pinned nixpkgs, over one corpus of Mandarin sentences.

## The report

`nix build .#ibus-web-pinyin-compare-report` builds two small native programs against nixpkgs' `libpinyin` and `librime`
and runs `report.ts`, which writes:

- `report.md`: exact-sentence accuracy and character accuracy (1 minus the edit distance over the sentence's length),
  for each engine and for libpinyin less Rime, over the whole corpus and by sentence length, each with its 95 %
  confidence interval;
- `summary.json`: the same figures;
- `conversions.tsv`: each sentence, its pinyin and both engines' output.

Each engine gets user data of its own, made empty for the run, and learns nothing during it.

- **libpinyin.** `libpinyin-convert` parses each line with `pinyin_parse_more_full_pinyins`, guesses with
  `pinyin_guess_sentence` and prints the first sentence. Its options are those ibus-libpinyin sets by default:
  incomplete pinyin, every pinyin correction, and the resplit and divided tables.
- **Rime.** `rime-session` deploys `rime-ice` with its suggested `default.yaml` and answers commands with the session's
  state. `rime.ts` presses the pinyin's keys and takes the first candidate; while that covers only part of the input, it
  selects it and takes the next. The last candidate is read from Rime's commit preview rather than selected, so nothing
  is committed and Rime's user dictionary stays empty.

The report isn't a check: a score is a finding, not a pass or a failure. `checks.tools-pinyin-compare` runs the Vitest
suites: corpus loading, normalisation, the metrics on hand-made cases, and Rime's partial-candidate loop against a
simulated session.

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
