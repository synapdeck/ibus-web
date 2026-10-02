/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Reads and writes touch only the chunks they cover: a read fetches the
 * chunks under its range, and a write fetches only the chunks it covers in
 * part and must keep the rest of. */

#include <fcntl.h>
#include <unistd.h>

#include "chunk-counts.h"
#include "idb-test.h"

#define DATABASE "ibus-web-test-lazy"
#define MOUNT "/lazy"

/* Enough chunks that touching every one of them can't pass for touching a
 * few. */
#define CHUNKS 64

/* Whether a call touched exactly `read` and `written` chunk records. */
#define CHECK_CHUNKS(call, read, written)                                      \
  do {                                                                         \
    reset_chunk_counts();                                                      \
    CHECK(call);                                                               \
    unsigned check_read_ = atomic_load(&chunk_records_read);                   \
    unsigned check_written_ = atomic_load(&chunk_records_written);             \
    if (check_read_ != (read) || check_written_ != (written)) {                \
      printf("%s:%d: %s read %u and wrote %u chunk record(s), expected %u "    \
             "and %u\n",                                                       \
             __FILE__, __LINE__, #call, check_read_, check_written_,           \
             (unsigned)(read), (unsigned)(written));                           \
      test_failures++;                                                         \
    }                                                                          \
  } while (0)

static uint8_t pattern(size_t i) { return (uint8_t)(i * 7 + i / 251); }

static void run_test(const struct idb_test_layout *layout) {
  size_t chunk = layout->chunk_size;
  printf("lazy: chunk size %zu\n", chunk);
  CHECK(layout->inodes == 1);
  CHECK(chunk >= 4);
  if (test_failures)
    finish_test("lazy");

  size_t size = CHUNKS * chunk;
  uint8_t *data = malloc(size);
  uint8_t *back = malloc(chunk);
  for (size_t i = 0; i < size; i++)
    data[i] = pattern(i);

  int fd = open(MOUNT "/file", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  /* A new file has nothing to keep. */
  CHECK_CHUNKS(write(fd, data, size) == (ssize_t)size, 0, CHUNKS);

  size_t mid = 37 * chunk + chunk / 2;
  CHECK_CHUNKS(pread(fd, back, 1, mid) == 1, 1, 0);
  CHECK(back[0] == data[mid]);
  /* Two bytes either side of a boundary. */
  size_t boundary = 20 * chunk;
  CHECK_CHUNKS(pread(fd, back, 2, boundary - 1) == 2, 2, 0);
  CHECK(memcmp(back, data + boundary - 1, 2) == 0);
  CHECK_CHUNKS(pread(fd, back, chunk, 9 * chunk) == (ssize_t)chunk, 1, 0);
  CHECK(memcmp(back, data + 9 * chunk, chunk) == 0);

  /* A whole aligned chunk replaces what was there without reading it. */
  memset(data + 5 * chunk, 'a', chunk);
  CHECK_CHUNKS(pwrite(fd, data + 5 * chunk, chunk, 5 * chunk) == (ssize_t)chunk,
               0, 1);
  /* One byte in the middle of a chunk keeps the rest of it. */
  data[mid] = 'b';
  CHECK_CHUNKS(pwrite(fd, data + mid, 1, mid) == 1, 1, 1);
  /* Across a boundary, each side is a partial chunk. */
  memset(data + boundary - 1, 'c', 2);
  CHECK_CHUNKS(pwrite(fd, data + boundary - 1, 2, boundary - 1) == 2, 2, 2);
  /* Two partial edges and a whole chunk between them. */
  size_t from = 40 * chunk + chunk / 2;
  memset(data + from, 'd', 2 * chunk);
  CHECK_CHUNKS(pwrite(fd, data + from, 2 * chunk, from) == (ssize_t)(2 * chunk),
               2, 3);
  /* Past the end, starting on a boundary, there is nothing to keep. */
  uint8_t tail[2] = {'e', 'f'};
  CHECK_CHUNKS(pwrite(fd, tail, 2, size) == 2, 0, 1);
  /* The new last chunk is partial, but holds nothing past the file's end. */
  CHECK_CHUNKS(pwrite(fd, tail, 2, size + 2) == 2, 1, 1);

  /* Every write landed where it should. */
  for (size_t index = 0; index < CHUNKS; index++) {
    CHECK(pread(fd, back, chunk, index * chunk) == (ssize_t)chunk);
    if (memcmp(back, data + index * chunk, chunk) != 0) {
      printf("chunk %zu differs\n", index);
      test_failures++;
    }
  }
  CHECK(pread(fd, back, chunk, size) == 4);
  CHECK(memcmp(back, "efef", 4) == 0);
  CHECK(close(fd) == 0);

  /* A write far past the end stores its own chunk and none of the gap,
   * which reads as zeros without a record. */
  fd = open(MOUNT "/sparse", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  size_t far = 10 * chunk + 1;
  CHECK_CHUNKS(pwrite(fd, tail, 1, far) == 1, 0, 1);
  memset(back, 'x', chunk);
  CHECK_CHUNKS(pread(fd, back, chunk, 4 * chunk) == (ssize_t)chunk, 0, 0);
  CHECK(back[0] == 0 && memcmp(back, back + 1, chunk - 1) == 0);
  CHECK_CHUNKS(pread(fd, back, 2, far - 1) == 2, 1, 0);
  CHECK(back[0] == 0 && back[1] == tail[0]);
  CHECK(close(fd) == 0);

  free(data);
  free(back);
  finish_test("lazy");
}

int main(void) { start_test(DATABASE, MOUNT); }
