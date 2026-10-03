// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Reads and writes touch only the chunks they cover: a read fetches the
// chunks under its range, and a write fetches only the chunks it covers in
// part and must keep the rest of.

#include "chunk-counts.h"
#include "idb-test.h"

using idb_test::errno_text;

namespace {

// Enough chunks that touching every one of them can't pass for touching a
// few.
constexpr size_t kChunks = 64;

uint8_t pattern(size_t i) { return (uint8_t)(i * 7 + i / 251); }

// A file of kChunks chunks of the pattern, open for reading and writing.
class Lazy : public idb_test::IdbTest {
protected:
  void SetUp() override {
    ASSERT_NO_FATAL_FAILURE(IdbTest::SetUp());
    chunk = layout.chunk_size;
    ASSERT_GE(chunk, 4u);
    size = kChunks * chunk;
    data.resize(size);
    back.resize(chunk);
    for (size_t i = 0; i < size; i++) {
      data[i] = pattern(i);
    }
    mid = 37 * chunk + chunk / 2;
    boundary = 20 * chunk;
  }

  void TearDown() override {
    if (fd >= 0) {
      EXPECT_EQ(close(fd), 0) << errno_text();
    }
    IdbTest::TearDown();
  }

  // Creates the file, as a single write.
  void write_whole() {
    fd = open(path("file").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
    ASSERT_GE(fd, 0) << errno_text();
    ASSERT_EQ(write(fd, data.data(), size), (ssize_t)size) << errno_text();
  }

  // Whether every write landed where it should.
  void expect_contents() {
    for (size_t index = 0; index < kChunks; index++) {
      EXPECT_EQ(pread(fd, back.data(), chunk, index * chunk), (ssize_t)chunk)
          << errno_text();
      EXPECT_EQ(memcmp(back.data(), data.data() + index * chunk, chunk), 0)
          << "chunk " << index << " differs";
    }
  }

  size_t chunk = 0;
  size_t size = 0;
  size_t mid = 0;
  size_t boundary = 0;
  std::vector<uint8_t> data;
  std::vector<uint8_t> back;
  int fd = -1;
  // What the last counted call returned.
  ssize_t result = 0;
};

} // namespace

// A new file has nothing to keep.
TEST_F(Lazy, NewFileWriteReadsNothing) {
  EXPECT_EQ(chunk_records([&] { write_whole(); }), (ChunkCounts{0, kChunks}));
}

TEST_F(Lazy, ReadFetchesOnlyTheChunksUnderIt) {
  ASSERT_NO_FATAL_FAILURE(write_whole());
  EXPECT_EQ(chunk_records([&] { result = pread(fd, back.data(), 1, mid); }),
            (ChunkCounts{1, 0}));
  EXPECT_EQ(result, 1) << errno_text();
  EXPECT_EQ(back[0], data[mid]);
  // Two bytes either side of a boundary.
  EXPECT_EQ(
      chunk_records([&] { result = pread(fd, back.data(), 2, boundary - 1); }),
      (ChunkCounts{2, 0}));
  EXPECT_EQ(result, 2) << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data() + boundary - 1, 2), 0);
  EXPECT_EQ(
      chunk_records([&] { result = pread(fd, back.data(), chunk, 9 * chunk); }),
      (ChunkCounts{1, 0}));
  EXPECT_EQ(result, (ssize_t)chunk) << errno_text();
  EXPECT_EQ(memcmp(back.data(), data.data() + 9 * chunk, chunk), 0);
}

// A whole aligned chunk replaces what was there without reading it.
TEST_F(Lazy, WholeChunkWriteReadsNothing) {
  ASSERT_NO_FATAL_FAILURE(write_whole());
  memset(data.data() + 5 * chunk, 'a', chunk);
  EXPECT_EQ(chunk_records([&] {
              result = pwrite(fd, data.data() + 5 * chunk, chunk, 5 * chunk);
            }),
            (ChunkCounts{0, 1}));
  EXPECT_EQ(result, (ssize_t)chunk) << errno_text();
  expect_contents();
}

// One byte in the middle of a chunk keeps the rest of it.
TEST_F(Lazy, PartialWriteReadsTheChunkItKeeps) {
  ASSERT_NO_FATAL_FAILURE(write_whole());
  data[mid] = 'b';
  EXPECT_EQ(
      chunk_records([&] { result = pwrite(fd, data.data() + mid, 1, mid); }),
      (ChunkCounts{1, 1}));
  EXPECT_EQ(result, 1) << errno_text();
  expect_contents();
}

// Across a boundary, each side is a partial chunk.
TEST_F(Lazy, WriteAcrossABoundaryReadsBothSides) {
  ASSERT_NO_FATAL_FAILURE(write_whole());
  memset(data.data() + boundary - 1, 'c', 2);
  EXPECT_EQ(chunk_records([&] {
              result = pwrite(fd, data.data() + boundary - 1, 2, boundary - 1);
            }),
            (ChunkCounts{2, 2}));
  EXPECT_EQ(result, 2) << errno_text();
  expect_contents();
}

// Two partial edges and a whole chunk between them.
TEST_F(Lazy, WriteReadsOnlyItsPartialEdges) {
  ASSERT_NO_FATAL_FAILURE(write_whole());
  const size_t from = 40 * chunk + chunk / 2;
  memset(data.data() + from, 'd', 2 * chunk);
  EXPECT_EQ(chunk_records([&] {
              result = pwrite(fd, data.data() + from, 2 * chunk, from);
            }),
            (ChunkCounts{2, 3}));
  EXPECT_EQ(result, (ssize_t)(2 * chunk)) << errno_text();
  expect_contents();
}

TEST_F(Lazy, AppendReadsOnlyWhatTheFileHolds) {
  ASSERT_NO_FATAL_FAILURE(write_whole());
  // Past the end, starting on a boundary, there is nothing to keep.
  const uint8_t tail[2] = {'e', 'f'};
  EXPECT_EQ(chunk_records([&] { result = pwrite(fd, tail, 2, size); }),
            (ChunkCounts{0, 1}));
  EXPECT_EQ(result, 2) << errno_text();
  // The new last chunk is partial, but holds nothing past the file's end.
  EXPECT_EQ(chunk_records([&] { result = pwrite(fd, tail, 2, size + 2); }),
            (ChunkCounts{1, 1}));
  EXPECT_EQ(result, 2) << errno_text();
  expect_contents();
  EXPECT_EQ(pread(fd, back.data(), chunk, size), 4) << errno_text();
  EXPECT_EQ(memcmp(back.data(), "efef", 4), 0);
}

// A write far past the end stores its own chunk and none of the gap, which
// reads as zeros without a record.
TEST_F(Lazy, SparseWriteStoresOnlyItsOwnChunk) {
  fd = open(path("sparse").c_str(), O_CREAT | O_EXCL | O_RDWR, 0644);
  ASSERT_GE(fd, 0) << errno_text();
  const uint8_t tail[1] = {'e'};
  const size_t far = 10 * chunk + 1;
  EXPECT_EQ(chunk_records([&] { result = pwrite(fd, tail, 1, far); }),
            (ChunkCounts{0, 1}));
  EXPECT_EQ(result, 1) << errno_text();
  memset(back.data(), 'x', chunk);
  EXPECT_EQ(
      chunk_records([&] { result = pread(fd, back.data(), chunk, 4 * chunk); }),
      (ChunkCounts{0, 0}));
  EXPECT_EQ(result, (ssize_t)chunk) << errno_text();
  EXPECT_EQ(back, std::vector<uint8_t>(chunk, 0));
  EXPECT_EQ(chunk_records([&] { result = pread(fd, back.data(), 2, far - 1); }),
            (ChunkCounts{1, 0}));
  EXPECT_EQ(result, 2) << errno_text();
  EXPECT_EQ(back[0], 0);
  EXPECT_EQ(back[1], tail[0]);
}
