// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Patch 0025, on the file system GLib's tools run on: Node's own. A Linux
// host gives EISDIR itself, so without the patch only a macOS host fails.

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>
#include <string>

#include <gtest/gtest.h>

namespace {

TEST(Patch0025, UnlinkDirectoryIsEisdir) {
  const char *tmp = getenv("TMPDIR");
  std::string dir =
      std::string(tmp == nullptr ? "/tmp" : tmp) + "/unlink-XXXXXX";
  ASSERT_NE(mkdtemp(dir.data()), nullptr) << strerror(errno);

  EXPECT_EQ(unlink(dir.c_str()), -1);
  EXPECT_EQ(errno, EISDIR) << strerror(errno);

  EXPECT_EQ(remove(dir.c_str()), 0) << strerror(errno);
  struct stat st;
  EXPECT_EQ(stat(dir.c_str(), &st), -1);
  EXPECT_EQ(errno, ENOENT) << strerror(errno);
}

} // namespace
