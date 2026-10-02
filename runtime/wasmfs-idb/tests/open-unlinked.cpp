/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* An open that resolved a file before another thread unlinked it, and
 * reaches the backend after: WasmFS's open looks the name up under the
 * parent's lock, drops it, and only then opens the file. Looking the file up
 * through WasmFS's own paths and opening it after the unlink replays that
 * order deterministically. The open must fail as if it came after the
 * unlink, rather than hand out a descriptor whose every read finds nothing. */

#include <cerrno>
#include <fcntl.h>
#include <memory>
#include <unistd.h>

#include "file.h"
#include "paths.h"

#include "idb-test.h"

#define DATABASE "ibus-web-test-open-unlinked"
#define MOUNT "/race"

static std::shared_ptr<wasmfs::DataFile> resolve(const char *path) {
  auto parsed = wasmfs::path::parseFile(path);
  if (parsed.getError()) {
    return nullptr;
  }
  return parsed.getFile()->dynCast<wasmfs::DataFile>();
}

static void run_test(const struct idb_test_layout *layout) {
  CHECK(layout->inodes == 1);

  write_file(MOUNT "/unlinked", 0644, "unlinked");
  auto file = resolve(MOUNT "/unlinked");
  CHECK(file);
  CHECK(unlink(MOUNT "/unlinked") == 0);
  if (file) {
    CHECK(file->locked().open(O_RDONLY) == -ENOENT);
  }

  write_file(MOUNT "/replaced", 0644, "replaced");
  write_file(MOUNT "/replacement", 0644, "replacement");
  file = resolve(MOUNT "/replaced");
  CHECK(file);
  CHECK(rename(MOUNT "/replacement", MOUNT "/replaced") == 0);
  if (file) {
    CHECK(file->locked().open(O_RDONLY) == -ENOENT);
  }
  check_contents(MOUNT "/replaced", "replacement");

  /* A file the open finds still there opens as usual. */
  file = resolve(MOUNT "/replaced");
  CHECK(file);
  if (file) {
    CHECK(file->locked().open(O_RDONLY) == 0);
    CHECK(file->locked().close() == 0);
  }

  finish_test("open-unlinked");
}

int main() { start_test(DATABASE, MOUNT); }
