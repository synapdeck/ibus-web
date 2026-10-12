/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Writes a line holding a NUL byte to stdout, and another to stderr. */

#include <unistd.h>

int main(void) {
  if (write(STDOUT_FILENO, "a\0b\n", 4) != 4)
    return 1;
  if (write(STDERR_FILENO, "c\0d\n", 4) != 4)
    return 1;
  return 0;
}
