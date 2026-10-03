// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What basic.1 left, read back from the database in a new run.

#include <dirent.h>
#include <sys/stat.h>
#include <time.h>

#include "basic.h"

using idb_test::errno_text;
using idb_test::read_file;

namespace {

// A file's whole contents, and one byte more asked for, which it lacks.
std::vector<uint8_t> read_whole(const char *path, size_t size) {
  std::vector<uint8_t> back(size + 1);
  const int fd = open(path, O_RDONLY);
  EXPECT_GE(fd, 0) << path << ": " << errno_text();
  if (fd < 0) {
    return {};
  }
  const ssize_t len = read(fd, back.data(), size + 1);
  EXPECT_EQ(len, (ssize_t)size) << path << ": " << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();
  back.resize(len > 0 ? len : 0);
  return back;
}

} // namespace

TEST_F(Basic, KeepsEveryInode) {
  EXPECT_EQ(mounted.layout.inodes, kBasicInodes);
}

TEST_F(Basic, SpanningFileReadsBack) {
  struct stat st;
  const char *spanning = BASIC_MOUNT "/dir/renamed";
  const size_t size = basic_file_size(chunk_size);
  ASSERT_EQ(stat(spanning, &st), 0) << errno_text();
  EXPECT_TRUE(S_ISREG(st.st_mode));
  EXPECT_EQ(st.st_mode & 07777, kBasicFileMode);
  EXPECT_EQ(st.st_size, (off_t)size);
  // Written in the previous run, so its time is stored, not this run's.
  const time_t now = time(NULL);
  EXPECT_GT(st.st_mtim.tv_sec, 0);
  EXPECT_LE(st.st_mtim.tv_sec, now);
  EXPECT_EQ(read_whole(spanning, size), basic_expected(chunk_size));
}

TEST_F(Basic, DirectoriesKeepTheirModes) {
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/dir", &st), 0) << errno_text();
  EXPECT_TRUE(S_ISDIR(st.st_mode));
  EXPECT_EQ(st.st_mode & 07777, 0755u);
  ASSERT_EQ(stat(BASIC_MOUNT "/dir/sub", &st), 0) << errno_text();
  EXPECT_TRUE(S_ISDIR(st.st_mode));
  EXPECT_EQ(st.st_mode & 07777, 0700u);
}

TEST_F(Basic, RenamedFilesKeepTheirContents) {
  EXPECT_EQ(read_file(BASIC_MOUNT "/dir/sub/inner"), kBasicInnerContents);
  EXPECT_EQ(read_file(BASIC_MOUNT "/replaced"), kBasicReplacedContents);
}

TEST_F(Basic, ModeAndTimesPersist) {
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/stamped", &st), 0) << errno_text();
  EXPECT_EQ(st.st_mode & 07777, kBasicStampedMode);
  EXPECT_EQ(st.st_atim.tv_sec, kBasicStampedAtime);
  EXPECT_EQ(st.st_mtim.tv_sec, kBasicStampedMtime);
}

TEST_F(Basic, ResizedFileReadsBack) {
  const size_t sized = basic_sized_size(chunk_size);
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/sized", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)sized);
  EXPECT_EQ(read_whole(BASIC_MOUNT "/sized", sized),
            basic_sized_expected(chunk_size));
}

TEST_F(Basic, TruncatedFileReadsBack) {
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/truncated", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)strlen(kBasicTruncatedContents));
  EXPECT_EQ(read_file(BASIC_MOUNT "/truncated"), kBasicTruncatedContents);
}

TEST_F(Basic, RenameOverOpenFileKeepsTheNewFile) {
  EXPECT_EQ(read_file(BASIC_MOUNT "/usurped"), kBasicUsurperContents);
}

TEST_F(Basic, SymlinkPersists) {
  char target[64] = {0};
  EXPECT_EQ(readlink(BASIC_MOUNT "/link", target, sizeof target - 1),
            (ssize_t)strlen(kBasicLinkTarget))
      << errno_text();
  EXPECT_STREQ(target, kBasicLinkTarget);
  struct stat st;
  ASSERT_EQ(lstat(BASIC_MOUNT "/link", &st), 0) << errno_text();
  EXPECT_TRUE(S_ISLNK(st.st_mode));
  ASSERT_EQ(stat(BASIC_MOUNT "/link", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)basic_file_size(chunk_size));
}

TEST_F(Basic, RemovedNamesStayGone) {
  static const char *const gone[] = {
      BASIC_MOUNT "/dir/file",    BASIC_MOUNT "/moving",
      BASIC_MOUNT "/replacement", BASIC_MOUNT "/temporary",
      BASIC_MOUNT "/empty",       BASIC_MOUNT "/held",
      BASIC_MOUNT "/usurper"};
  struct stat st;
  for (const char *path : gone) {
    SCOPED_TRACE(path);
    EXPECT_ERRNO(lstat(path, &st), ENOENT);
  }
}

TEST_F(Basic, RootHoldsWhatTheFirstRunLeft) {
  unsigned entries = 0;
  DIR *dir = opendir(BASIC_MOUNT);
  ASSERT_NE(dir, nullptr) << errno_text();
  while (struct dirent *entry = readdir(dir)) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
      entries++;
    }
  }
  EXPECT_EQ(closedir(dir), 0) << errno_text();
  EXPECT_EQ(entries, kBasicRootEntries);
}
