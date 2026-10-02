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
 * waiter on it. The host can then sleep on *wake_word (ibusweb_wait()) and
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
 *   ibusweb_wait(seen, delay);
 *
 * The hook can fire while the pump runs, for a source attached after the
 * pump last looked, and a pump that sources were added to or removed from
 * mid-iteration can return a delay that is already stale, or -1. Either
 * way the word no longer holds the value read, so the wait returns at once
 * and the host pumps again; read after the pump, the wake would be lost.
 *
 * Nothing catches an exception a source's callback throws: it unwinds
 * through GLib's dispatch out of ibusweb_pump() to the host, leaving the
 * context mid-dispatch. */
IBUSWEB_API int32_t ibusweb_pump(void);

/* Sleeps on the thread that called ibusweb_runtime_init() while *wake_word
 * still holds seen, for at most timeout_ms milliseconds, or for good if it is
 * negative. Returns 0 once the word has changed, -ETIMEDOUT if it hasn't by
 * the timeout, -EINVAL before ibusweb_runtime_init(), or, from any other
 * thread, logs a critical and returns -EPERM.
 *
 * Unlike a JavaScript Atomics.wait() on the word, this sleep runs the calls
 * other threads proxy synchronously to the thread that instantiated the
 * runtime, as Emscripten does with pthread_create() called on any other
 * thread: those threads would otherwise block until the host returned to
 * its event loop. It runs them at least once per call, even when the word
 * has already moved, provided that thread is the one calling. It also
 * reclaims the stacks and Workers of threads that ended without being
 * joined on that thread, detached ones among them. Anything that changes
 * the word wakes it, a write from JavaScript (Atomics.add() and
 * Atomics.notify() on the word) as well as the wake hook. */
IBUSWEB_API int ibusweb_wait(int32_t seen, int32_t timeout_ms);

/* A side module, or a set of operations registered as one.
 *
 * Register and load modules, and dispatch, on the pumping thread. The
 * opcode table itself is locked, but a registration isn't atomic against a
 * concurrent dispatch: its operations become callable one at a time and are
 * removed again if it fails, and a load that fails closes the module, whose
 * code an operation dispatched meanwhile could be running. */
typedef struct _IBusWebModule IBusWebModule;

/* A spike operation: reads the request's payload and appends its reply.
 *
 * A C++ exception it throws fails the dispatch, which isolates the failure
 * only if the exception unwound through C++ frames alone. One that crossed C
 * frames on its way out (a GLib signal emission, a foreach callback, a vfunc
 * called from C) skipped their cleanup: locks they held stay taken and
 * whatever they were changing stays half-changed. Other exceptions
 * (JavaScript errors, Emscripten's ExitStatus from exit(), longjmp()) aren't
 * caught at all. */
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
 * opcode, -ENOSYS for an opcode nobody registered, -ECANCELED if the operation
 * threw a C++ exception, or -ENOBUFS for a reply longer than reply_cap;
 * nothing is written on any failure. -ECANCELED says nothing of the state
 * the exception unwound through (see IBusWebOp). Any other exception an
 * operation raises propagates to the caller and leaks the reply being
 * built. */
IBUSWEB_API int32_t ibusweb_dispatch(const uint8_t *request,
                                     uint32_t request_len, uint8_t *reply,
                                     uint32_t reply_cap);

/* A streaming extractor of an engine's data: a POSIX ustar archive,
 * uncompressed, fed in pieces of any size as they arrive and written
 * through the file system as it goes.
 *
 * It takes regular files and directories only. A symbolic or hard link, a
 * device, a FIFO, an extended header, a name that is absolute or has a ".."
 * component, a header whose checksum doesn't match, or one that isn't
 * ustar's fails the install with -EINVAL, as does an archive that ends
 * before its end-of-archive blocks. Files and directories take the
 * archive's permission bits, plus the owner's read and write (and search,
 * for a directory), so that an install can always redo what an earlier one
 * wrote; a file that exists already is truncated and rewritten, a directory
 * that exists already is kept, both take the archive's mode as new ones do,
 * and missing parents are created, so installing again over a tree an
 * earlier install left half-written completes it. Nothing the archive lacks
 * is removed. Entries already written before a failure stay. Each file is
 * fsync()ed once written.
 *
 * Call it on one thread at a time; the file system's own calls may block,
 * as the IndexedDB backend's do. */
typedef struct _IBusWebInstall IBusWebInstall;

/* Starts extracting into `dir` (which must exist). Returns 0, -EINVAL
 * without dir or out, -ENOENT or -ENOTDIR if dir isn't a directory, or
 * -ENOMEM. */
IBUSWEB_API int ibusweb_install_begin(const char *dir, IBusWebInstall **out);

/* Feeds the next `len` bytes of the archive; returns 0 or a negative errno.
 * Once a feed has failed, every later one fails the same way; NULL data with
 * a length fails it with -EINVAL. Bytes after the end-of-archive blocks are
 * ignored. */
IBUSWEB_API int ibusweb_install_feed(IBusWebInstall *install,
                                     const uint8_t *data, uint32_t len);

/* Finishes: fsyncs what it wrote, returns 0 or a negative errno, frees
 * `install`. Returns a failed feed's error, or -EINVAL if the archive ended
 * early. */
IBUSWEB_API int ibusweb_install_end(IBusWebInstall *install);

G_END_DECLS
