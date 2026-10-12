// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The WasmFS fixes, on the file system test programs run on: WasmFS with
// the host's files under Node. Each case works in a directory of its own,
// named after it, under the working directory.

#include <emscripten/em_js.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <string>

#include <gtest/gtest.h>

// What the host sees, past WasmFS.
EM_JS(int, host_exists, (const char *path), {
  const fs = process.getBuiltinModule("node:fs");
  return fs.existsSync(UTF8ToString(path)) ? 1 : 0;
});

EM_JS(int, host_read, (const char *path, char *buf, int size), {
  const fs = process.getBuiltinModule("node:fs");
  try {
    return stringToUTF8(fs.readFileSync(UTF8ToString(path), "utf8"), buf, size);
  } catch {
    return -1;
  }
});

// The host's mode bits of path, or -1.
EM_JS(int, host_mode, (const char *path), {
  const fs = process.getBuiltinModule("node:fs");
  try {
    return fs.statSync(UTF8ToString(path)).mode & 0o7777;
  } catch {
    return -1;
  }
});

// The host's modification time of path, in whole seconds, or -1.
EM_JS(double, host_mtime, (const char *path), {
  const fs = process.getBuiltinModule("node:fs");
  try {
    return Math.floor(fs.statSync(UTF8ToString(path)).mtimeMs / 1000);
  } catch {
    return -1;
  }
});

// Whether the host lets this process past file permissions, as root or with
// CAP_DAC_OVERRIDE: it can read probe, a new file of mode 0.
EM_JS(int, host_ignores_permissions, (const char *probe), {
  const fs = process.getBuiltinModule("node:fs");
  const path = UTF8ToString(probe);
  fs.writeFileSync(path, "x", {mode : 0});
  try {
    fs.closeSync(fs.openSync(path, "r"));
    return 1;
  } catch {
    return 0;
  } finally {
    fs.unlinkSync(path);
  }
});

// How many descriptors the Node process has open.
EM_JS(int, host_open_fds, (void), {
  const fs = process.getBuiltinModule("node:fs");
  return fs.readdirSync("/proc/self/fd").length;
});

EM_JS(void, host_chmod, (const char *path, int mode), {
  const fs = process.getBuiltinModule("node:fs");
  fs.chmodSync(UTF8ToString(path), mode);
});

namespace {

std::string error_name(int error) {
  return std::string(strerror(error)) + " (" + std::to_string(error) + ")";
}

// Compares errno values by name, so that a mismatch reads as one.
#define EXPECT_ERRNO(actual, expected)                                         \
  EXPECT_EQ(error_name(actual), error_name(expected))

class Fixes : public testing::Test {
protected:
  void SetUp() override {
    char cwd[PATH_MAX];
    ASSERT_NE(getcwd(cwd, sizeof cwd), nullptr) << strerror(errno);
    base_ = cwd;
    const auto *info = testing::UnitTest::GetInstance()->current_test_info();
    dir_ = base_ + "/" + info->test_suite_name() + "." + info->name();
    ASSERT_EQ(mkdir(dir_.c_str(), 0777), 0) << dir_ << ": " << strerror(errno);
  }

  void TearDown() override { chdir(base_.c_str()); }

  // A path under this case's directory.
  std::string at(const std::string &rel) const { return dir_ + "/" + rel; }

  // Whether the host lets this process past file permissions, so that
  // checks it would make can't fail.
  bool host_ignores_permissions_here() const {
    return host_ignores_permissions(at("permission-probe").c_str());
  }

  static void put(const std::string &path, const char *text) {
    const int fd = open(path.c_str(), O_CREAT | O_WRONLY | O_TRUNC, 0644);
    ASSERT_GE(fd, 0) << "create " << path << ": " << strerror(errno);
    EXPECT_EQ(write(fd, text, strlen(text)), (ssize_t)strlen(text))
        << "write " << path << ": " << strerror(errno);
    EXPECT_EQ(close(fd), 0) << "close " << path << ": " << strerror(errno);
  }

  // WasmFS's view of path holds text.
  static void expect_file(const std::string &path, const char *text) {
    struct stat st;
    ASSERT_EQ(stat(path.c_str(), &st), 0) << path << ": " << strerror(errno);
    EXPECT_EQ(st.st_size, (off_t)strlen(text)) << path;
    const int fd = open(path.c_str(), O_RDONLY);
    ASSERT_GE(fd, 0) << path << ": " << strerror(errno);
    char buf[64] = {0};
    EXPECT_EQ(read(fd, buf, sizeof buf - 1), (ssize_t)strlen(text)) << path;
    EXPECT_STREQ(buf, text) << path;
    EXPECT_EQ(close(fd), 0) << path << ": " << strerror(errno);
  }

  // The host's file at rel holds text; with a null text, there is none.
  void expect_host(const std::string &rel, const char *text) const {
    const std::string path = at(rel);
    if (text == nullptr) {
      EXPECT_FALSE(host_exists(path.c_str())) << "the host still has " << rel;
      return;
    }
    char buf[64] = {0};
    EXPECT_GE(host_read(path.c_str(), buf, sizeof buf), 0)
        << "the host has no " << rel;
    EXPECT_STREQ(buf, text) << "the host's " << rel;
  }

  std::string base_;
  std::string dir_;
};

short poll_in(int fd) {
  struct pollfd pfd = {};
  pfd.fd = fd;
  pfd.events = POLLIN;
  EXPECT_GE(poll(&pfd, 1, 0), 0) << strerror(errno);
  return pfd.revents & POLLIN;
}

// A directory of the memory backend inside the case's host directory, with
// a second memory directory mounted inside it.
std::string memory_dir(const std::string &host_dir) {
  const std::string mem = host_dir + "/mem";
  wasmfs_create_directory(mem.c_str(), 0777, wasmfs_create_memory_backend());
  wasmfs_create_directory((mem + "/mnt").c_str(), 0777,
                          wasmfs_create_memory_backend());
  return mem;
}

using Patch0002 = Fixes;
using Patch0003 = Fixes;
using Patch0004 = Fixes;
using Patch0005 = Fixes;
using Patch0006 = Fixes;
using Patch0007 = Fixes;
using Patch0008 = Fixes;
using Patch0009 = Fixes;
using Patch0010 = Fixes;
using Patch0012 = Fixes;
using Patch0013 = Fixes;
using Patch0017 = Fixes;
using Patch0019 = Fixes;
using Patch0023 = Fixes;

class Patch0011 : public Fixes {
protected:
  // A tree below d, with files open in it, a file looked up in each of its
  // directories, and the working directory in d/sub.
  void build_tree() {
    ASSERT_EQ(mkdir(at("d").c_str(), 0777), 0) << strerror(errno);
    ASSERT_EQ(mkdir(at("d/sub").c_str(), 0777), 0) << strerror(errno);
    ASSERT_EQ(mkdir(at("d/sub/deep").c_str(), 0777), 0) << strerror(errno);
    put(at("d/f"), "f1");
    put(at("d/g"), "g1");
    put(at("d/sub/h"), "h1");
    put(at("d/sub/i"), "i1");
    put(at("d/sub/deep/j"), "j1");
    ASSERT_EQ(symlink("g", at("d/link").c_str()), 0) << strerror(errno);
    f_ = open(at("d/f").c_str(), O_RDWR);
    h_ = open(at("d/sub/h").c_str(), O_RDWR);
    ASSERT_GE(f_, 0) << strerror(errno);
    ASSERT_GE(h_, 0) << strerror(errno);
    struct stat st;
    ASSERT_EQ(stat(at("d/g").c_str(), &st), 0) << strerror(errno);
    ASSERT_EQ(stat(at("d/sub/i").c_str(), &st), 0) << strerror(errno);
    ASSERT_EQ(stat(at("d/sub/deep/j").c_str(), &st), 0) << strerror(errno);
    ASSERT_EQ(chdir(at("d/sub").c_str()), 0) << strerror(errno);
  }

  void TearDown() override {
    if (f_ >= 0)
      close(f_);
    if (h_ >= 0)
      close(h_);
    Fixes::TearDown();
  }

  // Renames d to e, and checks that everything below it followed.
  void rename_d() {
    ASSERT_EQ(rename(at("d").c_str(), at("e").c_str()), 0) << strerror(errno);
    expect_host("d", nullptr);
    struct stat st;
    EXPECT_EQ(pwrite(f_, "F2", 2, 0), 2) << strerror(errno);
    EXPECT_EQ(fstat(f_, &st), 0) << strerror(errno);
    EXPECT_EQ(st.st_size, 2);
    EXPECT_EQ(pwrite(h_, "H2", 2, 0), 2) << strerror(errno);
    EXPECT_EQ(fsync(h_), 0) << strerror(errno);
    expect_host("e/f", "F2");
    expect_host("e/sub/h", "H2");
    expect_file(at("e/f"), "F2");
    expect_file(at("e/g"), "g1");
    expect_file(at("e/link"), "g1");
    expect_file(at("e/sub/h"), "H2");
    expect_file(at("e/sub/i"), "i1");
    expect_file(at("e/sub/deep/j"), "j1");
    expect_file("i", "i1");
    put(at("e/sub/deep/new"), "n1");
    expect_host("e/sub/deep/new", "n1");
    put("k", "k1");
    expect_host("e/sub/k", "k1");
    const int result = open(at("d/f").c_str(), O_RDONLY);
    const int error = errno;
    EXPECT_LT(result, 0) << "open under the old name";
    EXPECT_ERRNO(error, ENOENT);
  }

  int f_ = -1;
  int h_ = -1;
};

TEST_F(Patch0002, GetcwdKeepsMountName) {
  const std::string sub = memory_dir(dir_) + "/mnt/sub";
  ASSERT_EQ(mkdir(sub.c_str(), 0777), 0) << strerror(errno);
  ASSERT_EQ(chdir(sub.c_str()), 0) << strerror(errno);
  char cwd[PATH_MAX];
  ASSERT_NE(getcwd(cwd, sizeof cwd), nullptr) << strerror(errno);
  EXPECT_EQ(cwd, sub);
}

TEST_F(Patch0006, OpenNeedsSearchPermission) {
  const std::string noexec = memory_dir(dir_) + "/noexec";
  ASSERT_EQ(mkdir(noexec.c_str(), 0777), 0) << strerror(errno);
  put(noexec + "/f", "f");
  ASSERT_EQ(chmod(noexec.c_str(), 0666), 0) << strerror(errno);
  const int result = open((noexec + "/f").c_str(), O_RDONLY);
  const int error = errno;
  EXPECT_LT(result, 0);
  EXPECT_ERRNO(error, EACCES);
}

TEST_F(Patch0006, ChdirNeedsSearchPermission) {
  const std::string noexec = memory_dir(dir_) + "/noexec";
  ASSERT_EQ(mkdir(noexec.c_str(), 0777), 0) << strerror(errno);
  ASSERT_EQ(chmod(noexec.c_str(), 0666), 0) << strerror(errno);
  const int result = chdir(noexec.c_str());
  const int error = errno;
  EXPECT_LT(result, 0);
  EXPECT_ERRNO(error, EACCES);
}

TEST_F(Patch0007, CreateNeedsWritePermission) {
  const std::string ro = memory_dir(dir_) + "/ro";
  ASSERT_EQ(mkdir(ro.c_str(), 0555), 0) << strerror(errno);
  const int result = open((ro + "/f").c_str(), O_CREAT | O_WRONLY, 0644);
  const int error = errno;
  EXPECT_LT(result, 0);
  EXPECT_ERRNO(error, EACCES);
}

TEST_F(Patch0003, EmptyFileIsReadable) {
  const std::string empty = memory_dir(dir_) + "/empty";
  put(empty, "");
  const int fd = open(empty.c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << strerror(errno);
  EXPECT_TRUE(poll_in(fd));
  close(fd);
}

TEST_F(Patch0003, DevNullIsReadable) {
  const int fd = open("/dev/null", O_RDONLY);
  ASSERT_GE(fd, 0) << strerror(errno);
  EXPECT_TRUE(poll_in(fd));
  close(fd);
}

TEST_F(Patch0003, PipeIsReadableOnlyWithData) {
  int fds[2];
  ASSERT_EQ(pipe(fds), 0) << strerror(errno);
  EXPECT_FALSE(poll_in(fds[0])) << "an empty pipe";
  EXPECT_EQ(write(fds[1], "x", 1), 1) << strerror(errno);
  EXPECT_TRUE(poll_in(fds[0])) << "a pipe holding data";
  close(fds[0]);
  close(fds[1]);
}

TEST_F(Patch0004, PipeIsFifo) {
  int fds[2];
  ASSERT_EQ(pipe(fds), 0) << strerror(errno);
  struct stat st;
  EXPECT_EQ(fstat(fds[0], &st), 0) << strerror(errno);
  EXPECT_TRUE(S_ISFIFO(st.st_mode)) << std::oct << st.st_mode;
  close(fds[0]);
  close(fds[1]);
}

TEST_F(Patch0005, OpenTakesNoctty) {
  const int fd = open("/dev/null", O_RDONLY | O_NOCTTY);
  EXPECT_GE(fd, 0) << strerror(errno);
  close(fd);
}

// As on Linux.
TEST_F(Patch0011, MountPointRenameIsBusy) {
  const std::string mem = memory_dir(dir_);
  ASSERT_EQ(mkdir((mem + "/mnt/sub").c_str(), 0777), 0) << strerror(errno);
  const int result = rename(mem.c_str(), at("mem-moved").c_str());
  const int error = errno;
  EXPECT_LT(result, 0);
  EXPECT_ERRNO(error, EBUSY);
  struct stat st;
  EXPECT_EQ(stat((mem + "/mnt/sub").c_str(), &st), 0)
      << "the mount stays where it was: " << strerror(errno);
}

// Only the host refuses, so the error comes from the host's open().
TEST_F(Patch0010, OpenReportsHostError) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const std::string path = at("locked");
  put(path, "locked");
  struct stat st;
  ASSERT_EQ(stat(path.c_str(), &st), 0) << strerror(errno);
  host_chmod(path.c_str(), 0);
  const int fd = open(path.c_str(), O_RDONLY);
  const int error = errno;
  host_chmod(path.c_str(), 0644);
  EXPECT_LT(fd, 0);
  EXPECT_ERRNO(error, EACCES);
}

TEST_F(Patch0009, FsyncSyncsHostFile) {
  const std::string path = at("synced");
  put(path, "file");
  const int fd = open(path.c_str(), O_RDWR);
  ASSERT_GE(fd, 0) << strerror(errno);
  EXPECT_EQ(write(fd, "synced", 6), 6) << strerror(errno);
  EXPECT_EQ(fsync(fd), 0) << strerror(errno);
  EXPECT_EQ(close(fd), 0) << strerror(errno);
  expect_host("synced", "synced");
}

TEST_F(Patch0013, ChmodReachesHost) {
  const std::string path = at("file");
  put(path, "file");
  EXPECT_EQ(chmod(path.c_str(), 0600), 0) << strerror(errno);
  EXPECT_EQ(host_mode(path.c_str()), 0600);
}

TEST_F(Patch0013, FchmodReachesHost) {
  const std::string path = at("file");
  put(path, "file");
  const int fd = open(path.c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << strerror(errno);
  EXPECT_EQ(fchmod(fd, 0640), 0) << strerror(errno);
  EXPECT_EQ(host_mode(path.c_str()), 0640);
  EXPECT_EQ(close(fd), 0) << strerror(errno);
}

TEST_F(Patch0013, UtimensatReachesHost) {
  const std::string path = at("file");
  put(path, "file");
  const struct timespec times[2] = {{1000000000, 0}, {1200000000, 0}};
  EXPECT_EQ(utimensat(AT_FDCWD, path.c_str(), times, 0), 0) << strerror(errno);
  EXPECT_EQ(host_mtime(path.c_str()), 1200000000);
}

// Through a descriptor, which has no path; the time still reaches the host.
TEST_F(Patch0008, FutimensSetsTimes) {
  const std::string path = at("file");
  put(path, "file");
  const int fd = open(path.c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << strerror(errno);
  const struct timespec times[2] = {{1000000000, 0}, {1100000000, 0}};
  EXPECT_EQ(futimens(fd, times), 0) << strerror(errno);
  EXPECT_EQ(host_mtime(path.c_str()), 1100000000);
  EXPECT_EQ(close(fd), 0) << strerror(errno);
}

// Rather than EIO: WasmFS still takes the directory for writable.
TEST_F(Patch0012, CreateReportsHostError) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const std::string shut = at("shut");
  ASSERT_EQ(mkdir(shut.c_str(), 0755), 0) << strerror(errno);
  struct stat st;
  ASSERT_EQ(stat(shut.c_str(), &st), 0) << strerror(errno);
  host_chmod(shut.c_str(), 0555);
  const int fd = open((shut + "/file").c_str(), O_CREAT | O_WRONLY, 0644);
  const int error = errno;
  host_chmod(shut.c_str(), 0755);
  EXPECT_LT(fd, 0);
  EXPECT_ERRNO(error, EACCES);
}

// Rather than EPERM: WasmFS still takes the directory for writable.
TEST_F(Patch0017, SymlinkReportsHostError) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const std::string shut = at("shut");
  ASSERT_EQ(mkdir(shut.c_str(), 0755), 0) << strerror(errno);
  struct stat st;
  ASSERT_EQ(stat(shut.c_str(), &st), 0) << strerror(errno);
  host_chmod(shut.c_str(), 0555);
  errno = 0;
  const int result = symlink("file", (shut + "/link").c_str());
  const int error = errno;
  host_chmod(shut.c_str(), 0755);
  EXPECT_LT(result, 0);
  EXPECT_ERRNO(error, EACCES);
}

// Rather than ENOENT: WasmFS still takes the directory for searchable.
TEST_F(Patch0019, StatReportsHostError) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const std::string closed = at("unsearchable");
  ASSERT_EQ(mkdir(closed.c_str(), 0755), 0) << strerror(errno);
  struct stat st;
  ASSERT_EQ(stat(closed.c_str(), &st), 0) << strerror(errno);
  host_chmod(closed.c_str(), 0644);
  errno = 0;
  const int result = stat((closed + "/file").c_str(), &st);
  const int error = errno;
  host_chmod(closed.c_str(), 0755);
  EXPECT_LT(result, 0);
  EXPECT_ERRNO(error, EACCES);
}

TEST_F(Patch0019, OpenReportsHostError) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const std::string closed = at("unsearchable");
  ASSERT_EQ(mkdir(closed.c_str(), 0755), 0) << strerror(errno);
  struct stat st;
  ASSERT_EQ(stat(closed.c_str(), &st), 0) << strerror(errno);
  host_chmod(closed.c_str(), 0644);
  errno = 0;
  const int fd = open((closed + "/file").c_str(), O_RDONLY);
  const int error = errno;
  host_chmod(closed.c_str(), 0755);
  EXPECT_LT(fd, 0);
  EXPECT_ERRNO(error, EACCES);
}

TEST_F(Patch0010, CreateIsNotBoundByItsMode) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const int fd = open(at("no-access").c_str(), O_CREAT | O_EXCL | O_RDWR, 0);
  ASSERT_GE(fd, 0) << strerror(errno);
  EXPECT_EQ(write(fd, "x", 1), 1) << strerror(errno);
  EXPECT_EQ(close(fd), 0) << strerror(errno);
}

// The host refuses to open a write-only file for reading, so a write-only
// open must ask it for writing alone.
TEST_F(Patch0023, OpenWriteOnlyFile) {
  if (host_ignores_permissions_here())
    GTEST_SKIP() << "the host ignores file permissions here";
  const std::string path = at("write-only");
  put(path, "abc");
  ASSERT_EQ(chmod(path.c_str(), 0200), 0) << strerror(errno);
  const int fd = open(path.c_str(), O_WRONLY);
  const int error = errno;
  if (fd >= 0) {
    EXPECT_EQ(write(fd, "xyz", 3), 3) << strerror(errno);
    EXPECT_EQ(close(fd), 0) << strerror(errno);
  }
  host_chmod(path.c_str(), 0644);
  ASSERT_GE(fd, 0) << strerror(error);
  expect_host("write-only", "xyz");
}

TEST_F(Patch0010, MknodKeepsNoDescriptor) {
  const int before = host_open_fds();
  for (int i = 0; i < 4; i++) {
    const std::string path = at("node-" + std::to_string(i));
    EXPECT_EQ(mknod(path.c_str(), S_IFREG | 0644, 0), 0) << strerror(errno);
  }
  EXPECT_EQ(host_open_fds(), before);
}

TEST_F(Patch0011, RenameKeepsHostPath) {
  ASSERT_NO_FATAL_FAILURE(build_tree());
  rename_d();
}

// A subdirectory, then its parent, then into another directory.
TEST_F(Patch0011, FurtherRenamesKeepHostPaths) {
  ASSERT_NO_FATAL_FAILURE(build_tree());
  ASSERT_NO_FATAL_FAILURE(rename_d());
  ASSERT_EQ(rename(at("e/sub").c_str(), at("e/sub2").c_str()), 0)
      << strerror(errno);
  ASSERT_EQ(rename(at("e").c_str(), at("x").c_str()), 0) << strerror(errno);
  ASSERT_EQ(mkdir(at("p").c_str(), 0777), 0) << strerror(errno);
  ASSERT_EQ(rename(at("x/sub2/deep").c_str(), at("p/moved").c_str()), 0)
      << strerror(errno);
  ASSERT_EQ(rename(at("x/g").c_str(), at("x/sub2/g").c_str()), 0)
      << strerror(errno);
  expect_host("e", nullptr);
  expect_host("x/sub", nullptr);
  expect_host("x/sub2/deep", nullptr);
  expect_host("x/g", nullptr);
  EXPECT_EQ(pwrite(h_, "H3", 2, 0), 2) << strerror(errno);
  expect_host("x/sub2/h", "H3");
  expect_file(at("x/f"), "F2");
  expect_file(at("x/sub2/g"), "g1");
  expect_file(at("x/sub2/h"), "H3");
  expect_file(at("x/sub2/i"), "i1");
  expect_file(at("p/moved/j"), "j1");
  expect_file(at("p/moved/new"), "n1");
  expect_file("k", "k1");
  char cwd[PATH_MAX];
  ASSERT_NE(getcwd(cwd, sizeof cwd), nullptr) << strerror(errno);
  EXPECT_EQ(cwd, at("x/sub2"));
}

// The directory is renamed back and forth meanwhile, but a lookup relative
// to the directory itself must always find the file in it. A lock-order
// regression here hangs rather than fails.
TEST_F(Patch0011, LookupDuringRenameFindsFile) {
  ASSERT_EQ(mkdir(at("c1").c_str(), 0777), 0) << strerror(errno);
  put(at("c1/f"), "c");
  const int dir = open(at("c1").c_str(), O_RDONLY | O_DIRECTORY);
  ASSERT_GE(dir, 0) << strerror(errno);

  struct Reader {
    int dir;
    std::atomic<bool> done{false};
    std::atomic<int> failures{0};
  } reader{dir};
  pthread_t thread;
  ASSERT_EQ(pthread_create(
                &thread, nullptr,
                [](void *arg) -> void * {
                  auto &reader = *static_cast<Reader *>(arg);
                  while (!reader.done) {
                    const int fd = openat(reader.dir, "f", O_RDONLY);
                    char c = 0;
                    if (fd < 0 || read(fd, &c, 1) != 1 || c != 'c')
                      reader.failures++;
                    if (fd >= 0)
                      close(fd);
                  }
                  return nullptr;
                },
                &reader),
            0);
  for (int i = 0; i < 2000; i++) {
    const std::string from = at("c" + std::to_string(1 + i % 2));
    const std::string to = at("c" + std::to_string(2 - i % 2));
    if (rename(from.c_str(), to.c_str()) != 0) {
      ADD_FAILURE() << "rename " << from << ": " << strerror(errno);
      break;
    }
  }
  reader.done = true;
  pthread_join(thread, nullptr);
  EXPECT_EQ(reader.failures, 0)
      << "lookups failed while their directory was renamed";
  close(dir);
}

} // namespace
