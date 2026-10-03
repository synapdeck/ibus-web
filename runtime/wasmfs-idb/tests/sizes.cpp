// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Files whose sizes sit on or around chunk boundaries and the limits of what
// the backend stores: holes, appends, empty files, and the largest size a
// JavaScript number holds exactly.

#include <cstdint>

#include "idb-test.h"

using idb_test::errno_text;

namespace {

// The largest offset a double holds exactly, and every integer below it.
constexpr off_t kMaxSize = ((off_t)1 << 53) - 1;

off_t size_of(int fd) {
  struct stat st;
  EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
  return st.st_size;
}

// Whether `len` bytes from `offset` all hold `byte`.
bool all(const std::vector<uint8_t> &buf, size_t offset, size_t len,
         uint8_t byte) {
  for (size_t i = offset; i < offset + len; i++) {
    if (buf[i] != byte) {
      return false;
    }
  }
  return true;
}

class Sizes : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    chunk = layout.chunk_size;
    ASSERT_GT(chunk, 13u);
  }

  size_t chunk = 0;
};

} // namespace

// Writes past the end leave holes that read as zeros: one inside the first
// chunk, and one spanning whole chunks.
TEST_F(Sizes, HolesReadAsZeros) {
  const int fd = open(path("sparse").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, "abc", 3), 3) << errno_text();
  EXPECT_EQ(lseek(fd, 10, SEEK_SET), 10);
  EXPECT_EQ(write(fd, "def", 3), 3) << errno_text();
  const size_t far = 3 * chunk + chunk / 2;
  EXPECT_EQ(lseek(fd, far, SEEK_SET), (off_t)far);
  EXPECT_EQ(size_of(fd), 13);
  EXPECT_EQ(write(fd, "ghi", 3), 3) << errno_text();
  const size_t size = far + 3;
  EXPECT_EQ(size_of(fd), (off_t)size);

  std::vector<uint8_t> back(size + 1, 'x');
  EXPECT_EQ(pread(fd, back.data(), size + 1, 0), (ssize_t)size) << errno_text();
  EXPECT_EQ(memcmp(back.data(), "abc", 3), 0);
  EXPECT_TRUE(all(back, 3, 7, 0));
  EXPECT_EQ(memcmp(back.data() + 10, "def", 3), 0);
  EXPECT_TRUE(all(back, 13, far - 13, 0));
  EXPECT_EQ(memcmp(back.data() + far, "ghi", 3), 0);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

// Shrinking onto a boundary drops every chunk past it; growing again reads
// zeros there.
TEST_F(Sizes, TruncateToABoundaryDropsTheChunksPastIt) {
  const size_t written = 2 * chunk + chunk / 2;
  const std::vector<uint8_t> data(written, 'z');
  const int fd =
      open(path("boundary").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), written), (ssize_t)written) << errno_text();
  EXPECT_EQ(ftruncate(fd, chunk), 0) << errno_text();
  EXPECT_EQ(size_of(fd), (off_t)chunk);
  EXPECT_EQ(ftruncate(fd, 3 * chunk), 0) << errno_text();
  EXPECT_EQ(size_of(fd), (off_t)(3 * chunk));

  std::vector<uint8_t> back(3 * chunk);
  EXPECT_EQ(pread(fd, back.data(), 3 * chunk, 0), (ssize_t)(3 * chunk))
      << errno_text();
  EXPECT_TRUE(all(back, 0, chunk, 'z'));
  EXPECT_TRUE(all(back, chunk, 2 * chunk, 0));
  EXPECT_EQ(close(fd), 0) << errno_text();
}

// O_APPEND writes at the end wherever the descriptor was, across a chunk
// boundary as well.
TEST_F(Sizes, AppendWritesAtTheEnd) {
  const size_t first = chunk - 1;
  const std::vector<uint8_t> data(first, 'a');
  int fd = open(path("append").c_str(), O_CREAT | O_EXCL | O_WRONLY, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), first), (ssize_t)first) << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();

  fd = open(path("append").c_str(), O_RDWR | O_APPEND);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(lseek(fd, 0, SEEK_SET), 0);
  EXPECT_EQ(write(fd, "bc", 2), 2) << errno_text();
  EXPECT_EQ(lseek(fd, 0, SEEK_CUR), (off_t)(chunk + 1));
  EXPECT_EQ(lseek(fd, 5, SEEK_SET), 5);
  EXPECT_EQ(write(fd, "d", 1), 1) << errno_text();
  const size_t size = chunk + 2;
  EXPECT_EQ(size_of(fd), (off_t)size);

  std::vector<uint8_t> back(size);
  EXPECT_EQ(pread(fd, back.data(), size, 0), (ssize_t)size) << errno_text();
  EXPECT_TRUE(all(back, 0, first, 'a'));
  EXPECT_EQ(memcmp(back.data() + first, "bcd", 3), 0);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

// A file of exactly some chunks ends on a boundary; one byte more starts a
// chunk of its own.
TEST_F(Sizes, WholeChunksEndOnABoundary) {
  const size_t size = 3 * chunk;
  std::vector<uint8_t> data(size + 1), back(size + 2);
  for (size_t i = 0; i < size + 1; i++) {
    data[i] = (uint8_t)(i * 13 + i / 241);
  }

  const int fd = open(path("whole").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(write(fd, data.data(), size), (ssize_t)size) << errno_text();
  EXPECT_EQ(size_of(fd), (off_t)size);
  EXPECT_EQ(pread(fd, back.data(), size + 2, 0), (ssize_t)size) << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data(), size), 0);
  EXPECT_EQ(pread(fd, back.data(), 1, size), 0) << errno_text();
  EXPECT_EQ(pread(fd, back.data(), 2, size - 1), 1) << errno_text();
  EXPECT_EQ(back[0], data[size - 1]);

  EXPECT_EQ(write(fd, data.data() + size, 1), 1) << errno_text();
  EXPECT_EQ(size_of(fd), (off_t)(size + 1));
  EXPECT_EQ(pread(fd, back.data(), size + 2, 0), (ssize_t)(size + 1))
      << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data(), size + 1), 0);
  EXPECT_EQ(pread(fd, back.data(), 2, size), 1) << errno_text();
  EXPECT_EQ(back[0], data[size]);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Sizes, EmptyFile) {
  int fd = open(path("empty").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(size_of(fd), 0);
  char buf[8];
  EXPECT_EQ(read(fd, buf, sizeof buf), 0) << errno_text();
  EXPECT_EQ(pread(fd, buf, sizeof buf, 100), 0) << errno_text();
  EXPECT_EQ(write(fd, buf, 0), 0) << errno_text();
  EXPECT_EQ(ftruncate(fd, 0), 0) << errno_text();
  EXPECT_EQ(size_of(fd), 0);
  EXPECT_EQ(close(fd), 0) << errno_text();

  struct stat st;
  ASSERT_EQ(stat(path("empty").c_str(), &st), 0) << errno_text();
  EXPECT_EQ(st.st_size, 0);
  fd = open(path("empty").c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_EQ(read(fd, buf, sizeof buf), 0) << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();
}

// A size the backend can't store exactly fails with EFBIG and changes
// nothing; the largest it can is an ordinary, if sparse, file.
TEST_F(Sizes, LargestSizeAJavaScriptNumberHolds) {
  const int fd = open(path("largest").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_ERRNO(ftruncate(fd, kMaxSize + 1), EFBIG);
  EXPECT_ERRNO(ftruncate(fd, INT64_MAX), EFBIG);
  EXPECT_ERRNO(pwrite(fd, "x", 1, kMaxSize), EFBIG);
  EXPECT_ERRNO(pwrite(fd, "xy", 2, kMaxSize - 1), EFBIG);
  EXPECT_EQ(lseek(fd, kMaxSize + 1, SEEK_SET), kMaxSize + 1);
  EXPECT_ERRNO(write(fd, "x", 1), EFBIG);
  EXPECT_EQ(size_of(fd), 0);

  EXPECT_EQ(ftruncate(fd, kMaxSize), 0) << errno_text();
  EXPECT_EQ(size_of(fd), kMaxSize);
  EXPECT_EQ(pwrite(fd, "y", 1, kMaxSize - 1), 1) << errno_text();
  EXPECT_EQ(size_of(fd), kMaxSize);
  char buf[4] = {0};
  EXPECT_EQ(pread(fd, buf, sizeof buf, kMaxSize - 2), 2) << errno_text();
  EXPECT_EQ(buf[0], 0);
  EXPECT_EQ(buf[1], 'y');
  EXPECT_EQ(pread(fd, buf, sizeof buf, kMaxSize), 0) << errno_text();
  EXPECT_ERRNO(pwrite(fd, "x", 1, kMaxSize), EFBIG);
  EXPECT_EQ(size_of(fd), kMaxSize);

  EXPECT_EQ(ftruncate(fd, 0), 0) << errno_text();
  EXPECT_EQ(size_of(fd), 0);
  EXPECT_EQ(close(fd), 0) << errno_text();
}
