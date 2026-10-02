/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Files whose sizes sit on or around chunk boundaries and the limits of what
 * the backend stores: holes, appends, empty files, and the largest size a
 * JavaScript number holds exactly. */

#include <fcntl.h>
#include <stdint.h>
#include <sys/stat.h>
#include <unistd.h>

#include "idb-test.h"

#define DATABASE "ibus-web-test-sizes"
#define MOUNT "/sizes"

/* The largest offset a double holds exactly, and every integer below it. */
#define MAX_SIZE (((off_t)1 << 53) - 1)

static off_t size_of(int fd) {
  struct stat st;
  CHECK(fstat(fd, &st) == 0);
  return st.st_size;
}

/* Whether `len` bytes from `offset` all hold `byte`. */
static int all(const uint8_t *buf, size_t offset, size_t len, uint8_t byte) {
  for (size_t i = offset; i < offset + len; i++)
    if (buf[i] != byte)
      return 0;
  return 1;
}

/* Writes past the end leave holes that read as zeros: one inside the first
 * chunk, and one spanning whole chunks. */
static void check_sparse(size_t chunk) {
  int fd = open(MOUNT "/sparse", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, "abc", 3) == 3);
  CHECK(lseek(fd, 10, SEEK_SET) == 10);
  CHECK(write(fd, "def", 3) == 3);
  size_t far = 3 * chunk + chunk / 2;
  CHECK(lseek(fd, far, SEEK_SET) == (off_t)far);
  CHECK(size_of(fd) == 13);
  CHECK(write(fd, "ghi", 3) == 3);
  size_t size = far + 3;
  CHECK(size_of(fd) == (off_t)size);

  uint8_t *back = malloc(size + 1);
  memset(back, 'x', size + 1);
  CHECK(pread(fd, back, size + 1, 0) == (ssize_t)size);
  CHECK(memcmp(back, "abc", 3) == 0);
  CHECK(all(back, 3, 7, 0));
  CHECK(memcmp(back + 10, "def", 3) == 0);
  CHECK(all(back, 13, far - 13, 0));
  CHECK(memcmp(back + far, "ghi", 3) == 0);
  CHECK(close(fd) == 0);
  free(back);
}

/* Shrinking onto a boundary drops every chunk past it; growing again reads
 * zeros there. */
static void check_truncate_to_boundary(size_t chunk) {
  size_t written = 2 * chunk + chunk / 2;
  uint8_t *data = malloc(written);
  memset(data, 'z', written);
  int fd = open(MOUNT "/boundary", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, written) == (ssize_t)written);
  CHECK(ftruncate(fd, chunk) == 0);
  CHECK(size_of(fd) == (off_t)chunk);
  CHECK(ftruncate(fd, 3 * chunk) == 0);
  CHECK(size_of(fd) == (off_t)(3 * chunk));

  uint8_t *back = malloc(3 * chunk);
  CHECK(pread(fd, back, 3 * chunk, 0) == (ssize_t)(3 * chunk));
  CHECK(all(back, 0, chunk, 'z'));
  CHECK(all(back, chunk, 2 * chunk, 0));
  CHECK(close(fd) == 0);
  free(data);
  free(back);
}

/* O_APPEND writes at the end wherever the descriptor was, across a chunk
 * boundary as well. */
static void check_append(size_t chunk) {
  size_t first = chunk - 1;
  uint8_t *data = malloc(first);
  memset(data, 'a', first);
  int fd = open(MOUNT "/append", O_CREAT | O_EXCL | O_WRONLY, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, first) == (ssize_t)first);
  CHECK(close(fd) == 0);

  fd = open(MOUNT "/append", O_RDWR | O_APPEND);
  CHECK(fd >= 0);
  CHECK(lseek(fd, 0, SEEK_SET) == 0);
  CHECK(write(fd, "bc", 2) == 2);
  CHECK(lseek(fd, 0, SEEK_CUR) == (off_t)(chunk + 1));
  CHECK(lseek(fd, 5, SEEK_SET) == 5);
  CHECK(write(fd, "d", 1) == 1);
  size_t size = chunk + 2;
  CHECK(size_of(fd) == (off_t)size);

  uint8_t *back = malloc(size);
  CHECK(pread(fd, back, size, 0) == (ssize_t)size);
  CHECK(all(back, 0, first, 'a'));
  CHECK(memcmp(back + first, "bcd", 3) == 0);
  CHECK(close(fd) == 0);
  free(data);
  free(back);
}

/* A file of exactly some chunks ends on a boundary; one byte more starts a
 * chunk of its own. */
static void check_whole_chunks(size_t chunk) {
  size_t size = 3 * chunk;
  uint8_t *data = malloc(size + 1);
  uint8_t *back = malloc(size + 2);
  for (size_t i = 0; i < size + 1; i++)
    data[i] = (uint8_t)(i * 13 + i / 241);

  int fd = open(MOUNT "/whole", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, size) == (ssize_t)size);
  CHECK(size_of(fd) == (off_t)size);
  CHECK(pread(fd, back, size + 2, 0) == (ssize_t)size);
  CHECK(memcmp(back, data, size) == 0);
  CHECK(pread(fd, back, 1, size) == 0);
  CHECK(pread(fd, back, 2, size - 1) == 1);
  CHECK(back[0] == data[size - 1]);

  CHECK(write(fd, data + size, 1) == 1);
  CHECK(size_of(fd) == (off_t)(size + 1));
  CHECK(pread(fd, back, size + 2, 0) == (ssize_t)(size + 1));
  CHECK(memcmp(back, data, size + 1) == 0);
  CHECK(pread(fd, back, 2, size) == 1);
  CHECK(back[0] == data[size]);
  CHECK(close(fd) == 0);
  free(data);
  free(back);
}

static void check_empty(void) {
  int fd = open(MOUNT "/empty", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK(size_of(fd) == 0);
  char buf[8];
  CHECK(read(fd, buf, sizeof buf) == 0);
  CHECK(pread(fd, buf, sizeof buf, 100) == 0);
  CHECK(write(fd, buf, 0) == 0);
  CHECK(ftruncate(fd, 0) == 0);
  CHECK(size_of(fd) == 0);
  CHECK(close(fd) == 0);

  struct stat st;
  CHECK(stat(MOUNT "/empty", &st) == 0);
  CHECK(st.st_size == 0);
  fd = open(MOUNT "/empty", O_RDONLY);
  CHECK(fd >= 0);
  CHECK(read(fd, buf, sizeof buf) == 0);
  CHECK(close(fd) == 0);
}

/* A size the backend can't store exactly fails with EFBIG and changes
 * nothing; the largest it can is an ordinary, if sparse, file. */
static void check_largest(void) {
  int fd = open(MOUNT "/largest", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK_ERRNO(ftruncate(fd, MAX_SIZE + 1), EFBIG);
  CHECK_ERRNO(ftruncate(fd, INT64_MAX), EFBIG);
  CHECK_ERRNO(pwrite(fd, "x", 1, MAX_SIZE), EFBIG);
  CHECK_ERRNO(pwrite(fd, "xy", 2, MAX_SIZE - 1), EFBIG);
  CHECK(lseek(fd, MAX_SIZE + 1, SEEK_SET) == MAX_SIZE + 1);
  CHECK_ERRNO(write(fd, "x", 1), EFBIG);
  CHECK(size_of(fd) == 0);

  CHECK(ftruncate(fd, MAX_SIZE) == 0);
  CHECK(size_of(fd) == MAX_SIZE);
  CHECK(pwrite(fd, "y", 1, MAX_SIZE - 1) == 1);
  CHECK(size_of(fd) == MAX_SIZE);
  char buf[4] = {0};
  CHECK(pread(fd, buf, sizeof buf, MAX_SIZE - 2) == 2);
  CHECK(buf[0] == 0 && buf[1] == 'y');
  CHECK(pread(fd, buf, sizeof buf, MAX_SIZE) == 0);
  CHECK_ERRNO(pwrite(fd, "x", 1, MAX_SIZE), EFBIG);
  CHECK(size_of(fd) == MAX_SIZE);

  CHECK(ftruncate(fd, 0) == 0);
  CHECK(size_of(fd) == 0);
  CHECK(close(fd) == 0);
}

static void run_test(const struct idb_test_layout *layout) {
  size_t chunk = layout->chunk_size;
  printf("sizes: chunk size %zu\n", chunk);
  CHECK(layout->inodes == 1);
  CHECK(chunk > 13);
  if (test_failures)
    finish_test("sizes");

  check_sparse(chunk);
  check_truncate_to_boundary(chunk);
  check_append(chunk);
  check_whole_chunks(chunk);
  check_empty();
  check_largest();

  finish_test("sizes");
}

int main(void) { start_test(DATABASE, MOUNT); }
