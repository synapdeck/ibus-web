// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Creating a read-write backend sweeps the orphans the previous program
// left: inodes no directory holds, with their chunks. It sweeps once, as it
// is created: an orphan that turns up later stays through everything the
// backend does until another backend is created, and a read-only backend,
// which changes nothing, doesn't sweep it either. A sweep that fails leaves
// the orphans for the next one, doesn't stop the backend mounting, and the
// host hears why. The Sweep cases find what sweep.1 left; the others make
// an orphan of their own on a fresh database.

#include <dirent.h>

#include "faults.h"
#include "stderr-lines.h"
#include "sweep.h"

using idb_test::Counts;
using idb_test::errno_text;
using idb_test::read_counts;
using idb_test::read_file;
using idb_test::write_file;

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
// Adds an inode with a chunk and no entry, under the next inode number, as
// the backend would have made it. `out` gets whether that worked.
EM_JS(void, insert_orphan, (void *call, uint32_t *out, const char *database), {
  const done = (inserted) => {
    HEAPU32[out >> 2] = inserted;
    _idb_test_finish(call);
  };
  const request = indexedDB.open(UTF8ToString(database), 1);
  request.onerror = () => done(0);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(["meta", "inodes", "chunks"], "readwrite");
    const meta = tx.objectStore("meta");
    const next = meta.get("nextIno");
    next.onsuccess = () => {
      const ino = next.result;
      const now = Date.now();
      meta.put(ino + 1, "nextIno");
      tx.objectStore("inodes").put(
        { kind: 1, mode: 0o644, size: 4, atime: now, mtime: now, ctime: now },
        ino);
      tx.objectStore("chunks").put(new ArrayBuffer(4), [ino, 0]);
    };
    tx.oncomplete = () => {
      db.close();
      done(1);
    };
    tx.onabort = () => done(0);
  };
});
// clang-format on

namespace {

class Sweep : public testing::Test {
protected:
  // What the previous program left, read before any backend has opened the
  // database, then the backend whose creation sweeps it.
  static void SetUpTestSuite() {
    left = read_counts(kSweepDatabase);
    mounted = idb_test::mount(kSweepDatabase, SWEEP_MOUNT);
  }

  void SetUp() override { ASSERT_EQ(mounted.problem, ""); }

  static inline std::optional<Counts> left;
  static inline idb_test::Mounted mounted;
};

// A kept file on a fresh database, then an orphan added behind the
// backend's back, which its creation can no longer sweep.
class SweepOnce : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    ASSERT_NO_FATAL_FAILURE(write_file(path("kept"), 0644, "kept"));
    auto out = idb_test::on_main_thread(
        "adding an orphan", [&](idb_test::MainThreadCall *call) {
          insert_orphan(call, call->out, database.c_str());
        });
    ASSERT_TRUE(out && (*out)[0]) << "could not add an orphan";
  }

  void TearDown() override {
    disarm_faults();
    IdbTest::TearDown();
  }

  // Another backend on the database, mounted beside the first.
  backend_t mount_another(std::string_view suffix, uint32_t flags = 0) {
    backend_t another = wasmfs_create_idb_backend(database.c_str(), flags);
    EXPECT_NE(another, nullptr);
    if (another) {
      EXPECT_EQ(
          wasmfs_create_directory(
              (mount_path + "-" + std::string(suffix)).c_str(), 0777, another),
          0);
    }
    return another;
  }

  // A writable backend whose sweep fails; the host hears why.
  void fail_sweep() {
    fail_delete(IDB_INODES);
    ASSERT_NE(mount_another("failed"), nullptr);
    EXPECT_FALSE(delete_failure_pending());
    const std::string log = "wasmfs-idb: sweeping " + database + " failed:";
    EXPECT_TRUE(idb_test::heard_on_stderr(log)) << "stderr never said: " << log;
  }
};

} // namespace

TEST_F(Sweep, FindsTheOrphanLeft) { EXPECT_EQ(left, kSweepLeft); }

TEST_F(Sweep, SweepsOrphansAsItIsCreated) {
  EXPECT_EQ(read_counts(kSweepDatabase), (Counts{2, 1, 1}));
  EXPECT_EQ(read_file(SWEEP_MOUNT "/kept"), "kept");
}

// Everything the backend does on its own files, creating and removing
// inodes among it, leaves an orphan that turned up later.
TEST_F(SweepOnce, KeepsALaterOrphanThroughEverythingItDoes) {
  write_file(path("more"), 0644, "more");
  EXPECT_EQ(read_file(path("more")), "more");
  EXPECT_EQ(rename(path("more").c_str(), path("moved").c_str()), 0)
      << errno_text();
  EXPECT_EQ(mkdir(path("dir").c_str(), 0755), 0) << errno_text();
  DIR *dir = opendir(mount_path.c_str());
  EXPECT_NE(dir, nullptr) << errno_text();
  while (dir && readdir(dir)) {
  }
  if (dir) {
    EXPECT_EQ(closedir(dir), 0) << errno_text();
  }
  EXPECT_EQ(unlink(path("moved").c_str()), 0) << errno_text();
  EXPECT_EQ(rmdir(path("dir").c_str()), 0) << errno_text();
  EXPECT_EQ(read_file(path("kept")), "kept");
  EXPECT_EQ(read_counts(database), (Counts{3, 1, 2}));
}

TEST_F(SweepOnce, ReadOnlyBackendLeavesTheOrphan) {
  ASSERT_NE(mount_another("ro", WASMFS_IDB_READ_ONLY), nullptr);
  EXPECT_EQ(read_file(mount_path + "-ro/kept"), "kept");
  EXPECT_EQ(read_counts(database), (Counts{3, 1, 2}));
}

TEST_F(SweepOnce, FailedSweepStillMountsAndSaysWhy) {
  ASSERT_NO_FATAL_FAILURE(fail_sweep());
  EXPECT_EQ(read_file(mount_path + "-failed/kept"), "kept");
  EXPECT_EQ(read_counts(database), (Counts{3, 1, 2}));
}

TEST_F(SweepOnce, NextBackendSweepsWhatAFailedSweepLeft) {
  ASSERT_NO_FATAL_FAILURE(fail_sweep());
  ASSERT_NE(mount_another("again"), nullptr);
  EXPECT_EQ(read_counts(database), (Counts{2, 1, 1}));
  EXPECT_EQ(read_file(mount_path + "-again/kept"), "kept");
  EXPECT_EQ(read_file(mount_path + "-failed/kept"), "kept");
  EXPECT_EQ(read_file(path("kept")), "kept");
}
