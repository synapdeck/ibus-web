/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* What basic.1 left, read back from the database in a new run. */

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "basic.h"
#include "idb-test.h"

static void run_test(const struct idb_test_layout *layout) {
  unsigned chunk_size = layout->chunk_size;
  printf("basic.2: chunk size %u, %u inode(s)\n", chunk_size, layout->inodes);
  CHECK(layout->inodes == BASIC_INODES);
  CHECK(chunk_size > BASIC_OVERWRITE_LEN);
  if (test_failures)
    finish_test("basic.2");

  struct stat st;
  const char *spanning = BASIC_MOUNT "/dir/renamed";
  size_t size = basic_file_size(chunk_size);
  CHECK(stat(spanning, &st) == 0);
  CHECK(S_ISREG(st.st_mode));
  CHECK((st.st_mode & 07777) == BASIC_FILE_MODE);
  CHECK(st.st_size == (off_t)size);
  /* Written in the previous run, so its time is stored, not this run's. */
  time_t now = time(NULL);
  CHECK(st.st_mtim.tv_sec > 0 && st.st_mtim.tv_sec <= now);

  uint8_t *expected = malloc(size);
  uint8_t *back = malloc(size + 1);
  basic_expected(expected, chunk_size);
  int fd = open(spanning, O_RDONLY);
  CHECK(fd >= 0);
  CHECK(read(fd, back, size + 1) == (ssize_t)size);
  CHECK(memcmp(back, expected, size) == 0);
  CHECK(close(fd) == 0);
  free(expected);
  free(back);

  CHECK(stat(BASIC_MOUNT "/dir", &st) == 0);
  CHECK(S_ISDIR(st.st_mode));
  CHECK((st.st_mode & 07777) == 0755);
  CHECK(stat(BASIC_MOUNT "/dir/sub", &st) == 0);
  CHECK(S_ISDIR(st.st_mode));
  CHECK((st.st_mode & 07777) == 0700);
  check_contents(BASIC_MOUNT "/dir/sub/inner", BASIC_INNER_CONTENTS);
  check_contents(BASIC_MOUNT "/replaced", BASIC_REPLACED_CONTENTS);

  CHECK(stat(BASIC_MOUNT "/stamped", &st) == 0);
  CHECK((st.st_mode & 07777) == BASIC_STAMPED_MODE);
  CHECK(st.st_atim.tv_sec == BASIC_STAMPED_ATIME);
  CHECK(st.st_mtim.tv_sec == BASIC_STAMPED_MTIME);

  char target[64] = {0};
  CHECK(readlink(BASIC_MOUNT "/link", target, sizeof target - 1) ==
        (ssize_t)strlen(BASIC_LINK_TARGET));
  CHECK(strcmp(target, BASIC_LINK_TARGET) == 0);
  CHECK(lstat(BASIC_MOUNT "/link", &st) == 0);
  CHECK(S_ISLNK(st.st_mode));
  CHECK(stat(BASIC_MOUNT "/link", &st) == 0);
  CHECK(st.st_size == (off_t)size);

  static const char *const gone[] = {
      BASIC_MOUNT "/dir/file",    BASIC_MOUNT "/moving",
      BASIC_MOUNT "/replacement", BASIC_MOUNT "/temporary",
      BASIC_MOUNT "/empty",       BASIC_MOUNT "/held"};
  for (size_t i = 0; i < sizeof gone / sizeof *gone; i++)
    CHECK_ERRNO(lstat(gone[i], &st), ENOENT);

  unsigned entries = 0;
  DIR *dir = opendir(BASIC_MOUNT);
  CHECK(dir != NULL);
  struct dirent *entry;
  while (dir && (entry = readdir(dir)))
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, ".."))
      entries++;
  if (dir)
    CHECK(closedir(dir) == 0);
  CHECK(entries == 4);

  finish_test("basic.2");
}

int main(void) { start_test(BASIC_DATABASE, BASIC_MOUNT); }
