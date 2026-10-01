/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#pragma once

#include <glib.h>
#include <stdint.h>

G_BEGIN_DECLS

/* Marks the runtime's API. The library is built with every other symbol
 * hidden, so only these reach a main module's exports and its side
 * modules. */
#define IBUSWEB_API __attribute__((visibility("default"))) extern

/* Runtime ABI version; the runtime's export list is versioned by it. */
#define IBUSWEB_RUNTIME_ABI 0

/* Errors are negative errno values, as Emscripten's libc numbers them. */

/* One-time setup on the thread that will pump. Acquires the default
 * GMainContext for good, since GLib signals a context's wakeup for sources
 * attached from other threads only while the context has an owner, and
 * installs a wake hook on it that increments *wake_word and wakes every
 * waiter on it. The host can then sleep on *wake_word (Atomics.wait) and
 * pump whenever it changes.
 *
 * The hook runs on whichever thread signals the wakeup, possibly with the
 * context locked, and also on the pumping thread during its own pumps (a
 * source's ready time changing, a poll fd added or removed, a main loop
 * quitting). So a wake promises nothing more than that pumping is worth a
 * try: a pump that finds nothing to do is harmless. Pump once after this
 * returns, for sources attached before the hook was in place.
 *
 * Returns 0, -EINVAL without a word, -EALREADY if already set up, or -EBUSY
 * if another thread owns the default context. */
IBUSWEB_API int ibusweb_runtime_init(int32_t *wake_word);

/* ibusweb_pump()'s return value when called from a thread that doesn't own
 * the default context; no delay is ever this value. */
#define IBUSWEB_PUMP_ERROR INT32_MIN

/* Dispatches the default context's ready sources without blocking, until
 * none is left, on the thread that called ibusweb_runtime_init(). Returns the
 * delay in milliseconds after which pumping again is due: until the next
 * source deadline, at most a few milliseconds while any source polls a file
 * descriptor (an fd turning ready wakes nobody), 0 if sources are still ready
 * (one that stays ready, such as an idle that never removes itself, has the
 * pump return so the host can serve requests in between), or -1 if nothing
 * is due until the next wake. From any other thread, it logs a critical and
 * returns IBUSWEB_PUMP_ERROR.
 *
 * To sleep without losing a wake, read *wake_word before pumping and wait
 * on the value read, for the delay returned; with words an Int32Array over
 * the memory holding *wake_word and i its index there:
 *
 *   const seen = Atomics.load(words, i);
 *   const delay = ibusweb_pump();
 *   if (delay === IBUSWEB_PUMP_ERROR) throw new Error("pumped off thread");
 *   Atomics.wait(words, i, seen, delay === -1 ? Infinity : delay);
 *
 * The hook can fire while the pump runs, for a source attached after the
 * pump last looked, and a pump that sources were added to or removed from
 * mid-iteration can return a delay that is already stale, or -1. Either
 * way the word no longer holds the value read, so the wait returns at once
 * and the host pumps again; read after the pump, the wake would be lost. */
IBUSWEB_API int32_t ibusweb_pump(void);

/* A side module, or a set of operations registered as one.
 *
 * Register and load modules, and dispatch, on the pumping thread. The
 * opcode table itself is locked, but a registration isn't atomic against a
 * concurrent dispatch: its operations become callable one at a time and are
 * removed again if it fails, and a load that fails closes the module, whose
 * code an operation dispatched meanwhile could be running. */
typedef struct _IBusWebModule IBusWebModule;

/* A spike operation: reads the request's payload and appends its reply. */
typedef void (*IBusWebOp)(const uint8_t *payload, uint32_t len, GString *reply);

/* Registers op under opcode for module, for ibusweb_dispatch(). Returns 0,
 * -EINVAL, or -EEXIST if the opcode is taken; a failure also fails the
 * registration in progress. */
IBUSWEB_API int ibusweb_module_add_op(IBusWebModule *module, uint32_t opcode,
                                      const char *name, IBusWebOp op);

/* Registers a module's operations by calling its init. */
typedef void (*IBusWebModuleInit)(IBusWebModule *module);

/* Registers a module linked into the runtime: calls init, which adds its
 * operations with ibusweb_module_add_op(). If any of them fails, none stays
 * registered and that failure is returned; otherwise returns 0. name is the
 * module's name in diagnostics. If module_out is given, it receives the
 * module, which lives as long as the runtime, or NULL on failure. */
IBUSWEB_API int ibusweb_register_module(const char *name,
                                        IBusWebModuleInit init,
                                        IBusWebModule **module_out);

/* Every side module defines this entry point. */
IBUSWEB_API void ibusweb_module_init(IBusWebModule *module);

/* Loads a side module with dlopen() and registers it as
 * ibusweb_register_module() does, through its ibusweb_module_init(), under
 * its path. Returns 0, -ENOENT if path names no file, -ENOEXEC if the file
 * can't be loaded or lacks the entry point, or the registration's failure;
 * the module is closed again on any failure. */
IBUSWEB_API int ibusweb_load_module(const char *path,
                                    IBusWebModule **module_out);

/* Spike dispatcher. A request is a little-endian uint32_t opcode followed by
 * the operation's payload; the reply the operation appends is copied into
 * reply. Returns the reply's length, -EINVAL for a request shorter than an
 * opcode, -ENOSYS for an opcode nobody registered, or -ENOBUFS, with nothing
 * written, for a reply longer than reply_cap. */
IBUSWEB_API int32_t ibusweb_dispatch(const uint8_t *request,
                                     uint32_t request_len, uint8_t *reply,
                                     uint32_t reply_cap);

G_END_DECLS
