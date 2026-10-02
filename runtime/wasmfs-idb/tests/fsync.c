/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* fsync() is the durability barrier: a commit with strict durability over
 * the stores a file lives in that writes a record, since a browser syncs
 * nothing for one that writes none, complete before fsync() returns, while
 * writes commit with the browser's default. Prints what an fsync() costs, as a
 * record rather than a check. */

#include <fcntl.h>
#include <unistd.h>

#include "idb-test.h"
#include "strict-commits.h"

#define DATABASE "ibus-web-test-fsync"
#define MOUNT "/fsync"
#define READ_ONLY_MOUNT "/fsync-ro"

/* Enough rounds that one slow commit doesn't make the mean. */
#define ROUNDS 50

/* Whether a call made exactly `all` strict commits, `files` of them over
 * the stores a file lives in, each of those writing a record. */
#define CHECK_STRICT(call, all, files)                                         \
  do {                                                                         \
    reset_strict_commits();                                                    \
    CHECK(call);                                                               \
    unsigned check_all_ = atomic_load(&strict_commits);                        \
    unsigned check_files_ = atomic_load(&strict_file_commits);                 \
    unsigned check_wrote_ = atomic_load(&strict_file_writes);                  \
    if (check_all_ != (all) || check_files_ != (files) ||                      \
        check_wrote_ != (files)) {                                             \
      printf("%s:%d: %s made %u strict commit(s), %u over a file's stores, "   \
             "%u of those writing, expected %u and %u, all writing\n",         \
             __FILE__, __LINE__, #call, check_all_, check_files_,              \
             check_wrote_, (unsigned)(all), (unsigned)(files));                \
      test_failures++;                                                         \
    }                                                                          \
  } while (0)

static void run_test(const struct idb_test_layout *layout) {
  CHECK(layout->inodes == 1);

  char block[4096];
  memset(block, 'a', sizeof block);
  int fd = open(MOUNT "/file", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK_STRICT(write(fd, block, sizeof block) == (ssize_t)sizeof block, 0, 0);
  CHECK_STRICT(fsync(fd) == 0, 1, 1);
  CHECK_STRICT(fdatasync(fd) == 0, 1, 1);
  /* Nothing written since: still a barrier, for whatever another
   * descriptor wrote. */
  CHECK_STRICT(fsync(fd) == 0, 1, 1);
  int reader = open(MOUNT "/file", O_RDONLY);
  CHECK(reader >= 0);
  CHECK_STRICT(fsync(reader) == 0, 1, 1);
  CHECK(close(reader) == 0);

  /* A read-only backend has written nothing to make durable. */
  backend_t read_only =
      wasmfs_create_idb_backend(DATABASE, WASMFS_IDB_READ_ONLY);
  CHECK(read_only != NULL);
  if (read_only) {
    CHECK(wasmfs_create_directory(READ_ONLY_MOUNT, 0777, read_only) == 0);
    reader = open(READ_ONLY_MOUNT "/file", O_RDONLY);
    CHECK(reader >= 0);
    CHECK_STRICT(fsync(reader) == 0, 0, 0);
    CHECK(close(reader) == 0);
  }

  double write_total = 0, fsync_total = 0;
  double fsync_min = 1e9, fsync_max = 0;
  reset_strict_commits();
  for (int i = 0; i < ROUNDS; i++) {
    double start = emscripten_get_now();
    CHECK(pwrite(fd, block, sizeof block, (off_t)i * sizeof block) ==
          (ssize_t)sizeof block);
    double written = emscripten_get_now();
    CHECK(fsync(fd) == 0);
    double synced = emscripten_get_now();
    write_total += written - start;
    double cost = synced - written;
    fsync_total += cost;
    fsync_min = cost < fsync_min ? cost : fsync_min;
    fsync_max = cost > fsync_max ? cost : fsync_max;
  }
  CHECK(atomic_load(&strict_file_commits) == ROUNDS);
  CHECK(atomic_load(&strict_file_writes) == ROUNDS);
  printf("fsync: %d rounds of a 4 KiB pwrite() then fsync(): pwrite %.3f ms "
         "mean; fsync %.3f ms mean, %.3f min, %.3f max\n",
         ROUNDS, write_total / ROUNDS, fsync_total / ROUNDS, fsync_min,
         fsync_max);

  CHECK(close(fd) == 0);
  finish_test("fsync");
}

int main(void) { start_test(DATABASE, MOUNT); }
