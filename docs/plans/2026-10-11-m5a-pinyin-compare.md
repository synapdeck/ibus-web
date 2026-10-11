# M5 Phase 1: the pinyin comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 5a of `docs/specs/2026-10-11-m5-rime.md` ("R19: the comparison" and Delivery item 1): the private workspace package `@ibus-web/pinyin-compare` in `tools/pinyin-compare/`, its committed corpus of 1,000 Tatoeba Mandarin sentences with their toneless pinyin, native drivers for nixpkgs' libpinyin and librime, the conversion procedure and metrics the spec describes, the report `packages.x86_64-linux.ibus-web-pinyin-compare-report`, the check `checks.tools-pinyin-compare`, and R19's resolution in `docs/specs/2026-09-26-ibus-web-design.md`, with libpinyin as M6 only if the report says it wins.

**Architecture:** A one-off Python generator (`generate-corpus.py`, run as the flake app `pinyin-compare-corpus` with nixpkgs' `python3Packages.opencc` and `pypinyin`) samples `corpus.tsv` from a Tatoeba export; the file is committed under CC BY 2.0 FR. Two small C programs, built natively by Nix against the pinned nixpkgs' `libpinyin` and `librime`, do the converting: `libpinyin-convert` is a filter, one pinyin line in, one sentence out; `rime-session` deploys `rime-ice` into an empty user directory and then answers one-line commands (`type <keys>`, `select`, `clear`) with the session's state as JSON. TypeScript run by Node does the rest: `corpus.ts` loads and validates the corpus and normalises outputs, `rime.ts` holds the partial-candidate loop against a `RimeSession` interface (so Vitest can drive it with a simulated session), `metrics.ts` and `summary.ts` compute the scores with 95 % confidence intervals and the spec's decision rule, and `report.ts` runs both engines and writes `report.md`, `summary.json` and `conversions.tsv`. The report is a package, not a check.

**Tech Stack:** C (libpinyin 2.11.91, librime 1.17.0 with librime-lua, `rime-ice` 2026.06.30, all native from the pinned nixpkgs), TypeScript 7 on Node 26 (type stripping), Vitest 5, Python 3.14 with pypinyin 0.55.0 and OpenCC 1.4.1 (generator only), Nix flake-parts, hk, oxfmt, clang-format, REUSE.

## Global Constraints

- Work on branch `typedrat/m5a-pinyin-compare`, cut from `master`: `nix develop -c git switch -c typedrat/m5a-pinyin-compare master`. Nothing here depends on phases 5b–5d, and they don't depend on this phase's code; only its outcome (Task 5) can change the roadmap.
- Run every command inside the dev shell (`nix develop -c …`) from the repository root. `git add` a new file before any `nix` command that should see it: the flake only reads files git tracks. **The one exception is `tools/pinyin-compare/package.json` in Task 1:** keep it untracked while `pnpm install` updates the lockfile, because the dev shell builds the workspace's `node_modules` from the tracked package list and fails (`ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`) while a tracked `package.json` has no lockfile importer.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`, in Conventional Commits. Stage named paths only, never `git add -A` or `git add .`. No attribution trailers. If hk's hook rewrites a file (clang-format, oxfmt, nixfmt), re-add it and commit again; never bypass the hook (`--no-verify` is forbidden).
- Comments explain why, never what; no history ("now", "previously"), no references to other files' implementations, plans or pull requests, no "NOTE:". Match the file's comment density. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and the code it describes. Never whitespace-minimize code.
- Licences: every file of the tool is `MIT OR Apache-2.0` with the SPDX header `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` in its comment syntax; `package.json` is covered by `REUSE.toml`'s existing `**/package.json` annotation and `README.md` by its `tools/**/README.md` one. `corpus.tsv` holds Tatoeba's sentences and gets its own `REUSE.toml` annotation, `LicenseRef-CC-BY-2.0-FR` (SPDX lists no `CC-BY-2.0-FR`; it has `CC-BY-2.0` and `CC-BY-NC-SA-2.0-FR`, checked against reuse 6.2.0's `licenses.json`), with the licence text in `LICENSES/LicenseRef-CC-BY-2.0-FR.txt`. `reuse lint` runs on every commit.
- Our C follows the repository's `.clang-format` (LLVM style); hk's clang-format step formats it on commit.
- Docs change in the same commit as the code they describe. Format Markdown with `nix develop -c oxfmt -c .oxfmtrc.jsonc <file>`; **never run oxfmt on `docs/plans/`**. Put non-Latin sample text in Markdown in code spans.
- Generated files are never edited by hand. This phase touches none of the `files:<path>` outputs: `pnpm-workspace.yaml` already globs `tools/*`. `pnpm-lock.yaml` is written by `pnpm install`; the `pnpmDeps` hash in `modules/typescript/workspace.nix` does not change, since the package adds no dependency outside the catalog (verified).
- Stay close to nixpkgs: the drivers link nixpkgs' native `libpinyin`, `librime` (with its default plugins, `librime-lua` and `librime-octagram`) and `rime-ice` unchanged.
- Run checks with `nix build .#checks.x86_64-linux.<name> -L`. Report which ran and what failed; never summarize a check you didn't run as passing.

### Decisions this plan makes where the spec is silent

- **The corpus's source.** Tatoeba's per-language Mandarin export, `https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2`: tab-separated id, language (`cmn`) and text, one sentence a line, about 89,000 lines. The spike used the export of 10 October 2026 (`Last-Modified: Sat, 10 Oct 2026 06:30:50 GMT`, 1,258,831 bytes, SHA-256 `91ded8d50ee05db5aca76e23dd9c7f2eeb2e948bcb538fa301cc82f8f4d8048e`).
- **Simplified, then de-duplicated.** Tatoeba holds many sentences in both scripts. After OpenCC's `t2s`, equal sentences become one, keeping the lowest id. From the spike's export: 56,257 distinct sentences of 8 characters or more.
- **What counts as a character.** A character is Han when its Unicode name begins `CJK UNIFIED IDEOGRAPH-` (Python's `unicodedata`); punctuation, symbols and separators (general categories `P*`, `S*`, `Z*`) are removed; a sentence holding anything else (Latin letters, digits including `〇`, kana, marks) is left out. The TypeScript check on the committed corpus is `\p{Unified_Ideograph}`, a superset, so every generated row passes it.
- **Pinyin.** pypinyin's `lazy_pinyin(sentence, style=Style.NORMAL)`: toneless, ü as `v` (`lv`, `nv`, `lve`), joined without separators. A sentence is left out if pypinyin gives other than one syllable per character, or any syllable without a vowel (`n` for `嗯`, `m` for `呣`), which neither engine spells that way. From the spike's export: 56,243 sentences spelled.
- **Sampling.** The 1,000 qualifying sentences whose ids have the lowest SHA-256 (of the decimal id), written in ascending id order. Ranking by a hash of the id makes the sample nearly the same from a later week's export: a new sentence enters only if its hash ranks among the first 1,000, so a regenerated corpus differs from the spike's in a handful of rows.
- **The generator runs as a flake app**, `nix run .#pinyin-compare-corpus -- <export>`, a `writeShellApplication` around `python3 -I generate-corpus.py` with `python3.withPackages (ps: [ ps.opencc ps.pypinyin ])` from the pinned nixpkgs. Its output is committed; nothing rebuilds the corpus.
- **The licence text** is the legal code at `https://creativecommons.org/licenses/by/2.0/fr/legalcode`, the text of its `id="legal-code-body"` element, a paragraph per block, extracted once by the script in Task 1 (output SHA-256 `1b8329565105f4db9d6336a98e3fcc86ce6970460264a36e7a742ea568aa2264`, 85 lines, 15,880 bytes).
- **libpinyin's options** are those ibus-libpinyin 1.16.5 applies by default, the conversion an M6 port would ship: `PINYIN_INCOMPLETE | ZHUYIN_INCOMPLETE | PINYIN_CORRECT_ALL | USE_RESPLIT_TABLE | USE_DIVIDED_TABLE`. ibus-libpinyin's `option()` is `m_option & m_option_mask`, whose mask is `PINYIN_INCOMPLETE | ZHUYIN_INCOMPLETE | PINYIN_CORRECT_ALL` with fuzzy pinyin off (`src/PYPConfig.cc`, `src/PYConfig.h`), so its `dynamic-adjust` setting never reaches the library; `LibPinyinBackEnd::setPinyinOptions` adds the two tables (`src/PYLibPinyin.cc`). Its addon dictionaries default to none (`dictionaries` is `''`), so none is loaded. Its `network.txt`, 375 internet-slang phrases ibus-libpinyin imports at start, is not: it is the front end's data, not the library's. The library's own default (`USE_TONE` alone, `pinyin_init` in `src/pinyin.cpp`) scores within 0.1 points of these on every overall figure (spike: exact 40.7 % against 40.6 %, characters 89.0 % for both).
- **libpinyin's data** is nixpkgs' `${libpinyin}/lib/libpinyin/data` (its `pkgdatadir` plus `data`, model20), the system directory `pinyin_init` takes; the user directory is a new empty directory for the run.
- **Rime's data** is `rime-ice` as its users install it: every file of nixpkgs' `share/rime-data` except the empty `build/` (Rime reads a shared `build/` as prebuilt data), plus `default.yaml` linked to `rime_ice_suggestion.yaml`, the upstream `default.yaml` nixpkgs installs under another name. `rime-session` deploys it with `start_maintenance(True)` into a new empty user directory (all nine schemas of its `schema_list`, about ten seconds natively) and selects `rime_ice`. Logging goes to stderr at warnings and above (`log_dir` empty, `min_log_level` 1).
- **Neither engine learns during the run.** libpinyin is never trained (`pinyin_train` is never called). Rime learns on commit, so the loop never commits a sentence it can read without committing: the last candidate is read from the context's `commit_text_preview`, and the composition is then cleared. Selecting a partial candidate does not commit. A last candidate that holds Latin letters of its own can't be told from raw input in the preview, so it is selected, which commits; this never happened on the spike's corpus.
- **The partial-candidate loop is TypeScript** (`convertWithRime`), against an interface `RimeSession { send(command) }`, so `checks.tools-pinyin-compare` can test it with a simulated session; `rime-session` only executes commands. Covering the input is read from the preview: while it holds a lowercase ASCII letter, input is left raw. The loop is bounded by the number of keys, since every selection uses at least one.
- **Normalising outputs.** Both engines' outputs are NFC-normalised and stripped of `\p{P}`, `\p{S}` and `\p{Z}`; letters and digits stay, so pinyin an engine leaves unconverted counts against it.
- **Metrics.** Exact-sentence accuracy: the share of sentences whose normalised output equals the sentence. Character accuracy: `1 − Σ distance / Σ length` over the group, distance the Levenshtein distance in code points between the sentence and the output, length the sentence's characters (pooled, so a long sentence weighs more than a short one).
- **Confidence intervals** are closed-form, by linearisation of a ratio of sums: for a metric `R = Σa/Σb` over n sentences, the margin is `1.959963984540054 × sqrt(n/(n−1) × Σ(aᵢ − R·bᵢ)²) / Σb` (for exact accuracy, the Wald interval with one degree of freedom). The difference between engines is paired: the residuals are subtracted sentence by sentence, which gives the narrower interval two engines on the same sentences deserve.
- **The decision rule.** The spec's "libpinyin is clearly ahead, more than either metric's 95 % confidence interval" is read as: over the whole corpus, the paired interval of libpinyin's lead lies wholly above zero for both exact-sentence accuracy and character accuracy (`summary.libpinyinAhead`). The report states the outcome in its last section.
- **Length buckets:** 8–11, 12–15, 16–19 and 20 or more characters (the spike's corpus: 616, 205, 100 and 79 sentences).
- **The report's files:** `report.md` (versions, both tables, the outcome), `summary.json` (every estimate), `conversions.tsv` (id, sentence, pinyin, libpinyin's and Rime's normalised outputs). `packages.ibus-web-pinyin-compare-report` carries `passthru.drivers` and `passthru.rimeData`, so the programs can be run by hand.
- **Docs.** The tool gets `tools/pinyin-compare/README.md`, listed in `docs/README.md`'s "Beside the code"; `README.md`'s licence list names the corpus's licence.
- **Design spec, if libpinyin wins:** besides R19 and the milestone table, D2's row and R6 and R16 (both "Withdrawn with libpinyin") change, so the spec doesn't contradict itself (Task 5, branch B).

### Where this plan departs from the spec

1. **Sentences with Latin text or digits are left out, not stripped.** The spec says the sentences are "stripped of punctuation, Latin text and digits". Cutting `3` out of `我有3个苹果` or `iPhone` out of a sentence leaves one nobody would type, whose pinyin measures neither engine. Punctuation, symbols and spaces are stripped, as the spec says; a sentence holding Latin letters or digits is skipped. 56,257 distinct sentences qualify, so the sample isn't short of any.
2. **Rime's last candidate is read, not selected.** The spec: "if it covers only part of the input, it is selected and the next first candidate taken until the input is used up". The loop does exactly that for partial candidates, but takes the final one from Rime's commit preview instead of selecting it, because selecting it commits the sentence and Rime's user dictionary would learn from every sentence, which "fresh user data" excludes. The text is the same either way (verified natively: selecting `一千度高中的时候我每天早上六点起床` commits exactly the preview).
3. **The rule's "either metric".** Read as both, through the paired difference's interval (see the decisions above). Each engine's own interval is in the report too, so a reader can apply the stricter non-overlap reading; on the spike's figures both readings agree.
4. **No grammar-model arm.** The design spec's R19 says "with and without a grammar model"; the M5 spec makes the model a non-goal and compares dictionaries alone. R19's resolution (Task 5) says so.
5. **The M5 row of the milestone table** ("default pinyin data whose long-sentence conversion matches ibus-libpinyin's (R19)") is left to phase 5d, which rewrites that row. Task 5 changes it only in branch B, where the milestones are renumbered.

### What was verified, and how

All of it in a scratch clone of `master` at `e0f1d5d` (`m5a-spike`), building with `nix build` and running in the dev shell:

- **The corpus.** The export above, downloaded 11 October 2026; `nix run .#pinyin-compare-corpus` over it printed `56257 distinct sentences, 56243 spelled, 1000 sampled` and wrote a 1,001-line `corpus.tsv` with SHA-256 `02e16d0bbc28888508b18b51e581f4d9695a8d272a0ee9d1a0c8e97b520e836c`, identical on a second run (and identical between the app and a direct `python3 -I` run).
- **The licence text.** The extraction script here over the legal code page (fetched 11 October 2026, HTML SHA-256 `597d4c64…`) gives the 85-line text with SHA-256 `1b83295651…`, sections 1–8 complete. `reuse lint` passes with the `REUSE.toml` annotation here (1,110 files).
- **The drivers** compile with `-std=gnu23 -Wall -Wextra -Werror` against nixpkgs' `libpinyin` 2.11.91 and `librime` 1.17.0 through `pkg-config` in the derivation here, and `checks.toolchain-clangd` passes with the native clangd fragment here (it failed without it, then with plain `-std=c23`, as Task 4 describes). `libpinyin-convert` parsed all 1,000 lines whole (no `parsed … of …` line in the log). `rime-session` deployed `rime-ice` (its log: `duplicate word definition` warnings for `melt_eng`, `nonexistent config file` for the not-yet-built schemas, one OpenCC `emoji.json` schema warning; none fatal) and answered commands as described; by hand, `type nihaoiii` gives the partial candidate `你好` with preview `你好iii`, and after `select` no candidate and preview `你好iii`.
- **Rime's first candidate covered the whole input for all 1,000 sentences** (counted by typing each and checking the preview for letters), so the partial loop never ran on the corpus; it is exercised by the Vitest cases and by the `nihaoiii` probe.
- **The report** built several times from the code here (about 70 s each, most of it Rime's dictionary compilation), with identical figures each time (see [Preliminary figures](#preliminary-figures)), and `nix build .#ibus-web-pinyin-compare-report --rebuild` found its output bit-for-bit reproducible. The `jq` commands in Task 5 were run on its `summary.json` and print what Task 5 expects.
- **Vitest:** all 39 tests pass, under `pnpm test` in the package and in `checks.tools-pinyin-compare`. Each task's failing step was checked to fail as written (`Cannot find module './rime.ts'` for a missing module).
- **Lints:** `tsc -b --noEmit tools/pinyin-compare`, `oxfmt --check`, oxlint, clang-format, nixfmt, `reuse lint`, `links` and `tsconfig-extends` pass on the tool. (`hk check --all`'s `tsc` step failed in the scratch clone on `packages/panel`, which can't resolve `@ibus-web/protocol` there; that is the fresh clone's missing build output, not this phase's code, and the step must be rerun in the real worktree.)
- **`nix flake check -L`** in the clone with this plan's final code: passes, 134 checks and outputs, `checks.flake-hk` (hk over the whole tree in Nix, `tsc` included), `checks.toolchain-clangd`, `checks.tools-pinyin-compare`, `apps.pinyin-compare-corpus` and the report's evaluation among them. An earlier run, before the clangd fragment, failed `toolchain-clangd` (hence the fragment) and once timed out `tools-ibus-test`'s `cleans up a spawned grandchild on child-abort` under the full parallel load; that check passed when rebuilt alone and in the final run. `nix build .#integration-checks -L` passed (exit 0) with the tool and lockfile change in place, before the clangd fragment, which touches no integration check.
- **Sensitivity:** libpinyin with the library's default options (`USE_TONE`), all else equal, scored within 0.1 points of the figures below overall, and within 1.2 points in every bucket.
- **By reading the sources:** ibus-libpinyin 1.16.5 `src/PYPConfig.cc`, `src/PYConfig.h`, `src/PYLibPinyin.cc`, `src/PYPFullPinyinEditor.cc`, `src/PYPLibPinyinCandidates.cc` and `data/com.github.libpinyin.ibus-libpinyin.gschema.xml`; libpinyin 2.11.91 `pinyin.h`, `pinyin_custom2.h`, `src/pinyin.cpp`; librime 1.17.0 `rime_api.h`; `rime-ice` 2026.06.30 `rime_ice.schema.yaml` and `rime_ice_suggestion.yaml`; nixpkgs' recipes for `libpinyin`, `rime-ice` and `librime`.
- **Not verifiable here:** the figures from a corpus regenerated from a later export (they should move by at most a few tenths of a point), and how the outcome reads once Task 5 is written into the spec, which depends on the report the executor builds.

### Preliminary figures

From the spike's report (`libpinyin 2.11.91, with ibus-libpinyin 1.16.5's default options`; `librime 1.17.0, rime-ice 2026.06.30`), percentages with 95 % intervals:

| Length     | Sentences | Exact: libpinyin    | Exact: Rime         | Exact: libpinyin − Rime | Characters: libpinyin | Characters: Rime    | Characters: libpinyin − Rime |
| ---------- | --------: | ------------------- | ------------------- | ----------------------- | --------------------- | ------------------- | ---------------------------- |
| All        |      1000 | 40.6 (37.6 to 43.6) | 51.5 (48.4 to 54.6) | −10.9 (−14.1 to −7.7)   | 89.0 (88.2 to 89.7)   | 90.8 (90.0 to 91.6) | −1.8 (−2.6 to −1.1)          |
| 8–11       |       616 | 44.5 (40.6 to 48.4) | 58.6 (54.7 to 62.5) | −14.1 (−18.2 to −10.0)  | 88.8 (87.7 to 89.9)   | 91.4 (90.4 to 92.4) | −2.6 (−3.7 to −1.6)          |
| 12–15      |       205 | 41.5 (34.7 to 48.2) | 48.3 (41.4 to 55.1) | −6.8 (−13.9 to 0.3)     | 89.7 (88.1 to 91.4)   | 91.8 (90.4 to 93.3) | −2.1 (−3.6 to −0.6)          |
| 16–19      |       100 | 34.0 (24.7 to 43.3) | 39.0 (29.4 to 48.6) | −5.0 (−14.4 to 4.4)     | 89.1 (86.9 to 91.4)   | 91.1 (88.9 to 93.4) | −2.0 (−4.0 to −0.0)          |
| 20 or more |        79 | 16.5 (8.2 to 24.7)  | 20.3 (11.3 to 29.2) | −3.8 (−14.1 to 6.5)     | 88.3 (86.2 to 90.4)   | 87.7 (85.2 to 90.3) | 0.6 (−1.5 to 2.7)            |

Outcome: libpinyin is not ahead; Rime with `rime-ice` is ahead overall on both metrics, beyond the paired intervals, and the two are level within the intervals on sentences of 16 characters or more. Of the 1,000 sentences, both convert 324 exactly, only Rime 191, only libpinyin 82. Unless the executor's corpus differs materially, Task 5 takes branch A.

---

## Interfaces later phases rely on

- **Package** `tools/pinyin-compare/`, `@ibus-web/pinyin-compare` (private): `corpus.ts` exports `interface Entry { readonly id: number; readonly sentence: string; readonly pinyin: string }`, `const minimumLength = 8`, `parseCorpus(text: string): Entry[]`, `normalise(text: string): string`.
- **Corpus** `tools/pinyin-compare/corpus.tsv`: UTF-8, LF, a header line `id\tsentence\tpinyin`, then 1,000 rows in ascending id order: Tatoeba's decimal sentence id, the sentence (8 or more `\p{Unified_Ideograph}` characters, simplified), and its toneless pinyin (`[a-z]+`, ü as `v`). Phase 5b's `rime-golden` case "a long corpus sentence converted whole" can take row `340077` (`他乘飞机去了芝加哥在那里偶然遇见了一个朋友`, `tachengfeijiqulezhijiagezainaliouranyujianleyigepengyou`, 21 characters), which native Rime with `rime_ice` converts exactly as its first candidate (libpinyin does not).
- **App** `apps.x86_64-linux.pinyin-compare-corpus`: `nix run .#pinyin-compare-corpus -- <cmn_sentences.tsv.bz2>` writes a corpus to stdout and a count line to stderr.
- **Package** `packages.x86_64-linux.ibus-web-pinyin-compare-report` (Linux only, as nixpkgs' `libpinyin` is): `$out/report.md`, `$out/summary.json` (`Summary`, below), `$out/conversions.tsv`; `passthru.drivers` (`bin/libpinyin-convert`, `bin/rime-session`) and `passthru.rimeData` (the deployed-from shared directory).
- **`summary.json`'s shape** (`summary.ts`): `{ overall: Group, byLength: Group[], libpinyinAhead: boolean }`, `Group = { label, sentences, libpinyin: Scores, rime: Scores, difference: Scores }`, `Scores = { exact: Estimate, character: Estimate }`, `Estimate = { value, low, high }` as fractions; `difference` is libpinyin's less Rime's.
- **Check** `checks.x86_64-linux.tools-pinyin-compare`.
- **Licence** `LicenseRef-CC-BY-2.0-FR`, text in `LICENSES/LicenseRef-CC-BY-2.0-FR.txt`.
- **Design spec:** R19 settled (Task 5). In branch B only, `## 12. Milestones` gains `M6` libpinyin and `1.0` becomes `M7`; phase 5d's update of the M5 row and R19 status then builds on that.

---

## File structure

| Path | Change |
| --- | --- |
| `tools/pinyin-compare/package.json`, `tsconfig.json`, `vitest.config.ts` | The workspace package |
| `tools/pinyin-compare/corpus.ts`, `corpus.test.ts` | Corpus loading and validation, output normalisation |
| `tools/pinyin-compare/generate-corpus.py` | The one-off corpus generator |
| `tools/pinyin-compare/corpus.tsv` | The committed corpus (generated once) |
| `tools/pinyin-compare/metrics.ts`, `metrics.test.ts` | Edit distance, samples, ratio and paired-difference estimates |
| `tools/pinyin-compare/summary.ts`, `summary.test.ts` | Groups by length, the decision rule |
| `tools/pinyin-compare/rime.ts`, `rime.test.ts` | Rime's partial-candidate loop; the `rime-session` process |
| `tools/pinyin-compare/libpinyin.ts` | Running `libpinyin-convert` |
| `tools/pinyin-compare/libpinyin-convert.c`, `rime-session.c` | The native drivers |
| `tools/pinyin-compare/report.ts` | The report's entry point |
| `tools/pinyin-compare/module.nix` | `apps.pinyin-compare-corpus`, `checks.tools-pinyin-compare`, `packages.ibus-web-pinyin-compare-report` |
| `tools/pinyin-compare/README.md` | The tool's documentation |
| `LICENSES/LicenseRef-CC-BY-2.0-FR.txt` | CC BY 2.0 FR's legal code |
| `REUSE.toml` | The corpus's annotation |
| `pnpm-lock.yaml` | The package's importer |
| `docs/README.md`, `README.md` | The README's index entry; the corpus's licence |
| `docs/specs/2026-09-26-ibus-web-design.md` | R19's resolution (and, in branch B, D2, R6, R16 and the milestones) |

---

### Task 1: The corpus

**Files:**
- Create: `tools/pinyin-compare/package.json`, `tools/pinyin-compare/tsconfig.json`, `tools/pinyin-compare/vitest.config.ts`, `tools/pinyin-compare/corpus.ts`, `tools/pinyin-compare/corpus.test.ts`, `tools/pinyin-compare/generate-corpus.py`, `tools/pinyin-compare/module.nix`, `tools/pinyin-compare/corpus.tsv` (generated), `tools/pinyin-compare/README.md`, `LICENSES/LicenseRef-CC-BY-2.0-FR.txt` (generated)
- Modify: `REUSE.toml`, `pnpm-lock.yaml` (by `pnpm install`), `docs/README.md`, `README.md`

**Interfaces:**
- Produces: `corpus.ts`'s `Entry`, `minimumLength`, `parseCorpus(text: string): Entry[]`, `normalise(text: string): string`; `apps.pinyin-compare-corpus`; `checks.tools-pinyin-compare` (13 tests after this task); `corpus.tsv`.

- [ ] **Step 1: Create the package and add it to the lockfile**

Create `tools/pinyin-compare/package.json`:

```json
{
  "name": "@ibus-web/pinyin-compare",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --configLoader native"
  },
  "devDependencies": {
    "@ibus-web/tsconfig": "workspace:*",
    "@types/node": "catalog:",
    "vitest": "catalog:"
  },
  "ibusWeb": {
    "assets": [
      "corpus.tsv"
    ]
  }
}
```

(`ibusWeb.assets` puts `corpus.tsv` into the built workspace, which the check and the report read; the workspace otherwise takes only `.ts` and `.json` files.)

Create `tools/pinyin-compare/tsconfig.json`:

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@ibus-web/tsconfig/node.json",
  "compilerOptions": {
    // Vitest's declarations name DOM types, which Node code doesn't have.
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
```

Create `tools/pinyin-compare/vitest.config.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { defineConfig } from "vitest/config";

// A Nix build's tree is read-only, so checks point Vite's cache elsewhere.
const cacheDir = process.env["IBUS_WEB_TEST_CACHE_DIR"];

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  test: { include: ["*.test.ts"] },
});
```

With `package.json` still untracked, run:

```bash
nix develop -c pnpm install
nix develop -c git add tools/pinyin-compare/package.json tools/pinyin-compare/tsconfig.json tools/pinyin-compare/vitest.config.ts pnpm-lock.yaml
```

Expected: pnpm finishes (`Done in …`); `git diff --cached pnpm-lock.yaml` adds exactly one importer, 12 lines:

```yaml
  tools/pinyin-compare:
    devDependencies:
      '@ibus-web/tsconfig':
        specifier: workspace:*
        version: link:../../packages/tsconfig
      '@types/node':
        specifier: 'catalog:'
        version: 26.6.4
      vitest:
        specifier: 'catalog:'
        version: 5.0.3(@types/node@26.6.4)(@vitest/browser-playwright@5.0.3)(@vitest/ui@5.0.3)(vite@8.3.2(@types/node@26.6.4)(yaml@2.9.1))
```

(The versions are the catalog's at `e0f1d5d`; take whatever `pnpm install` writes.)

- [ ] **Step 2: Write the failing test**

Create `tools/pinyin-compare/corpus.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { minimumLength, normalise, parseCorpus } from "./corpus.ts";

const header = "id\tsentence\tpinyin\n";

describe("parseCorpus", () => {
  test("reads the committed corpus", () => {
    const entries = parseCorpus(readFileSync(new URL("corpus.tsv", import.meta.url), "utf8"));
    expect(entries).toHaveLength(1000);
    expect(new Set(entries.map((entry) => entry.sentence)).size).toBe(1000);
    for (const entry of entries) {
      expect(normalise(entry.sentence)).toBe(entry.sentence);
      expect([...entry.sentence].length).toBeGreaterThanOrEqual(minimumLength);
    }
  });

  test("reads each row's id, sentence and pinyin", () => {
    expect(
      parseCorpus(
        `${header}3\t我们明天去北京吧\twomenmingtianqubeijingba\n7\t绿色的女人喜欢学习\tlvsedenvrenxihuanxuexi\n`,
      ),
    ).toEqual([
      { id: 3, sentence: "我们明天去北京吧", pinyin: "womenmingtianqubeijingba" },
      { id: 7, sentence: "绿色的女人喜欢学习", pinyin: "lvsedenvrenxihuanxuexi" },
    ]);
  });

  test.each([
    ["a header of other columns", "id\tsentence\n", "the header"],
    ["no final newline", `${header}3\t我们明天去北京吧\twomenmingtianqubeijingba`, "no newline"],
    ["a missing field", `${header}3\t我们明天去北京吧\n`, "2 fields"],
    ["an id that isn't a number", `${header}x3\t我们明天去北京吧\twomenmingtianqubeijingba\n`, "positive integer"],
    ["punctuation in a sentence", `${header}3\t我们明天去北京吧！\twomenmingtianqubeijingba\n`, "Han characters"],
    ["a short sentence", `${header}3\t我们去北京吧\twomenqubeijingba\n`, "8 or more"],
    ["pinyin with a separator", `${header}3\t我们明天去北京吧\twomen'mingtianqubeijingba\n`, "lowercase letters"],
    [
      "ids out of order",
      `${header}7\t我们明天去北京吧\twomenmingtianqubeijingba\n3\t绿色的女人喜欢学习\tlvsedenvrenxihuanxuexi\n`,
      "ascending",
    ],
  ])("rejects %s", (_, text, message) => {
    expect(() => parseCorpus(text)).toThrow(message);
  });
});

describe("normalise", () => {
  test("removes punctuation, symbols and spaces, full-width or not", () => {
    expect(normalise("“你好，世界！”　我们…走吧～ ok?")).toBe("你好世界我们走吧ok");
  });

  test("keeps letters and digits, which an engine is scored for", () => {
    expect(normalise("你好nihao123")).toBe("你好nihao123");
  });

  test("composes", () => {
    expect(normalise("lü")).toBe("lü");
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `nix develop -c bash -c 'cd tools/pinyin-compare && pnpm test'`
Expected: FAIL, `FAIL  corpus.test.ts`, `Error: Cannot find module './corpus.ts' imported from …/tools/pinyin-compare/corpus.test.ts`, `Test Files  1 failed (1)`.

- [ ] **Step 4: Implement `corpus.ts`**

Create `tools/pinyin-compare/corpus.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

export interface Entry {
  /** Tatoeba's sentence id. */
  readonly id: number;
  readonly sentence: string;
  /** Toneless pinyin without separators, ü spelled v. */
  readonly pinyin: string;
}

export const minimumLength = 8;

const header = "id\tsentence\tpinyin";

/** Parses corpus.tsv, failing on any row the generator couldn't have written. */
export function parseCorpus(text: string): Entry[] {
  const lines = text.split("\n");
  if (lines[0] !== header) {
    throw new Error(`corpus: the header isn't ${JSON.stringify(header)}`);
  }
  if (lines.at(-1) !== "") {
    throw new Error("corpus: the last line has no newline");
  }

  const entries: Entry[] = [];
  for (const [index, line] of lines.slice(1, -1).entries()) {
    const where = `corpus line ${index + 2}`;
    const fields = line.split("\t");
    if (fields.length !== 3) {
      throw new Error(`${where}: ${fields.length} fields, not 3`);
    }

    const [id, sentence, pinyin] = fields as [string, string, string];
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw new Error(`${where}: the id ${JSON.stringify(id)} isn't a positive integer`);
    }
    if (!/^\p{Unified_Ideograph}+$/u.test(sentence) || [...sentence].length < minimumLength) {
      throw new Error(`${where}: the sentence isn't ${minimumLength} or more Han characters`);
    }
    if (!/^[a-z]+$/.test(pinyin)) {
      throw new Error(`${where}: the pinyin isn't lowercase letters alone`);
    }

    const previous = entries.at(-1);
    if (previous !== undefined && previous.id >= Number(id)) {
      throw new Error(`${where}: the ids aren't in ascending order`);
    }
    entries.push({ id: Number(id), sentence, pinyin });
  }
  return entries;
}

/**
 * An engine's output as it is compared with the sentence: composed, and
 * without punctuation, symbols or spaces, which the corpus's sentences don't
 * hold. Letters and digits stay, so an engine that leaves pinyin unconverted
 * is scored for it.
 */
export function normalise(text: string): string {
  return text.normalize("NFC").replace(/[\p{P}\p{S}\p{Z}]/gu, "");
}
```

- [ ] **Step 5: Write the generator and the Nix module**

Create `tools/pinyin-compare/generate-corpus.py`:

```python
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
```

Create `tools/pinyin-compare/module.nix` (Task 4 adds the report to it):

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing typescript;

      workspace = typescript.workspaceFor [ "tools/pinyin-compare" ];

      corpusPython = pkgs.python3.withPackages (ps: [
        ps.opencc
        ps.pypinyin
      ]);
    in
    {
      # Run once to write the committed corpus; Tatoeba replaces its exports
      # weekly, so the corpus is never rebuilt from one.
      apps.pinyin-compare-corpus = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-pinyin-compare-corpus";
            text = ''
              exec ${corpusPython}/bin/python3 -I ${./generate-corpus.py} "$@"
            '';
          }
        );
      };

      checks.tools-pinyin-compare = testing.vitestCheck {
        name = "tools-pinyin-compare";
        packageDir = "${workspace}/tools/pinyin-compare";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

- [ ] **Step 6: Generate the corpus**

If the spike's corpus still exists at `/tmp/claude-1000/-home-awilliams-Development-ibus-web/94c82694-6a1b-403a-aa21-a376ad1a2d59/scratchpad/m5a-spike/tools/pinyin-compare/corpus.tsv` and its SHA-256 is `02e16d0bbc28888508b18b51e581f4d9695a8d272a0ee9d1a0c8e97b520e836c`, copy it to `tools/pinyin-compare/corpus.tsv`: it is this generator's output over the export of 10 October 2026, the corpus the [preliminary figures](#preliminary-figures) come from. Keep the README's date and hash (Step 9) as written, and skip to Step 7.

Otherwise generate it from the current export. Download outside the tree, into a new empty directory:

```bash
export_dir=$(mktemp -d)
curl -sSL -D "$export_dir/headers" -o "$export_dir/cmn_sentences.tsv.bz2" https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2
grep -i '^last-modified' "$export_dir/headers"
sha256sum "$export_dir/cmn_sentences.tsv.bz2"
nix develop -c git add tools/pinyin-compare/generate-corpus.py tools/pinyin-compare/module.nix
nix run .#pinyin-compare-corpus -- "$export_dir/cmn_sentences.tsv.bz2" > tools/pinyin-compare/corpus.tsv
```

Expected: stderr `<n> distinct sentences, <m> spelled, 1000 sampled`, with n near 56,257 and m about 14 fewer (the spike's export gave `56257 distinct sentences, 56243 spelled, 1000 sampled`); `wc -l tools/pinyin-compare/corpus.tsv` is `1001`; `head -3 tools/pinyin-compare/corpus.tsv` is the header, then rows such as `55	以前读高中的时候我每天早上六点起床	yiqiandugaozhongdeshihouwomeitianzaoshangliudianqichuang` and `332451	医生请给这孩子急救	yishengqinggeizhehaizijijiu` (both are in the spike's sample, and a later export keeps nearly all of it). If the export's SHA-256 is `91ded8d50ee05db5aca76e23dd9c7f2eeb2e948bcb538fa301cc82f8f4d8048e`, the corpus's SHA-256 must be `02e16d0bbc28888508b18b51e581f4d9695a8d272a0ee9d1a0c8e97b520e836c`. Note the `Last-Modified` date and the export's SHA-256 for Step 9.

- [ ] **Step 7: Run the tests to see them pass**

Run:

```bash
nix develop -c git add tools/pinyin-compare/corpus.ts tools/pinyin-compare/corpus.test.ts tools/pinyin-compare/corpus.tsv tools/pinyin-compare/generate-corpus.py tools/pinyin-compare/module.nix
nix develop -c bash -c 'cd tools/pinyin-compare && pnpm test'
nix build .#checks.x86_64-linux.tools-pinyin-compare -L
```

Expected: both PASS, `✓ corpus.test.ts (13 tests)`, `Tests  13 passed (13)`.

- [ ] **Step 8: Add the corpus's licence**

Save this script outside the tree as `$TMPDIR/extract-legalcode.py`:

```python
import html.parser
import re
import sys


class LegalCode(html.parser.HTMLParser):
    """The text of the element with id legal-code-body, a paragraph a block."""

    blocks = {"p", "li", "h1", "h2", "h3", "h4", "dt", "dd", "ol", "ul", "div", "br"}

    def __init__(self):
        super().__init__()
        self.depth = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if self.depth == 0 and dict(attrs).get("id") == "legal-code-body":
            self.depth = 1
        elif self.depth > 0:
            if tag not in {"br", "img", "hr"}:
                self.depth += 1
            if tag in self.blocks:
                self.parts.append("\n\n")

    def handle_endtag(self, tag):
        if self.depth > 0 and tag not in {"br", "img", "hr"}:
            self.depth -= 1
            if tag in self.blocks:
                self.parts.append("\n\n")

    def handle_data(self, data):
        if self.depth > 0:
            self.parts.append(data)


parser = LegalCode()
parser.feed(sys.stdin.read())
text = re.sub(r"[ \t\r\n]*\n\n[ \t\r\n]*", "\n\n", "".join(parser.parts))
paragraphs = [re.sub(r"\s+", " ", block).strip() for block in text.split("\n\n")]
print("\n\n".join(p for p in paragraphs if p))
```

Run:

```bash
page_dir=$(mktemp -d)
curl -sSL -o "$page_dir/legalcode.html" https://creativecommons.org/licenses/by/2.0/fr/legalcode
python3 -I "$TMPDIR/extract-legalcode.py" < "$page_dir/legalcode.html" > LICENSES/LicenseRef-CC-BY-2.0-FR.txt
sha256sum LICENSES/LicenseRef-CC-BY-2.0-FR.txt
head -1 LICENSES/LicenseRef-CC-BY-2.0-FR.txt
grep -c '^[1-8]\. ' LICENSES/LicenseRef-CC-BY-2.0-FR.txt
```

Expected: SHA-256 `1b8329565105f4db9d6336a98e3fcc86ce6970460264a36e7a742ea568aa2264`; first line `Paternité - 2.0`; `8` (the eight articles, `1. Définitions` to `8. Divers`); the last line `Creative Commons peut être contacté à https://creativecommons.org/ .`. If Creative Commons has changed the page's markup and the hash differs, check that the text still runs from `Paternité - 2.0` through the eight articles to that last line, with no navigation text, and use it.

In `REUSE.toml`, insert after the `tools/cast-audit/fixtures/*.sarif` annotation (before the one for `docs/**`):

```toml
# Tatoeba's sentences, each under the id Tatoeba gives it, and their pinyin.
[[annotations]]
path = "tools/pinyin-compare/corpus.tsv"
SPDX-FileCopyrightText = "The Tatoeba contributors <https://tatoeba.org/>"
SPDX-License-Identifier = "LicenseRef-CC-BY-2.0-FR"
```

Run: `nix develop -c git add LICENSES/LicenseRef-CC-BY-2.0-FR.txt REUSE.toml && nix develop -c reuse lint`
Expected: `Congratulations! Your project is compliant with version 3.3 of the REUSE Specification :-)`.

- [ ] **Step 9: Document the tool and the corpus**

Create `tools/pinyin-compare/README.md`. If Step 6 generated a new corpus, replace `10 October 2026` with the export's `Last-Modified` date and the SHA-256 with the export's.

````markdown
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
````

In `docs/README.md`'s table under "Beside the code", insert after the `tools/ibus-test/README.md` row:

```markdown
| [`tools/pinyin-compare/README.md`](../tools/pinyin-compare/README.md) | The pinyin comparison (R19): its corpus and report |
```

In `README.md`'s "License" list, insert after the line `- The Emscripten patches: Emscripten's MIT OR NCSA.`:

```markdown
- The pinyin comparison's corpus, `tools/pinyin-compare/corpus.tsv`: Tatoeba's sentences, under CC BY 2.0 FR.
```

Run: `nix develop -c oxfmt -c .oxfmtrc.jsonc tools/pinyin-compare/README.md docs/README.md README.md && nix develop -c hk check -S links --all`
Expected: oxfmt realigns `docs/README.md`'s table; the links step passes.

- [ ] **Step 10: Commit**

```bash
nix develop -c git add tools/pinyin-compare/package.json tools/pinyin-compare/tsconfig.json tools/pinyin-compare/vitest.config.ts tools/pinyin-compare/corpus.ts tools/pinyin-compare/corpus.test.ts tools/pinyin-compare/generate-corpus.py tools/pinyin-compare/module.nix tools/pinyin-compare/corpus.tsv tools/pinyin-compare/README.md LICENSES/LicenseRef-CC-BY-2.0-FR.txt REUSE.toml pnpm-lock.yaml docs/README.md README.md
nix develop -c git commit -m "feat(pinyin-compare): sample a Tatoeba corpus with its pinyin" -- tools/pinyin-compare/package.json tools/pinyin-compare/tsconfig.json tools/pinyin-compare/vitest.config.ts tools/pinyin-compare/corpus.ts tools/pinyin-compare/corpus.test.ts tools/pinyin-compare/generate-corpus.py tools/pinyin-compare/module.nix tools/pinyin-compare/corpus.tsv tools/pinyin-compare/README.md LICENSES/LicenseRef-CC-BY-2.0-FR.txt REUSE.toml pnpm-lock.yaml docs/README.md README.md
```

---

### Task 2: Metrics and the decision rule

**Files:**
- Create: `tools/pinyin-compare/metrics.ts`, `tools/pinyin-compare/metrics.test.ts`, `tools/pinyin-compare/summary.ts`, `tools/pinyin-compare/summary.test.ts`

**Interfaces:**
- Consumes: `corpus.ts`'s `Entry`.
- Produces (`metrics.ts`): `editDistance(a: string, b: string): number`; `interface Sample { readonly numerator: number; readonly denominator: number }`; `exactSample(sentence: string, output: string): Sample`; `characterSample(sentence: string, output: string): Sample`; `interface Estimate { readonly value: number; readonly low: number; readonly high: number }`; `ratio(samples: readonly Sample[]): Estimate`; `difference(a: readonly Sample[], b: readonly Sample[]): Estimate`.
- Produces (`summary.ts`): `interface Conversion { readonly entry: Entry; readonly libpinyin: string; readonly rime: string }`; `interface Scores { readonly exact: Estimate; readonly character: Estimate }`; `interface Group { readonly label: string; readonly sentences: number; readonly libpinyin: Scores; readonly rime: Scores; readonly difference: Scores }`; `interface Summary { readonly overall: Group; readonly byLength: readonly Group[]; readonly libpinyinAhead: boolean }`; `lengthBuckets`; `summarise(conversions: readonly Conversion[]): Summary`.

- [ ] **Step 1: Write the failing tests**

Create `tools/pinyin-compare/metrics.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { characterSample, difference, editDistance, exactSample, ratio, type Sample } from "./metrics.ts";

const z = 1.959963984540054;

describe("editDistance", () => {
  test.each([
    ["", "", 0],
    ["", "北京", 2],
    ["我们去北京吧", "我们去北京吧", 0],
    ["我们去北京吧", "我们去背景吧", 2],
    ["我们去北京吧", "我们北京吧", 1],
    ["我们去北京吧", "我们去了北京吧", 1],
    ["kitten", "sitting", 3],
    // One character outside the Basic Multilingual Plane, two UTF-16 units.
    ["𠀀好", "好", 1],
  ])("from %j to %j is %i", (a, b, distance) => {
    expect(editDistance(a, b)).toBe(distance);
    expect(editDistance(b, a)).toBe(distance);
  });
});

describe("samples", () => {
  test("an exact sentence counts 1 of 1, any other 0 of 1", () => {
    expect(exactSample("我们去北京吧", "我们去北京吧")).toEqual({ numerator: 1, denominator: 1 });
    expect(exactSample("我们去北京吧", "我们去背景吧")).toEqual({ numerator: 0, denominator: 1 });
  });

  test("a sentence's characters count its length less the edit distance", () => {
    expect(characterSample("我们去北京吧", "我们去背景吧")).toEqual({ numerator: 4, denominator: 6 });
  });

  test("an output longer than the sentence can count below zero", () => {
    expect(characterSample("北京", "我们去背景吧")).toEqual({ numerator: -4, denominator: 2 });
  });
});

const exact = (outcomes: readonly number[]): Sample[] => outcomes.map((numerator) => ({ numerator, denominator: 1 }));

describe("ratio", () => {
  test("is the sums' ratio with a 95 % interval", () => {
    // Residuals 0.25, -0.75, 0.25, 0.25: their squares sum to 0.75, and
    // 4/3 of that is 1, so the margin is z/4.
    const estimate = ratio(exact([1, 0, 1, 1]));
    expect(estimate.value).toBe(0.75);
    expect(estimate.low).toBeCloseTo(0.75 - z / 4, 12);
    expect(estimate.high).toBeCloseTo(0.75 + z / 4, 12);
  });

  test("weighs each sentence by its denominator", () => {
    const estimate = ratio([
      { numerator: 8, denominator: 8 },
      { numerator: 6, denominator: 12 },
    ]);
    expect(estimate.value).toBe(0.7);
    // Residuals 8 - 0.7 * 8 = 2.4 and 6 - 0.7 * 12 = -2.4.
    expect(estimate.high - estimate.value).toBeCloseTo((z * Math.sqrt(2 * (2 * 2.4 ** 2))) / 20, 12);
  });

  test("has no interval for one sentence", () => {
    expect(() => ratio(exact([1]))).toThrow("two sentences");
  });
});

describe("difference", () => {
  test("pairs the sentences", () => {
    // Paired residuals -0.25, 0.75, -0.25, -0.25: the margin is z/4 again.
    const estimate = difference(exact([1, 1, 0, 1]), exact([1, 0, 0, 1]));
    expect(estimate.value).toBe(0.25);
    expect(estimate.low).toBeCloseTo(0.25 - z / 4, 12);
    expect(estimate.high).toBeCloseTo(0.25 + z / 4, 12);
  });

  test("is exact when the engines differ the same way on every sentence", () => {
    expect(difference(exact([1, 1, 1]), exact([0, 0, 0]))).toEqual({ value: 1, low: 1, high: 1 });
  });

  test("needs the same sentences on both sides", () => {
    expect(() => difference(exact([1, 1]), exact([1]))).toThrow("same sentences");
    expect(() =>
      difference(
        [
          { numerator: 1, denominator: 8 },
          { numerator: 1, denominator: 8 },
        ],
        [
          { numerator: 1, denominator: 8 },
          { numerator: 1, denominator: 9 },
        ],
      ),
    ).toThrow("same sentences");
  });
});
```

Create `tools/pinyin-compare/summary.test.ts` (the sentences are 8, 9, 12, 12, 16, 16, 17, 19, 20 and 21 characters long):

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { summarise, type Conversion } from "./summary.ts";

const sentences = [
  "我们明天去北京吧",
  "绿色的女人喜欢学习",
  "以前读高中的时候我每天早",
  "这一消息证实了我的怀疑吗",
  "以前读高中的时候我每天早上六点钟",
  "我将确保你们在第一年后有一个增长",
  "以前读高中的时候我每天早上六点起床",
  "我将确保你们在第一年后有一个增长和发展",
  "以前读高中的时候我每天早上六点起床去学校",
  "我将确保你们在第一年后有一个增长和很大发展",
];

function conversions(libpinyin: (sentence: string) => string, rime: (sentence: string) => string): Conversion[] {
  return sentences.map((sentence, index) => ({
    entry: { id: index + 1, sentence, pinyin: "x" },
    libpinyin: libpinyin(sentence),
    rime: rime(sentence),
  }));
}

const same = (sentence: string) => sentence;
const wrongFirst = (sentence: string) => `错${sentence.slice(1)}`;

describe("summarise", () => {
  test("groups the sentences by length", () => {
    const summary = summarise(conversions(same, same));
    expect(summary.overall.sentences).toBe(10);
    expect(summary.byLength.map((group) => [group.label, group.sentences])).toEqual([
      ["8–11", 2],
      ["12–15", 2],
      ["16–19", 4],
      ["20 or more", 2],
    ]);
  });

  test("scores each engine and the difference", () => {
    const summary = summarise(conversions(same, wrongFirst));
    expect(summary.overall.libpinyin.exact.value).toBe(1);
    expect(summary.overall.rime.exact.value).toBe(0);
    expect(summary.overall.difference.exact).toEqual({ value: 1, low: 1, high: 1 });
    const characters = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
    expect(summary.overall.rime.character.value).toBeCloseTo(1 - sentences.length / characters, 12);
  });

  test("finds libpinyin ahead only past both differences' intervals", () => {
    expect(summarise(conversions(same, wrongFirst)).libpinyinAhead).toBe(true);
    expect(summarise(conversions(wrongFirst, same)).libpinyinAhead).toBe(false);
    expect(summarise(conversions(same, same)).libpinyinAhead).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nix develop -c bash -c 'cd tools/pinyin-compare && pnpm test'`
Expected: FAIL, `Cannot find module './metrics.ts'` for `metrics.test.ts` and `Cannot find module './summary.ts'` for `summary.test.ts`; `Test Files  2 failed | 1 passed (3)`.

- [ ] **Step 3: Implement `metrics.ts`**

Create `tools/pinyin-compare/metrics.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

/** Levenshtein distance between two strings, counted in code points. */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [i, x] of left.entries()) {
    const current = [i + 1];
    for (const [j, y] of right.entries()) {
      current.push(Math.min(previous[j + 1]! + 1, current[j]! + 1, previous[j]! + (x === y ? 0 : 1)));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** One sentence's share of a ratio metric: the metric is Σ numerator / Σ denominator. */
export interface Sample {
  readonly numerator: number;
  readonly denominator: number;
}

/** 1 for a sentence converted exactly, 0 otherwise, over 1. */
export function exactSample(sentence: string, output: string): Sample {
  return { numerator: output === sentence ? 1 : 0, denominator: 1 };
}

/** The sentence's length less the edit distance, over its length. */
export function characterSample(sentence: string, output: string): Sample {
  const length = [...sentence].length;
  return { numerator: length - editDistance(sentence, output), denominator: length };
}

/** A value with its 95 % confidence interval. */
export interface Estimate {
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

const z = 1.959963984540054;

// The standard error of a ratio of sums over sentences sampled at random,
// by linearisation: each sentence contributes its numerator less the ratio's
// share of its denominator. For exact-sentence accuracy that is the familiar
// sqrt(p(1 - p)/n), corrected for one degree of freedom.
function interval(value: number, residuals: readonly number[], denominator: number): Estimate {
  const n = residuals.length;
  if (n < 2) {
    throw new Error("an interval needs two sentences or more");
  }
  const squares = residuals.reduce((sum, residual) => sum + residual * residual, 0);
  const margin = (z * Math.sqrt((n / (n - 1)) * squares)) / denominator;
  return { value, low: value - margin, high: value + margin };
}

function total(samples: readonly Sample[], field: keyof Sample): number {
  return samples.reduce((sum, sample) => sum + sample[field], 0);
}

/** A ratio metric over the samples. */
export function ratio(samples: readonly Sample[]): Estimate {
  const denominator = total(samples, "denominator");
  const value = total(samples, "numerator") / denominator;
  return interval(
    value,
    samples.map((sample) => sample.numerator - value * sample.denominator),
    denominator,
  );
}

/**
 * The difference a − b between one ratio metric of two engines over the same
 * sentences. Pairing the sentences gives a narrower interval than the two
 * engines' own intervals would, since a sentence hard for one engine is
 * usually hard for the other.
 */
export function difference(a: readonly Sample[], b: readonly Sample[]): Estimate {
  if (a.length !== b.length || a.some((sample, index) => sample.denominator !== b[index]!.denominator)) {
    throw new Error("a difference needs the same sentences on both sides");
  }

  const denominator = total(a, "denominator");
  const valueA = total(a, "numerator") / denominator;
  const valueB = total(b, "numerator") / denominator;
  return interval(
    valueA - valueB,
    a.map(
      (sample, index) =>
        sample.numerator - valueA * sample.denominator - (b[index]!.numerator - valueB * sample.denominator),
    ),
    denominator,
  );
}
```

- [ ] **Step 4: Implement `summary.ts`**

Create `tools/pinyin-compare/summary.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import type { Entry } from "./corpus.ts";
import { characterSample, difference, exactSample, ratio, type Estimate, type Sample } from "./metrics.ts";

/** One sentence and each engine's normalised output. */
export interface Conversion {
  readonly entry: Entry;
  readonly libpinyin: string;
  readonly rime: string;
}

export interface Scores {
  readonly exact: Estimate;
  readonly character: Estimate;
}

export interface Group {
  readonly label: string;
  readonly sentences: number;
  readonly libpinyin: Scores;
  readonly rime: Scores;
  /** libpinyin's scores less Rime's. */
  readonly difference: Scores;
}

export interface Summary {
  readonly overall: Group;
  readonly byLength: readonly Group[];
  /** Whether libpinyin is ahead on both metrics by more than the difference's interval. */
  readonly libpinyinAhead: boolean;
}

/** Sentence lengths in characters, each bucket's bounds inclusive. */
export const lengthBuckets = [
  { label: "8–11", min: 8, max: 11 },
  { label: "12–15", min: 12, max: 15 },
  { label: "16–19", min: 16, max: 19 },
  { label: "20 or more", min: 20, max: Infinity },
] as const;

function samples(conversions: readonly Conversion[], engine: "libpinyin" | "rime") {
  const exact: Sample[] = [];
  const character: Sample[] = [];
  for (const conversion of conversions) {
    exact.push(exactSample(conversion.entry.sentence, conversion[engine]));
    character.push(characterSample(conversion.entry.sentence, conversion[engine]));
  }
  return { exact, character };
}

function group(label: string, conversions: readonly Conversion[]): Group {
  const libpinyin = samples(conversions, "libpinyin");
  const rime = samples(conversions, "rime");
  return {
    label,
    sentences: conversions.length,
    libpinyin: { exact: ratio(libpinyin.exact), character: ratio(libpinyin.character) },
    rime: { exact: ratio(rime.exact), character: ratio(rime.character) },
    difference: {
      exact: difference(libpinyin.exact, rime.exact),
      character: difference(libpinyin.character, rime.character),
    },
  };
}

export function summarise(conversions: readonly Conversion[]): Summary {
  const overall = group("All", conversions);
  return {
    overall,
    byLength: lengthBuckets.map((bucket) =>
      group(
        bucket.label,
        conversions.filter((conversion) => {
          const length = [...conversion.entry.sentence].length;
          return length >= bucket.min && length <= bucket.max;
        }),
      ),
    ),
    libpinyinAhead: overall.difference.exact.low > 0 && overall.difference.character.low > 0,
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run:

```bash
nix develop -c git add tools/pinyin-compare/metrics.ts tools/pinyin-compare/metrics.test.ts tools/pinyin-compare/summary.ts tools/pinyin-compare/summary.test.ts
nix develop -c bash -c 'cd tools/pinyin-compare && pnpm test'
nix build .#checks.x86_64-linux.tools-pinyin-compare -L
```

Expected: PASS, `✓ metrics.test.ts (17 tests)`, `✓ summary.test.ts (3 tests)`, `✓ corpus.test.ts (13 tests)`, `Tests  33 passed (33)`.

- [ ] **Step 6: Commit**

```bash
nix develop -c git commit -m "feat(pinyin-compare): score conversions with confidence intervals" -- tools/pinyin-compare/metrics.ts tools/pinyin-compare/metrics.test.ts tools/pinyin-compare/summary.ts tools/pinyin-compare/summary.test.ts
```

---

### Task 3: Rime's partial-candidate loop

**Files:**
- Create: `tools/pinyin-compare/rime.ts`, `tools/pinyin-compare/rime.test.ts`

**Interfaces:**
- Produces: `interface RimeState { readonly input: string | null; readonly preview: string | null; readonly candidate: string | null; readonly commit: string | null }`; `type RimeCommand = \`type ${string}\` | "select" | "clear"`; `interface RimeSession { send(command: RimeCommand): Promise<RimeState> }`; `convertWithRime(session: RimeSession, pinyin: string): Promise<string>`; `interface RimeProcess extends RimeSession { close(): Promise<void> }`; `spawnRimeSession(program: string, sharedDir: string, userDir: string, schema: string): Promise<RimeProcess>`. The state is exactly what Task 4's `rime-session` prints for each command.

- [ ] **Step 1: Write the failing test**

Create `tools/pinyin-compare/rime.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { convertWithRime, type RimeCommand, type RimeSession, type RimeState } from "./rime.ts";

interface Offer {
  readonly text: string;
  /** How many keys of the input left the candidate covers. */
  readonly keys: number;
}

/**
 * A session that behaves as rime-session does: the preview is the selected
 * text, then the first candidate, then the input left raw, and selecting a
 * candidate that covers the input left commits everything.
 */
class FakeSession implements RimeSession {
  readonly commands: RimeCommand[] = [];
  private readonly offer: (rest: string) => Offer | null;
  private selected = "";
  private rest = "";

  constructor(offer: (rest: string) => Offer | null) {
    this.offer = offer;
  }

  async send(command: RimeCommand): Promise<RimeState> {
    this.commands.push(command);
    let commit: string | null = null;

    if (command.startsWith("type ")) {
      this.selected = "";
      this.rest = command.slice("type ".length);
    } else if (command === "select") {
      const offer = this.offer(this.rest);
      if (offer !== null) {
        this.selected += offer.text;
        this.rest = this.rest.slice(offer.keys);
        if (this.rest === "") {
          commit = this.selected;
          this.selected = "";
        }
      }
    } else {
      this.selected = "";
      this.rest = "";
    }

    if (this.selected === "" && this.rest === "") {
      return { input: "", preview: null, candidate: null, commit };
    }
    const offer = this.offer(this.rest);
    return {
      input: this.rest,
      preview: this.selected + (offer === null ? this.rest : offer.text + this.rest.slice(offer.keys)),
      candidate: offer?.text ?? null,
      commit,
    };
  }
}

const words: Record<string, string> = { nihao: "你好", shijie: "世界", women: "我们" };

// The longest word at the start of the input left, as a partial candidate.
function byWord(rest: string): Offer | null {
  for (let keys = rest.length; keys > 0; keys--) {
    const text = words[rest.slice(0, keys)];
    if (text !== undefined) {
      return { text, keys };
    }
  }
  return null;
}

describe("convertWithRime", () => {
  test("takes a first candidate that covers the input without selecting it", async () => {
    const session = new FakeSession((rest) => ({ text: "你好世界", keys: rest.length }));
    expect(await convertWithRime(session, "nihaoshijie")).toBe("你好世界");
    expect(session.commands).toEqual(["type nihaoshijie", "clear"]);
  });

  test("selects a partial first candidate and continues with the next", async () => {
    const session = new FakeSession(byWord);
    expect(await convertWithRime(session, "womennihaoshijie")).toBe("我们你好世界");
    expect(session.commands).toEqual(["type womennihaoshijie", "select", "select", "clear"]);
  });

  test("leaves input no candidate covers as its letters", async () => {
    const session = new FakeSession(byWord);
    expect(await convertWithRime(session, "nihaoiii")).toBe("你好iii");
    expect(session.commands).toEqual(["type nihaoiii", "select", "clear"]);
  });

  test("takes the commit when the last candidate holds letters of its own", async () => {
    const session = new FakeSession((rest) => (rest === "iphone" ? { text: "iPhone", keys: 6 } : null));
    expect(await convertWithRime(session, "iphone")).toBe("iPhone");
    expect(session.commands).toEqual(["type iphone", "select", "clear"]);
  });

  test("stops a candidate that never uses the input up", async () => {
    const session = new FakeSession(() => ({ text: "你", keys: 0 }));
    await expect(convertWithRime(session, "ni")).rejects.toThrow("more selections than it has keys");
    expect(session.commands.at(-1)).toBe("clear");
  });

  test("rejects input that isn't lowercase letters", async () => {
    await expect(convertWithRime(new FakeSession(byWord), "ni hao")).rejects.toThrow("lowercase letters");
  });
});
```

(The `nihaoiii` case is what native Rime with `rime_ice` does: `type nihaoiii` offers `你好` with preview `你好iii`; after `select`, no candidate and preview `你好iii`.)

- [ ] **Step 2: Run the test to see it fail**

Run: `nix develop -c git add tools/pinyin-compare/rime.test.ts && nix develop -c bash -c 'cd tools/pinyin-compare && pnpm test'`
Expected: FAIL, `FAIL  rime.test.ts [ rime.test.ts ]`, `Error: Cannot find module './rime.ts' imported from …/tools/pinyin-compare/rime.test.ts`; the other three files pass.

- [ ] **Step 3: Implement `rime.ts`**

Create `tools/pinyin-compare/rime.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** A Rime session's state after a command, as rime-session prints it. */
export interface RimeState {
  readonly input: string | null;
  /** What committing now would give: the selected text, the first candidate, then any input left raw. */
  readonly preview: string | null;
  readonly candidate: string | null;
  readonly commit: string | null;
}

export type RimeCommand = `type ${string}` | "select" | "clear";

export interface RimeSession {
  send(command: RimeCommand): Promise<RimeState>;
}

/**
 * Converts pinyin as a user taking the first candidate each time would: the
 * keys, then the first candidate; while that covers only part of the input,
 * it is selected and the next first candidate taken. The last candidate is
 * read from the preview rather than selected, and the composition cleared,
 * so nothing is committed and Rime learns nothing from one sentence to the
 * next.
 */
export async function convertWithRime(session: RimeSession, pinyin: string): Promise<string> {
  if (!/^[a-z]+$/.test(pinyin)) {
    throw new Error(`rime: ${JSON.stringify(pinyin)} isn't lowercase letters alone`);
  }

  let state = await session.send(`type ${pinyin}`);
  try {
    // Each selection uses at least one key of the input.
    for (let selections = 0; selections <= pinyin.length; selections++) {
      if (state.commit !== null) {
        return state.commit;
      }
      // Input left raw shows in the preview as its letters.
      if (state.candidate === null || !/[a-z]/.test(state.preview ?? "")) {
        return state.preview ?? "";
      }
      state = await session.send("select");
    }
    throw new Error(`rime: ${pinyin} took more selections than it has keys`);
  } finally {
    await session.send("clear");
  }
}

/** A running rime-session process. */
export interface RimeProcess extends RimeSession {
  close(): Promise<void>;
}

export async function spawnRimeSession(
  program: string,
  sharedDir: string,
  userDir: string,
  schema: string,
): Promise<RimeProcess> {
  const child = spawn(program, [sharedDir, userDir, schema], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();

  const next = async (): Promise<unknown> => {
    const line = await lines.next();
    if (line.done === true) {
      throw new Error(`rime-session exited with ${await exited}`);
    }
    return JSON.parse(line.value);
  };

  const ready = (await next()) as { schema?: unknown };
  if (ready.schema !== schema) {
    throw new Error(`rime-session started in ${JSON.stringify(ready.schema)}, not ${schema}`);
  }

  return {
    async send(command) {
      child.stdin.write(`${command}\n`);
      return (await next()) as RimeState;
    },
    async close() {
      child.stdin.end();
      const status = await exited;
      if (status !== 0) {
        throw new Error(`rime-session exited with ${status}`);
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run:

```bash
nix develop -c git add tools/pinyin-compare/rime.ts
nix develop -c bash -c 'cd tools/pinyin-compare && pnpm test'
nix build .#checks.x86_64-linux.tools-pinyin-compare -L
```

Expected: PASS, `✓ rime.test.ts (6 tests)`, `Test Files  4 passed (4)`, `Tests  39 passed (39)`.

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "feat(pinyin-compare): convert through Rime's first candidates" -- tools/pinyin-compare/rime.ts tools/pinyin-compare/rime.test.ts
```

---

### Task 4: The native drivers and the report

**Files:**
- Create: `tools/pinyin-compare/libpinyin-convert.c`, `tools/pinyin-compare/rime-session.c`, `tools/pinyin-compare/libpinyin.ts`, `tools/pinyin-compare/report.ts`
- Modify: `tools/pinyin-compare/module.nix`, `tools/pinyin-compare/README.md`

**Interfaces:**
- Consumes: `parseCorpus`, `normalise` (Task 1); `summarise` and its types, `Estimate` (Task 2); `convertWithRime`, `spawnRimeSession` (Task 3).
- Produces: `libpinyin-convert <system data directory> <empty user directory>` (stdin pinyin lines → stdout sentences, one each); `rime-session <shared data directory> <empty user directory> <schema>` (prints `{"schema":"<id>"}` once ready, then one state line per command); `convertWithLibpinyin(program: string, dataDir: string, userDir: string, pinyins: readonly string[]): string[]`; `packages.ibus-web-pinyin-compare-report` with `passthru.drivers` and `passthru.rimeData`.

- [ ] **Step 1: See the report missing**

Run: `nix build .#ibus-web-pinyin-compare-report`
Expected: FAIL, `error: flake '…' does not provide attribute 'packages.x86_64-linux.ibus-web-pinyin-compare-report'` (with the usual alternatives listed).

- [ ] **Step 2: Write the libpinyin driver**

Create `tools/pinyin-compare/libpinyin-convert.c`:

```c
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Converts each line of toneless full pinyin on stdin to libpinyin's guessed
// sentence on stdout, one line each.
//
// Usage: libpinyin-convert <system data directory> <empty user directory>

#include <pinyin.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ibus-libpinyin's defaults: its settings' incomplete pinyin and pinyin
// corrections, masked by its option mask, which leaves out DYNAMIC_ADJUST,
// and the tables it always adds.
static const pinyin_option_t options = PINYIN_INCOMPLETE | ZHUYIN_INCOMPLETE |
                                       PINYIN_CORRECT_ALL | USE_RESPLIT_TABLE |
                                       USE_DIVIDED_TABLE;

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <system data directory> <user directory>\n",
            argv[0]);
    return 2;
  }

  pinyin_context_t *context = pinyin_init(argv[1], argv[2]);
  if (context == NULL) {
    fprintf(stderr, "pinyin_init failed\n");
    return 1;
  }
  pinyin_set_options(context, options);
  pinyin_instance_t *instance = pinyin_alloc_instance(context);

  char *line = NULL;
  size_t capacity = 0;
  ssize_t length;
  while ((length = getline(&line, &capacity, stdin)) != -1) {
    if (length > 0 && line[length - 1] == '\n')
      line[--length] = '\0';

    pinyin_reset(instance);
    size_t parsed = pinyin_parse_more_full_pinyins(instance, line);
    if (parsed != (size_t)length)
      fprintf(stderr, "%s: parsed %zu of %zd bytes\n", line, parsed, length);

    char *sentence = NULL;
    if (!pinyin_guess_sentence(instance) ||
        !pinyin_get_sentence(instance, 0, &sentence)) {
      fprintf(stderr, "%s: no sentence\n", line);
      puts("");
      continue;
    }
    puts(sentence);
    g_free(sentence);
  }
  free(line);

  pinyin_free_instance(instance);
  pinyin_fini(context);
  return ferror(stdout) ? 1 : 0;
}
```

- [ ] **Step 3: Write the Rime driver**

Create `tools/pinyin-compare/rime-session.c`:

```c
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Drives one Rime session in a schema by commands on stdin, one a line,
// answering each with the session's state as one line of JSON on stdout:
//
//   type <keys>   clears the composition, then presses each key
//   select        selects the first candidate
//   clear         clears the composition
//
// The state is {"input", "preview", "candidate", "commit"}: the unconverted
// input, the text a commit would give now, the first candidate, and the text
// the command committed, each null when there is none. It deploys into the
// user directory first and prints {"schema": <id>} once the session is in the
// schema.
//
// Usage: rime-session <shared data directory> <empty user directory> <schema>

#include <rime_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static RimeApi *rime;
static RimeSessionId session;

static void print_string(const char *text) {
  if (text == NULL) {
    fputs("null", stdout);
    return;
  }
  putchar('"');
  for (const unsigned char *c = (const unsigned char *)text; *c != '\0'; c++) {
    if (*c == '"' || *c == '\\')
      printf("\\%c", *c);
    else if (*c < 0x20)
      printf("\\u%04x", *c);
    else
      putchar(*c);
  }
  putchar('"');
}

static void print_state(void) {
  RIME_STRUCT(RimeContext, context);
  RIME_STRUCT(RimeCommit, commit);
  rime->get_context(session, &context);
  Bool committed = rime->get_commit(session, &commit);

  fputs("{\"input\":", stdout);
  print_string(rime->get_input(session));
  fputs(",\"preview\":", stdout);
  print_string(context.commit_text_preview);
  fputs(",\"candidate\":", stdout);
  print_string(context.menu.num_candidates > 0 ? context.menu.candidates[0].text
                                               : NULL);
  fputs(",\"commit\":", stdout);
  print_string(committed ? commit.text : NULL);
  fputs("}\n", stdout);
  fflush(stdout);

  if (committed)
    rime->free_commit(&commit);
  rime->free_context(&context);
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr,
            "usage: %s <shared data directory> <user directory> <schema>\n",
            argv[0]);
    return 2;
  }

  rime = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = argv[1];
  traits.user_data_dir = argv[2];
  traits.app_name = "rime.pinyin-compare";
  traits.distribution_name = "pinyin-compare";
  traits.distribution_code_name = "pinyin-compare";
  traits.distribution_version = "1";
  // Logs go to stderr, warnings and above.
  traits.log_dir = "";
  traits.min_log_level = 1;

  rime->setup(&traits);
  rime->initialize(&traits);
  if (!rime->start_maintenance(True)) {
    fprintf(stderr, "maintenance didn't start\n");
    return 1;
  }
  rime->join_maintenance_thread();

  session = rime->create_session();
  char current[100];
  if (session == 0 || !rime->select_schema(session, argv[3]) ||
      !rime->get_current_schema(session, current, sizeof current) ||
      strcmp(current, argv[3]) != 0) {
    fprintf(stderr, "schema %s isn't available\n", argv[3]);
    return 1;
  }
  fputs("{\"schema\":", stdout);
  print_string(current);
  fputs("}\n", stdout);
  fflush(stdout);

  char *line = NULL;
  size_t capacity = 0;
  ssize_t length;
  while ((length = getline(&line, &capacity, stdin)) != -1) {
    if (length > 0 && line[length - 1] == '\n')
      line[--length] = '\0';

    if (strncmp(line, "type ", 5) == 0) {
      rime->clear_composition(session);
      for (const char *key = line + 5; *key != '\0'; key++)
        rime->process_key(session, (unsigned char)*key, 0);
    } else if (strcmp(line, "select") == 0) {
      rime->select_candidate(session, 0);
    } else if (strcmp(line, "clear") == 0) {
      rime->clear_composition(session);
    } else {
      fprintf(stderr, "unknown command: %s\n", line);
      return 2;
    }
    print_state();
  }
  free(line);

  rime->destroy_session(session);
  rime->finalize();
  return 0;
}
```

(A key's keycode is its ASCII value, which is its X keysym for lowercase letters.)

- [ ] **Step 4: Write `libpinyin.ts` and `report.ts`**

Create `tools/pinyin-compare/libpinyin.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { execFileSync } from "node:child_process";

/** Each pinyin's sentence from libpinyin-convert, in order. */
export function convertWithLibpinyin(
  program: string,
  dataDir: string,
  userDir: string,
  pinyins: readonly string[],
): string[] {
  const output = execFileSync(program, [dataDir, userDir], {
    input: pinyins.map((pinyin) => `${pinyin}\n`).join(""),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });

  const sentences = output.split("\n");
  if (sentences.pop() !== "" || sentences.length !== pinyins.length) {
    throw new Error(`libpinyin-convert gave ${sentences.length} lines for ${pinyins.length} inputs`);
  }
  return sentences;
}
```

Create `tools/pinyin-compare/report.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// report.ts --corpus <corpus.tsv> --out <directory> --libpinyin-convert <program> --libpinyin-data <directory>
//   --rime-session <program> --rime-data <directory> --libpinyin-version <text> --rime-version <text>
//
// Converts the corpus with both engines, each with user data of its own made
// fresh, and writes conversions.tsv, summary.json and report.md to the output
// directory.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { normalise, parseCorpus } from "./corpus.ts";
import { convertWithLibpinyin } from "./libpinyin.ts";
import { type Estimate } from "./metrics.ts";
import { convertWithRime, spawnRimeSession } from "./rime.ts";
import { summarise, type Conversion, type Group, type Summary } from "./summary.ts";

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    out: { type: "string" },
    "libpinyin-convert": { type: "string" },
    "libpinyin-data": { type: "string" },
    "rime-session": { type: "string" },
    "rime-data": { type: "string" },
    "libpinyin-version": { type: "string" },
    "rime-version": { type: "string" },
  },
  strict: true,
});

function required(name: keyof typeof values): string {
  const value = values[name];
  if (value === undefined) {
    console.error(`report.ts: --${name} is required`);
    process.exit(2);
  }
  return value;
}

const percent = (value: number) => (value * 100).toFixed(1);
const estimate = (value: Estimate) => `${percent(value.value)} (${percent(value.low)} to ${percent(value.high)})`;

function table(groups: readonly Group[], metric: "exact" | "character"): string {
  const rows = groups.map(
    (group) =>
      `| ${group.label} | ${group.sentences} | ${estimate(group.libpinyin[metric])} | ${estimate(group.rime[metric])} | ${estimate(group.difference[metric])} |`,
  );
  return [
    "| Length | Sentences | libpinyin | Rime | libpinyin − Rime |",
    "| ------ | --------: | --------: | ---: | ---------------: |",
    ...rows,
  ].join("\n");
}

function render(summary: Summary, libpinyinVersion: string, rimeVersion: string): string {
  const groups = [summary.overall, ...summary.byLength];
  const verdict = summary.libpinyinAhead
    ? "libpinyin is ahead on both metrics by more than the difference's 95 % confidence interval."
    : "libpinyin is not ahead on both metrics by more than the difference's 95 % confidence interval.";
  return [
    "# Long-sentence conversion: libpinyin and Rime",
    "",
    `- libpinyin: ${libpinyinVersion}`,
    `- Rime: ${rimeVersion}`,
    "",
    "Percentages, each with its 95 % confidence interval.",
    "",
    "## Exact-sentence accuracy",
    "",
    table(groups, "exact"),
    "",
    "## Character accuracy",
    "",
    table(groups, "character"),
    "",
    "## Outcome",
    "",
    verdict,
    "",
  ].join("\n");
}

const corpus = parseCorpus(readFileSync(required("corpus"), "utf8"));
const out = required("out");
mkdirSync(out, { recursive: true });

const libpinyinOutputs = convertWithLibpinyin(
  required("libpinyin-convert"),
  required("libpinyin-data"),
  mkdtempSync(join(tmpdir(), "libpinyin-")),
  corpus.map((entry) => entry.pinyin),
);

const session = await spawnRimeSession(
  required("rime-session"),
  required("rime-data"),
  mkdtempSync(join(tmpdir(), "rime-")),
  "rime_ice",
);
const rimeOutputs: string[] = [];
for (const entry of corpus) {
  rimeOutputs.push(await convertWithRime(session, entry.pinyin));
}
await session.close();

const conversions: Conversion[] = corpus.map((entry, index) => ({
  entry,
  libpinyin: normalise(libpinyinOutputs[index]!),
  rime: normalise(rimeOutputs[index]!),
}));
const summary = summarise(conversions);

writeFileSync(
  join(out, "conversions.tsv"),
  [
    "id\tsentence\tpinyin\tlibpinyin\trime\n",
    ...conversions.map(
      ({ entry, libpinyin, rime }) => `${entry.id}\t${entry.sentence}\t${entry.pinyin}\t${libpinyin}\t${rime}\n`,
    ),
  ].join(""),
);
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(out, "report.md"), render(summary, required("libpinyin-version"), required("rime-version")));
```

- [ ] **Step 5: Add the drivers and the report to the Nix module**

Replace `tools/pinyin-compare/module.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      inherit (config.ibusWeb) testing typescript;

      workspace = typescript.workspaceFor [ "tools/pinyin-compare" ];

      drivers = pkgs.stdenv.mkDerivation {
        name = "ibus-web-pinyin-compare-drivers";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./libpinyin-convert.c
            ./rime-session.c
          ];
        };

        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [
          pkgs.glib
          pkgs.libpinyin
          pkgs.librime
        ];

        # GNU C23: pinyin.h uses bool without stdbool.h, and the drivers use
        # POSIX getline.
        buildPhase = ''
          runHook preBuild
          $CC -std=gnu23 -O2 -Wall -Wextra -Werror libpinyin-convert.c $(pkg-config --cflags --libs libpinyin) -o libpinyin-convert
          $CC -std=gnu23 -O2 -Wall -Wextra -Werror rime-session.c $(pkg-config --cflags --libs rime) -o rime-session
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          install -Dm755 -t $out/bin libpinyin-convert rime-session
          runHook postInstall
        '';
      };

      # rime-ice as its users install it: its suggested default.yaml, which
      # nixpkgs installs under another name, is the default configuration. Its
      # empty build/ is left out, since Rime reads a shared build/ as prebuilt
      # data.
      rimeData = pkgs.runCommand "ibus-web-pinyin-compare-rime-data" { } ''
        mkdir $out
        for file in ${pkgs.rime-ice}/share/rime-data/*; do
          [ "$(basename "$file")" = build ] || ln -s "$file" $out/
        done
        ln -s ${pkgs.rime-ice}/share/rime-data/rime_ice_suggestion.yaml $out/default.yaml
      '';

      # clangd reads the repository's C as WebAssembly; the drivers are native.
      nativeClangd =
        pkgs.runCommand "ibus-web-pinyin-compare-clangd"
          {
            inherit (drivers) buildInputs;
            nativeBuildInputs = [ pkgs.pkg-config ];
          }
          ''
            {
              echo 'If:'
              echo '  PathMatch: tools/pinyin-compare/.*\.c'
              echo 'CompileFlags:'
              echo '  Compiler: ${pkgs.stdenv.cc}/bin/cc'
              echo '  Remove: [-isystem, -fwasm-exceptions, -mextended-const]'
              echo '  Add:'
              echo '    - -std=gnu23'
              for flag in $(pkg-config --cflags libpinyin rime); do
                echo "    - $flag"
              done
            } > $out
          '';

      corpusPython = pkgs.python3.withPackages (ps: [
        ps.opencc
        ps.pypinyin
      ]);
    in
    {
      # Run once to write the committed corpus; Tatoeba replaces its exports
      # weekly, so the corpus is never rebuilt from one.
      apps.pinyin-compare-corpus = {
        type = "app";
        program = lib.getExe (
          pkgs.writeShellApplication {
            name = "ibus-web-pinyin-compare-corpus";
            text = ''
              exec ${corpusPython}/bin/python3 -I ${./generate-corpus.py} "$@"
            '';
          }
        );
      };

      # nixpkgs builds libpinyin for Linux alone.
      ibusWeb.toolchain = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        clangdFragments = [ nativeClangd ];
        clangdQueryDrivers = [ "${pkgs.stdenv.cc}/bin/cc" ];
      };

      # A finding rather than a check: the scores neither pass nor fail.
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-web-pinyin-compare-report =
          pkgs.runCommand "ibus-web-pinyin-compare-report"
            {
              nativeBuildInputs = [ typescript.nodejs ];
              passthru = { inherit drivers rimeData; };
            }
            ''
              export HOME=$(mktemp -d)
              node ${workspace}/tools/pinyin-compare/report.ts \
                --corpus ${workspace}/tools/pinyin-compare/corpus.tsv \
                --out $out \
                --libpinyin-convert ${drivers}/bin/libpinyin-convert \
                --libpinyin-data ${pkgs.libpinyin}/lib/libpinyin/data \
                --rime-session ${drivers}/bin/rime-session \
                --rime-data ${rimeData} \
                --libpinyin-version "libpinyin ${pkgs.libpinyin.version}, with ibus-libpinyin ${pkgs.ibus-engines.libpinyin.version}'s default options" \
                --rime-version "librime ${pkgs.librime.version}, rime-ice ${pkgs.rime-ice.version}"
            '';
      };

      checks.tools-pinyin-compare = testing.vitestCheck {
        name = "tools-pinyin-compare";
        packageDir = "${workspace}/tools/pinyin-compare";
        env = { };
        inBrowsers = false;
        limit = 60;
      };
    };
}
```

`checks.toolchain-clangd` runs `clangd --check` on every C file in the repository under the editor configuration, which treats C as WebAssembly; without the native fragment it fails on `'rime_api.h' file not found`, and without `-std=gnu23` on `unknown type name 'bool'` in `pinyin.h` (clangd's default is C17) and on `getline` (plain `-std=c23` hides POSIX). The gate follows the native IBus adapter's: `libpinyin`'s `meta.platforms` is Linux.

- [ ] **Step 6: Build the report**

Run:

```bash
nix develop -c git add tools/pinyin-compare/libpinyin-convert.c tools/pinyin-compare/rime-session.c tools/pinyin-compare/libpinyin.ts tools/pinyin-compare/report.ts tools/pinyin-compare/module.nix
nix build .#ibus-web-pinyin-compare-report -L -o pinyin-compare-report
cat pinyin-compare-report/report.md
nix log .#ibus-web-pinyin-compare-report | grep -c 'parsed .* of .* bytes\|no sentence'
nix develop -c tsc -b --noEmit tools/pinyin-compare
nix build .#checks.x86_64-linux.toolchain-clangd -L
```

Expected: the build succeeds in a minute or two; its log shows Rime's deployment warnings (`entry_collector.cc … duplicate word definition`, `config_data.cc … nonexistent config file '…/build/<schema>.schema.yaml'`, `circular dependencies detected in radical_pinyin.schema`, an OpenCC `config does not conform to schema` warning for `emoji.json`) and libpinyin's `open …/user.conf failed.`, none of them fatal. `report.md` opens `# Long-sentence conversion: libpinyin and Rime`, names `libpinyin 2.11.91, with ibus-libpinyin 1.16.5's default options` and `librime 1.17.0, rime-ice 2026.06.30`, and has both tables with rows `All`, `8–11`, `12–15`, `16–19`, `20 or more`. With the spike's corpus its figures are exactly the [preliminary figures](#preliminary-figures) and its outcome `libpinyin is not ahead on both metrics by more than the difference's 95 % confidence interval.`; with a regenerated corpus they move by a few tenths of a point. The `grep -c` prints `0`, tsc prints nothing, and `toolchain-clangd` passes. Remove the `pinyin-compare-report` link afterwards (`rm pinyin-compare-report`); it is not committed.

- [ ] **Step 7: Document the report**

In `tools/pinyin-compare/README.md`, insert above `## The corpus`:

```markdown
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

```

Run: `nix develop -c oxfmt -c .oxfmtrc.jsonc tools/pinyin-compare/README.md`

- [ ] **Step 8: Commit**

```bash
nix develop -c git add tools/pinyin-compare/README.md
nix develop -c git commit -m "feat(pinyin-compare): build the comparison report natively" -- tools/pinyin-compare/libpinyin-convert.c tools/pinyin-compare/rime-session.c tools/pinyin-compare/libpinyin.ts tools/pinyin-compare/report.ts tools/pinyin-compare/module.nix tools/pinyin-compare/README.md
```

Expected: hk's clang-format step passes (the C above is already formatted); if it reformats a file, re-add it and commit again.

---

### Task 5: R19's resolution in the design spec

The report from Task 4 decides which branch applies: `jq .libpinyinAhead pinyin-compare-report/summary.json` (rebuild the link with `nix build .#ibus-web-pinyin-compare-report -o pinyin-compare-report` if it was removed). **`false` → branch A. `true` → branch B.** Do only one. The spike's report gives `false`.

**Files:**
- Modify: `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**
- Consumes: `pinyin-compare-report/report.md` and `summary.json`.
- Produces: R19 settled; in branch B, `M6` libpinyin and `M7` 1.0 in `## 12. Milestones`.

- [ ] **Step 1: Read the figures**

Run:

```bash
jq -r '[.overall, .byLength[-1]][] | [.label, .sentences, (.libpinyin, .rime, .difference | .exact, .character | [.value, .low, .high] | map(. * 1000 | round / 10) | join("/"))] | join("  ")' pinyin-compare-report/summary.json
```

Expected (spike): `All  1000  40.6/37.6/43.6  89/88.2/89.7  51.5/48.4/54.6  90.8/90/91.6  -10.9/-14.1/-7.7  -1.8/-2.6/-1.1` and `20 or more  79  16.5/8.2/24.7  88.3/86.2/90.4  20.3/11.3/29.2  87.7/85.2/90.3  -3.8/-14.1/6.5  0.6/-1.5/2.7` (each triple value/low/high in percent: libpinyin exact, libpinyin characters, Rime exact, Rime characters, difference exact, difference characters). Use these numbers, to one decimal, wherever the text below has figures; the text below carries the spike's.

- [ ] **Step 2 (branch A, `libpinyinAhead` is `false`): Settle R19, libpinyin stays dropped**

In `docs/specs/2026-09-26-ibus-web-design.md`, section `## 13. Risks and open questions`, replace the whole R19 item, from `- **R19. Rime's sentence conversion.** With` through `the options without one are dictionaries alone or a smaller model built for the purpose.`, with:

```markdown
- **R19. Rime's sentence conversion. Settled in M5: libpinyin stays dropped.** `tools/pinyin-compare` converts 1,000
  Mandarin sentences from Tatoeba, of 8 characters or more, typed as toneless pinyin without separators, with native
  libpinyin 2.11.91 at ibus-libpinyin 1.16.5's default options and native librime 1.17.0 with `rime-ice` 2026.06.30's
  `rime_ice`, each with fresh user data and neither with a grammar model; `nix build .#ibus-web-pinyin-compare-report`
  rebuilds the report. Rime converts 51.5 % of the sentences exactly to libpinyin's 40.6 %, 10.9 points ahead (95 %
  interval of the paired difference 7.7 to 14.1), and 90.8 % of their characters to 89.0 %, 1.8 points ahead (1.1 to
  2.6). Its lead narrows with length: on the 79 sentences of 20 characters or more the two are level within the
  intervals (exact 20.3 % and 16.5 %, characters 87.7 % and 88.3 %). libpinyin is ahead on neither metric, so M5 ships
  `rime-ice` without a grammar model, libpinyin stays dropped (D2), and the 398 MB model isn't needed to match it.
```

If the executor's figures differ, keep the sentences and change the numbers; if Rime's overall lead is not beyond the paired interval on a metric, write `level within the intervals on <metric>` in place of that metric's `N points ahead (…)` clause.

- [ ] **Step 2 (branch B, `libpinyinAhead` is `true`): Settle R19, libpinyin returns as M6**

In `docs/specs/2026-09-26-ibus-web-design.md`:

1. Replace the whole R19 item, from `- **R19. Rime's sentence conversion.** With` through `the options without one are dictionaries alone or a smaller model built for the purpose.`, with the following, its figures taken from Step 1 (`<…>` marks each one):

   ```markdown
   - **R19. Rime's sentence conversion. Settled in M5: libpinyin returns as M6.** `tools/pinyin-compare` converts 1,000
     Mandarin sentences from Tatoeba, of 8 characters or more, typed as toneless pinyin without separators, with native
     libpinyin 2.11.91 at ibus-libpinyin 1.16.5's default options and native librime 1.17.0 with `rime-ice` 2026.06.30's
     `rime_ice`, each with fresh user data and neither with a grammar model; `nix build .#ibus-web-pinyin-compare-report`
     rebuilds the report. libpinyin converts <libpinyin exact> % of the sentences exactly to Rime's <Rime exact> %,
     <difference exact> points ahead (95 % interval of the paired difference <low> to <high>), and <libpinyin characters> %
     of their characters to <Rime characters> %, <difference characters> points ahead (<low> to <high>). Rime with
     `rime-ice` stays M5's Chinese engine for its schemes; ibus-libpinyin's sentence conversion comes in M6 rather than a
     398 MB grammar model.
   ```

2. In `## 12. Milestones`, replace the row that begins `| M6      | 1.0: finished facade` with two rows:

   ```markdown
   | M6      | libpinyin: ibus-libpinyin over libpinyin, its bigram model and its databases in IndexedDB, as one side module beside Rime (R19) | Does libpinyin's KyotoCabinet or BerkeleyDB storage work over WasmFS (R6); how its binary data is shipped (R16) |
   | M7      | 1.0: finished facade, docs, generated protocol spec, release pipeline with source bundles | |
   ```

3. In `## 3. Decision log`, D2's row: replace its "Chosen" cell `Hangul, m17n, Mozc, Rime, custom table engine; Rime alone for Chinese` with `Hangul, m17n, Mozc, Rime, custom table engine; Rime for Chinese, and libpinyin from M6 for its sentence conversion (R19)`, and its "Main alternatives rejected" cell `Arbitrary engines from day one; libpinyin as well as Rime (Rime covers its input schemes; Mozc already proved C++ side modules, persistence and large tables)` with `Arbitrary engines from day one`.

4. Replace `- **R6. libpinyin databases in WASM. Withdrawn** with libpinyin (D2).` with `- **R6. libpinyin databases in WASM.** Reopened by R19, for M6: whether libpinyin's database backend works over WasmFS and the IndexedDB backend.` and `- **R16. libpinyin binary data. Withdrawn** with libpinyin (D2).` with `- **R16. libpinyin binary data.** Reopened by R19, for M6: how libpinyin's generated binary tables are built and shipped.`

- [ ] **Step 3: Format and check**

Run: `nix develop -c oxfmt -c .oxfmtrc.jsonc docs/specs/2026-09-26-ibus-web-design.md && nix develop -c hk check -S links --all && git diff --stat`
Expected: oxfmt rewraps the R19 item (and, in branch B, realigns the two tables); links pass; the diff touches only `docs/specs/2026-09-26-ibus-web-design.md`.

- [ ] **Step 4: Commit**

Branch A:

```bash
nix develop -c git add docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "docs(spec): settle R19 for rime-ice; libpinyin stays dropped" -- docs/specs/2026-09-26-ibus-web-design.md
```

Branch B:

```bash
nix develop -c git add docs/specs/2026-09-26-ibus-web-design.md
nix develop -c git commit -m "docs(spec): settle R19; libpinyin returns as M6" -- docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 6: Verify the phase

- [ ] **Step 1: Generated files**

Run: `nix run .#write-files && git status --short`
Expected: no output from `git status` (no drift; this phase changes no generated file).

- [ ] **Step 2: The phase's own check and report**

Run:

```bash
nix build .#checks.x86_64-linux.tools-pinyin-compare -L
nix build .#ibus-web-pinyin-compare-report -L --rebuild
```

Expected: the check passes with `Tests  39 passed (39)`; the report rebuilds with the same `summary.json` as Task 5 used (`--rebuild` compares it with the stored output and fails on any difference, which would mean the conversion isn't deterministic).

- [ ] **Step 3: The flake's checks**

Run: `nix flake check -L`
Expected: every check passes. `checks.tools-pinyin-compare` is among them; `packages.ibus-web-pinyin-compare-report` and `apps.pinyin-compare-corpus` evaluate. (In the spike, `tools-ibus-test`'s `cleans up a spawned grandchild on child-abort` timed out once under the full parallel load and passed when rebuilt alone with `nix build .#checks.x86_64-linux.tools-ibus-test -L`; if it fails, rebuild it alone and report both runs.)

- [ ] **Step 4: Integration checks**

Run: `nix build .#integration-checks -L`
Expected: PASS. This phase adds nothing to them; it confirms the lockfile change disturbs nothing.

- [ ] **Step 5: Every lint**

Run: `nix develop -c hk check --all`
Expected: every step passes, `reuse` and `links` included.

- [ ] **Step 6: Report**

Report which of Steps 1–5 ran and their results, the report's figures and outcome (`report.md`'s tables and last line), which branch of Task 5 was taken, and the corpus used (the spike's, or the export date and SHA-256 if regenerated).
