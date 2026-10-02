/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Files, directories and symlinks on a fresh database, leaving what basic.2
 * reads back in the next run. */

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "basic.h"
#include "idb-test.h"

/* Writes the file in pieces of a third of a chunk, so every chunk is built
 * from several writes, then overwrites a run across the chunk boundary. */
static void make_spanning_file(const char *path, unsigned chunk_size) {
  size_t size = basic_file_size(chunk_size);
  uint8_t *data = malloc(size);
  uint8_t *back = malloc(size);
  for (size_t i = 0; i < size; i++)
    data[i] = basic_pattern(i);

  int fd = open(path, O_CREAT | O_EXCL | O_RDWR, BASIC_FILE_MODE);
  CHECK(fd >= 0);
  size_t piece = chunk_size / 3;
  for (size_t off = 0; off < size; off += piece) {
    size_t len = size - off < piece ? size - off : piece;
    CHECK(write(fd, data + off, len) == (ssize_t)len);
  }
  uint8_t run[BASIC_OVERWRITE_LEN];
  memset(run, BASIC_OVERWRITE_BYTE, sizeof run);
  CHECK(pwrite(fd, run, sizeof run, basic_overwrite_offset(chunk_size)) ==
        (ssize_t)sizeof run);

  basic_expected(data, chunk_size);
  CHECK(lseek(fd, 0, SEEK_SET) == 0);
  CHECK(read(fd, back, size) == (ssize_t)size);
  CHECK(memcmp(back, data, size) == 0);
  /* A read across the boundary alone, and one past the end. */
  size_t at = chunk_size - 3;
  CHECK(lseek(fd, at, SEEK_SET) == (off_t)at);
  CHECK(read(fd, back, 6) == 6);
  CHECK(memcmp(back, data + at, 6) == 0);
  CHECK(lseek(fd, size - 2, SEEK_SET) == (off_t)(size - 2));
  CHECK(read(fd, back, 10) == 2);
  CHECK(read(fd, back, 10) == 0);

  struct stat st;
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == (off_t)size);
  CHECK(S_ISREG(st.st_mode));
  CHECK((st.st_mode & 07777) == BASIC_FILE_MODE);
  CHECK(close(fd) == 0);
  free(data);
  free(back);
}

/* The names in a directory, but for . and .., as a bit set over `names`. */
static unsigned list_dir(const char *path, const char *const *names,
                         const unsigned char *types, unsigned count) {
  unsigned seen = 0;
  DIR *dir = opendir(path);
  CHECK(dir != NULL);
  if (!dir)
    return 0;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, ".."))
      continue;
    unsigned i;
    for (i = 0; i < count; i++)
      if (!strcmp(entry->d_name, names[i]))
        break;
    if (i == count) {
      printf("unexpected entry %s in %s\n", entry->d_name, path);
      test_failures++;
      continue;
    }
    CHECK(entry->d_type == types[i]);
    seen |= 1u << i;
  }
  CHECK(closedir(dir) == 0);
  return seen;
}

/* An unlinked file stays usable through a descriptor open on it. */
static void check_unlinked_open(unsigned chunk_size) {
  const char *path = BASIC_MOUNT "/held";
  size_t size = chunk_size + 1;
  uint8_t *data = malloc(size + 4);
  uint8_t *back = malloc(size + 4);
  for (size_t i = 0; i < size + 4; i++)
    data[i] = (uint8_t)(i * 13);

  int fd = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
  CHECK(fd >= 0);
  CHECK(write(fd, data, size) == (ssize_t)size);
  CHECK(unlink(path) == 0);
  struct stat st;
  CHECK_ERRNO(stat(path, &st), ENOENT);

  CHECK(pread(fd, back, size, 0) == (ssize_t)size);
  CHECK(memcmp(back, data, size) == 0);
  CHECK(pwrite(fd, data + size, 4, size) == 4);
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == (off_t)(size + 4));
  CHECK(pread(fd, back, size + 4, 0) == (ssize_t)(size + 4));
  CHECK(memcmp(back, data, size + 4) == 0);
  CHECK(close(fd) == 0);
  free(data);
  free(back);
}

/* Shrinking deletes the chunks past the new end and trims the one it ends
 * in, so growing again reads zeros there. */
static void check_set_size(unsigned chunk_size) {
  size_t written = basic_sized_written(chunk_size);
  size_t kept = basic_sized_kept(chunk_size);
  size_t size = basic_sized_size(chunk_size);
  uint8_t *data = malloc(written);
  uint8_t *expected = malloc(size);
  uint8_t *back = malloc(size + 1);
  for (size_t i = 0; i < written; i++)
    data[i] = basic_pattern(i);
  basic_sized_expected(expected, chunk_size);

  int fd = open(BASIC_MOUNT "/sized", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, written) == (ssize_t)written);
  CHECK(ftruncate(fd, kept) == 0);
  struct stat st;
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == (off_t)kept);
  CHECK(pread(fd, back, size + 1, 0) == (ssize_t)kept);
  CHECK(memcmp(back, data, kept) == 0);

  CHECK(ftruncate(fd, size) == 0);
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == (off_t)size);
  CHECK(pread(fd, back, size + 1, 0) == (ssize_t)size);
  CHECK(memcmp(back, expected, size) == 0);
  CHECK(close(fd) == 0);
  free(data);
  free(expected);
  free(back);
}

static void check_open_truncate(unsigned chunk_size) {
  const char *path = BASIC_MOUNT "/truncated";
  size_t len = chunk_size + 10;
  uint8_t *data = malloc(len);
  uint8_t *back = malloc(len);
  memset(data, 'x', len);
  int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, len) == (ssize_t)len);
  CHECK(close(fd) == 0);

  fd = open(path, O_RDWR | O_TRUNC);
  CHECK(fd >= 0);
  struct stat st;
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == 0);
  size_t short_len = strlen(BASIC_TRUNCATED_CONTENTS);
  CHECK(write(fd, BASIC_TRUNCATED_CONTENTS, short_len) == (ssize_t)short_len);
  CHECK(pread(fd, back, len, 0) == (ssize_t)short_len);
  CHECK(memcmp(back, BASIC_TRUNCATED_CONTENTS, short_len) == 0);
  CHECK(close(fd) == 0);
  free(data);
  free(back);
}

/* A file renamed over one a descriptor holds: the descriptor keeps the
 * replaced file's data until it closes, which deletes it. */
static void check_rename_over_open(void) {
  const char *held = BASIC_MOUNT "/usurped";
  const char *usurper = BASIC_MOUNT "/usurper";
  write_file(held, 0644, BASIC_HELD_CONTENTS);
  int fd = open(held, O_RDONLY);
  CHECK(fd >= 0);
  write_file(usurper, 0644, BASIC_USURPER_CONTENTS);
  CHECK(rename(usurper, held) == 0);
  check_contents(held, BASIC_USURPER_CONTENTS);

  char buf[64] = {0};
  size_t len = strlen(BASIC_HELD_CONTENTS);
  CHECK(pread(fd, buf, sizeof buf - 1, 0) == (ssize_t)len);
  CHECK(strcmp(buf, BASIC_HELD_CONTENTS) == 0);
  struct stat st;
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == (off_t)len);
  CHECK(close(fd) == 0);
}

static void run_test(const struct idb_test_layout *layout) {
  unsigned chunk_size = layout->chunk_size;
  printf("basic.1: chunk size %u, %u inode(s)\n", chunk_size, layout->inodes);
  /* The run straddling the boundary must fit in the two chunks. */
  CHECK(chunk_size > BASIC_OVERWRITE_LEN);
  CHECK(layout->inodes == 1);
  if (test_failures)
    finish_test("basic.1");

  CHECK(mkdir(BASIC_MOUNT "/dir", 0755) == 0);
  CHECK_ERRNO(mkdir(BASIC_MOUNT "/dir", 0755), EEXIST);
  make_spanning_file(BASIC_MOUNT "/dir/file", chunk_size);

  /* Renames: a file within its directory, a directory with a file in it
   * into another, and a file over another. */
  CHECK(rename(BASIC_MOUNT "/dir/file", BASIC_MOUNT "/dir/renamed") == 0);
  struct stat st;
  CHECK_ERRNO(stat(BASIC_MOUNT "/dir/file", &st), ENOENT);
  CHECK(stat(BASIC_MOUNT "/dir/renamed", &st) == 0);
  CHECK(st.st_size == (off_t)basic_file_size(chunk_size));

  CHECK(mkdir(BASIC_MOUNT "/moving", 0700) == 0);
  write_file(BASIC_MOUNT "/moving/inner", 0644, BASIC_INNER_CONTENTS);
  CHECK(rename(BASIC_MOUNT "/moving", BASIC_MOUNT "/dir/sub") == 0);
  CHECK_ERRNO(stat(BASIC_MOUNT "/moving", &st), ENOENT);
  check_contents(BASIC_MOUNT "/dir/sub/inner", BASIC_INNER_CONTENTS);

  write_file(BASIC_MOUNT "/replaced", 0644, "to be replaced");
  write_file(BASIC_MOUNT "/replacement", 0644, BASIC_REPLACED_CONTENTS);
  CHECK(rename(BASIC_MOUNT "/replacement", BASIC_MOUNT "/replaced") == 0);
  CHECK_ERRNO(stat(BASIC_MOUNT "/replacement", &st), ENOENT);
  check_contents(BASIC_MOUNT "/replaced", BASIC_REPLACED_CONTENTS);

  /* Unlink and rmdir. */
  write_file(BASIC_MOUNT "/temporary", 0644, "temporary");
  CHECK(unlink(BASIC_MOUNT "/temporary") == 0);
  CHECK_ERRNO(stat(BASIC_MOUNT "/temporary", &st), ENOENT);
  CHECK(mkdir(BASIC_MOUNT "/empty", 0755) == 0);
  CHECK_ERRNO(rmdir(BASIC_MOUNT "/dir"), ENOTEMPTY);
  CHECK(rmdir(BASIC_MOUNT "/empty") == 0);
  CHECK_ERRNO(stat(BASIC_MOUNT "/empty", &st), ENOENT);

  check_unlinked_open(chunk_size);
  check_rename_over_open();
  check_set_size(chunk_size);
  check_open_truncate(chunk_size);

  /* A symlink, followed. */
  CHECK(symlink(BASIC_LINK_TARGET, BASIC_MOUNT "/link") == 0);
  CHECK(stat(BASIC_MOUNT "/link", &st) == 0);
  CHECK(st.st_size == (off_t)basic_file_size(chunk_size));

  /* Mode and times set explicitly. */
  write_file(BASIC_MOUNT "/stamped", 0644, "stamped");
  CHECK(chmod(BASIC_MOUNT "/stamped", BASIC_STAMPED_MODE) == 0);
  struct timespec times[2] = {{BASIC_STAMPED_ATIME, 0},
                              {BASIC_STAMPED_MTIME, 0}};
  CHECK(utimensat(AT_FDCWD, BASIC_MOUNT "/stamped", times, 0) == 0);
  CHECK(stat(BASIC_MOUNT "/stamped", &st) == 0);
  CHECK((st.st_mode & 07777) == BASIC_STAMPED_MODE);
  CHECK(st.st_mtim.tv_sec == BASIC_STAMPED_MTIME);

  static const char *const root_names[BASIC_ROOT_ENTRIES] = {
      "dir", "replaced", "link", "stamped", "sized", "truncated", "usurped"};
  static const unsigned char root_types[BASIC_ROOT_ENTRIES] = {
      DT_DIR, DT_REG, DT_LNK, DT_REG, DT_REG, DT_REG, DT_REG};
  CHECK(list_dir(BASIC_MOUNT, root_names, root_types, BASIC_ROOT_ENTRIES) ==
        (1u << BASIC_ROOT_ENTRIES) - 1);
  static const char *const dir_names[] = {"renamed", "sub"};
  static const unsigned char dir_types[] = {DT_REG, DT_DIR};
  CHECK(list_dir(BASIC_MOUNT "/dir", dir_names, dir_types, 2) == 0x3);

  finish_test("basic.1");
}

int main(void) { start_test(BASIC_DATABASE, BASIC_MOUNT); }
