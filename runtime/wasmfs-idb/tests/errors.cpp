// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// How the backend fails. A write over the quota fails with ENOSPC and
// changes nothing; a read-only backend refuses every change with EROFS and
// still reads; a connection asking for a newer version of the database
// closes the backend's, after which its calls fail with EIO and the host
// hears why; and a database that can't be opened gives no backend, leaves
// no thread behind, and the host hears why too.

#include <dirent.h>

#include <set>

#include "faults.h"
#include "idb-test.h"
#include "stderr-lines.h"

using idb_test::errno_text;
using idb_test::heard_on_stderr;
using idb_test::read_file;
using idb_test::write_file;

EM_JS_DEPS(errors, "$PThread");

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
// `out` gets 1 once the database has been opened at version 2 and closed
// again, 2 as soon as a connection that stays open blocks that, and 0 if it
// fails.
EM_JS(void, upgrade_database, (void *call, uint32_t *out, const char *database), {
  wasmfsIdbTestUpgrade(UTF8ToString(database), (outcome) => {
    HEAPU32[out >> 2] = outcome;
    _idb_test_finish(call);
  });
});

// `out` gets the count of the program's threads, the backends' among them,
// that are running, once enough have ended to bring it down to `expected`,
// or after 5 seconds if they never do. A thread that ended leaves the count
// once the main thread takes its Worker back for the pool, which is when the
// count is checked again; nothing here notices a thread starting.
EM_JS(void, await_threads, (void *call, uint32_t *out, int expected), {
  const count = () => Object.keys(PThread.pthreads).length;
  const { returnWorkerToPool } = PThread;
  let backstop;
  const done = () => {
    PThread.returnWorkerToPool = returnWorkerToPool;
    clearTimeout(backstop);
    HEAPU32[out >> 2] = count();
    _idb_test_finish(call);
  };
  if (count() === expected) {
    done();
    return;
  }
  PThread.returnWorkerToPool = (worker) => {
    returnWorkerToPool(worker);
    if (count() === expected) done();
  };
  backstop = setTimeout(done, 5000);
});
// clang-format on

namespace {

uint8_t pattern(size_t i) { return (uint8_t)(i * 13 + i / 241); }

// The program's threads, the backends' among them, that are running.
int running_threads() {
  return MAIN_THREAD_EM_ASM_INT(
      { return Object.keys(PThread.pthreads).length; });
}

// The threads running, once enough have ended to leave `expected`, or as
// many as are left if they never do.
int threads_settled_at(int expected) {
  auto out = idb_test::on_main_thread(
      "waiting for the threads", [&](idb_test::MainThreadCall *call) {
        await_threads(call, call->out, expected);
      });
  return out ? (int)(*out)[0] : -1;
}

// Whether `a` and `b` describe a file alike. WasmFS numbers files by its
// own objects, one per backend, and keeps a file's times in memory once it
// has looked the file up, so neither says anything of the database; its
// records' digest does.
void expect_same(const struct stat &a, const struct stat &b) {
  EXPECT_EQ(a.st_mode, b.st_mode);
  EXPECT_EQ(a.st_size, b.st_size);
}

// A file of three chunks, a directory and a symlink to the file, with what
// the database held once they were made.
class Errors : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    chunk = layout.chunk_size;
    size = 3 * chunk;
    data.resize(size);
    for (size_t i = 0; i < size; i++) {
      data[i] = pattern(i);
    }
    const int fd =
        open(path("file").c_str(), O_CREAT | O_EXCL | O_WRONLY, 0644);
    ASSERT_GE(fd, 0) << errno_text();
    ASSERT_EQ(write(fd, data.data(), size), (ssize_t)size) << errno_text();
    ASSERT_EQ(close(fd), 0) << errno_text();
    ASSERT_EQ(mkdir(path("dir").c_str(), 0755), 0) << errno_text();
    ASSERT_EQ(symlink("file", path("link").c_str()), 0) << errno_text();
    auto made = idb_test::read_layout(database);
    ASSERT_TRUE(made);
    before = *made;
    ASSERT_EQ(before.inodes, 4u);
    ASSERT_EQ(before.entries, 3u);
    ASSERT_EQ(before.chunks, 3u);
    ASSERT_EQ(lstat(path("file").c_str(), &file_stat), 0) << errno_text();
    ASSERT_EQ(lstat(path("dir").c_str(), &dir_stat), 0) << errno_text();
    ASSERT_EQ(lstat(path("link").c_str(), &link_stat), 0) << errno_text();
  }

  void TearDown() override {
    disarm_faults();
    IdbTest::TearDown();
  }

  // Whether the file, through `fd`, holds exactly what it was written
  // with.
  void expect_file(int fd) {
    struct stat st;
    EXPECT_EQ(fstat(fd, &st), 0) << errno_text();
    EXPECT_EQ(st.st_size, (off_t)size);
    std::vector<uint8_t> back(size + 1);
    EXPECT_EQ(pread(fd, back.data(), size + 1, 0), (ssize_t)size)
        << errno_text();
    back.resize(size);
    EXPECT_EQ(back, data);
  }

  // Whether the database and the writable backend's files are exactly as
  // they were made.
  void expect_unchanged() {
    struct stat st;
    EXPECT_EQ(lstat(path("file").c_str(), &st), 0) << errno_text();
    expect_same(st, file_stat);
    EXPECT_EQ(lstat(path("dir").c_str(), &st), 0) << errno_text();
    expect_same(st, dir_stat);
    EXPECT_EQ(lstat(path("link").c_str(), &st), 0) << errno_text();
    expect_same(st, link_stat);
    auto now = idb_test::read_layout(database);
    ASSERT_TRUE(now);
    EXPECT_EQ(*now, before);
  }

  // A read-only backend on the database, mounted beside the writable one.
  void mount_read_only() {
    read_only_mount = mount_path + "-ro";
    read_only =
        wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY);
    ASSERT_NE(read_only, nullptr);
    ASSERT_EQ(wasmfs_create_directory(read_only_mount.c_str(), 0777, read_only),
              0);
  }

  std::string read_only_path(std::string_view name) const {
    return read_only_mount + "/" + std::string(name);
  }

  // Opens the database at version 2, as a later version of the backend
  // would, which every backend on it must let happen.
  void upgrade() {
    auto out = idb_test::on_main_thread(
        "upgrading " + database, [&](idb_test::MainThreadCall *call) {
          upgrade_database(call, call->out, database.c_str());
        });
    ASSERT_TRUE(out);
    const uint32_t outcome = (*out)[0];
    ASSERT_EQ(outcome, 1u) << "opening the database at version 2 "
                           << (outcome == 2 ? "was blocked" : "failed");
  }

  // A fresh database still opens after failures, on a thread of its own:
  // none of theirs was left running.
  void expect_backend_opens(int threads) {
    const std::string fresh = other_database("fresh");
    const std::string fresh_mount = mount_path + "-fresh";
    backend_t opened = wasmfs_create_idb_backend(fresh.c_str(), 0);
    ASSERT_NE(opened, nullptr);
    EXPECT_EQ(running_threads(), threads + 1);
    ASSERT_EQ(wasmfs_create_directory(fresh_mount.c_str(), 0777, opened), 0);
    write_file(fresh_mount + "/file", 0644, "fresh");
    EXPECT_EQ(read_file(fresh_mount + "/file"), "fresh");
  }

  size_t chunk = 0;
  // The file's size: three chunks.
  size_t size = 0;
  std::vector<uint8_t> data;
  struct stat file_stat{};
  struct stat dir_stat{};
  struct stat link_stat{};
  idb_test::Layout before{};
  backend_t read_only = nullptr;
  std::string read_only_mount;
};

} // namespace

// Each write over the quota fails whole: its transaction aborts, taking
// whatever it had already written with it. This one is over the last two
// chunks and past the end, so it would add a chunk and grow the file.
TEST_F(Errors, QuotaWriteLeavesNothingChanged) {
  const int fd = open(path("file").c_str(), O_RDWR);
  ASSERT_GE(fd, 0) << errno_text();
  const size_t len = 2 * chunk;
  const off_t offset = chunk + chunk / 2;
  const std::vector<uint8_t> other(len, 'x');
  // The second chunk fails, after the first went in.
  fail_put(IDB_CHUNKS, 1);
  EXPECT_ERRNO(pwrite(fd, other.data(), len, offset), ENOSPC);
  EXPECT_FALSE(put_failure_pending());
  expect_file(fd);
  // The inode fails, after every chunk went in.
  fail_put(IDB_INODES, 0);
  EXPECT_ERRNO(pwrite(fd, other.data(), len, offset), ENOSPC);
  EXPECT_FALSE(put_failure_pending());
  expect_file(fd);
  EXPECT_EQ(close(fd), 0) << errno_text();
  expect_unchanged();
}

// Truncating deletes and trims chunks before the inode fails.
TEST_F(Errors, QuotaTruncateLeavesNothingChanged) {
  const int fd = open(path("file").c_str(), O_RDWR);
  ASSERT_GE(fd, 0) << errno_text();
  fail_put(IDB_INODES, 0);
  EXPECT_ERRNO(ftruncate(fd, chunk / 2), ENOSPC);
  expect_file(fd);
  fail_put(IDB_INODES, 0);
  EXPECT_ERRNO(ftruncate(fd, size + chunk), ENOSPC);
  expect_file(fd);
  EXPECT_FALSE(put_failure_pending());
  EXPECT_EQ(close(fd), 0) << errno_text();
  expect_unchanged();
}

TEST_F(Errors, QuotaChmodLeavesNothingChanged) {
  const int fd = open(path("file").c_str(), O_RDWR);
  ASSERT_GE(fd, 0) << errno_text();
  fail_put(IDB_INODES, 0);
  EXPECT_ERRNO(fchmod(fd, 0600), ENOSPC);
  EXPECT_FALSE(put_failure_pending());
  EXPECT_EQ(close(fd), 0) << errno_text();
  expect_unchanged();
}

// A create adds its entry before the inode fails, and a directory's the
// next inode number.
TEST_F(Errors, QuotaCreateLeavesNothing) {
  struct stat st;
  fail_put(IDB_INODES, 0);
  EXPECT_ERRNO(open(path("new").c_str(), O_CREAT | O_EXCL | O_WRONLY, 0644),
               ENOSPC);
  EXPECT_ERRNO(stat(path("new").c_str(), &st), ENOENT);
  fail_put(IDB_META, 0);
  EXPECT_ERRNO(mkdir(path("newdir").c_str(), 0755), ENOSPC);
  EXPECT_ERRNO(stat(path("newdir").c_str(), &st), ENOENT);
  fail_put(IDB_INODES, 0);
  EXPECT_ERRNO(symlink("file", path("newlink").c_str()), ENOSPC);
  EXPECT_ERRNO(lstat(path("newlink").c_str(), &st), ENOENT);
  EXPECT_FALSE(put_failure_pending());
  expect_unchanged();
}

// A rename deletes the old entry before the new one fails.
TEST_F(Errors, QuotaRenameLeavesNothingChanged) {
  struct stat st;
  fail_put(IDB_ENTRIES, 0);
  EXPECT_ERRNO(rename(path("file").c_str(), path("renamed").c_str()), ENOSPC);
  EXPECT_ERRNO(stat(path("renamed").c_str(), &st), ENOENT);
  EXPECT_FALSE(put_failure_pending());
  expect_unchanged();
}

// Each change that fails with ENOSPC counts, and nothing else does: neither
// a change that succeeds nor one refused for another reason.
TEST_F(Errors, QuotaFailuresAreCounted) {
  ASSERT_NO_FATAL_FAILURE(mount_read_only());
  EXPECT_EQ(wasmfs_idb_backend_quota_failures(backend), 0u);
  const int fd = open(path("file").c_str(), O_RDWR);
  ASSERT_GE(fd, 0) << errno_text();
  const uint8_t byte = 'x';
  fail_put(IDB_CHUNKS, 0);
  EXPECT_ERRNO(pwrite(fd, &byte, 1, 0), ENOSPC);
  EXPECT_EQ(wasmfs_idb_backend_quota_failures(backend), 1u);
  fail_put(IDB_META, 0);
  EXPECT_ERRNO(mkdir(path("newdir").c_str(), 0755), ENOSPC);
  EXPECT_EQ(wasmfs_idb_backend_quota_failures(backend), 2u);

  EXPECT_EQ(pwrite(fd, &byte, 1, 0), 1) << errno_text();
  EXPECT_ERRNO(mkdir(read_only_path("newdir").c_str(), 0755), EROFS);
  EXPECT_EQ(wasmfs_idb_backend_quota_failures(backend), 2u);
  EXPECT_EQ(wasmfs_idb_backend_quota_failures(read_only), 0u);
  EXPECT_EQ(close(fd), 0) << errno_text();
}

TEST_F(Errors, ReadOnlyRefusesEveryChange) {
  ASSERT_NO_FATAL_FAILURE(mount_read_only());
  const auto ro = [&](std::string_view name) { return read_only_path(name); };
  EXPECT_ERRNO(open(ro("file").c_str(), O_WRONLY), EROFS);
  EXPECT_ERRNO(open(ro("file").c_str(), O_RDWR), EROFS);
  EXPECT_ERRNO(open(ro("file").c_str(), O_WRONLY | O_TRUNC), EROFS);
  EXPECT_ERRNO(open(ro("new").c_str(), O_CREAT | O_WRONLY, 0644), EROFS);
  EXPECT_ERRNO(open(ro("new").c_str(), O_CREAT | O_RDONLY, 0644), EROFS);
  EXPECT_ERRNO(mknod(ro("node").c_str(), S_IFREG | 0644, 0), EROFS);
  EXPECT_ERRNO(truncate(ro("file").c_str(), 0), EROFS);
  EXPECT_ERRNO(mkdir(ro("newdir").c_str(), 0755), EROFS);
  EXPECT_ERRNO(mkdir(ro("dir/newdir").c_str(), 0755), EROFS);
  EXPECT_ERRNO(unlink(ro("file").c_str()), EROFS);
  EXPECT_ERRNO(unlink(ro("link").c_str()), EROFS);
  EXPECT_ERRNO(rmdir(ro("dir").c_str()), EROFS);
  EXPECT_ERRNO(rename(ro("file").c_str(), ro("renamed").c_str()), EROFS);
  EXPECT_ERRNO(rename(ro("file").c_str(), ro("dir/file").c_str()), EROFS);
  EXPECT_ERRNO(rename(ro("link").c_str(), ro("file").c_str()), EROFS);
  EXPECT_ERRNO(rename(ro("dir").c_str(), ro("moved").c_str()), EROFS);
  EXPECT_ERRNO(chmod(ro("file").c_str(), 0600), EROFS);
  EXPECT_ERRNO(chmod(ro("dir").c_str(), 0700), EROFS);
  EXPECT_ERRNO(chmod(read_only_mount.c_str(), 0700), EROFS);
  EXPECT_ERRNO(utimensat(AT_FDCWD, ro("file").c_str(), NULL, 0), EROFS);
  EXPECT_ERRNO(utimensat(AT_FDCWD, ro("dir").c_str(), NULL, 0), EROFS);
  EXPECT_ERRNO(
      utimensat(AT_FDCWD, ro("link").c_str(), NULL, AT_SYMLINK_NOFOLLOW),
      EROFS);
  EXPECT_ERRNO(symlink("file", ro("newlink").c_str()), EROFS);
  EXPECT_ERRNO(symlink("file", ro("dir/newlink").c_str()), EROFS);

  const int fd = open(ro("file").c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << errno_text();
  EXPECT_ERRNO(fchmod(fd, 0600), EROFS);
  EXPECT_ERRNO(futimens(fd, NULL), EROFS);
  EXPECT_EQ(close(fd), 0) << errno_text();
  expect_unchanged();
}

TEST_F(Errors, ReadOnlyStillReads) {
  ASSERT_NO_FATAL_FAILURE(mount_read_only());
  int fd = open(read_only_path("file").c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << errno_text();
  expect_file(fd);
  // Nothing was written, so there is nothing to make durable.
  EXPECT_EQ(fsync(fd), 0) << errno_text();
  EXPECT_EQ(close(fd), 0) << errno_text();
  char target[16] = {0};
  EXPECT_EQ(readlink(read_only_path("link").c_str(), target, sizeof target - 1),
            4)
      << errno_text();
  EXPECT_STREQ(target, "file");
  struct stat st;
  EXPECT_EQ(lstat(read_only_path("file").c_str(), &st), 0) << errno_text();
  expect_same(st, file_stat);
  EXPECT_EQ(lstat(read_only_path("dir").c_str(), &st), 0) << errno_text();
  expect_same(st, dir_stat);
  EXPECT_EQ(lstat(read_only_path("link").c_str(), &st), 0) << errno_text();
  expect_same(st, link_stat);
  std::set<std::string> names;
  DIR *dir = opendir(read_only_mount.c_str());
  ASSERT_NE(dir, nullptr) << errno_text();
  while (struct dirent *entry = readdir(dir)) {
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) {
      names.insert(entry->d_name);
    }
  }
  EXPECT_EQ(closedir(dir), 0) << errno_text();
  EXPECT_EQ(names, (std::set<std::string>{"dir", "file", "link"}));

  // Through the writable backend, everything is as it was.
  fd = open(path("file").c_str(), O_RDONLY);
  ASSERT_GE(fd, 0) << errno_text();
  expect_file(fd);
  EXPECT_EQ(close(fd), 0) << errno_text();
  expect_unchanged();
}

// Asked for version 2 with both backends' connections open, the backends
// close them, so the upgrade goes ahead, and the host hears why.
TEST_F(Errors, VersionChangeClosesEveryBackend) {
  ASSERT_NO_FATAL_FAILURE(mount_read_only());
  EXPECT_FALSE(wasmfs_idb_backend_closed(backend));
  EXPECT_FALSE(wasmfs_idb_backend_closed(read_only));
  ASSERT_NO_FATAL_FAILURE(upgrade());
  EXPECT_TRUE(wasmfs_idb_backend_closed(backend));
  EXPECT_TRUE(wasmfs_idb_backend_closed(read_only));
  const std::string closed =
      "wasmfs-idb: " + database + " closed for a version change";
  EXPECT_TRUE(heard_on_stderr(closed)) << "stderr never said: " << closed;
}

// Every call through a descriptor open on either backend that reaches the
// database fails once the backends have closed.
TEST_F(Errors, CallsAfterAVersionChangeFailWithEIO) {
  ASSERT_NO_FATAL_FAILURE(mount_read_only());
  const int writer = open(path("file").c_str(), O_RDWR);
  ASSERT_GE(writer, 0) << errno_text();
  const int reader = open(read_only_path("file").c_str(), O_RDONLY);
  ASSERT_GE(reader, 0) << errno_text();
  ASSERT_NO_FATAL_FAILURE(upgrade());

  uint8_t buf[4];
  struct stat st;
  EXPECT_ERRNO(pread(writer, buf, sizeof buf, 0), EIO);
  EXPECT_ERRNO(pwrite(writer, "abcd", 4, 0), EIO);
  EXPECT_ERRNO(fstat(writer, &st), EIO);
  EXPECT_ERRNO(ftruncate(writer, 0), EIO);
  EXPECT_ERRNO(fchmod(writer, 0600), EIO);
  EXPECT_ERRNO(fsync(writer), EIO);
  EXPECT_ERRNO(pread(reader, buf, sizeof buf, 0), EIO);
  // Closing needs nothing from the database.
  EXPECT_EQ(close(writer), 0) << errno_text();
  EXPECT_EQ(close(reader), 0) << errno_text();
  EXPECT_ERRNO(mkdir(path("dir/after").c_str(), 0755), EIO);
  EXPECT_ERRNO(symlink("file", path("dir/afterlink").c_str()), EIO);
  EXPECT_ERRNO(chmod(path("dir").c_str(), 0700), EIO);
  EXPECT_ERRNO(open(path("file").c_str(), O_RDONLY), EIO);
  errno = 0;
  EXPECT_EQ(opendir(path("dir").c_str()), nullptr);
  EXPECT_EQ(errno, EIO) << errno_text();
}

// A lookup the database can't answer says so, rather than that there is no
// such file, which a caller would take for leave to create one.
TEST_F(Errors, LookupsAfterAVersionChangeFailWithEIO) {
  ASSERT_NO_FATAL_FAILURE(mount_read_only());
  ASSERT_NO_FATAL_FAILURE(upgrade());
  struct stat st;
  EXPECT_ERRNO(stat(path("never").c_str(), &st), EIO);
  EXPECT_ERRNO(stat(read_only_path("never").c_str(), &st), EIO);
  EXPECT_ERRNO(open(path("never").c_str(), O_RDONLY), EIO);
  EXPECT_ERRNO(open(path("never").c_str(), O_CREAT | O_WRONLY, 0644), EIO);
}

// A database at a version newer than the backend's gives no backend,
// writable or read-only, its thread is gone, and the host hears why.
TEST_F(Errors, NewerVersionGivesNoBackend) {
  ASSERT_NO_FATAL_FAILURE(upgrade());
  const int threads = running_threads();
  EXPECT_EQ(wasmfs_create_idb_backend(database.c_str(), 0), nullptr);
  EXPECT_EQ(threads_settled_at(threads), threads);
  EXPECT_EQ(wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY),
            nullptr);
  EXPECT_EQ(threads_settled_at(threads), threads);
  const std::string newer =
      "wasmfs-idb: opening " + database + " failed: VersionError";
  EXPECT_TRUE(heard_on_stderr(newer)) << "stderr never said: " << newer;
  expect_backend_opens(threads);
}

// A database IndexedDB refuses to open gives no backend, its thread is
// gone, and the host hears why.
TEST_F(Errors, RefusedOpenGivesNoBackend) {
  const std::string refused = database + "-refused";
  const int threads = running_threads();
  fail_open();
  EXPECT_EQ(wasmfs_create_idb_backend(refused.c_str(), 0), nullptr);
  EXPECT_EQ(threads_settled_at(threads), threads);
  const std::string log =
      "wasmfs-idb: opening " + refused + " failed: SecurityError";
  EXPECT_TRUE(heard_on_stderr(log)) << "stderr never said: " << log;
  expect_backend_opens(threads);
}
