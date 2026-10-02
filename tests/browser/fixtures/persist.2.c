/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: MIT OR Apache-2.0 */

/* Reads back the value persist.1 stored in IndexedDB in an earlier run in
 * the same browser context. */

#include <emscripten.h>
#include <emscripten/eventloop.h>
#include <stdio.h>
#include <stdlib.h>

#define PERSIST_VALUE 4242

EMSCRIPTEN_KEEPALIVE void persist_loaded(int found, int value) {
  if (found)
    printf("persist.2: read %d\n", value);
  else
    printf("persist.2: nothing stored\n");
  emscripten_runtime_keepalive_pop();
  exit(found && value == PERSIST_VALUE ? 0 : 1);
}

EM_JS_DEPS(persist, "$callUserCallback");

/* clang-format reads an EM_JS body as C and splits JavaScript's =>. */
/* clang-format off */
/* IndexedDB only answers asynchronously, so the program stays alive until
 * the read completes and its callback exits. */
EM_JS(void, persist_load, (void), {
  const done = (found, value) =>
    callUserCallback(() => _persist_loaded(found, value));
  const request = indexedDB.open("ibus-web-browser-fixture", 1);
  // A database created here means persist.1's never reached this context.
  request.onupgradeneeded = () => request.result.createObjectStore("values");
  request.onerror = () => done(0, 0);
  request.onsuccess = () => {
    const db = request.result;
    const get = db.transaction("values").objectStore("values").get("persist");
    get.onsuccess = () => {
      db.close();
      const value = get.result;
      done(typeof value === "number" ? 1 : 0, value ?? 0);
    };
    get.onerror = () => done(0, 0);
  };
});
/* clang-format on */

int main(void) {
  persist_load();
  emscripten_exit_with_live_runtime();
}
