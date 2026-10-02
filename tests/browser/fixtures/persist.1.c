/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Stores a value in IndexedDB for persist.2, which runs next in the same
 * browser context. */

#include <emscripten.h>
#include <emscripten/eventloop.h>
#include <stdio.h>
#include <stdlib.h>

#define PERSIST_VALUE 4242

EMSCRIPTEN_KEEPALIVE void persist_done(int ok) {
  printf("persist.1: %s\n", ok ? "stored" : "failed to store");
  emscripten_runtime_keepalive_pop();
  exit(ok ? 0 : 1);
}

EM_JS_DEPS(persist, "$callUserCallback");

/* clang-format reads an EM_JS body as C and splits JavaScript's =>. */
/* clang-format off */
/* IndexedDB only answers asynchronously, so the program stays alive until
 * the transaction completes and its callback exits. */
EM_JS(void, persist_store, (int value), {
  const done = (ok) => callUserCallback(() => _persist_done(ok));
  const request = indexedDB.open("ibus-web-browser-fixture", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("values");
  request.onerror = () => done(0);
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction("values", "readwrite");
    transaction.objectStore("values").put(value, "persist");
    transaction.oncomplete = () => {
      db.close();
      done(1);
    };
    transaction.onabort = () => done(0);
  };
});
/* clang-format on */

int main(void) {
  persist_store(PERSIST_VALUE);
  emscripten_exit_with_live_runtime();
}
