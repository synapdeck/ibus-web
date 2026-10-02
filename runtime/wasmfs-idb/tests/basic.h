/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* What basic.1 leaves in the database and basic.2 expects to find. */

#pragma once

#include <stddef.h>
#include <stdint.h>

#define BASIC_DATABASE "ibus-web-test-basic"
#define BASIC_MOUNT "/data"

/* A file spanning two chunks, the second partly filled, with a run that
 * straddles the boundary between them overwritten. */
#define BASIC_FILE_MODE 0640
#define BASIC_OVERWRITE_LEN 20
#define BASIC_OVERWRITE_BYTE 'Z'

static size_t basic_file_size(unsigned chunk_size) {
  return chunk_size + chunk_size / 2;
}

static size_t basic_overwrite_offset(unsigned chunk_size) {
  return chunk_size - BASIC_OVERWRITE_LEN / 2;
}

/* The file's first contents: no byte repeats at a chunk's distance, so a
 * chunk stored at the wrong index shows. */
static uint8_t basic_pattern(size_t i) { return (uint8_t)(i * 7 + i / 251); }

static void basic_expected(uint8_t *buf, unsigned chunk_size) {
  size_t size = basic_file_size(chunk_size);
  for (size_t i = 0; i < size; i++)
    buf[i] = basic_pattern(i);
  for (size_t i = 0; i < BASIC_OVERWRITE_LEN; i++)
    buf[basic_overwrite_offset(chunk_size) + i] = BASIC_OVERWRITE_BYTE;
}

/* A file whose mode and times are set explicitly. */
#define BASIC_STAMPED_MODE 0604
#define BASIC_STAMPED_ATIME 1111111111
#define BASIC_STAMPED_MTIME 1234567890

/* A file written over several chunks, shrunk into the middle of one, then
 * grown past its first size: what it kept holds the pattern, and the rest
 * reads as zeros rather than the bytes the shrink dropped. */
static inline size_t basic_sized_written(unsigned chunk_size) {
  return 3 * (size_t)chunk_size + chunk_size / 2;
}

static size_t basic_sized_kept(unsigned chunk_size) {
  return chunk_size + chunk_size / 3;
}

static size_t basic_sized_size(unsigned chunk_size) {
  return 4 * (size_t)chunk_size + chunk_size / 4;
}

static void basic_sized_expected(uint8_t *buf, unsigned chunk_size) {
  size_t kept = basic_sized_kept(chunk_size);
  size_t size = basic_sized_size(chunk_size);
  for (size_t i = 0; i < size; i++)
    buf[i] = i < kept ? basic_pattern(i) : 0;
}

/* A file opened with O_TRUNC over more than a chunk, then written. */
#define BASIC_TRUNCATED_CONTENTS "short"

/* A file renamed over one a descriptor held open. */
#define BASIC_HELD_CONTENTS "held by a descriptor"
#define BASIC_USURPER_CONTENTS "usurper"

#define BASIC_INNER_CONTENTS "inner"
#define BASIC_REPLACED_CONTENTS "replacement"
#define BASIC_LINK_TARGET "dir/renamed"

/* The root, dir, dir/renamed, dir/sub, dir/sub/inner, replaced, stamped,
 * link, sized, truncated and usurped: every unlinked or replaced inode is
 * gone once its last descriptor closed. */
#define BASIC_INODES 11

/* The names basic.1 leaves in the mount. */
#define BASIC_ROOT_ENTRIES 7
