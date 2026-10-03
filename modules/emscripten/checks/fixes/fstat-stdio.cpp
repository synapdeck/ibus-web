// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The NODERAWFS fix, on the file system GLib's tools run on: Node's own.

#include <errno.h>
#include <sys/stat.h>

#include <cstring>

#include <gtest/gtest.h>

namespace {

TEST(Patch0001, FstatStandardStreams) {
  for (int fd = 0; fd < 3; fd++) {
    struct stat st;
    EXPECT_EQ(fstat(fd, &st), 0) << "fd " << fd << ": " << strerror(errno);
  }
}

} // namespace
