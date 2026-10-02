/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Leaves an orphan, as a page that goes away with a file unlinked but still
 * open does: the program exits before it closes the file, so the inode and
 * chunks the last close would delete stay behind. */

#include <fcntl.h>
#include <unistd.h>

#include "idb-test.h"
#include "sweep.h"

static void left(const struct idb_test_layout *layout) {
  CHECK(layout->inodes == SWEEP_LEFT_INODES);
  CHECK(layout->entries == SWEEP_LEFT_ENTRIES);
  CHECK(layout->chunks == SWEEP_LEFT_CHUNKS);
  finish_test("sweep.1");
}

static void run_test(const struct idb_test_layout *layout) {
  CHECK(layout->inodes == 1);
  write_file(SWEEP_MOUNT "/kept", 0644, "kept");

  /* Two chunks. */
  size_t size = layout->chunk_size + 1;
  uint8_t *data = malloc(size);
  memset(data, 'o', size);
  int fd = open(SWEEP_MOUNT "/orphan", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, size) == (ssize_t)size);
  CHECK(unlink(SWEEP_MOUNT "/orphan") == 0);
  uint8_t byte = 0;
  CHECK(pread(fd, &byte, 1, size - 1) == 1 && byte == 'o');
  free(data);
  read_layout_then(SWEEP_DATABASE, left);
}

int main(void) { start_test(SWEEP_DATABASE, SWEEP_MOUNT); }
