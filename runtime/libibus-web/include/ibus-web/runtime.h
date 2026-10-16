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
#define IBUSWEB_RUNTIME_ABI 1

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
 * It also has every signal handler and source callback GLib calls, on any
 * thread, run inside a C++ try: an engine's exception stops there, GLib
 * finishes the emission or dispatch as for a call that returned, and the
 * runtime marks its engines faulted (ibusweb_fault_reason()).
 *
 * Returns 0, -EINVAL without a word, -EALREADY if already set up, or -EBUSY
 * if another thread owns the default context. */
IBUSWEB_API int ibusweb_runtime_init(int32_t *wake_word);

/* Why the engines faulted: what() of the C++ exception an engine threw, or a
 * description of one that wasn't a std::exception; NULL until one has. The
 * first fault's reason stays, valid for the runtime's lifetime. Any thread
 * may read it; a fault on another thread also wakes the host through the
 * wake word, so a host asleep in ibusweb_wait() finds it at once. */
IBUSWEB_API const char *ibusweb_fault_reason(void);

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
 * A C++ exception a source's callback throws stops in the runtime's catch
 * and faults the engines (ibusweb_fault_reason()); the pump then dispatches
 * nothing more and returns -1, as it does once the engines have faulted or
 * a Shutdown has run. */
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

/* A test operation, which side modules register for tests to call through
 * ibusweb_test_dispatch(): reads the request's payload and appends its reply.
 *
 * A C++ exception it throws fails the dispatch, which isolates the failure
 * only if the exception unwound through C++ frames alone. One that crossed C
 * frames on its way out (a GLib signal emission, a foreach callback, a vfunc
 * called from C) skipped their cleanup: locks they held stay taken and
 * whatever they were changing stays half-changed. Other exceptions
 * (JavaScript errors, Emscripten's ExitStatus from exit(), longjmp()) aren't
 * caught at all. */
typedef void (*IBusWebOp)(const uint8_t *payload, uint32_t len, GString *reply);

/* Registers op under opcode for module, for ibusweb_test_dispatch(). Returns 0,
 * -EINVAL, or -EEXIST if the opcode is taken; a failure also fails the
 * registration in progress. */
IBUSWEB_API int ibusweb_module_add_op(IBusWebModule *module, uint32_t opcode,
                                      const char *name, IBusWebOp op);

/* Writes what a module keeps in memory to storage, on the pumping thread,
 * for a Persist request: the page sends one when it may end the Worker
 * next, which runs no finalizer. Whatever the module hasn't written by the
 * time it returns is lost if the Worker ends.
 *
 * A C++ exception it throws fails the request as an engine's does (see
 * ibusweb_dispatch()). */
typedef void (*IBusWebPersist)(void);

/* Has each Persist request call persist, once module's registration has
 * succeeded. Call it from the module's init; a later call replaces the
 * function. Persist calls the modules' functions in the order they were
 * registered. Returns 0, or -EINVAL, which also fails the registration in
 * progress. */
IBUSWEB_API int ibusweb_module_set_persist(IBusWebModule *module,
                                           IBusWebPersist persist);

/* Releases what a module holds for its lifetime, on the pumping thread, for
 * a Shutdown request: the page sends one, after Persist, just before it ends
 * the Worker. No request or source reaches an engine afterwards, so the
 * function may free what its engines use.
 *
 * A C++ exception it throws fails the request as an engine's does (see
 * ibusweb_dispatch()). */
typedef void (*IBusWebShutdown)(void);

/* Has the Shutdown request call shutdown, once module's registration has
 * succeeded. Call it from the module's init; a later call replaces the
 * function. Shutdown calls the modules' functions in the reverse of the
 * order they were registered, so a module's goes before those of the modules
 * registered ahead of it. Returns 0, or -EINVAL, which also fails the
 * registration in progress. */
IBUSWEB_API int ibusweb_module_set_shutdown(IBusWebModule *module,
                                            IBusWebShutdown shutdown);

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

/* Fails the CreateEngine in progress with reason, which the host receives in
 * a CreateEngineFailed record on the request's context, ahead of the -EIO
 * reply. Call it from a handler of the factory's "create-engine" signal,
 * which then returns NULL: it stops the emission, so the factory doesn't
 * make the engine anyway. The first reason counts, and invalid UTF-8 in it
 * is replaced. Outside a create-engine emission it logs a critical. */
IBUSWEB_API void ibusweb_factory_fail_create(const char *reason);

/* Test dispatcher, through which a host's tests call the operations side
 * modules register. A request is a little-endian uint32_t opcode followed by
 * the operation's payload; the reply the operation appends is copied into
 * reply. Returns the reply's length, -EINVAL for a request shorter than an
 * opcode, -ENOSYS for an opcode nobody registered, -ECANCELED if the operation
 * threw a C++ exception, or -ENOBUFS for a reply longer than reply_cap;
 * nothing is written on any failure. -ECANCELED says nothing of the state
 * the exception unwound through (see IBusWebOp). Any other exception an
 * operation raises propagates to the caller and leaks the reply being
 * built. */
IBUSWEB_API int32_t ibusweb_test_dispatch(const uint8_t *request,
                                          uint32_t request_len, uint8_t *reply,
                                          uint32_t reply_cap);

/* Whole records in sequence order. The pointer remains valid until the next
 * runtime call, ibusweb_wait() included: a call another thread proxied to
 * the pumping thread runs inside the wait, and one that appends a record
 * can move the buffer. Peek and consume are restricted to the pumping thread.
 * They keep working after ibusweb_dispatch() has returned -ECANCELED, so the
 * host can drain the records written before the fault; a record still waiting
 * to be appended from another thread when the fault happened is lost. */
IBUSWEB_API const uint8_t *ibusweb_output_peek(uint32_t *len);
/* A length not ending on a record boundary logs a critical and drops nothing.
 */
IBUSWEB_API void ibusweb_output_consume(uint32_t len);
/* Last appended sequence number, zero before any record. Wraps at 2^32. */
IBUSWEB_API uint32_t ibusweb_output_last_seq(void);

/* Dispatch one protocol.h request on the pumping thread, without pumping.
 * Returns a key event's boolean reply, zero for other requests, or a negative
 * errno: EBADMSG for invalid framing/payload, ENOSYS for unknown kinds,
 * ENOTCONN before Init, EALREADY for a repeated Init, EPROTO for a version
 * mismatch, ENOENT for a missing context, EEXIST for a duplicate context,
 * ESRCH for an unregistered engine, EIO for a registered one that wasn't made,
 * EINVAL for a SetSurroundingText cursor or anchor past the text's length in
 * characters, EPERM off-thread, ECANCELED when an engine throws a C++
 * exception, ENOTRECOVERABLE once one has, or ESHUTDOWN once a Shutdown has
 * run. Requests failing on their framing, payload or context reach no engine.
 *
 * SettingChanged ignores the header's ic, so its ENOENT means a path no Init
 * entry declared or a key its schema lacks, never a missing context; it
 * returns EINVAL for a value outside the key's type or range, or ENOTSUP for a
 * default settings backend other than the runtime's. Each of these also
 * writes a Log record. Persist ignores it too, and returns 0 once every
 * module's persist function (ibusweb_module_set_persist()) has returned, and
 * so does Shutdown, which calls every module's shutdown function
 * (ibusweb_module_set_shutdown()), last registered first.
 *
 * ECANCELED means the engines can't be trusted: an exception stopped in the
 * runtime's catch (ibusweb_runtime_init()) partway through engine code, whose
 * frames between the throw and the catch skipped their cleanup, so the host
 * must end the engines, as for a crash, with ibusweb_fault_reason() as the
 * diagnostic. GLib finished its own bookkeeping, so output, the log writer
 * and the settings backend keep working; every later ibusweb_dispatch()
 * returns ENOTRECOVERABLE without reaching any engine. */
IBUSWEB_API int32_t ibusweb_dispatch(const uint8_t *request, uint32_t len);

G_END_DECLS
