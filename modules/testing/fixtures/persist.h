// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A value kept in a program's storage: IndexedDB in a browser, a file in
// the working directory under Node. IndexedDB answers through an event
// loop, which a test's pthread doesn't run while it waits, so the requests
// go to the program's main thread.

#pragma once

#include <emscripten/em_js.h>
#include <emscripten/em_macros.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>

#include <cstdio>
#include <optional>

inline constexpr int kPersistValue = 4242;

namespace persist {

enum class Op : int { kStore, kLoad, kExists };

struct Call {
  Op op;
  int value;
  // 1 if the value or database was there or the store succeeded, 0 if not,
  // -1 if IndexedDB failed.
  int found;
};

} // namespace persist

// IndexedDB's callbacks end the proxied call through this.
extern "C" EMSCRIPTEN_KEEPALIVE inline void
persist_finish(em_proxying_ctx *ctx) {
  emscripten_proxy_finish(ctx);
}

// clang-format reads an EM_JS body as C and splits JavaScript's =>.
// clang-format off
EM_JS(void, persist_idb, (em_proxying_ctx *ctx, void *call), {
  const name = "ibus-web-test-programs-fixture";
  const op = HEAP32[call >> 2];
  const finish = (value, found) => {
    HEAP32[(call >> 2) + 1] = value;
    HEAP32[(call >> 2) + 2] = found;
    _persist_finish(ctx);
  };
  if (op === 2) {
    indexedDB.databases().then(
      (databases) => finish(0, databases.some((database) => database.name === name) ? 1 : 0),
      () => finish(0, -1));
    return;
  }
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("values");
  request.onerror = () => finish(0, -1);
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction("values", op === 0 ? "readwrite" : "readonly");
    const store = transaction.objectStore("values");
    if (op === 0) {
      store.put(HEAP32[(call >> 2) + 1], "persist");
      transaction.oncomplete = () => {
        db.close();
        finish(0, 1);
      };
    } else {
      const get = store.get("persist");
      transaction.oncomplete = () => {
        db.close();
        const value = get.result;
        finish(typeof value === "number" ? value : 0, typeof value === "number" ? 1 : 0);
      };
    }
    transaction.onabort = () => finish(0, -1);
  };
});
// Node has no IndexedDB; a browser's Workers do, a pthread's among them.
EM_JS(int, persist_has_idb, (void), { return !!globalThis.indexedDB; });
// clang-format on

namespace persist {

inline constexpr const char *kFile = "persist.value";

inline void idb(Call &call) {
  emscripten_proxy_sync_with_ctx(
      emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(),
      [](em_proxying_ctx *ctx, void *arg) {
        persist_idb(ctx, static_cast<Call *>(arg));
      },
      &call);
}

inline bool store(int value) {
  if (persist_has_idb()) {
    Call call{Op::kStore, value, 0};
    idb(call);
    return call.found == 1;
  }
  std::FILE *file = std::fopen(kFile, "w");
  if (file == nullptr)
    return false;
  const bool written = std::fprintf(file, "%d\n", value) > 0;
  return std::fclose(file) == 0 && written;
}

inline std::optional<int> load() {
  if (persist_has_idb()) {
    Call call{Op::kLoad, 0, 0};
    idb(call);
    return call.found == 1 ? std::optional<int>(call.value) : std::nullopt;
  }
  std::FILE *file = std::fopen(kFile, "r");
  if (file == nullptr)
    return std::nullopt;
  int value;
  const bool read = std::fscanf(file, "%d", &value) == 1;
  std::fclose(file);
  return read ? std::optional<int>(value) : std::nullopt;
}

// Whether anything is stored at all: the database, or the file.
inline bool exists() {
  if (persist_has_idb()) {
    Call call{Op::kExists, 0, 0};
    idb(call);
    return call.found != 0;
  }
  std::FILE *file = std::fopen(kFile, "r");
  if (file == nullptr)
    return false;
  std::fclose(file);
  return true;
}

} // namespace persist
