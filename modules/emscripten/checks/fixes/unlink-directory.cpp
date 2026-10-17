// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Patch 0025, built for NODERAWFS, which GLib's tools run on, and for
// WasmFS's Node backend, which its tests run on. A Linux host gives EISDIR
// itself, so without the patch only a macOS host fails.

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cstring>
#include <string>

#include <gtest/gtest.h>

namespace {

// A new empty directory under TMPDIR, or an empty string if it can't be made.
std::string tempDir() {
  const char *tmp = getenv("TMPDIR");
  std::string dir = std::string(tmp == nullptr ? "/tmp" : tmp) + "/dir-XXXXXX";
  return mkdtemp(dir.data()) == nullptr ? "" : dir;
}

TEST(Patch0025, UnlinkDirectoryIsEisdir) {
  std::string dir = tempDir();
  ASSERT_NE(dir, "") << strerror(errno);

  EXPECT_EQ(unlink(dir.c_str()), -1);
  EXPECT_EQ(errno, EISDIR) << strerror(errno);

  EXPECT_EQ(remove(dir.c_str()), 0) << strerror(errno);
  struct stat st;
  EXPECT_EQ(stat(dir.c_str(), &st), -1);
  EXPECT_EQ(errno, ENOENT) << strerror(errno);
}

TEST(Patch0025, RmdirDirectory) {
  std::string dir = tempDir();
  ASSERT_NE(dir, "") << strerror(errno);

  EXPECT_EQ(rmdir(dir.c_str()), 0) << strerror(errno);
  struct stat st;
  EXPECT_EQ(stat(dir.c_str(), &st), -1);
  EXPECT_EQ(errno, ENOENT) << strerror(errno);
}

} // namespace
