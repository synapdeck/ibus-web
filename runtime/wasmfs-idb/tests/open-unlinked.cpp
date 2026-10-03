// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// An open that resolved a file before another thread unlinked it, and
// reaches the backend after: WasmFS's open looks the name up under the
// parent's lock, drops it, and only then opens the file. Looking the file up
// through WasmFS's own paths and opening it after the unlink replays that
// order deterministically. The open must fail as if it came after the
// unlink, rather than hand out a descriptor whose every read finds nothing.

#include <memory>

#include "file.h"
#include "paths.h"

#include "idb-test.h"

using idb_test::errno_text;
using idb_test::read_file;
using idb_test::write_file;

namespace {

std::shared_ptr<wasmfs::DataFile> resolve(const std::string &path) {
  auto parsed = wasmfs::path::parseFile(path);
  if (parsed.getError()) {
    return nullptr;
  }
  return parsed.getFile()->dynCast<wasmfs::DataFile>();
}

class OpenUnlinked : public idb_test::IdbTest {};

} // namespace

TEST_F(OpenUnlinked, OpenAfterUnlinkFails) {
  write_file(path("unlinked"), 0644, "unlinked");
  auto file = resolve(path("unlinked"));
  ASSERT_TRUE(file);
  EXPECT_EQ(unlink(path("unlinked").c_str()), 0) << errno_text();
  EXPECT_EQ(file->locked().open(O_RDONLY), -ENOENT);
}

TEST_F(OpenUnlinked, OpenAfterRenameOverFails) {
  write_file(path("replaced"), 0644, "replaced");
  write_file(path("replacement"), 0644, "replacement");
  auto file = resolve(path("replaced"));
  ASSERT_TRUE(file);
  EXPECT_EQ(rename(path("replacement").c_str(), path("replaced").c_str()), 0)
      << errno_text();
  EXPECT_EQ(file->locked().open(O_RDONLY), -ENOENT);
  EXPECT_EQ(read_file(path("replaced")), "replacement");
}

// A file the open finds still there opens as usual.
TEST_F(OpenUnlinked, OpenOfALinkedFileWorks) {
  write_file(path("replaced"), 0644, "replaced");
  write_file(path("replacement"), 0644, "replacement");
  EXPECT_EQ(rename(path("replacement").c_str(), path("replaced").c_str()), 0)
      << errno_text();
  auto file = resolve(path("replaced"));
  ASSERT_TRUE(file);
  EXPECT_EQ(file->locked().open(O_RDONLY), 0);
  EXPECT_EQ(file->locked().close(), 0);
}
