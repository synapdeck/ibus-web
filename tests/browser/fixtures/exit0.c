/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include <stdio.h>

int main(int argc, char **argv) {
  printf("exit0: %d arguments\n", argc - 1);
  for (int i = 1; i < argc; i++)
    printf("exit0: argv[%d] = %s\n", i, argv[i]);
  fprintf(stderr, "exit0: on stderr\n");
  return 0;
}
