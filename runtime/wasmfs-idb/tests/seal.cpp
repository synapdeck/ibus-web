// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A sealed backend takes changes until it is sealed and none after, even
// through a descriptor opened for writing before, and changes nothing in the
// database once sealed; reads still work.

#include "idb-test.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

// Files written, a descriptor left open for writing, and then the seal.
class Seal : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    writer = open(path("file").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
    ASSERT_GE(writer, 0) << errno_text();
    ASSERT_EQ(write(writer, "written", 7), 7) << errno_text();
    ASSERT_EQ(mkdir(path("dir").c_str(), 0755), 0) << errno_text();
    ASSERT_EQ(mkdir(path("empty").c_str(), 0755), 0) << errno_text();
    ASSERT_NO_FATAL_FAILURE(write_file(path("dir/inner"), 0644, "inner"));
    ASSERT_EQ(fsync(writer), 0) << errno_text();
    auto written = idb_test::read_layout(database);
    ASSERT_TRUE(written);
    before = *written;
    wasmfs_idb_backend_seal(backend);
  }

  void TearDown() override {
    if (writer >= 0) {
      EXPECT_EQ(close(writer), 0) << errno_text();
    }
    IdbTest::TearDown();
  }

  void refuse_through_writer() {
    EXPECT_ERRNO(write(writer, "more", 4), EROFS);
    EXPECT_ERRNO(ftruncate(writer, 0), EROFS);
    EXPECT_ERRNO(fchmod(writer, 0600), EROFS);
  }

  void refuse_new_changes() {
    EXPECT_ERRNO(open(path("file").c_str(), O_WRONLY), EROFS);
    EXPECT_ERRNO(open(path("new").c_str(), O_CREAT | O_WRONLY, 0644), EROFS);
    EXPECT_ERRNO(mkdir(path("newdir").c_str(), 0755), EROFS);
    EXPECT_ERRNO(mkdir(path("dir/newdir").c_str(), 0755), EROFS);
    EXPECT_ERRNO(unlink(path("file").c_str()), EROFS);
    EXPECT_ERRNO(rmdir(path("empty").c_str()), EROFS);
    EXPECT_ERRNO(rename(path("file").c_str(), path("renamed").c_str()), EROFS);
    EXPECT_ERRNO(chmod(path("dir").c_str(), 0700), EROFS);
    EXPECT_ERRNO(utimensat(AT_FDCWD, path("file").c_str(), NULL, 0), EROFS);
    EXPECT_ERRNO(symlink("file", path("link").c_str()), EROFS);
  }

  int writer = -1;
  // What the database held as it was sealed.
  idb_test::Layout before{};
};

} // namespace

TEST_F(Seal, RefusesWritesThroughADescriptorOpenedBefore) {
  refuse_through_writer();
}

// Nothing is left to make durable, but fsync() still works.
TEST_F(Seal, FsyncStillWorks) {
  EXPECT_EQ(fsync(writer), 0) << errno_text();
  EXPECT_EQ(close(writer), 0) << errno_text();
  writer = -1;
}

TEST_F(Seal, RefusesEveryNewChange) { refuse_new_changes(); }

TEST_F(Seal, StillReads) {
  EXPECT_EQ(read_file(path("file")), "written");
  EXPECT_EQ(read_file(path("dir/inner")), "inner");
  struct stat st;
  ASSERT_EQ(stat(path("dir").c_str(), &st), 0) << errno_text();
  EXPECT_TRUE(S_ISDIR(st.st_mode));
}

TEST_F(Seal, RefusedChangesLeaveTheDatabaseAsItWas) {
  refuse_through_writer();
  EXPECT_EQ(fsync(writer), 0) << errno_text();
  refuse_new_changes();
  auto after = idb_test::read_layout(database);
  ASSERT_TRUE(after);
  EXPECT_EQ(after->digest, before.digest);
}
