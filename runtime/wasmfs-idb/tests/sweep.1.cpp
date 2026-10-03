// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Leaves an orphan, as a page that goes away with a file unlinked but still
// open does: the program exits before it closes the file, so the inode and
// chunks the last close would delete stay behind.

#include "sweep.h"

using idb_test::errno_text;
using idb_test::write_file;

TEST(Sweep, LeavesAnOrphan) {
  const idb_test::Mounted mounted =
      idb_test::mount(kSweepDatabase, SWEEP_MOUNT);
  ASSERT_EQ(mounted.problem, "");
  ASSERT_EQ(mounted.layout.inodes, 1u);
  write_file(SWEEP_MOUNT "/kept", 0644, "kept");

  // Two chunks.
  const size_t size = mounted.layout.chunk_size + 1;
  const std::vector<uint8_t> data(size, 'o');
  const int fd = open(SWEEP_MOUNT "/orphan", O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), size), (ssize_t)size) << errno_text();
  EXPECT_EQ(unlink(SWEEP_MOUNT "/orphan"), 0) << errno_text();
  uint8_t byte = 0;
  EXPECT_EQ(pread(fd, &byte, 1, size - 1), 1) << errno_text();
  EXPECT_EQ(byte, 'o');
  EXPECT_EQ(idb_test::read_counts(kSweepDatabase), kSweepLeft);
}
