// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A backend's window: shut, it refuses every change, even through a
// descriptor opened while it was open, and leaves the database as it was;
// open, it takes changes, on a backend created read-only too, whose fsync()
// then makes them durable; a sealed backend's never opens again.

#include "idb-test.h"
#include "strict-commits.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

// What fsync() makes once the backend has taken a change: one strict
// commit, over a file's stores, writing.
constexpr StrictCommits kBarrier{1, 1, 1};

// Files written while the window is open, a descriptor left open for
// writing, and then the window shut.
class Writable : public idb_test::IdbTest {
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
    ASSERT_EQ(wasmfs_idb_backend_set_writable(backend, false), 0);
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

  void refuse_new_changes(const std::string &root) {
    EXPECT_ERRNO(open((root + "/file").c_str(), O_WRONLY), EROFS);
    EXPECT_ERRNO(open((root + "/new").c_str(), O_CREAT | O_WRONLY, 0644),
                 EROFS);
    EXPECT_ERRNO(mkdir((root + "/newdir").c_str(), 0755), EROFS);
    EXPECT_ERRNO(mkdir((root + "/dir/newdir").c_str(), 0755), EROFS);
    EXPECT_ERRNO(unlink((root + "/file").c_str()), EROFS);
    EXPECT_ERRNO(rmdir((root + "/empty").c_str()), EROFS);
    EXPECT_ERRNO(rename((root + "/file").c_str(), (root + "/renamed").c_str()),
                 EROFS);
    EXPECT_ERRNO(chmod((root + "/dir").c_str(), 0700), EROFS);
    EXPECT_ERRNO(utimensat(AT_FDCWD, (root + "/file").c_str(), NULL, 0), EROFS);
    EXPECT_ERRNO(symlink("file", (root + "/link").c_str()), EROFS);
  }

  // A second backend over the same database, created read-only, mounted
  // beside the first.
  std::string mount_read_only(backend_t *out) {
    const std::string root = mount_path + "-ro";
    *out = wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY);
    EXPECT_NE(*out, nullptr);
    if (*out != nullptr) {
      EXPECT_EQ(wasmfs_create_directory(root.c_str(), 0777, *out), 0);
    }
    return root;
  }

  int writer = -1;
  // What the database held as the window shut.
  idb_test::Layout before{};
};

} // namespace

TEST_F(Writable, ShutRefusesWritesThroughADescriptorOpenedBefore) {
  refuse_through_writer();
}

TEST_F(Writable, ShutRefusesEveryNewChange) { refuse_new_changes(mount_path); }

TEST_F(Writable, ShutStillReads) {
  EXPECT_EQ(read_file(path("file")), "written");
  EXPECT_EQ(read_file(path("dir/inner")), "inner");
}

TEST_F(Writable, RefusedChangesLeaveTheDatabaseAsItWas) {
  refuse_through_writer();
  EXPECT_EQ(fsync(writer), 0) << errno_text();
  refuse_new_changes(mount_path);
  auto after = idb_test::read_layout(database);
  ASSERT_TRUE(after);
  EXPECT_EQ(after->digest, before.digest);
}

TEST_F(Writable, OpenedAgainTakesChanges) {
  ASSERT_EQ(wasmfs_idb_backend_set_writable(backend, true), 0);
  EXPECT_EQ(pwrite(writer, "W", 1, 0), 1) << errno_text();
  ASSERT_NO_FATAL_FAILURE(write_file(path("dir/later"), 0644, "later"));
  EXPECT_EQ(mkdir(path("newdir").c_str(), 0755), 0) << errno_text();
  EXPECT_EQ(read_file(path("file")), "Written");
  EXPECT_EQ(read_file(path("dir/later")), "later");
}

TEST_F(Writable, ReadOnlyBackendTakesChangesWhileOpen) {
  backend_t read_only = nullptr;
  const std::string root = mount_read_only(&read_only);
  ASSERT_NE(read_only, nullptr);
  refuse_new_changes(root);
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, true), 0);
  ASSERT_NO_FATAL_FAILURE(write_file(root + "/dir/installed", 0644, "data"));
  EXPECT_EQ(read_file(path("dir/installed")), "data");
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, false), 0);
  EXPECT_ERRNO(unlink((root + "/dir/installed").c_str()), EROFS);
}

// The window has let the backend change the database, so fsync() has
// something to make durable, though the backend was created read-only.
TEST_F(Writable, FsyncCommitsOnceTheWindowHasOpened) {
  backend_t read_only = nullptr;
  const std::string root = mount_read_only(&read_only);
  ASSERT_NE(read_only, nullptr);
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, true), 0);
  const int fd =
      open((root + "/synced").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, "data", 4), 4) << errno_text();
  ASSERT_EQ(wasmfs_idb_backend_set_writable(read_only, false), 0);
  int result = -1;
  EXPECT_EQ(strict_commits_of([&] { result = fsync(fd); }), kBarrier);
  EXPECT_EQ(result, 0) << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Writable, SealedStaysShut) {
  wasmfs_idb_backend_seal(backend);
  EXPECT_EQ(wasmfs_idb_backend_set_writable(backend, true), -EROFS);
  refuse_through_writer();
  refuse_new_changes(mount_path);
}
