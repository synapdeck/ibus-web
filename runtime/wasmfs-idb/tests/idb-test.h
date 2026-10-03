// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the backend's test programs share: a fixture that mounts a database
// of the test's own, reads of a database's records made directly, and
// checks on files. IndexedDB answers only through an event loop, which a
// test's pthread doesn't run while it waits, so whatever needs its answer
// runs on the program's main thread while the test waits for it.

#pragma once

#include <emscripten.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <gtest/gtest.h>
#include <ibus-web/wasmfs-idb.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <optional>
#include <ostream>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

// The main thread's JavaScript ends a call proxied to it through this.
extern "C" EMSCRIPTEN_KEEPALIVE inline void
idb_test_finish(em_proxying_ctx *ctx) {
  emscripten_proxy_finish(ctx);
}

EM_JS_DEPS(idb_test, "$UTF8ToString");

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
// A connection of its own, opened at the backend's version, reads the chunk
// size the database was created with, counts its records and hashes them
// all (FNV-1a over each store's keys and values, and the bytes of each
// chunk). `out` gets whether that worked, then those five numbers.
EM_JS(void, idb_test_read_layout, (em_proxying_ctx *ctx, const char *database, uint32_t *out), {
  const done = (...values) => {
    values.forEach((value, i) => (HEAPU32[(out >> 2) + i] = value));
    _idb_test_finish(ctx);
  };
  const failed = () => done(0);
  const request = indexedDB.open(UTF8ToString(database), 1);
  request.onerror = failed;
  request.onsuccess = () => {
    const db = request.result;
    const names = ["meta", "inodes", "entries", "chunks"];
    const tx = db.transaction(names);
    const stores = names.map((name) => ({
      keys: tx.objectStore(name).getAllKeys(),
      values: tx.objectStore(name).getAll(),
    }));
    tx.oncomplete = () => {
      db.close();
      const [meta, inodes, entries, chunks] =
        stores.map(({ keys, values }) => ({
          keys: keys.result,
          values: values.result,
        }));
      let digest = 0x811c9dc5;
      const hash = (bytes) => {
        for (const byte of bytes) digest = Math.imul(digest ^ byte, 0x01000193);
      };
      const encoder = new TextEncoder();
      for (const store of [meta, inodes, entries])
        hash(encoder.encode(JSON.stringify(store)));
      hash(encoder.encode(JSON.stringify(chunks.keys)));
      for (const chunk of chunks.values) hash(new Uint8Array(chunk));
      done(1, meta.values[meta.keys.indexOf("chunkSize")], inodes.keys.length,
           entries.keys.length, chunks.keys.length, digest >>> 0);
    };
    tx.onabort = failed;
  };
});

// `out` gets 1 once the database is gone, 2 if a connection that stays
// open blocks deleting it, and 0 if deleting it fails.
EM_JS(void, idb_test_delete_database, (em_proxying_ctx *ctx, const char *database, int *out), {
  let settled = false;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    HEAP32[out >> 2] = outcome;
    _idb_test_finish(ctx);
  };
  const request = indexedDB.deleteDatabase(UTF8ToString(database));
  request.onsuccess = () => settle(1);
  request.onerror = () => settle(0);
  request.onblocked = () => settle(2);
});
// clang-format on

namespace idb_test {

// Runs `start` on the program's main thread, then waits until the
// JavaScript it started calls _idb_test_finish with the context it was
// given.
inline void on_main_thread(std::function<void(em_proxying_ctx *)> start) {
  const int proxied = emscripten_proxy_sync_with_ctx(
      emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
      [](em_proxying_ctx *ctx, void *arg) {
        (*static_cast<std::function<void(em_proxying_ctx *)> *>(arg))(ctx);
      },
      &start);
  if (!proxied) {
    ADD_FAILURE() << "could not reach the main thread";
  }
}

// What a database holds, as the backend's own records show it.
struct Layout {
  unsigned chunk_size;
  unsigned inodes;
  unsigned entries;
  unsigned chunks;
  // A hash of every record, keys and values, in every store.
  unsigned digest;

  friend bool operator==(const Layout &a, const Layout &b) {
    return a.chunk_size == b.chunk_size && a.inodes == b.inodes &&
           a.entries == b.entries && a.chunks == b.chunks &&
           a.digest == b.digest;
  }
  friend std::ostream &operator<<(std::ostream &os, const Layout &layout) {
    return os << layout.inodes << " inode(s), " << layout.entries
              << " entries, " << layout.chunks << " chunk(s), digest "
              << std::hex << layout.digest << std::dec;
  }
};

// What `database` holds, or nothing if it can't be read.
inline std::optional<Layout> read_layout(const std::string &database) {
  uint32_t out[6] = {};
  on_main_thread([&](em_proxying_ctx *ctx) {
    idb_test_read_layout(ctx, database.c_str(), out);
  });
  if (!out[0]) {
    return std::nullopt;
  }
  return Layout{out[1], out[2], out[3], out[4], out[5]};
}

// The inode, entry and chunk records a database holds.
struct Counts {
  unsigned inodes;
  unsigned entries;
  unsigned chunks;

  friend bool operator==(const Counts &a, const Counts &b) {
    return a.inodes == b.inodes && a.entries == b.entries &&
           a.chunks == b.chunks;
  }
  friend std::ostream &operator<<(std::ostream &os, const Counts &counts) {
    return os << counts.inodes << " inode(s), " << counts.entries
              << " entries and " << counts.chunks << " chunk(s)";
  }
};

inline std::optional<Counts> read_counts(const std::string &database) {
  auto layout = read_layout(database);
  if (!layout) {
    return std::nullopt;
  }
  return Counts{layout->inodes, layout->entries, layout->chunks};
}

enum class Deleted { kFailed = 0, kDeleted = 1, kBlocked = 2 };

inline std::ostream &operator<<(std::ostream &os, Deleted deleted) {
  switch (deleted) {
  case Deleted::kFailed:
    return os << "failed";
  case Deleted::kDeleted:
    return os << "deleted";
  case Deleted::kBlocked:
    return os << "blocked by a connection left open";
  }
  return os << static_cast<int>(deleted);
}

inline Deleted delete_database(const std::string &database) {
  int out = 0;
  on_main_thread([&](em_proxying_ctx *ctx) {
    idb_test_delete_database(ctx, database.c_str(), &out);
  });
  return static_cast<Deleted>(out);
}

inline std::string errno_text() { return std::strerror(errno); }

// Whether a call failed with the expected errno.
#define EXPECT_ERRNO(call, expected)                                           \
  do {                                                                         \
    errno = 0;                                                                 \
    const long expect_errno_result_ = static_cast<long>(call);                 \
    const int expect_errno_ = errno;                                           \
    EXPECT_EQ(expect_errno_result_, -1) << #call;                              \
    EXPECT_EQ(expect_errno_, (expected))                                       \
        << #call << " failed with " << std::strerror(expect_errno_)            \
        << ", not " << std::strerror(expected);                                \
  } while (0)

// A short file's contents, read through a descriptor of its own.
inline std::string read_file(const std::string &path) {
  char buf[64] = {};
  const int fd = open(path.c_str(), O_RDONLY);
  EXPECT_GE(fd, 0) << path << ": " << errno_text();
  if (fd < 0) {
    return {};
  }
  const ssize_t len = read(fd, buf, sizeof buf - 1);
  EXPECT_GE(len, 0) << path << ": " << errno_text();
  EXPECT_EQ(close(fd), 0) << path << ": " << errno_text();
  return std::string(buf, len > 0 ? len : 0);
}

// Creates a file that must not exist yet, holding `contents`.
inline void write_file(const std::string &path, mode_t mode,
                       std::string_view contents) {
  const int fd = open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY, mode);
  ASSERT_GE(fd, 0) << path << ": " << errno_text();
  EXPECT_EQ(write(fd, contents.data(), contents.size()),
            static_cast<ssize_t>(contents.size()))
      << path << ": " << errno_text();
  EXPECT_EQ(close(fd), 0) << path << ": " << errno_text();
}

// A backend mounted on a database, and what the database held then.
struct Mounted {
  backend_t backend = nullptr;
  Layout layout{};
  // Why mounting failed, if it did.
  std::string problem;
};

inline Mounted mount(const std::string &database, const std::string &path,
                     uint32_t flags = 0) {
  Mounted mounted;
  mounted.backend = wasmfs_create_idb_backend(database.c_str(), flags);
  if (!mounted.backend) {
    mounted.problem = "wasmfs_create_idb_backend(\"" + database + "\") failed";
    return mounted;
  }
  const int err = wasmfs_create_directory(path.c_str(), 0777, mounted.backend);
  if (err != 0) {
    mounted.problem = "mounting " + path + " failed: " + std::strerror(-err);
    return mounted;
  }
  auto layout = read_layout(database);
  if (!layout) {
    mounted.problem = "could not read " + database + "'s layout";
    return mounted;
  }
  mounted.layout = *layout;
  return mounted;
}

// A fresh database of the test's own, named after it and mounted at a
// directory named after it, deleted after the test, which closes every
// backend's connection to it. A backend's thread outlives the test: WasmFS
// keeps every backend it was given.
class IdbTest : public testing::Test {
protected:
  void SetUp() override {
    const auto *info = testing::UnitTest::GetInstance()->current_test_info();
    const std::string name =
        std::string(info->test_suite_name()) + "." + info->name();
    database = "ibus-web-test-" + name;
    databases.push_back(database);
    mount_path = "/" + name;
    Mounted mounted = mount(database, mount_path);
    backend = mounted.backend;
    layout = mounted.layout;
    ASSERT_EQ(mounted.problem, "");
    ASSERT_EQ(layout.inodes, 1u) << "a fresh database holds its root alone";
  }

  void TearDown() override {
    for (const auto &name : databases) {
      EXPECT_EQ(delete_database(name), Deleted::kDeleted) << name;
    }
  }

  // A path in the mounted database.
  std::string path(std::string_view name) const {
    return mount_path + "/" + std::string(name);
  }

  // Another database of the test's own, deleted after it as well.
  std::string other_database(std::string_view suffix) {
    databases.push_back(database + "-" + std::string(suffix));
    return databases.back();
  }

  std::string database;
  std::string mount_path;
  backend_t backend = nullptr;
  // What the database held once mounted.
  Layout layout{};

private:
  std::vector<std::string> databases;
};

} // namespace idb_test
