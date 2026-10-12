# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
"""Samples the comparison's corpus from a Tatoeba Mandarin sentence export.

Usage: generate-corpus.py <cmn_sentences.tsv.bz2>

Writes the corpus, as tab-separated id, sentence and pinyin, to stdout.
"""

import bz2
import hashlib
import re
import sys
import unicodedata

import opencc
from pypinyin import Style, lazy_pinyin

SIZE = 1000
MIN_LENGTH = 8

# A syllable without a vowel is an interjection, such as 嗯 (n) or 呣 (m),
# which the engines spell otherwise or not at all.
SYLLABLE = re.compile(r"[a-z]*[aeiouv][a-z]*")


def is_han(char):
    return unicodedata.name(char, "").startswith("CJK UNIFIED IDEOGRAPH-")


def strip(text):
    """The text's Han characters, or None if it holds any letter, digit or
    mark that isn't Han: a sentence with Latin text or digits is left out
    rather than cut, which would leave it ungrammatical."""
    kept = []
    for char in text:
        if is_han(char):
            kept.append(char)
        elif unicodedata.category(char)[0] not in "PSZ":
            return None
    return "".join(kept)


def pinyin(sentence):
    syllables = lazy_pinyin(sentence, style=Style.NORMAL, errors=lambda chars: [""] * len(chars))
    if len(syllables) != len(sentence) or not all(SYLLABLE.fullmatch(s) for s in syllables):
        return None
    return "".join(syllables)


def rank(sentence_id):
    """A fixed pseudo-random order, so the sample doesn't follow the order in
    which Tatoeba's users added sentences."""
    return hashlib.sha256(str(sentence_id).encode()).hexdigest()


def main(export):
    converter = opencc.OpenCC("t2s.json")

    # Tatoeba holds many sentences in both scripts, which t2s makes one.
    first = {}
    with bz2.open(export, "rt", encoding="utf-8") as rows:
        for row in rows:
            sentence_id, language, text = row.rstrip("\n").split("\t")
            if language != "cmn":
                raise ValueError(f"sentence {sentence_id} is in {language}, not cmn")

            sentence = strip(converter.convert(text))
            if sentence is None or len(sentence) < MIN_LENGTH:
                continue

            sentence_id = int(sentence_id)
            if sentence not in first or sentence_id < first[sentence]:
                first[sentence] = sentence_id

    entries = []
    for sentence, sentence_id in first.items():
        spelled = pinyin(sentence)
        if spelled is not None:
            entries.append((sentence_id, sentence, spelled))

    entries.sort(key=lambda entry: rank(entry[0]))
    sample = sorted(entries[:SIZE])
    if len(sample) < SIZE:
        raise ValueError(f"only {len(sample)} sentences qualify")

    print("id\tsentence\tpinyin")
    for sentence_id, sentence, spelled in sample:
        print(f"{sentence_id}\t{sentence}\t{spelled}")
    print(f"{len(first)} distinct sentences, {len(entries)} spelled, {SIZE} sampled", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip())
    main(sys.argv[1])
