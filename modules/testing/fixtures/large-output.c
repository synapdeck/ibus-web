/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Lists its one case after a TAP comment of a mebibyte, more than a pipe's
 * reader can take in at once. Its standard output must block until the
 * reader catches up: on a non-blocking pipe the comment's write comes up
 * short and drops the rest of the line, or a later write fails with
 * EAGAIN, and the case is never listed. */

#include <stdio.h>
#include <string.h>

#define COMMENT_BYTES (1024 * 1024)

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "-l") == 0) {
      fputs("# ", stdout);
      for (int j = 0; j < COMMENT_BYTES; j++)
        putchar('x');
      putchar('\n');
      printf("/large/listed\n");
      return 0;
    }
  }

  printf("TAP version 14\n");
  printf("ok 1 /large/listed\n");
  printf("1..1\n");
  return 0;
}
