// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Files, directories and symlinks on a fresh database, leaving what basic.2
// reads back in the next run. Each case builds on what those before it
// left.

#include <dirent.h>
#include <sys/stat.h>

#include <map>

#include "basic.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

// The names in a directory, but for . and .., with their types.
std::map<std::string, unsigned char> list_dir(const char *path) {
  std::map<std::string, unsigned char> names;
  DIR *dir = opendir(path);
  EXPECT_NE(dir, nullptr) << path << ": " << errno_text();
  if (!dir) {
    return names;
  }
  while (struct dirent *entry = readdir(dir)) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
      names[entry->d_name] = entry->d_type;
    }
  }
  EXPECT_EQ(closedir(dir), 0) << errno_text();
  return names;
}

} // namespace

TEST_F(Basic, StartsWithAnEmptyDatabase) {
  EXPECT_EQ(mounted.layout.inodes, 1u);
}

TEST_F(Basic, MakeDirectory) {
  EXPECT_EQ(mkdir(BASIC_MOUNT "/dir", 0755), 0) << errno_text();
  EXPECT_ERRNO(mkdir(BASIC_MOUNT "/dir", 0755), EEXIST);
}

// Writes the file in pieces of a third of a chunk, so every chunk is built
// from several writes, then overwrites a run across the chunk boundary.
TEST_F(Basic, WriteAcrossChunks) {
  const size_t size = basic_file_size(chunk_size);
  std::vector<uint8_t> data(size), back(size);
  for (size_t i = 0; i < size; i++) {
    data[i] = basic_pattern(i);
  }

  const int fd =
      open(BASIC_MOUNT "/dir/file", O_CREAT | O_EXCL | O_RDWR, kBasicFileMode);
  ASSERT_GE(fd, 0) << errno_text();
  const size_t piece = chunk_size / 3;
  for (size_t off = 0; off < size; off += piece) {
    const size_t len = size - off < piece ? size - off : piece;
    EXPECT_EQ(write(fd, data.data() + off, len), (ssize_t)len) << errno_text();
  }
  uint8_t run[kBasicOverwriteLen];
  memset(run, kBasicOverwriteByte, sizeof run);
  EXPECT_EQ(pwrite(fd, run, sizeof run, basic_overwrite_offset(chunk_size)),
            (ssize_t)sizeof run)
      << errno_text();

  data = basic_expected(chunk_size);
  EXPECT_EQ(lseek(fd, 0, SEEK_SET), 0);
  EXPECT_EQ(read(fd, back.data(), size), (ssize_t)size) << errno_text();
  EXPECT_EQ(back, data);
  // A read across the boundary alone, and one past the end.
  const size_t at = chunk_size - 3;
  EXPECT_EQ(lseek(fd, at, SEEK_SET), (off_t)at);
  EXPECT_EQ(read(fd, back.data(), 6), 6) << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data() + at, 6), 0);
  EXPECT_EQ(lseek(fd, size - 2, SEEK_SET), (off_t)(size - 2));
  EXPECT_EQ(read(fd, back.data(), 10), 2) << errno_text();
  EXPECT_EQ(read(fd, back.data(), 10), 0) << errno_text();

  struct stat st;
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)size);
  EXPECT_TRUE(S_ISREG(st.st_mode));
  EXPECT_EQ(st.st_mode & 07777, kBasicFileMode);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Basic, RenameFile) {
  EXPECT_EQ(rename(BASIC_MOUNT "/dir/file", BASIC_MOUNT "/dir/renamed"), 0)
      << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/dir/file", &st), ENOENT);
  ASSERT_EQ(stat(BASIC_MOUNT "/dir/renamed", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)basic_file_size(chunk_size));
}

// A directory with a file in it, into another.
TEST_F(Basic, RenameDirectory) {
  ASSERT_EQ(mkdir(BASIC_MOUNT "/moving", 0700), 0) << errno_text();
  write_file(BASIC_MOUNT "/moving/inner", 0644, kBasicInnerContents);
  EXPECT_EQ(rename(BASIC_MOUNT "/moving", BASIC_MOUNT "/dir/sub"), 0)
      << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/moving", &st), ENOENT);
  EXPECT_EQ(read_file(BASIC_MOUNT "/dir/sub/inner"), kBasicInnerContents);
}

TEST_F(Basic, RenameOverFile) {
  write_file(BASIC_MOUNT "/replaced", 0644, "to be replaced");
  write_file(BASIC_MOUNT "/replacement", 0644, kBasicReplacedContents);
  EXPECT_EQ(rename(BASIC_MOUNT "/replacement", BASIC_MOUNT "/replaced"), 0)
      << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/replacement", &st), ENOENT);
  EXPECT_EQ(read_file(BASIC_MOUNT "/replaced"), kBasicReplacedContents);
}

TEST_F(Basic, Unlink) {
  write_file(BASIC_MOUNT "/temporary", 0644, "temporary");
  EXPECT_EQ(unlink(BASIC_MOUNT "/temporary"), 0) << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/temporary", &st), ENOENT);
}

TEST_F(Basic, RemoveDirectory) {
  EXPECT_EQ(mkdir(BASIC_MOUNT "/empty", 0755), 0) << errno_text();
  EXPECT_ERRNO(rmdir(BASIC_MOUNT "/dir"), ENOTEMPTY);
  EXPECT_EQ(rmdir(BASIC_MOUNT "/empty"), 0) << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/empty", &st), ENOENT);
}

// An unlinked file stays usable through a descriptor open on it.
TEST_F(Basic, UnlinkedFileStaysUsableWhileOpen) {
  const char *path = BASIC_MOUNT "/held";
  const size_t size = chunk_size + 1;
  std::vector<uint8_t> data(size + 4), back(size + 4);
  for (size_t i = 0; i < size + 4; i++) {
    data[i] = (uint8_t)(i * 13);
  }

  const int fd = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), size), (ssize_t)size) << errno_text();
  EXPECT_EQ(unlink(path), 0) << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(path, &st), ENOENT);

  EXPECT_EQ(pread(fd, back.data(), size, 0), (ssize_t)size) << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data(), size), 0);
  EXPECT_EQ(pwrite(fd, data.data() + size, 4, size), 4) << errno_text();
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)(size + 4));
  EXPECT_EQ(pread(fd, back.data(), size + 4, 0), (ssize_t)(size + 4))
      << errno_text();
  EXPECT_EQ(back, data);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

// A file renamed over one a descriptor holds: the descriptor keeps the
// replaced file's data until it closes, which deletes it.
TEST_F(Basic, RenameOverOpenFile) {
  const char *held = BASIC_MOUNT "/usurped";
  const char *usurper = BASIC_MOUNT "/usurper";
  write_file(held, 0644, kBasicHeldContents);
  const int fd = open(held, O_RDONLY);
  ASSERT_GE(fd, 0) << errno_text();
  write_file(usurper, 0644, kBasicUsurperContents);
  EXPECT_EQ(rename(usurper, held), 0) << errno_text();
  EXPECT_EQ(read_file(held), kBasicUsurperContents);

  char buf[64] = {0};
  const size_t len = strlen(kBasicHeldContents);
  EXPECT_EQ(pread(fd, buf, sizeof buf - 1, 0), (ssize_t)len) << errno_text();
  EXPECT_STREQ(buf, kBasicHeldContents);
  struct stat st;
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)len);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

// Shrinking deletes the chunks past the new end and trims the one it ends
// in, so growing again reads zeros there.
TEST_F(Basic, ShrinkThenGrowReadsZeros) {
  const size_t written = basic_sized_written(chunk_size);
  const size_t kept = basic_sized_kept(chunk_size);
  const size_t size = basic_sized_size(chunk_size);
  std::vector<uint8_t> data(written), back(size + 1);
  for (size_t i = 0; i < written; i++) {
    data[i] = basic_pattern(i);
  }
  const std::vector<uint8_t> expected = basic_sized_expected(chunk_size);

  const int fd = open(BASIC_MOUNT "/sized", O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), written), (ssize_t)written) << errno_text();
  EXPECT_EQ(ftruncate(fd, kept), 0) << errno_text();
  struct stat st;
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)kept);
  EXPECT_EQ(pread(fd, back.data(), size + 1, 0), (ssize_t)kept) << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data(), kept), 0);

  EXPECT_EQ(ftruncate(fd, size), 0) << errno_text();
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)size);
  EXPECT_EQ(pread(fd, back.data(), size + 1, 0), (ssize_t)size) << errno_text();
  EXPECT_EQ(memcmp(back.data(), expected.data(), size), 0);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Basic, OpenTruncate) {
  const char *path = BASIC_MOUNT "/truncated";
  const size_t len = chunk_size + 10;
  std::vector<uint8_t> data(len, 'x'), back(len);
  int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), len), (ssize_t)len) << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();

  fd = open(path, O_RDWR | O_TRUNC);
  ASSERT_GE(fd, 0) << errno_text();
  struct stat st;
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, 0);
  const size_t short_len = strlen(kBasicTruncatedContents);
  EXPECT_EQ(write(fd, kBasicTruncatedContents, short_len), (ssize_t)short_len)
      << errno_text();
  EXPECT_EQ(pread(fd, back.data(), len, 0), (ssize_t)short_len) << errno_text();
  EXPECT_EQ(memcmp(back.data(), kBasicTruncatedContents, short_len), 0);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Basic, FollowSymlink) {
  EXPECT_EQ(symlink(kBasicLinkTarget, BASIC_MOUNT "/link"), 0) << errno_text();
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/link", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)basic_file_size(chunk_size));
}

TEST_F(Basic, SetModeAndTimes) {
  write_file(BASIC_MOUNT "/stamped", 0644, "stamped");
  EXPECT_EQ(chmod(BASIC_MOUNT "/stamped", kBasicStampedMode), 0)
      << errno_text();
  struct timespec times[2] = {{kBasicStampedAtime, 0}, {kBasicStampedMtime, 0}};
  EXPECT_EQ(utimensat(AT_FDCWD, BASIC_MOUNT "/stamped", times, 0), 0)
      << errno_text();
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/stamped", &st), 0) << errno_text();
  EXPECT_EQ(st.st_mode & 07777, kBasicStampedMode);
  EXPECT_EQ(st.st_mtim.tv_sec, kBasicStampedMtime);
}

TEST_F(Basic, ListRoot) {
  const std::map<std::string, unsigned char> expected = {
      {"dir", DT_DIR},     {"replaced", DT_REG}, {"link", DT_LNK},
      {"stamped", DT_REG}, {"sized", DT_REG},    {"truncated", DT_REG},
      {"usurped", DT_REG}};
  ASSERT_EQ(expected.size(), kBasicRootEntries);
  EXPECT_EQ(list_dir(BASIC_MOUNT), expected);
}

TEST_F(Basic, ListDirectory) {
  const std::map<std::string, unsigned char> expected = {{"renamed", DT_REG},
                                                         {"sub", DT_DIR}};
  EXPECT_EQ(list_dir(BASIC_MOUNT "/dir"), expected);
}

// The last close of an unlinked or replaced file deleted it, so the
// database holds an inode for each name alone. The next backend would sweep
// whatever it left, so only this run can see it.
TEST_F(Basic, LastCloseDeletesUnlinkedFiles) {
  auto layout = idb_test::read_layout(kBasicDatabase);
  ASSERT_TRUE(layout);
  EXPECT_EQ(layout->inodes, kBasicInodes);
}
