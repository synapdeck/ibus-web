/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* How the backend fails. A write over the quota fails with ENOSPC and
 * changes nothing; a read-only backend refuses every change with EROFS and
 * still reads; a connection asking for a newer version of the database
 * closes the backend's, after which its calls fail with EIO and the host
 * hears why; and a database that can't be opened gives no backend, leaves
 * no thread behind, and the host hears why too. Each step reads the database's
 * records directly before the next. */

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "faults.h"
#include "idb-test.h"

#define DATABASE "ibus-web-test-errors"
#define MOUNT "/data"
#define READ_ONLY_MOUNT "/ro"
#define CLOSED_LOG "wasmfs-idb: " DATABASE " closed for a version change"
#define REFUSED_DATABASE DATABASE "-refused"
#define NEWER_LOG "wasmfs-idb: opening " DATABASE " failed: VersionError"
#define REFUSED_LOG                                                            \
  "wasmfs-idb: opening " REFUSED_DATABASE " failed: SecurityError"

EM_JS_DEPS(errors, "$PThread,$callUserCallback,$UTF8ToString");

/* clang-format reads an EM_JS body as C and splits JavaScript's =>. */
/* clang-format off */
/* The program's threads, the backends' among them, that are running. */
EM_JS(int, running_threads, (void), {
  return Object.keys(PThread.pthreads).length;
});

EM_JS(void, upgrade_database, (const char *database), {
  wasmfsIdbTestUpgrade(UTF8ToString(database), (outcome) =>
    callUserCallback(() => _errors_upgraded(outcome)));
});

EM_JS(void, await_stderr, (const char *text), {
  wasmfsIdbTestAwaitStderr(UTF8ToString(text), (found) =>
    callUserCallback(() => _errors_heard(found)));
});
/* clang-format on */

static size_t chunk;
/* The quota file: three chunks. */
static size_t size;
static uint8_t *data;
static struct stat file_stat, dir_stat, link_stat;
static struct idb_test_layout before;
static backend_t read_only;
static int writer_fd = -1, reader_fd = -1;
/* What runs once stderr has had the line awaited, or has not. */
static void (*heard)(int found);

/* A line from another thread reaches this one as a message, so it can only
 * be heard from the event loop. */
static void await_line(const char *text, void (*next)(int found)) {
  heard = next;
  await_stderr(text);
}

EMSCRIPTEN_KEEPALIVE void errors_heard(int found) { heard(found); }

static uint8_t pattern(size_t i) { return (uint8_t)(i * 13 + i / 241); }

/* Whether the quota file, through `fd`, holds exactly `data`. */
static void check_file(int fd) {
  struct stat st;
  CHECK(fstat(fd, &st) == 0);
  CHECK(st.st_size == (off_t)size);
  uint8_t *back = malloc(size + 1);
  CHECK(pread(fd, back, size + 1, 0) == (ssize_t)size);
  CHECK(memcmp(back, data, size) == 0);
  free(back);
}

/* Whether `a` and `b` describe a file alike. WasmFS numbers files by its
 * own objects, one per backend, and keeps a file's times in memory once it
 * has looked the file up, so neither says anything of the database; its
 * records' digest does. */
static void check_same(const struct stat *a, const struct stat *b) {
  CHECK(a->st_mode == b->st_mode);
  CHECK(a->st_size == b->st_size);
}

/* Whether the database holds exactly what it did at `before`. */
static void check_layout_unchanged(const struct idb_test_layout *layout) {
  if (layout->inodes != before.inodes || layout->entries != before.entries ||
      layout->chunks != before.chunks || layout->digest != before.digest) {
    printf("the database holds %u inode(s), %u entries and %u chunk(s), "
           "digest %08x, expected %u, %u, %u and %08x\n",
           layout->inodes, layout->entries, layout->chunks, layout->digest,
           before.inodes, before.entries, before.chunks, before.digest);
    test_failures++;
  }
}

static void quota_failures(const struct idb_test_layout *layout);
static void read_only_refusals(const struct idb_test_layout *layout);

static void run_test(const struct idb_test_layout *layout) {
  CHECK(layout->inodes == 1);
  chunk = layout->chunk_size;
  size = 3 * chunk;
  printf("errors: chunk size %zu\n", chunk);
  data = malloc(size);
  for (size_t i = 0; i < size; i++)
    data[i] = pattern(i);
  int fd = open(MOUNT "/file", O_CREAT | O_EXCL | O_WRONLY, 0644);
  CHECK(fd >= 0);
  CHECK(write(fd, data, size) == (ssize_t)size);
  CHECK(close(fd) == 0);
  CHECK(mkdir(MOUNT "/dir", 0755) == 0);
  CHECK(symlink("file", MOUNT "/link") == 0);
  read_layout_then(DATABASE, quota_failures);
}

/* Each write over the quota fails whole: its transaction aborts, taking
 * whatever it had already written with it. */
static void quota_failures(const struct idb_test_layout *layout) {
  before = *layout;
  CHECK(before.inodes == 4 && before.entries == 3 && before.chunks == 3);
  CHECK(lstat(MOUNT "/file", &file_stat) == 0);
  CHECK(lstat(MOUNT "/dir", &dir_stat) == 0);
  CHECK(lstat(MOUNT "/link", &link_stat) == 0);

  int fd = open(MOUNT "/file", O_RDWR);
  CHECK(fd >= 0);
  /* Over the last two chunks and past the end, so it would add a chunk and
   * grow the file. */
  size_t len = 2 * chunk;
  off_t offset = chunk + chunk / 2;
  uint8_t *other = malloc(len);
  memset(other, 'x', len);
  /* The second chunk fails, after the first went in. */
  fail_put(IDB_CHUNKS, 1);
  CHECK_ERRNO(pwrite(fd, other, len, offset), ENOSPC);
  CHECK(!put_failure_pending());
  check_file(fd);
  /* The inode fails, after every chunk went in. */
  fail_put(IDB_INODES, 0);
  CHECK_ERRNO(pwrite(fd, other, len, offset), ENOSPC);
  check_file(fd);
  free(other);
  /* Truncating deletes and trims chunks before the inode fails. */
  fail_put(IDB_INODES, 0);
  CHECK_ERRNO(ftruncate(fd, chunk / 2), ENOSPC);
  check_file(fd);
  fail_put(IDB_INODES, 0);
  CHECK_ERRNO(ftruncate(fd, size + chunk), ENOSPC);
  check_file(fd);
  fail_put(IDB_INODES, 0);
  CHECK_ERRNO(fchmod(fd, 0600), ENOSPC);

  /* A create adds its entry before the inode fails, and a directory's the
   * next inode number. */
  struct stat st;
  fail_put(IDB_INODES, 0);
  CHECK_ERRNO(open(MOUNT "/new", O_CREAT | O_EXCL | O_WRONLY, 0644), ENOSPC);
  CHECK_ERRNO(stat(MOUNT "/new", &st), ENOENT);
  fail_put(IDB_META, 0);
  CHECK_ERRNO(mkdir(MOUNT "/newdir", 0755), ENOSPC);
  CHECK_ERRNO(stat(MOUNT "/newdir", &st), ENOENT);
  fail_put(IDB_INODES, 0);
  CHECK_ERRNO(symlink("file", MOUNT "/newlink"), ENOSPC);
  CHECK_ERRNO(lstat(MOUNT "/newlink", &st), ENOENT);
  /* A rename deletes the old entry before the new one fails. */
  fail_put(IDB_ENTRIES, 0);
  CHECK_ERRNO(rename(MOUNT "/file", MOUNT "/renamed"), ENOSPC);
  CHECK_ERRNO(stat(MOUNT "/renamed", &st), ENOENT);
  CHECK(!put_failure_pending());

  CHECK(lstat(MOUNT "/file", &st) == 0);
  check_same(&st, &file_stat);
  CHECK(lstat(MOUNT "/dir", &st) == 0);
  check_same(&st, &dir_stat);
  CHECK(close(fd) == 0);
  read_layout_then(DATABASE, read_only_refusals);
}

/* Every change through a read-only backend fails with EROFS and changes
 * nothing, and every read works. */
static void check_read_only(void) {
  read_only = wasmfs_create_idb_backend(DATABASE, WASMFS_IDB_READ_ONLY);
  CHECK(read_only != NULL);
  if (!read_only)
    return;
  CHECK(wasmfs_create_directory(READ_ONLY_MOUNT, 0777, read_only) == 0);

#define RO(path) READ_ONLY_MOUNT path
  CHECK_ERRNO(open(RO("/file"), O_WRONLY), EROFS);
  CHECK_ERRNO(open(RO("/file"), O_RDWR), EROFS);
  CHECK_ERRNO(open(RO("/file"), O_WRONLY | O_TRUNC), EROFS);
  CHECK_ERRNO(open(RO("/new"), O_CREAT | O_WRONLY, 0644), EROFS);
  CHECK_ERRNO(open(RO("/new"), O_CREAT | O_RDONLY, 0644), EROFS);
  CHECK_ERRNO(mknod(RO("/node"), S_IFREG | 0644, 0), EROFS);
  CHECK_ERRNO(truncate(RO("/file"), 0), EROFS);
  CHECK_ERRNO(mkdir(RO("/newdir"), 0755), EROFS);
  CHECK_ERRNO(mkdir(RO("/dir/newdir"), 0755), EROFS);
  CHECK_ERRNO(unlink(RO("/file")), EROFS);
  CHECK_ERRNO(unlink(RO("/link")), EROFS);
  CHECK_ERRNO(rmdir(RO("/dir")), EROFS);
  CHECK_ERRNO(rename(RO("/file"), RO("/renamed")), EROFS);
  CHECK_ERRNO(rename(RO("/file"), RO("/dir/file")), EROFS);
  CHECK_ERRNO(rename(RO("/link"), RO("/file")), EROFS);
  CHECK_ERRNO(rename(RO("/dir"), RO("/moved")), EROFS);
  CHECK_ERRNO(chmod(RO("/file"), 0600), EROFS);
  CHECK_ERRNO(chmod(RO("/dir"), 0700), EROFS);
  CHECK_ERRNO(chmod(READ_ONLY_MOUNT, 0700), EROFS);
  CHECK_ERRNO(utimensat(AT_FDCWD, RO("/file"), NULL, 0), EROFS);
  CHECK_ERRNO(utimensat(AT_FDCWD, RO("/dir"), NULL, 0), EROFS);
  CHECK_ERRNO(utimensat(AT_FDCWD, RO("/link"), NULL, AT_SYMLINK_NOFOLLOW),
              EROFS);
  CHECK_ERRNO(symlink("file", RO("/newlink")), EROFS);
  CHECK_ERRNO(symlink("file", RO("/dir/newlink")), EROFS);

  int fd = open(RO("/file"), O_RDONLY);
  CHECK(fd >= 0);
  check_file(fd);
  CHECK_ERRNO(fchmod(fd, 0600), EROFS);
  CHECK_ERRNO(futimens(fd, NULL), EROFS);
  /* Nothing was written, so there is nothing to make durable. */
  CHECK(fsync(fd) == 0);
  CHECK(close(fd) == 0);
  char target[16] = {0};
  CHECK(readlink(RO("/link"), target, sizeof target - 1) == 4);
  CHECK(strcmp(target, "file") == 0);
  struct stat st;
  CHECK(lstat(RO("/file"), &st) == 0);
  check_same(&st, &file_stat);
  CHECK(lstat(RO("/dir"), &st) == 0);
  check_same(&st, &dir_stat);
  CHECK(lstat(RO("/link"), &st) == 0);
  check_same(&st, &link_stat);
  unsigned seen = 0;
  DIR *dir = opendir(READ_ONLY_MOUNT);
  CHECK(dir != NULL);
  struct dirent *entry;
  while (dir && (entry = readdir(dir))) {
    if (!strcmp(entry->d_name, "file"))
      seen |= 1;
    else if (!strcmp(entry->d_name, "dir"))
      seen |= 2;
    else if (!strcmp(entry->d_name, "link"))
      seen |= 4;
    else if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
      printf("unexpected entry %s\n", entry->d_name);
      test_failures++;
    }
  }
  CHECK(seen == 7);
  if (dir)
    CHECK(closedir(dir) == 0);
#undef RO

  /* Through the writable backend, everything is as it was. */
  CHECK(lstat(MOUNT "/file", &st) == 0);
  check_same(&st, &file_stat);
  CHECK(lstat(MOUNT "/dir", &st) == 0);
  check_same(&st, &dir_stat);
  CHECK(lstat(MOUNT "/link", &st) == 0);
  check_same(&st, &link_stat);
  fd = open(MOUNT "/file", O_RDONLY);
  CHECK(fd >= 0);
  check_file(fd);
  CHECK(close(fd) == 0);
}

static void version_change(const struct idb_test_layout *layout);
static void closed_heard(int found);
static void newer_heard(int found);
static void refused_heard(int found);

static void read_only_refusals(const struct idb_test_layout *layout) {
  check_layout_unchanged(layout);
  check_read_only();
  read_layout_then(DATABASE, version_change);
}

/* Asks for version 2 with both backends' connections open, and descriptors
 * open on each. */
static void version_change(const struct idb_test_layout *layout) {
  check_layout_unchanged(layout);
  CHECK(!wasmfs_idb_backend_closed(test_backend));
  CHECK(read_only && !wasmfs_idb_backend_closed(read_only));
  writer_fd = open(MOUNT "/file", O_RDWR);
  CHECK(writer_fd >= 0);
  reader_fd = open(READ_ONLY_MOUNT "/file", O_RDONLY);
  CHECK(reader_fd >= 0);
  if (test_failures)
    finish_test("errors");
  upgrade_database(DATABASE);
}

/* Both backends closed their connections, so the upgrade went ahead, and
 * every call that reaches the database fails. */
EMSCRIPTEN_KEEPALIVE void errors_upgraded(int outcome) {
  if (outcome != 1) {
    printf("opening the database at version 2 %s\n",
           outcome == 2 ? "was blocked" : "failed");
    test_failures++;
    finish_test("errors");
  }
  CHECK(wasmfs_idb_backend_closed(test_backend));
  CHECK(wasmfs_idb_backend_closed(read_only));

  uint8_t buf[4];
  struct stat st;
  CHECK_ERRNO(pread(writer_fd, buf, sizeof buf, 0), EIO);
  CHECK_ERRNO(pwrite(writer_fd, "abcd", 4, 0), EIO);
  CHECK_ERRNO(fstat(writer_fd, &st), EIO);
  CHECK_ERRNO(ftruncate(writer_fd, 0), EIO);
  CHECK_ERRNO(fchmod(writer_fd, 0600), EIO);
  CHECK_ERRNO(fsync(writer_fd), EIO);
  CHECK_ERRNO(pread(reader_fd, buf, sizeof buf, 0), EIO);
  /* Closing needs nothing from the database. */
  CHECK(close(writer_fd) == 0);
  CHECK(close(reader_fd) == 0);
  CHECK_ERRNO(mkdir(MOUNT "/dir/after", 0755), EIO);
  CHECK_ERRNO(symlink("file", MOUNT "/dir/afterlink"), EIO);
  CHECK_ERRNO(chmod(MOUNT "/dir", 0700), EIO);
  CHECK_ERRNO(open(MOUNT "/file", O_RDONLY), EIO);
  errno = 0;
  CHECK(opendir(MOUNT "/dir") == NULL && errno == EIO);
  /* A lookup that fails can only say there is no such file; the backend
   * logs why. */
  CHECK_ERRNO(stat(MOUNT "/never", &st), ENOENT);

  await_line(CLOSED_LOG, closed_heard);
}

static void check_heard(int found, const char *text) {
  if (!found) {
    printf("stderr never said: %s\n", text);
    test_failures++;
  }
}

/* A database that can't be opened, at a version newer than the backend's or
 * where IndexedDB refuses, gives no backend, its thread is gone, and the
 * host hears why. */
static int threads_before_failures;

static void closed_heard(int found) {
  check_heard(found, CLOSED_LOG);
  threads_before_failures = running_threads();
  CHECK(wasmfs_create_idb_backend(DATABASE, 0) == NULL);
  CHECK(running_threads() == threads_before_failures);
  CHECK(wasmfs_create_idb_backend(DATABASE, WASMFS_IDB_READ_ONLY) == NULL);
  CHECK(running_threads() == threads_before_failures);
  fail_open();
  CHECK(wasmfs_create_idb_backend(REFUSED_DATABASE, 0) == NULL);
  CHECK(running_threads() == threads_before_failures);
  await_line(NEWER_LOG, newer_heard);
}

static void newer_heard(int found) {
  check_heard(found, NEWER_LOG);
  await_line(REFUSED_LOG, refused_heard);
}

/* The pool has one thread to spare, which a thread left running would have
 * taken. */
static void refused_heard(int found) {
  check_heard(found, REFUSED_LOG);
  if (test_failures)
    finish_test("errors");
  backend_t fresh = wasmfs_create_idb_backend(DATABASE "-fresh", 0);
  CHECK(fresh != NULL);
  CHECK(running_threads() == threads_before_failures + 1);
  if (fresh) {
    CHECK(wasmfs_create_directory("/fresh", 0777, fresh) == 0);
    write_file("/fresh/file", 0644, "fresh");
    check_contents("/fresh/file", "fresh");
  }
  free(data);
  finish_test("errors");
}

int main(void) { start_test(DATABASE, MOUNT); }
