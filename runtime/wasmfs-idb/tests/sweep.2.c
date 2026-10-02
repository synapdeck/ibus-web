/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Creating a read-write backend sweeps the orphans the previous program
 * left: inodes no directory holds, with their chunks. It sweeps once, as it
 * is created: an orphan that turns up later stays through everything the
 * backend does until another backend is created, and a read-only backend,
 * which changes nothing, doesn't sweep it either. A sweep that fails leaves
 * the orphans for the next one and doesn't stop the backend mounting. */

#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>

#include "faults.h"
#include "idb-test.h"
#include "sweep.h"

#define READ_ONLY_MOUNT "/sweep-ro"
#define FAILED_MOUNT "/sweep-failed"
#define AGAIN_MOUNT "/sweep-again"

EM_JS_DEPS(sweep, "$callUserCallback,$UTF8ToString");

/* clang-format reads an EM_JS body as C and splits JavaScript's =>. */
/* clang-format off */
/* Adds an inode with a chunk and no entry, under the next inode number, as
 * the backend would have made it. */
EM_JS(void, insert_orphan, (const char *database), {
  const done = (ok) => callUserCallback(() => _sweep_orphan_inserted(ok));
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
/* clang-format on */

static void check_counts(const struct idb_test_layout *layout, unsigned inodes,
                         unsigned entries, unsigned chunks) {
  if (layout->inodes != inodes || layout->entries != entries ||
      layout->chunks != chunks) {
    printf("the database holds %u inode(s), %u entries and %u chunk(s), "
           "expected %u, %u and %u\n",
           layout->inodes, layout->entries, layout->chunks, inodes, entries,
           chunks);
    test_failures++;
  }
}

static void swept(const struct idb_test_layout *layout);
static void survived(const struct idb_test_layout *layout);
static void survived_read_only(const struct idb_test_layout *layout);
static void survived_failure(const struct idb_test_layout *layout);
static void swept_again(const struct idb_test_layout *layout);

/* Before any backend has opened the database, the orphan is there. */
static void run_test(const struct idb_test_layout *layout) {
  check_counts(layout, SWEEP_LEFT_INODES, SWEEP_LEFT_ENTRIES,
               SWEEP_LEFT_CHUNKS);
  backend_t backend = wasmfs_create_idb_backend(SWEEP_DATABASE, 0);
  CHECK(backend != NULL);
  if (!backend || wasmfs_create_directory(SWEEP_MOUNT, 0777, backend) != 0) {
    printf("mounting %s failed\n", SWEEP_MOUNT);
    finish_test("sweep.2");
  }
  read_layout_then(SWEEP_DATABASE, swept);
}

static void swept(const struct idb_test_layout *layout) {
  check_counts(layout, 2, 1, 1);
  check_contents(SWEEP_MOUNT "/kept", "kept");
  insert_orphan(SWEEP_DATABASE);
}

EMSCRIPTEN_KEEPALIVE void sweep_orphan_inserted(int ok) {
  CHECK(ok);
  /* Everything the backend does on its own files, creating and removing
   * inodes among it. */
  write_file(SWEEP_MOUNT "/more", 0644, "more");
  check_contents(SWEEP_MOUNT "/more", "more");
  CHECK(rename(SWEEP_MOUNT "/more", SWEEP_MOUNT "/moved") == 0);
  CHECK(mkdir(SWEEP_MOUNT "/dir", 0755) == 0);
  DIR *dir = opendir(SWEEP_MOUNT);
  CHECK(dir != NULL);
  while (dir && readdir(dir))
    ;
  if (dir)
    CHECK(closedir(dir) == 0);
  CHECK(unlink(SWEEP_MOUNT "/moved") == 0);
  CHECK(rmdir(SWEEP_MOUNT "/dir") == 0);
  check_contents(SWEEP_MOUNT "/kept", "kept");
  read_layout_then(SWEEP_DATABASE, survived);
}

static void survived(const struct idb_test_layout *layout) {
  check_counts(layout, 3, 1, 2);
  backend_t read_only =
      wasmfs_create_idb_backend(SWEEP_DATABASE, WASMFS_IDB_READ_ONLY);
  CHECK(read_only != NULL);
  if (read_only) {
    CHECK(wasmfs_create_directory(READ_ONLY_MOUNT, 0777, read_only) == 0);
    check_contents(READ_ONLY_MOUNT "/kept", "kept");
  }
  read_layout_then(SWEEP_DATABASE, survived_read_only);
}

static void survived_read_only(const struct idb_test_layout *layout) {
  check_counts(layout, 3, 1, 2);
  fail_delete(IDB_INODES);
  backend_t failed = wasmfs_create_idb_backend(SWEEP_DATABASE, 0);
  CHECK(failed != NULL);
  CHECK(!delete_failure_pending());
  if (failed) {
    CHECK(wasmfs_create_directory(FAILED_MOUNT, 0777, failed) == 0);
    check_contents(FAILED_MOUNT "/kept", "kept");
  }
  read_layout_then(SWEEP_DATABASE, survived_failure);
}

static void survived_failure(const struct idb_test_layout *layout) {
  check_counts(layout, 3, 1, 2);
  backend_t again = wasmfs_create_idb_backend(SWEEP_DATABASE, 0);
  CHECK(again != NULL);
  if (again)
    CHECK(wasmfs_create_directory(AGAIN_MOUNT, 0777, again) == 0);
  read_layout_then(SWEEP_DATABASE, swept_again);
}

static void swept_again(const struct idb_test_layout *layout) {
  check_counts(layout, 2, 1, 1);
  check_contents(AGAIN_MOUNT "/kept", "kept");
  check_contents(FAILED_MOUNT "/kept", "kept");
  check_contents(SWEEP_MOUNT "/kept", "kept");
  finish_test("sweep.2");
}

int main(void) {
  read_layout_then(SWEEP_DATABASE, run_test);
  emscripten_exit_with_live_runtime();
}
