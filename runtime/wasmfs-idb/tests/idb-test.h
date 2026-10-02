/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* What the backend's test programs share: checks that count failures, and a
 * start that mounts the backend and reads its database's layout directly. */

#pragma once

#include <emscripten.h>
#include <emscripten/eventloop.h>
#include <errno.h>
#include <fcntl.h>
#include <ibus-web/wasmfs-idb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int test_failures;

#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      printf("%s:%d: CHECK failed: %s (errno %d: %s)\n", __FILE__, __LINE__,   \
             #cond, errno, strerror(errno));                                   \
      test_failures++;                                                         \
    }                                                                          \
  } while (0)

/* Whether a call failed with the expected errno. */
#define CHECK_ERRNO(call, expected)                                            \
  do {                                                                         \
    errno = 0;                                                                 \
    int check_result_ = (int)(call);                                           \
    if (check_result_ != -1 || errno != (expected)) {                          \
      printf("%s:%d: CHECK failed: %s returned %d, errno %d (%s), "            \
             "expected errno %d\n",                                            \
             __FILE__, __LINE__, #call, check_result_, errno, strerror(errno), \
             expected);                                                        \
      test_failures++;                                                         \
    }                                                                          \
  } while (0)

/* Whether a short file holds exactly `expected`. */
static void check_contents(const char *path, const char *expected) {
  char buf[64] = {0};
  int fd = open(path, O_RDONLY);
  CHECK(fd >= 0);
  CHECK(read(fd, buf, sizeof buf - 1) == (ssize_t)strlen(expected));
  CHECK(strcmp(buf, expected) == 0);
  CHECK(close(fd) == 0);
}

static inline void write_file(const char *path, mode_t mode,
                              const char *contents) {
  int fd = open(path, O_CREAT | O_EXCL | O_WRONLY, mode);
  CHECK(fd >= 0);
  size_t len = strlen(contents);
  CHECK(write(fd, contents, len) == (ssize_t)len);
  CHECK(close(fd) == 0);
}

/* What the database holds as the backend's own records show it. */
struct idb_test_layout {
  unsigned chunk_size;
  unsigned inodes;
};

/* The test proper, run once the layout has been read. */
static void run_test(const struct idb_test_layout *layout);

static void finish_test(const char *name) {
  printf("%s: %s, %d failure(s)\n", name, test_failures ? "FAIL" : "ok",
         test_failures);
  emscripten_runtime_keepalive_pop();
  exit(test_failures ? 1 : 0);
}

/* The layout's reader calls this by its C name. */
#ifdef __cplusplus
extern "C" {
#endif
EMSCRIPTEN_KEEPALIVE void idb_test_layout_read(int ok, unsigned chunk_size,
                                               unsigned inodes) {
  if (!ok) {
    printf("could not read the database's layout\n");
    exit(1);
  }
  struct idb_test_layout layout = {chunk_size, inodes};
  run_test(&layout);
}
#ifdef __cplusplus
}
#endif

EM_JS_DEPS(idb_test, "$callUserCallback,$UTF8ToString");

/* clang-format reads an EM_JS body as C and splits JavaScript's =>. */
/* clang-format off */
/* A second connection, opened at the backend's version, reads the chunk size
 * the database was created with and counts its inodes. IndexedDB only
 * answers asynchronously, so the test continues in a callback. */
EM_JS(void, idb_test_read_layout, (const char *database), {
  const done = (ok, chunkSize, inodes) =>
    callUserCallback(() => _idb_test_layout_read(ok, chunkSize, inodes));
  const request = indexedDB.open(UTF8ToString(database), 1);
  request.onerror = () => done(0, 0, 0);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction(["meta", "inodes"]);
    const chunkSize = tx.objectStore("meta").get("chunkSize");
    const inodes = tx.objectStore("inodes").count();
    tx.oncomplete = () => {
      db.close();
      done(1, chunkSize.result, inodes.result);
    };
    tx.onabort = () => done(0, 0, 0);
  };
});
/* clang-format on */

/* Mounts the database at `mount`, then reads its layout and runs the test. */
static void start_test(const char *database, const char *mount) {
  backend_t backend = wasmfs_create_idb_backend(database, 0);
  if (!backend) {
    printf("wasmfs_create_idb_backend(\"%s\") failed\n", database);
    exit(1);
  }
  int err = wasmfs_create_directory(mount, 0777, backend);
  if (err != 0) {
    printf("mounting %s failed: %s\n", mount, strerror(-err));
    exit(1);
  }
  idb_test_read_layout(database);
  emscripten_exit_with_live_runtime();
}
