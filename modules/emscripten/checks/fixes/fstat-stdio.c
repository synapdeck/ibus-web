/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

#include <stdio.h>
#include <sys/stat.h>

int main(void) {
  for (int fd = 0; fd < 3; fd++) {
    struct stat st;
    if (fstat(fd, &st) != 0) {
      printf("fstat(%d) failed\n", fd);
      return 1;
    }
  }
  return 0;
}
