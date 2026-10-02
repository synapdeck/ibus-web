/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* A sealed backend takes changes until it is sealed and none after, even
 * through a descriptor opened for writing before, and changes nothing in the
 * database once sealed; reads still work. */

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include "idb-test.h"

#define DATABASE "ibus-web-test-seal"
#define MOUNT "/sealed"

static unsigned before_digest;
static int writer = -1;

static void after_refusals(const struct idb_test_layout *layout) {
  CHECK(layout->digest == before_digest);
  finish_test("seal");
}

static void after_writes(const struct idb_test_layout *layout) {
  before_digest = layout->digest;
  wasmfs_idb_backend_seal(test_backend);

  CHECK_ERRNO(write(writer, "more", 4), EROFS);
  CHECK_ERRNO(ftruncate(writer, 0), EROFS);
  CHECK_ERRNO(fchmod(writer, 0600), EROFS);
  /* Nothing is left to make durable, but fsync() still works. */
  CHECK(fsync(writer) == 0);
  CHECK(close(writer) == 0);
  CHECK_ERRNO(open(MOUNT "/file", O_WRONLY), EROFS);
  CHECK_ERRNO(open(MOUNT "/new", O_CREAT | O_WRONLY, 0644), EROFS);
  CHECK_ERRNO(mkdir(MOUNT "/newdir", 0755), EROFS);
  CHECK_ERRNO(mkdir(MOUNT "/dir/newdir", 0755), EROFS);
  CHECK_ERRNO(unlink(MOUNT "/file"), EROFS);
  CHECK_ERRNO(rmdir(MOUNT "/empty"), EROFS);
  CHECK_ERRNO(rename(MOUNT "/file", MOUNT "/renamed"), EROFS);
  CHECK_ERRNO(chmod(MOUNT "/dir", 0700), EROFS);
  CHECK_ERRNO(utimensat(AT_FDCWD, MOUNT "/file", NULL, 0), EROFS);
  CHECK_ERRNO(symlink("file", MOUNT "/link"), EROFS);

  check_contents(MOUNT "/file", "written");
  check_contents(MOUNT "/dir/inner", "inner");
  struct stat st;
  CHECK(stat(MOUNT "/dir", &st) == 0 && S_ISDIR(st.st_mode));
  read_layout_then(DATABASE, after_refusals);
}

static void run_test(const struct idb_test_layout *layout) {
  CHECK(layout->inodes == 1);
  writer = open(MOUNT "/file", O_CREAT | O_EXCL | O_RDWR, 0644);
  CHECK(writer >= 0);
  CHECK(write(writer, "written", 7) == 7);
  CHECK(mkdir(MOUNT "/dir", 0755) == 0);
  CHECK(mkdir(MOUNT "/empty", 0755) == 0);
  write_file(MOUNT "/dir/inner", 0644, "inner");
  CHECK(fsync(writer) == 0);
  read_layout_then(DATABASE, after_writes);
}

int main(void) { start_test(DATABASE, MOUNT); }
