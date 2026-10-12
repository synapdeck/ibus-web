// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The pipe fixes, on each file system a program here runs on: WasmFS, and
// the JavaScript one's pipes, which NODERAWFS keeps.

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <unistd.h>

#include <cstring>
#include <string>

#include <gtest/gtest.h>

namespace {

// Linux's default pipe capacity.
constexpr size_t capacity = 65536;

std::string error_name(int error) {
  return std::string(strerror(error)) + " (" + std::to_string(error) + ")";
}

// Compares errno values by name, so that a mismatch reads as one.
#define EXPECT_ERRNO(actual, expected)                                         \
  EXPECT_EQ(error_name(actual), error_name(expected))

class Pipe : public testing::Test {
protected:
  void SetUp() override { ASSERT_EQ(pipe(fds_), 0) << strerror(errno); }

  void TearDown() override {
    for (int fd : fds_) {
      if (fd >= 0)
        close(fd);
    }
  }

  void set_nonblocking() {
    ASSERT_EQ(fcntl(fds_[1], F_SETFL, O_NONBLOCK), 0) << strerror(errno);
  }

  // Writes size bytes in one call, returning what write() does.
  ssize_t write_bytes(size_t size) {
    static char zeros[4 * capacity];
    return write(fds_[1], zeros, size);
  }

  // Writes until the write end refuses, giving up past four times the
  // capacity, and returns how much it took.
  size_t fill() {
    size_t written = 0;
    ssize_t n;
    while (written < 4 * capacity && (n = write_bytes(1024)) > 0)
      written += n;
    return written;
  }

  bool writable() {
    struct pollfd pfd = {};
    pfd.fd = fds_[1];
    pfd.events = POLLOUT;
    EXPECT_GE(poll(&pfd, 1, 0), 0) << strerror(errno);
    return pfd.revents & POLLOUT;
  }

  ssize_t read_bytes(size_t size) {
    static char buf[2 * capacity];
    return read(fds_[0], buf, size);
  }

  int fds_[2] = {-1, -1};
};

using Patch0021 = Pipe;
using Patch0022 = Pipe;

TEST_F(Patch0021, NonblockingWriterSeesCapacity) {
  ASSERT_NO_FATAL_FAILURE(set_nonblocking());
  EXPECT_EQ(fill(), capacity);
  errno = 0;
  EXPECT_EQ(write_bytes(1), -1);
  EXPECT_ERRNO(errno, EAGAIN);
}

TEST_F(Patch0021, LargeWriteIsShort) {
  ASSERT_NO_FATAL_FAILURE(set_nonblocking());
  EXPECT_EQ(write_bytes(capacity + 4096), (ssize_t)capacity);
}

// Writes of up to PIPE_BUF bytes are atomic: all or nothing.
TEST_F(Patch0021, SmallWriteIsWhole) {
  ASSERT_NO_FATAL_FAILURE(set_nonblocking());
  ASSERT_EQ(write_bytes(capacity - 100), (ssize_t)(capacity - 100));
  errno = 0;
  EXPECT_EQ(write_bytes(200), -1);
  EXPECT_ERRNO(errno, EAGAIN);
  EXPECT_EQ(write_bytes(100), 100);
}

// A blocking write can't wait for a reader, so it isn't held to the
// capacity, but poll() says when it would have waited.
TEST_F(Patch0021, PollFollowsRoom) {
  EXPECT_TRUE(writable()) << "an empty pipe";
  EXPECT_EQ(write_bytes(2 * capacity), (ssize_t)(2 * capacity));
  EXPECT_FALSE(writable()) << "a pipe past its capacity";
  EXPECT_EQ(read_bytes(capacity + PIPE_BUF), (ssize_t)(capacity + PIPE_BUF));
  EXPECT_TRUE(writable()) << "a pipe with room for PIPE_BUF bytes";
}

TEST_F(Patch0022, ReadAtEndOfFileIsZero) {
  ASSERT_EQ(write_bytes(1), 1) << strerror(errno);
  ASSERT_EQ(close(fds_[1]), 0) << strerror(errno);
  fds_[1] = -1;
  EXPECT_EQ(read_bytes(4), 1) << strerror(errno);
  errno = 0;
  EXPECT_EQ(read_bytes(4), 0) << strerror(errno);
}

} // namespace
