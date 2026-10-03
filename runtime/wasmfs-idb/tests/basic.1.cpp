// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Files, directories and symlinks on a fresh database, leaving what basic.2
// reads back in the next run. Each Basic case makes the files it works on
// itself; the BasicLeft cases check what all of them left together.

#include <dirent.h>
#include <sys/stat.h>

#include <map>
#include <set>

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

// Writes the spanning file in pieces of a third of a chunk, so every chunk
// is built from several writes, then overwrites a run across the chunk
// boundary. Returns the descriptor, open for reading and writing.
int write_spanning(const char *path, unsigned chunk_size) {
  const size_t size = basic_file_size(chunk_size);
  std::vector<uint8_t> data(size);
  for (size_t i = 0; i < size; i++) {
    data[i] = basic_pattern(i);
  }
  const int fd = open(path, O_CREAT | O_EXCL | O_RDWR, kBasicFileMode);
  EXPECT_GE(fd, 0) << path << ": " << errno_text();
  if (fd < 0) {
    return fd;
  }
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
  return fd;
}

// The cases that each make part of what the database is left holding. One
// that passes says so, for the cases that check the whole.
class Basic : public BasicDatabase {
protected:
  void TearDown() override {
    if (!HasFailure()) {
      passed.insert(
          testing::UnitTest::GetInstance()->current_test_info()->name());
    }
  }

public:
  static inline std::set<std::string> passed;
};

// The cases that check what every Basic case left, so they need all of
// them to have run and passed first; without that, they skip.
class BasicLeft : public BasicDatabase {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(BasicDatabase::SetUp());
    const auto *unit = testing::UnitTest::GetInstance();
    int cases = 0;
    for (int i = 0; i < unit->total_test_suite_count(); i++) {
      if (std::string(unit->GetTestSuite(i)->name()) == "Basic") {
        cases = unit->GetTestSuite(i)->total_test_count();
      }
    }
    if ((int)Basic::passed.size() != cases) {
      GTEST_SKIP() << "needs the Basic cases before it: "
                   << Basic::passed.size() << " of " << cases
                   << " ran and passed";
    }
  }
};

// The last close of a file no name holds deletes what it stored.
class Deletion : public idb_test::IdbTest {};

} // namespace

TEST_F(Basic, MakeDirectory) {
  EXPECT_EQ(mkdir(BASIC_MOUNT "/dir", 0755), 0) << errno_text();
  EXPECT_ERRNO(mkdir(BASIC_MOUNT "/dir", 0755), EEXIST);
}

TEST_F(Basic, WriteAcrossChunks) {
  const size_t size = basic_file_size(chunk_size);
  const int fd = write_spanning(BASIC_MOUNT "/spanning", chunk_size);
  ASSERT_GE(fd, 0);

  const std::vector<uint8_t> data = basic_expected(chunk_size);
  std::vector<uint8_t> back(size);
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

// A file spanning chunks, renamed within its directory.
TEST_F(Basic, RenameFile) {
  ASSERT_EQ(mkdir(BASIC_MOUNT "/files", 0755), 0) << errno_text();
  const int fd = write_spanning(BASIC_MOUNT "/files/file", chunk_size);
  ASSERT_GE(fd, 0);
  EXPECT_EQ(close(fd), 0) << errno_text();
  EXPECT_EQ(rename(BASIC_MOUNT "/files/file", BASIC_MOUNT "/files/renamed"), 0)
      << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/files/file", &st), ENOENT);
  ASSERT_EQ(stat(BASIC_MOUNT "/files/renamed", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)basic_file_size(chunk_size));
}

// A directory with a file in it, into another.
TEST_F(Basic, RenameDirectory) {
  ASSERT_EQ(mkdir(BASIC_MOUNT "/parent", 0755), 0) << errno_text();
  ASSERT_EQ(mkdir(BASIC_MOUNT "/moving", 0700), 0) << errno_text();
  write_file(BASIC_MOUNT "/moving/inner", 0644, kBasicInnerContents);
  EXPECT_EQ(rename(BASIC_MOUNT "/moving", BASIC_MOUNT "/parent/sub"), 0)
      << errno_text();
  struct stat st;
  EXPECT_ERRNO(stat(BASIC_MOUNT "/moving", &st), ENOENT);
  EXPECT_EQ(read_file(BASIC_MOUNT "/parent/sub/inner"), kBasicInnerContents);
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
  ASSERT_EQ(mkdir(BASIC_MOUNT "/full", 0755), 0) << errno_text();
  write_file(BASIC_MOUNT "/full/kept", 0644, kBasicKeptContents);
  EXPECT_EQ(mkdir(BASIC_MOUNT "/empty", 0755), 0) << errno_text();
  EXPECT_ERRNO(rmdir(BASIC_MOUNT "/full"), ENOTEMPTY);
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
  write_file(BASIC_MOUNT "/link-target", 0644, kBasicLinkedContents);
  EXPECT_EQ(symlink(kBasicLinkTarget, BASIC_MOUNT "/link"), 0) << errno_text();
  struct stat st;
  ASSERT_EQ(stat(BASIC_MOUNT "/link", &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, (off_t)strlen(kBasicLinkedContents));
  EXPECT_EQ(read_file(BASIC_MOUNT "/link"), kBasicLinkedContents);
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

TEST_F(BasicLeft, ListRoot) {
  const std::map<std::string, unsigned char> expected = {
      {"dir", DT_DIR},     {"spanning", DT_REG},    {"files", DT_DIR},
      {"parent", DT_DIR},  {"replaced", DT_REG},    {"full", DT_DIR},
      {"usurped", DT_REG}, {"sized", DT_REG},       {"truncated", DT_REG},
      {"link", DT_LNK},    {"link-target", DT_REG}, {"stamped", DT_REG}};
  ASSERT_EQ(expected.size(), kBasicRootEntries);
  EXPECT_EQ(list_dir(BASIC_MOUNT), expected);
}

TEST_F(BasicLeft, ListDirectories) {
  EXPECT_EQ(list_dir(BASIC_MOUNT "/files"),
            (std::map<std::string, unsigned char>{{"renamed", DT_REG}}));
  EXPECT_EQ(list_dir(BASIC_MOUNT "/parent"),
            (std::map<std::string, unsigned char>{{"sub", DT_DIR}}));
  EXPECT_EQ(list_dir(BASIC_MOUNT "/full"),
            (std::map<std::string, unsigned char>{{"kept", DT_REG}}));
}

// The database holds an inode for each name alone, which basic.2 checks
// again after its backend has swept whatever this run left.
TEST_F(BasicLeft, HoldsAnInodeForEachName) {
  auto layout = idb_test::read_layout(kBasicDatabase);
  ASSERT_TRUE(layout);
  EXPECT_EQ(layout->inodes, kBasicInodes);
}

// Unlinked while open, and replaced by a rename while open: once each is
// closed, the database holds its root and the file that replaced the
// other alone. A backend created later would sweep whatever was left, so
// only the backend that deleted the names can show this.
TEST_F(Deletion, LastCloseDeletesUnlinkedFiles) {
  write_file(path("unlinked"), 0644, "unlinked");
  write_file(path("replaced"), 0644, "replaced");
  const int unlinked = open(path("unlinked").c_str(), O_RDONLY);
  ASSERT_GE(unlinked, 0) << errno_text();
  const int replaced = open(path("replaced").c_str(), O_RDONLY);
  ASSERT_GE(replaced, 0) << errno_text();
  EXPECT_EQ(unlink(path("unlinked").c_str()), 0) << errno_text();
  write_file(path("replacement"), 0644, "replacement");
  EXPECT_EQ(rename(path("replacement").c_str(), path("replaced").c_str()), 0)
      << errno_text();
  EXPECT_EQ(idb_test::read_counts(database), (idb_test::Counts{4, 1, 3}))
      << "while the descriptors are open";
  EXPECT_EQ(close(unlinked), 0) << errno_text();
  EXPECT_EQ(close(replaced), 0) << errno_text();
  EXPECT_EQ(idb_test::read_counts(database), (idb_test::Counts{2, 1, 1}));
}
