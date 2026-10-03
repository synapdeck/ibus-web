// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What basic.1 leaves in the database and basic.2 expects to find, and the
// fixture both mount it with: once, for every case, which run in order on
// the one database.

#pragma once

#include <cstddef>
#include <cstdint>

#include "idb-test.h"

inline constexpr const char *kBasicDatabase = "ibus-web-test-basic";
#define BASIC_MOUNT "/data"

// A file spanning two chunks, the second partly filled, with a run that
// straddles the boundary between them overwritten.
inline constexpr mode_t kBasicFileMode = 0640;
inline constexpr size_t kBasicOverwriteLen = 20;
inline constexpr uint8_t kBasicOverwriteByte = 'Z';

inline size_t basic_file_size(unsigned chunk_size) {
  return chunk_size + chunk_size / 2;
}

inline size_t basic_overwrite_offset(unsigned chunk_size) {
  return chunk_size - kBasicOverwriteLen / 2;
}

// The file's first contents: no byte repeats at a chunk's distance, so a
// chunk stored at the wrong index shows.
inline uint8_t basic_pattern(size_t i) { return (uint8_t)(i * 7 + i / 251); }

inline std::vector<uint8_t> basic_expected(unsigned chunk_size) {
  std::vector<uint8_t> buf(basic_file_size(chunk_size));
  for (size_t i = 0; i < buf.size(); i++) {
    buf[i] = basic_pattern(i);
  }
  for (size_t i = 0; i < kBasicOverwriteLen; i++) {
    buf[basic_overwrite_offset(chunk_size) + i] = kBasicOverwriteByte;
  }
  return buf;
}

// A file whose mode and times are set explicitly.
inline constexpr mode_t kBasicStampedMode = 0604;
inline constexpr time_t kBasicStampedAtime = 1111111111;
inline constexpr time_t kBasicStampedMtime = 1234567890;

// A file written over several chunks, shrunk into the middle of one, then
// grown past its first size: what it kept holds the pattern, and the rest
// reads as zeros rather than the bytes the shrink dropped.
inline size_t basic_sized_written(unsigned chunk_size) {
  return 3 * (size_t)chunk_size + chunk_size / 2;
}

inline size_t basic_sized_kept(unsigned chunk_size) {
  return chunk_size + chunk_size / 3;
}

inline size_t basic_sized_size(unsigned chunk_size) {
  return 4 * (size_t)chunk_size + chunk_size / 4;
}

inline std::vector<uint8_t> basic_sized_expected(unsigned chunk_size) {
  const size_t kept = basic_sized_kept(chunk_size);
  std::vector<uint8_t> buf(basic_sized_size(chunk_size));
  for (size_t i = 0; i < buf.size(); i++) {
    buf[i] = i < kept ? basic_pattern(i) : 0;
  }
  return buf;
}

// A file opened with O_TRUNC over more than a chunk, then written.
inline constexpr const char *kBasicTruncatedContents = "short";

// A file renamed over one a descriptor held open.
inline constexpr const char *kBasicHeldContents = "held by a descriptor";
inline constexpr const char *kBasicUsurperContents = "usurper";

inline constexpr const char *kBasicInnerContents = "inner";
inline constexpr const char *kBasicReplacedContents = "replacement";
inline constexpr const char *kBasicLinkTarget = "dir/renamed";

// The root, dir, dir/renamed, dir/sub, dir/sub/inner, replaced, stamped,
// link, sized, truncated and usurped: every unlinked or replaced inode is
// gone once its last descriptor closed.
inline constexpr unsigned kBasicInodes = 11;

// The names basic.1 leaves in the mount.
inline constexpr unsigned kBasicRootEntries = 7;

class Basic : public testing::Test {
protected:
  static void SetUpTestSuite() {
    mounted = idb_test::mount(kBasicDatabase, BASIC_MOUNT);
  }

  void SetUp() override {
    ASSERT_EQ(mounted.problem, "");
    chunk_size = mounted.layout.chunk_size;
    // The run straddling the boundary must fit in the two chunks.
    ASSERT_GT(chunk_size, kBasicOverwriteLen);
  }

  static inline idb_test::Mounted mounted;
  unsigned chunk_size = 0;
};
