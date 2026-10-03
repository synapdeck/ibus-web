// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// fsync() is the durability barrier: a commit with strict durability over
// the stores a file lives in that writes a record, since a browser syncs
// nothing for one that writes none, complete before fsync() returns, while
// writes commit with the browser's default. What an fsync() costs goes in
// the report as a record rather than a check.

#include <algorithm>

#include "idb-test.h"
#include "strict-commits.h"

using idb_test::errno_text;

namespace {

// Enough rounds that one slow commit doesn't make the mean.
constexpr int kRounds = 50;

// What fsync() is expected to make: one strict commit, over a file's
// stores, writing.
constexpr StrictCommits kBarrier{1, 1, 1};
constexpr StrictCommits kNone{0, 0, 0};

// A file written with a block, open for reading and writing.
class Fsync : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    memset(block, 'a', sizeof block);
    fd = open(path("file").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
    ASSERT_GE(fd, 0) << errno_text();
  }

  void TearDown() override {
    if (fd >= 0) {
      EXPECT_EQ(close(fd), 0) << errno_text();
    }
    IdbTest::TearDown();
  }

  void write_block() {
    EXPECT_EQ(write(fd, block, sizeof block), (ssize_t)sizeof block)
        << errno_text();
  }

  char block[4096];
  int fd = -1;
  // What the last counted call returned.
  int result = 0;
};

} // namespace

TEST_F(Fsync, WritesCommitWithTheDefaultDurability) {
  EXPECT_EQ(strict_commits_of([&] { write_block(); }), kNone);
}

TEST_F(Fsync, FsyncAndFdatasyncCommitStrictly) {
  write_block();
  EXPECT_EQ(strict_commits_of([&] { result = fsync(fd); }), kBarrier);
  EXPECT_EQ(result, 0) << errno_text();
  EXPECT_EQ(strict_commits_of([&] { result = fdatasync(fd); }), kBarrier);
  EXPECT_EQ(result, 0) << errno_text();
}

// Nothing written since: still a barrier, for whatever another descriptor
// wrote.
TEST_F(Fsync, FsyncWithNothingWrittenIsStillABarrier) {
  write_block();
  EXPECT_EQ(fsync(fd), 0) << errno_text();
  EXPECT_EQ(strict_commits_of([&] { result = fsync(fd); }), kBarrier);
  EXPECT_EQ(result, 0) << errno_text();
  const int reader = open(path("file").c_str(), O_RDONLY);
  ASSERT_GE(reader, 0) << errno_text();
  EXPECT_EQ(strict_commits_of([&] { result = fsync(reader); }), kBarrier);
  EXPECT_EQ(result, 0) << errno_text();
  EXPECT_EQ(close(reader), 0) << errno_text();
}

// A read-only backend has written nothing to make durable.
TEST_F(Fsync, ReadOnlyBackendHasNothingToSync) {
  write_block();
  const std::string read_only_mount = mount_path + "-ro";
  backend_t read_only =
      wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY);
  ASSERT_NE(read_only, nullptr);
  ASSERT_EQ(wasmfs_create_directory(read_only_mount.c_str(), 0777, read_only),
            0);
  const int reader = open((read_only_mount + "/file").c_str(), O_RDONLY);
  ASSERT_GE(reader, 0) << errno_text();
  EXPECT_EQ(strict_commits_of([&] { result = fsync(reader); }), kNone);
  EXPECT_EQ(result, 0) << errno_text();
  EXPECT_EQ(close(reader), 0) << errno_text();
}

TEST_F(Fsync, EveryFsyncCommitsStrictlyOnce) {
  double write_total = 0, fsync_total = 0;
  double fsync_min = 1e9, fsync_max = 0;
  reset_strict_commits();
  for (int i = 0; i < kRounds; i++) {
    const double start = emscripten_get_now();
    EXPECT_EQ(pwrite(fd, block, sizeof block, (off_t)i * sizeof block),
              (ssize_t)sizeof block)
        << errno_text();
    const double written = emscripten_get_now();
    EXPECT_EQ(fsync(fd), 0) << errno_text();
    const double synced = emscripten_get_now();
    write_total += written - start;
    const double cost = synced - written;
    fsync_total += cost;
    fsync_min = std::min(cost, fsync_min);
    fsync_max = std::max(cost, fsync_max);
  }
  EXPECT_EQ(strict_file_commits.load(), (unsigned)kRounds);
  EXPECT_EQ(strict_file_writes.load(), (unsigned)kRounds);

  // In microseconds: a property's number is an integer.
  const auto us = [](double ms) { return (int)(ms * 1000); };
  RecordProperty("rounds", kRounds);
  RecordProperty("pwrite_mean_us", us(write_total / kRounds));
  RecordProperty("fsync_mean_us", us(fsync_total / kRounds));
  RecordProperty("fsync_min_us", us(fsync_min));
  RecordProperty("fsync_max_us", us(fsync_max));
}
