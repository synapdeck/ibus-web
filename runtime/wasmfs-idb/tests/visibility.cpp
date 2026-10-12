// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What another backend over the same database creates, as another Worker's
// would, a backend that looked for it first and found nothing then finds:
// WasmFS keeps the entries a lookup found, never an entry's absence, and
// lists a directory from the database each time. A directory moved onto a
// name is found there whole: the move is one transaction, which leaves the
// tree where it was if it fails, and it never replaces a directory that
// holds anything.

#include <dirent.h>

#include "faults.h"
#include "idb-test.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

// The fixture's backend writes, as the host installing a store path would;
// a second, created read-only and mounted beside it, reads, as a host that
// mounted the version earlier would.
class Visibility : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    reader_path = mount_path + "-reader";
    reader = wasmfs_create_idb_backend(database.c_str(), WASMFS_IDB_READ_ONLY);
    ASSERT_NE(reader, nullptr);
    ASSERT_EQ(wasmfs_create_directory(reader_path.c_str(), 0777, reader), 0);
  }

  void TearDown() override {
    disarm_faults();
    IdbTest::TearDown();
  }

  // A tree as an install would stage it: a directory, one nested in it, and
  // a file in each.
  void stage(const std::string &dir) const {
    ASSERT_EQ(mkdir(path(dir).c_str(), 0755), 0) << errno_text();
    ASSERT_EQ(mkdir(path(dir + "/sub").c_str(), 0755), 0) << errno_text();
    ASSERT_NO_FATAL_FAILURE(write_file(path(dir + "/top"), 0644, "top"));
    ASSERT_NO_FATAL_FAILURE(write_file(path(dir + "/sub/file"), 0644, "data"));
  }

  std::string read(std::string_view name) const {
    return reader_path + "/" + std::string(name);
  }

  // The names a directory lists, but "." and "..".
  static std::vector<std::string> listed(const std::string &dir) {
    std::vector<std::string> names;
    DIR *stream = opendir(dir.c_str());
    EXPECT_NE(stream, nullptr) << dir << ": " << errno_text();
    if (stream == nullptr) {
      return names;
    }
    while (const dirent *entry = readdir(stream)) {
      const std::string name = entry->d_name;
      if (name != "." && name != "..") {
        names.push_back(name);
      }
    }
    EXPECT_EQ(closedir(stream), 0) << errno_text();
    std::sort(names.begin(), names.end());
    return names;
  }

  std::string reader_path;
  backend_t reader = nullptr;
};

} // namespace

TEST_F(Visibility, ATreeCreatedAfterAMissIsFound) {
  struct stat st;
  EXPECT_ERRNO(stat(read("store").c_str(), &st), ENOENT);
  EXPECT_ERRNO(stat(read("store/file").c_str(), &st), ENOENT);
  ASSERT_EQ(mkdir(path("store").c_str(), 0755), 0) << errno_text();
  ASSERT_NO_FATAL_FAILURE(write_file(path("store/file"), 0644, "data"));
  EXPECT_EQ(read_file(read("store/file")), "data");
}

TEST_F(Visibility, AFileCreatedInAKnownDirectoryAfterAMissIsFound) {
  ASSERT_EQ(mkdir(path("store").c_str(), 0755), 0) << errno_text();
  EXPECT_EQ(listed(read("store")), std::vector<std::string>{});
  struct stat st;
  EXPECT_ERRNO(stat(read("store/file").c_str(), &st), ENOENT);
  ASSERT_NO_FATAL_FAILURE(write_file(path("store/file"), 0644, "data"));
  EXPECT_EQ(listed(read("store")), std::vector<std::string>{"file"});
  EXPECT_EQ(read_file(read("store/file")), "data");
}

TEST_F(Visibility, ADirectoryMovedOntoANameAfterAMissIsFoundWhole) {
  struct stat st;
  EXPECT_ERRNO(stat(read("store").c_str(), &st), ENOENT);
  EXPECT_ERRNO(stat(read("store/sub/file").c_str(), &st), ENOENT);
  ASSERT_NO_FATAL_FAILURE(stage(".staging"));
  ASSERT_EQ(rename(path(".staging").c_str(), path("store").c_str()), 0)
      << errno_text();
  EXPECT_EQ(listed(read("store")), (std::vector<std::string>{"sub", "top"}));
  EXPECT_EQ(listed(read("store/sub")), std::vector<std::string>{"file"});
  EXPECT_EQ(read_file(read("store/top")), "top");
  EXPECT_EQ(read_file(read("store/sub/file")), "data");
  EXPECT_ERRNO(stat(read(".staging").c_str(), &st), ENOENT);
}

// The move deletes the old entry before it puts the new one, which fails:
// one transaction, it leaves both names as they were.
TEST_F(Visibility, AFailedMoveOfADirectoryLeavesItWhereItWas) {
  ASSERT_NO_FATAL_FAILURE(stage(".staging"));
  fail_put(IDB_ENTRIES, 0);
  EXPECT_ERRNO(rename(path(".staging").c_str(), path("store").c_str()), ENOSPC);
  EXPECT_FALSE(put_failure_pending());
  struct stat st;
  EXPECT_ERRNO(stat(read("store").c_str(), &st), ENOENT);
  EXPECT_ERRNO(stat(path("store").c_str(), &st), ENOENT);
  EXPECT_EQ(listed(read(".staging")), (std::vector<std::string>{"sub", "top"}));
  EXPECT_EQ(read_file(read(".staging/sub/file")), "data");
}

// Another backend made the name a directory holding a file, unseen by this
// one until the move looks.
TEST_F(Visibility, AMoveOntoADirectoryAnotherBackendFilledIsRefused) {
  ASSERT_NO_FATAL_FAILURE(stage(".staging"));
  ASSERT_EQ(wasmfs_idb_backend_set_writable(reader, true), 0);
  ASSERT_EQ(mkdir(read("store").c_str(), 0755), 0) << errno_text();
  ASSERT_NO_FATAL_FAILURE(write_file(read("store/other"), 0644, "other"));
  EXPECT_ERRNO(rename(path(".staging").c_str(), path("store").c_str()),
               ENOTEMPTY);
  EXPECT_EQ(listed(path("store")), std::vector<std::string>{"other"});
  EXPECT_EQ(listed(path(".staging")), (std::vector<std::string>{"sub", "top"}));
}
