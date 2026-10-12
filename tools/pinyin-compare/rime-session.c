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
