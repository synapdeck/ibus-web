// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Creating a read-write backend sweeps the orphans the previous program
// left: inodes no directory holds, with their chunks. It sweeps once, as it
// is created: an orphan that turns up later stays through everything the
// backend does until another backend is created, and a read-only backend,
// which changes nothing, doesn't sweep it either. A sweep that fails leaves
// the orphans for the next one, doesn't stop the backend mounting, and the
// host hears why. Each case builds on what those before it left.

#include <dirent.h>

#include "faults.h"
#include "stderr-lines.h"
#include "sweep.h"

using idb_test::Counts;
using idb_test::errno_text;
using idb_test::read_counts;
using idb_test::read_file;
using idb_test::write_file;

#define READ_ONLY_MOUNT "/sweep-ro"
#define FAILED_MOUNT "/sweep-failed"
#define AGAIN_MOUNT "/sweep-again"

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
// Adds an inode with a chunk and no entry, under the next inode number, as
// the backend would have made it. `ok` gets whether that worked.
EM_JS(void, insert_orphan, (em_proxying_ctx *ctx, const char *database, int *ok), {
  const done = (inserted) => {
    HEAP32[ok >> 2] = inserted;
    _idb_test_finish(ctx);
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

  void TearDown() override { disarm_faults(); }

  static inline std::optional<Counts> left;
  static inline idb_test::Mounted mounted;
};

} // namespace

TEST_F(Sweep, FindsTheOrphanLeft) { EXPECT_EQ(left, kSweepLeft); }

TEST_F(Sweep, SweepsOrphansAsItIsCreated) {
  EXPECT_EQ(read_counts(kSweepDatabase), (Counts{2, 1, 1}));
  EXPECT_EQ(read_file(SWEEP_MOUNT "/kept"), "kept");
}

// Everything the backend does on its own files, creating and removing
// inodes among it, leaves an orphan that turned up later.
TEST_F(Sweep, KeepsALaterOrphanThroughEverythingItDoes) {
  int inserted = 0;
  idb_test::on_main_thread([&](em_proxying_ctx *ctx) {
    insert_orphan(ctx, kSweepDatabase, &inserted);
  });
  ASSERT_TRUE(inserted);
  write_file(SWEEP_MOUNT "/more", 0644, "more");
  EXPECT_EQ(read_file(SWEEP_MOUNT "/more"), "more");
  EXPECT_EQ(rename(SWEEP_MOUNT "/more", SWEEP_MOUNT "/moved"), 0)
      << errno_text();
  EXPECT_EQ(mkdir(SWEEP_MOUNT "/dir", 0755), 0) << errno_text();
  DIR *dir = opendir(SWEEP_MOUNT);
  EXPECT_NE(dir, nullptr) << errno_text();
  while (dir && readdir(dir)) {
  }
  if (dir) {
    EXPECT_EQ(closedir(dir), 0) << errno_text();
  }
  EXPECT_EQ(unlink(SWEEP_MOUNT "/moved"), 0) << errno_text();
  EXPECT_EQ(rmdir(SWEEP_MOUNT "/dir"), 0) << errno_text();
  EXPECT_EQ(read_file(SWEEP_MOUNT "/kept"), "kept");
  EXPECT_EQ(read_counts(kSweepDatabase), (Counts{3, 1, 2}));
}

TEST_F(Sweep, ReadOnlyBackendLeavesTheOrphan) {
  backend_t read_only =
      wasmfs_create_idb_backend(kSweepDatabase, WASMFS_IDB_READ_ONLY);
  ASSERT_NE(read_only, nullptr);
  ASSERT_EQ(wasmfs_create_directory(READ_ONLY_MOUNT, 0777, read_only), 0);
  EXPECT_EQ(read_file(READ_ONLY_MOUNT "/kept"), "kept");
  EXPECT_EQ(read_counts(kSweepDatabase), (Counts{3, 1, 2}));
}

TEST_F(Sweep, FailedSweepStillMountsAndSaysWhy) {
  fail_delete(IDB_INODES);
  backend_t failed = wasmfs_create_idb_backend(kSweepDatabase, 0);
  ASSERT_NE(failed, nullptr);
  EXPECT_FALSE(delete_failure_pending());
  ASSERT_EQ(wasmfs_create_directory(FAILED_MOUNT, 0777, failed), 0);
  EXPECT_EQ(read_file(FAILED_MOUNT "/kept"), "kept");
  const std::string log =
      std::string("wasmfs-idb: sweeping ") + kSweepDatabase + " failed:";
  EXPECT_TRUE(idb_test::heard_on_stderr(log)) << "stderr never said: " << log;
  EXPECT_EQ(read_counts(kSweepDatabase), (Counts{3, 1, 2}));
}

TEST_F(Sweep, NextBackendSweepsWhatAFailedSweepLeft) {
  backend_t again = wasmfs_create_idb_backend(kSweepDatabase, 0);
  ASSERT_NE(again, nullptr);
  ASSERT_EQ(wasmfs_create_directory(AGAIN_MOUNT, 0777, again), 0);
  EXPECT_EQ(read_counts(kSweepDatabase), (Counts{2, 1, 1}));
  EXPECT_EQ(read_file(AGAIN_MOUNT "/kept"), "kept");
  EXPECT_EQ(read_file(FAILED_MOUNT "/kept"), "kept");
  EXPECT_EQ(read_file(SWEEP_MOUNT "/kept"), "kept");
}
