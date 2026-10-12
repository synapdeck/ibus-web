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
