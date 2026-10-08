# M2.1c: The Table Engine in the Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the native table engine of phase 2 in the browser: one GObject glue file, the `table.wasm` side module, its distribution and npm package, a real-runtime host check, the table module in the demo with Playwright cases, and the docs, as phase 3 of `docs/specs/2026-10-08-m2-1-table-engine.md` describes.

**Architecture:** `engines/table/src/glue.cpp` is the module's only GObject code: one `IBusEngine` subclass for every engine, whose `engine-name` picks a table, implementing phase 2's `Sink` over IBus's engine API. A `create-engine` handler on the factory parses a table on first use into a module-level map and, when the table doesn't parse, fails `CreateEngine` with the parser's `path:line: reason` through `ibusweb_factory_fail_create`, a runtime API Task 1 adds: the runtime sends the reason to the page in a `CreateEngineFailed` record, and the page's `select` rejects with it. `pkgsWasm.ibus-web-table` compiles phase 2's sources and the glue with the runtime's side-module flags, links MARISA statically, and compiles the table and schema directories in as store paths, which makes them its data closure. `mkEngineManifest` packs it with descriptors from `table-describe`; the worker-host's engine suites learn to run any module, which `table-host` uses; the demo serves the module through `ibusWeb.demo.modules`.

**Tech Stack:** C++23 (Emscripten `em++`, libc++ from the runtime), GObject/IBus (`libibus-web`), MARISA 0.3.1, Nix flake-parts with import-tree, Vitest 5 under Node (worker-host suites), Playwright (Chromium, Firefox, WebKit), pnpm, REUSE, hk.

## Global Constraints

- Work on a branch cut from `master` after Plans A and B are merged: `git switch -c typedrat/m2-1c-table-browser master`.
- Run every command inside the dev shell: `nix develop -c <command>`. Never search from `/`.
- `nix develop -c git add <paths>` every new file before any `nix` command that should see it: the flake reads only tracked files.
- Stage named paths only; commit with `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`. hk's pre-commit hook runs then; if it rejects or rewrites files, fix the cause and commit again, never bypass it. No AI attribution in commits.
- Every new file starts with `SPDX-FileCopyrightText: 2026 Synapdeck, Inc.` and `SPDX-License-Identifier: MIT OR Apache-2.0` in its comment syntax. `package.json` is covered by `REUSE.toml` already.
- The module's licence is exactly `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`; `@ibus-web/engine-table`'s `LICENSES/` holds `MIT.txt`, `Apache-2.0.txt` and `W3C.txt` from the repository, and MARISA's own `marisa/COPYING.md` from its source. The repository has no `LICENSES/BSD-2-Clause.txt`: nothing in it is BSD-2-Clause, and `reuse lint` rejects a licence text no file uses.
- The module ships `org.freedesktop.ibus.panel` as its only settings schema: `settingsSchemas = [ "org.freedesktop.ibus.panel" ]`.
- Candidate pages hold 10. The preedit is the raw buffer, underlined, in COMMIT mode. FocusOut and Reset clear state and emit nothing.
- Comments say why, never what; no history, no references to other files' implementations, plans or pull requests. Separate logical blocks with a blank line; no blank line right after an opening token, right before a closing one, or between a comment and its code.
- Markdown outside `docs/plans/` is formatted with `nix develop -c oxfmt <file>`. Never run oxfmt on `docs/plans/`.
- Generated files are never edited by hand. Task 1 changes the protocol's schemas, so it regenerates `packages/protocol/PROTOCOL.md` and `runtime/libibus-web/include/ibus-web/protocol.h` with `nix run .#write-files`; no other task changes a generated file's source.
- Don't revert, reformat or "fix" changes you didn't make.

## What this plan assumes from Plans A and B

These come from the cross-phase contracts. Each task that touches one says so; where the merged code differs, adapt the step to the merged names and keep the behaviour.

**From B (native engine):**

- `engines/table/src/` holds `keys.hpp`, `table.hpp`/`table.cpp`, `sink.hpp`, `session.hpp`, `command.cpp`, `continuous.cpp`, in namespace `ibusweb::table`, with exactly the contract's declarations: `Table::load(const std::filesystem::path &) -> std::expected<Table, ParseError>`, `ParseError::message()` giving `path:line: reason`, `Candidate { std::string key; std::string output; }`, `class Sink { commit(std::string_view); preedit(std::string_view); candidates(std::span<const Candidate>, std::size_t cursor, bool cursorShown); }`, `inline constexpr std::size_t pageSize = 10;`, `class Session { processKey(std::uint32_t, char32_t, std::uint32_t) -> bool; candidateClicked(std::size_t); pageUp(); pageDown(); cursorUp(); cursorDown(); reset(); }`, `makeSession(const Table &, Sink &) -> std::unique_ptr<Session>`. MARISA appears only in `table.cpp`.
- `engines/table/options.nix` declares, inside `options.perSystem = flake-parts-lib.mkPerSystemOption { … }`, the set `options.ibusWeb.engines.table` with `tables` (a derivation whose `$out` holds exactly `latex.table` and `xsampa.table`), `tools` (native, with `bin/table-check` and `bin/table-describe`) and `sources` (a sorted list of the `.cpp` file names in `engines/table/src`: `command.cpp continuous.cpp session.cpp table.cpp utf8.cpp`; the side module compiles them from that directory).
- `engines/table/overlay.nix` defines `flake.overlays.table`, gated on `isEmscriptenWasm`, defining `marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };`, where `engines/table/_marisa.nix` applies PR #146 with `fetchpatch`; nothing is vendored.
- `table-check <file>` exits 1 and prints exactly one line, `<file>:<line>: <reason>`, for a table that doesn't parse, `<file>` being the path as given.
- `table-describe <file>...` prints a JSON array of `EngineDescriptor`s in argument order.
- The LaTeX table's frontmatter `name` is `LaTeX`; X-SAMPA's is `X-SAMPA`.
- `LICENSES/W3C.txt` exists (B's `unicode.xml` fixture uses it); `LICENSES/BSD-2-Clause.txt` does not.
- `docs/table.md` and its `docs/README.md` Topics row exist (B's) and describe the table format and the native engine; this plan only extends the page.

**From A (page side):**

- `@ibus-web/protocol` exports `ModuleManifest` (renamed from `EngineManifest`) and `EngineDescriptor`; every `EngineManifest` in `packages/worker-host/test/` is now `ModuleManifest`.
- `ibusWeb.engines.mkEngineManifest { name, package, threads, heapBytes, settingsSchemaDir, engines, settingsSchemas }`, with `engines` a list of descriptors or a path to a JSON file holding them.
- `examples/demo/options.nix` declares `ibusWeb.demo.modules` (`attrsOf package`); the demo serves every entry.
- `examples/demo/test/e2e/fixtures.ts` exports `test`, whose automatic `healthyDemo` fixture opens the demo for every test with `openDemo(page)`, and `expect`. The demo's typing field is `#input`; its engine picker is `#engine-picker`, a `<select>` labelled `Input method` with an `Off` option (value `""`) and one `<optgroup label="<module>">` per module whose options are labelled with each engine's `displayName`; Ctrl+Space (Playwright `Control+Space`) toggles between `deselect()` and the last selection and is not typed into the field; the Worker host's script is served under `/ibus-web/host/worker/index.js`. `selectionchange` carries `CustomEvent<Selection | null>`, `null` after a deselection.
- The facade's option is `modules`, and `select(module, engine?)` selects.
- `packages/core/src/router/router.ts`'s `reconcile` sends `CreateEngine({ name: context.engine })` and returns on a negative reply; `select(module, engine?)` reconciles every surface in its `start`. `packages/core/test/browser/support/dom.ts`'s `run` starts with module `a` (engines `factory` and `other`) selected, and the file exports `record` and `key`; its `DomConnection` holds a request kind with `hold` and settles it with `completeAsync`.

## File structure

| Path | Role |
| --- | --- |
| `runtime/libibus-web/src/ibus/ibusfactory.c`, `ibusweb-private.h`, `src/dispatch.c`, `include/ibus-web/runtime.h`, `tests/test-dispatch.c` (modify) | `ibusweb_factory_fail_create`, `-EIO` and the `CreateEngineFailed` record |
| `packages/protocol/src/messages/records.ts`, `src/index.ts`, `test/messages/{kinds,codec}.test.ts`, `test/parity/parity.test.ts`, `test/parity/c/parity.c` (modify) | The `CreateEngineFailed` record and its parity |
| `packages/core/src/router/router.ts`, `src/page/index.ts`, `test/browser/router/switching.test.ts` (modify) | `CreateEngineError`, which `select` rejects with |
| `docs/runtime.md`, `docs/protocol.md`, `docs/core.md`, `docs/ibus-web.md`, `runtime/libibus-web/src/ibus/README.md`, `docs/specs/2026-09-26-ibus-web-design.md` (modify) | Docs for engine creation failures |
| `engines/table/src/glue.cpp` (create) | The IBus engine class, the `Sink` over it, lazy table loading, `ibusweb_module_init` |
| `engines/table/_package.nix` (create) | `callPackage` recipe for `table.wasm`, its schema directory and audit flags |
| `engines/table/overlay.nix` (modify, B's) | Adds `ibus-web-table` to `pkgsWasm` |
| `engines/table/options.nix` (modify, B's) | Adds `ibusWeb.engines.table.module` |
| `engines/table/side-module.nix` (create) | `packages.ibus-web-table`, editor flags, `table-imports`, `table-cast-audit`, `table-data-closure` |
| `engines/table/cast-audit.jsonc` (create) | The empty allow-list |
| `engines/table/dist.nix` (create) | `packages.ibus-web-table-dist`, `ibusWeb.demo.modules.table` |
| `engines/table/checks/host/checks.nix`, `broken.table` (create) | `table-host` and its broken-table distribution |
| `packages/worker-host/test/node/config.ts` (modify) | Engine-module suites, generic over modules |
| `packages/worker-host/test/engines/page-session.ts` (modify) | `PageSession` with per-suite options and expected warnings |
| `packages/worker-host/test/engines/hangul.test.ts` (modify) | Uses the generic session |
| `packages/worker-host/test/engines/table.test.ts` (create) | The table module's host suite |
| `engines/hangul/checks/host/checks.nix` (modify) | Describes its suite in the new format |
| `packages/engines/table/{package.json,README.md,module.nix}` (create) | `@ibus-web/engine-table` |
| `examples/demo/test/e2e/table.spec.ts` (create) | Playwright cases |
| `docs/table.md`, `docs/engines.md`, `docs/worker-host.md`, `docs/testing.md`, `docs/README.md`, `README.md`, `docs/specs/2026-09-26-ibus-web-design.md` (modify) | Docs |

---

### Task 1: Engines fail `CreateEngine` with a reason the page sees

`CreateEngine`'s reply is only `ibusweb_dispatch`'s return value, so an engine that can't be created has no way to say why: the factory replies `-ESRCH` as for a name nobody registered, and the page's router drops the failure silently. This task gives a `create-engine` handler a way to fail the creation with a reason. The factory writes it in a new record, `CreateEngineFailed`, on the request's context before the reply, which becomes `-EIO` for a registered engine that isn't made; `-ESRCH` stays for an unregistered name. Records written during a request are the reply's own, so the router finds the reason in the reply and rejects `select` with it.

**Files:**

- Modify: `packages/protocol/src/messages/records.ts`, `packages/protocol/src/index.ts`, `packages/protocol/test/messages/kinds.test.ts`, `packages/protocol/test/messages/codec.test.ts`, `packages/protocol/test/parity/parity.test.ts`, `packages/protocol/test/parity/c/parity.c`
- Regenerate: `packages/protocol/PROTOCOL.md`, `runtime/libibus-web/include/ibus-web/protocol.h`
- Modify: `runtime/libibus-web/include/ibus-web/runtime.h`, `runtime/libibus-web/src/ibus/ibusfactory.c`, `runtime/libibus-web/src/ibus/ibusweb-private.h`, `runtime/libibus-web/src/dispatch.c`, `runtime/libibus-web/tests/test-dispatch.c`, `runtime/libibus-web/src/ibus/README.md`
- Modify: `packages/core/src/router/router.ts`, `packages/core/src/page/index.ts`, `packages/core/test/browser/router/switching.test.ts`
- Modify: `docs/runtime.md`, `docs/protocol.md`, `docs/core.md`, `docs/ibus-web.md`, `docs/specs/2026-09-26-ibus-web-design.md`

**Interfaces:**

- Consumes (A): the router's `reconcile`, which sends `CreateEngine({ name: context.engine })` and returns on a negative reply, and `select(module, engine?)`, whose `start` reconciles every surface in a loop; `InputContext.module`/`.engine`; `packages/core/test/browser/support/dom.ts`'s `run` (module `a` with engines `factory` and `other`, selected at start), `record` and `key`, and `DomConnection.hold`/`untilSent`/`completeAsync`.
- Produces: record `CreateEngineFailed { message: string }`, kind 35, signature `(s)`, exported from `@ibus-web/protocol`; `IBUSWEB_REC_CREATE_ENGINE_FAILED` in `protocol.h`; `IBUSWEB_API void ibusweb_factory_fail_create(const char *reason)` in `runtime.h`; `CreateEngine` replies `-ESRCH` for an unregistered name and `-EIO` for a registered engine that isn't made; `CreateEngineError` (`_tag`, `module`, `engine`, `reason: string | undefined`) exported from `@ibus-web/core`, with which `select` and `override` reject.

Neither `PROTOCOL_VERSION` nor `IBUSWEB_RUNTIME_ABI` changes: the record and the function are additions, and the page, host and runtime of one build ship together.

- [ ] **Step 1: Add the record to the protocol's schemas**

In `packages/protocol/src/messages/records.ts`, add after the `Crashed` class:

```ts
export class CreateEngineFailed extends Schema.TaggedClass<CreateEngineFailed>()(
  "CreateEngineFailed",
  { message: Str.annotate({ description: "Why the engine couldn't be created, in the engine's words." }) },
  {
    kind: 35,
    description:
      "Explain a CreateEngine that the engine failed: written on the request's input context, before its -EIO reply.",
  },
) {}
```

and add `CreateEngineFailed,` after `Crashed,` in the `OutputRecord` union. In `packages/protocol/src/index.ts`, add `CreateEngineFailed,` after `Crashed,` in the export from `./messages/records.ts`.

In `packages/protocol/test/messages/kinds.test.ts`, add `["CreateEngineFailed", 35, "(s)"],` after `["Crashed", 34, "(us)"],` and change `expect(recordKinds.size).toBe(18);` to `expect(recordKinds.size).toBe(19);`.

In `packages/protocol/test/messages/codec.test.ts`, add `CreateEngineFailed,` after `CrashReason,` in the import from `../../src/index.ts`, and append:

```ts
test("decodes CreateEngineFailed's reason on its input context", () => {
  const message = "latex.table:9: line 9 has no tab";
  expect(decodeRecord(encodeRecordForTest(new CreateEngineFailed({ message })))).toMatchObject({
    ic: 7,
    record: { _tag: "CreateEngineFailed", message },
  });
});
```

- [ ] **Step 2: Regenerate the header and the wire reference, and run the protocol's unit suites**

```bash
nix run .#write-files
git status --short
nix build .#checks.x86_64-linux.protocol-node -L
```

Expected: `git status` lists `packages/protocol/PROTOCOL.md` and `runtime/libibus-web/include/ibus-web/protocol.h` among the changes; `protocol.h` now has `IBUSWEB_REC_CREATE_ENGINE_FAILED = 35` and `{IBUSWEB_REC_CREATE_ENGINE_FAILED, "(s)"}`. `protocol-node` passes, the codec test above and the kinds test included.

- [ ] **Step 3: Write the failing runtime test**

In `runtime/libibus-web/tests/test-dispatch.c`, add after `skip_debug_logs`:

```c
static void expect_create_failed(guint32 expected_ic, const gchar *expected) {
  guint32 length;
  const guint8 *data = ibusweb_output_peek(&length);
  g_assert_nonnull(data);
  g_assert_cmpuint(length, >=, sizeof(IBusWebRecordHeader));
  IBusWebRecordHeader header;
  memcpy(&header, data, sizeof header);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==,
                   IBUSWEB_REC_CREATE_ENGINE_FAILED);
  g_assert_cmpuint(GUINT32_FROM_LE(header.ic), ==, expected_ic);

  guint payload_length = GUINT32_FROM_LE(header.len);
  GVariant *payload = g_variant_ref_sink(
      g_variant_new_from_data(G_VARIANT_TYPE("(s)"), data + sizeof header,
                              payload_length, FALSE, NULL, NULL));
  g_assert_true(g_variant_is_normal_form(payload));
  const gchar *message;
  g_variant_get(payload, "(&s)", &message);
  g_assert_cmpstr(message, ==, expected);
  g_variant_unref(payload);

  ibusweb_output_consume((sizeof header + payload_length + 7) & ~7u);
  empty_output();
}
```

and, before `static void protocol(void)`:

```c
static IBusEngine *refuse(IBusFactory *factory, const gchar *name,
                          gpointer data G_GNUC_UNUSED) {
  if (g_str_equal(name, "refused"))
    ibusweb_factory_fail_create("refused.table:9: line 9 has no tab");
  else if (g_str_equal(name, "silent"))
    g_signal_stop_emission_by_name(factory, "create-engine");
  return NULL;
}

/* Registered engines that aren't made: a handler's reason reaches the host
 * on the request's context ahead of the reply, and stops the factory from
 * making the engine anyway. */
static void refusals(void) {
  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 9, g_variant_new("(s)", "refused")), ==,
      -EIO);
  skip_debug_logs();
  expect_create_failed(9, "refused.table:9: line 9 has no tab");

  g_assert_cmpint(
      send(IBUSWEB_REQ_CREATE_ENGINE, 9, g_variant_new("(s)", "silent")), ==,
      -EIO);
  skip_debug_logs();
  empty_output();
  g_assert_null(last_created);

  ibusweb_factory_fail_create("outside");
  expect_log(G_LOG_LEVEL_CRITICAL, "ibus-web", "outside a CreateEngine");
}
```

In `protocol()`, replace

```c
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  ibus_factory_add_engine(factory, "test", dispatch_engine_get_type());
  g_object_unref(factory);
```

with

```c
  IBusFactory *factory = g_object_ref_sink(ibus_factory_new(NULL));
  ibus_factory_add_engine(factory, "test", dispatch_engine_get_type());
  ibus_factory_add_engine(factory, "refused", dispatch_engine_get_type());
  ibus_factory_add_engine(factory, "silent", dispatch_engine_get_type());
  g_signal_connect(factory, "create-engine", G_CALLBACK(refuse), NULL);
  g_object_unref(factory);
  refusals();
```

```bash
nix build .#checks.x86_64-linux.libibus-web-tests -L
```

Expected: FAIL to compile: `ibusweb_factory_fail_create` is undeclared.

- [ ] **Step 4: Declare the API**

In `runtime/libibus-web/include/ibus-web/runtime.h`, add after the declaration of `ibusweb_load_module`:

```c
/* Fails the CreateEngine in progress with reason, which the host receives in
 * a CreateEngineFailed record on the request's context, ahead of the -EIO
 * reply. Call it from a handler of the factory's "create-engine" signal,
 * which then returns NULL: it stops the emission, so the factory doesn't
 * make the engine anyway. The first reason counts, and invalid UTF-8 in it
 * is replaced. Outside a create-engine emission it logs a critical. */
IBUSWEB_API void ibusweb_factory_fail_create(const char *reason);
```

and in `ibusweb_dispatch`'s comment, replace `ESRCH for an unregistered engine, EINVAL` with `ESRCH for an unregistered engine, EIO for a registered one that wasn't made, EINVAL`, rewrapping the comment to 80 columns as clang-format leaves it.

In `runtime/libibus-web/src/ibus/ibusweb-private.h`, add after `ibusweb_factory_create`:

```c
G_GNUC_INTERNAL gboolean ibusweb_factory_fail(const char *reason);
```

- [ ] **Step 5: Implement it in the factory**

In `runtime/libibus-web/src/ibus/ibusfactory.c`, add the includes

```c
#include "../output.h"
#include <ibus-web/protocol.h>
```

after `#include "ibusweb-private.h"`, replace the private struct with

```c
struct _IBusFactoryPrivate {
  GHashTable *types;
  uint32_t creating_ic;
  /* While create-engine is emitted: the reason a handler failed the
   * creation with, once one has. */
  gboolean creating;
  gchar *failure;
};
```

and replace `ibusweb_factory_create` with:

```c
gboolean ibusweb_factory_fail(const char *reason) {
  if (runtime_factory == NULL || !runtime_factory->priv->creating)
    return FALSE;

  IBusFactoryPrivate *priv = runtime_factory->priv;
  if (priv->failure == NULL)
    priv->failure = g_utf8_make_valid(reason, -1);
  g_signal_stop_emission(runtime_factory, create_engine_signal, 0);
  return TRUE;
}

IBusEngine *ibusweb_factory_create(uint32_t ic, const char *name, int *error) {
  if (error != NULL)
    *error = -ESRCH;
  if (runtime_factory == NULL ||
      !g_hash_table_contains(runtime_factory->priv->types, name))
    return NULL;
  if (error != NULL)
    *error = -EIO;

  IBusFactoryPrivate *priv = runtime_factory->priv;
  IBusEngine *engine = NULL;
  uint32_t previous_ic = priv->creating_ic;
  priv->creating_ic = ic;
  priv->creating = TRUE;
  g_signal_emit(runtime_factory, create_engine_signal, 0, name, &engine);
  priv->creating_ic = previous_ic;
  priv->creating = FALSE;
  g_autofree gchar *failure = g_steal_pointer(&priv->failure);

  if (engine != NULL && g_object_is_floating(engine))
    g_object_ref_sink(engine);
  /* The handler that gave a reason may still have returned an engine. */
  if (engine != NULL && failure != NULL) {
    ibus_object_destroy(IBUS_OBJECT(engine));
    g_clear_object(&engine);
  }

  if (engine == NULL) {
    /* Written before the reply, so the host hands the page both together. */
    if (failure != NULL)
      ibusweb_output_append(ic, IBUSWEB_REC_CREATE_ENGINE_FAILED,
                            g_variant_new("(s)", failure));
    return NULL;
  }

  ibusweb_engine_set_ic(engine, ic);
  if (error != NULL)
    *error = 0;
  return engine;
}
```

The public entry point lives in `libibus-web.a`, whose `IBUSWEB_API` symbols are the runtime's export list; the IBus layer exports IBus's own API only. In `runtime/libibus-web/src/dispatch.c`, add before `gboolean ibusweb_runtime_faulted(void)`:

```c
void ibusweb_factory_fail_create(const char *reason) {
  g_return_if_fail(reason != NULL);
  if (!ibusweb_factory_fail(reason))
    g_critical("ibusweb_factory_fail_create() called outside a CreateEngine");
}
```

In `runtime/libibus-web/src/ibus/README.md`, change the `src/ibus/ibusfactory.c` row's description to `Ours, using upstream signal semantics: one runtime registry, per-context engine creation, and a handler's reason for failing it.`

- [ ] **Step 6: Run the runtime's checks**

```bash
nix build .#checks.x86_64-linux.libibus-web-tests .#checks.x86_64-linux.libibus-web-cast-audit .#checks.x86_64-linux.libibus-web-vendored .#checks.x86_64-linux.ibus-runtime-exports .#checks.x86_64-linux.hangul-host -L
```

Expected: all pass. `libibus-web-tests` runs `dispatch` and `dispatch-debug` with `refusals()` and still reports 69 C cases; `test-engine`'s factory case still gets `-ESRCH` for `missing`. `ibus-runtime-exports` finds `ibusweb_factory_fail_create` in `libibus-web`'s exports and declared by `runtime.h`. `hangul-host` shows Hangul's own creation unchanged.

- [ ] **Step 7: Have the parity producer emit the record**

In `packages/protocol/test/parity/c/parity.c`, add before `static int dispatch_file`:

```c
static IBusEngine *refuse(IBusFactory *factory G_GNUC_UNUSED,
                          const gchar *name, gpointer data G_GNUC_UNUSED) {
  if (g_str_equal(name, "refused"))
    ibusweb_factory_fail_create("parity refusal");
  return NULL;
}
```

In `run_runtime`, replace

```c
  ibus_factory_add_engine(factory, "parity", parity_engine_get_type());
```

with

```c
  ibus_factory_add_engine(factory, "parity", parity_engine_get_type());
  ibus_factory_add_engine(factory, "refused", parity_engine_get_type());
  g_signal_connect(factory, "create-engine", G_CALLBACK(refuse), NULL);
```

and replace

```c
  ibusweb_dispatch(trigger, sizeof(trigger));
  json_builder_end_array(records);
```

with

```c
  ibusweb_dispatch(trigger, sizeof(trigger));

  begin_observation(records, "CreateEngineFailed");
  string_member(records, "message", "parity refusal");
  end_observation(records);

  GVariant *refused = g_variant_ref_sink(g_variant_new("(s)", "refused"));
  gsize refused_size = 8 + g_variant_get_size(refused);
  guint8 *create = g_malloc0(refused_size);
  guint16 create_kind = GUINT16_TO_LE(IBUSWEB_REQ_CREATE_ENGINE);
  guint32 create_ic = GUINT32_TO_LE(2);
  memcpy(create, &create_kind, sizeof(create_kind));
  memcpy(create + 4, &create_ic, sizeof(create_ic));
  g_variant_store(refused, create + 8);

  ibusweb_dispatch(create, refused_size);
  g_free(create);
  g_variant_unref(refused);
  json_builder_end_array(records);
```

In `packages/protocol/test/parity/parity.test.ts`, replace

```ts
      expect(decoded.ic).toBe(decoded.record._tag === "Log" || decoded.record._tag === "SettingWritten" ? 0 : 1);
```

with

```ts
      const tag = decoded.record._tag;
      expect(decoded.ic).toBe(tag === "Log" || tag === "SettingWritten" ? 0 : tag === "CreateEngineFailed" ? 2 : 1);
```

```bash
nix build .#checks.x86_64-linux.protocol-parity -L
```

Expected: PASS; the records test decodes `CreateEngineFailed` with `message: "parity refusal"` on context 2, and the emitted kinds again equal every kind but `Crashed`.

- [ ] **Step 8: Write the failing router tests**

In `packages/core/test/browser/router/switching.test.ts`, add `record` to the import from `../support/dom.ts`, and insert before `test("hotkeys start empty, can consume a custom binding, and unregister", …)`:

```ts
test.each([
  {
    records: [record({ _tag: "CreateEngineFailed", message: "other.table:9: line 9 has no tab" })],
    reason: "other.table:9: line 9 has no tab",
  },
  { records: [], reason: "CreateEngine returned -29" },
])("a failed CreateEngine rejects select with its reason: $reason", ({ records, reason }) =>
  run(async ({ router, connections, field }) => {
    await Effect.runPromise(router.deselect());
    const f = field();
    f.element.focus();
    const a = connections.a[0]!;
    a.hold = "CreateEngine";

    const selecting = Effect.runPromise(router.select("a", "other"));
    await a.untilSent("CreateEngine");
    a.completeAsync(-29, records);

    await expect(selecting).rejects.toThrow(`Engine other of module a could not be created: ${reason}`);
    expect(key(f.element).defaultPrevented).toBe(false);
  }),
);
```

```bash
nix build .#checks.x86_64-linux.core-browser -L
```

Expected: FAIL: both cases resolve instead of rejecting.

- [ ] **Step 9: Reject with the engine's reason in the router**

In `packages/core/src/router/router.ts`, add `type Reply` to the imports, from `../connection/connection.ts`, and add before `export class Router`:

```ts
/** A surface's engine failed to start; `reason` is the engine's own explanation, when it gave one. */
export class CreateEngineError extends Error {
  readonly _tag = "CreateEngineError";
  readonly module: string;
  readonly engine: string;
  readonly reason: string | undefined;

  constructor(module: string, engine: string, ret: number, reason: string | undefined) {
    super(`Engine ${engine} of module ${module} could not be created: ${reason ?? `CreateEngine returned ${ret}`}`);
    this.module = module;
    this.engine = engine;
    this.reason = reason;
  }
}
```

In `makeRouter`, add before `const reconcile`:

```ts
  const createFailure = (context: InputContext, reply: Reply) => {
    const reason = reply.records.flatMap(({ ic, record }) =>
      ic === context.ic && record._tag === "CreateEngineFailed" ? [record.message] : [],
    )[0];
    return new CreateEngineError(context.module, context.engine, reply.ret, reason);
  };
```

In `reconcile`, replace

```ts
        if (reply.ret < 0) return;
```

with

```ts
        if (reply.ret < 0) return yield* Effect.fail(createFailure(context, reply));
```

Add after `reconcile`:

```ts
  // One surface's engine failing to start mustn't leave the others on the old selection.
  const reconcileAll = () =>
    Effect.gen(function* () {
      const failures: CreateEngineError[] = [];
      for (const surface of surfaces.values())
        yield* reconcile(surface).pipe(
          Effect.catch((error) =>
            error instanceof CreateEngineError ? Effect.sync(() => void failures.push(error)) : Effect.fail(error),
          ),
        );

      if (failures.length > 0) return yield* Effect.fail(failures[0]!);
    });
```

and in `select`'s `start`, replace `for (const surface of surfaces.values()) yield* reconcile(surface);` with `yield* reconcileAll();`. `override` reconciles one surface and rejects with its failure as it is; a reconcile the mailbox runs on focus already logs its failure as a warning.

In `packages/core/src/page/index.ts`, add `CreateEngineError` to the export from `../router/router.ts`.

```bash
nix build .#checks.x86_64-linux.core-browser .#checks.x86_64-linux.core-node .#checks.x86_64-linux.ibus-web-browser -L
nix develop -c hk check -S tsc packages/core/src/router/router.ts packages/core/test/browser/router/switching.test.ts packages/protocol/src/messages/records.ts
```

Expected: all pass, the two new switching cases in Chromium and Firefox included; hk's `tsc` step reports nothing.

- [ ] **Step 10: Document engine creation failures**

In `docs/runtime.md`, under `### Protocol, dispatch and output`, insert `` `-EIO` for a registered engine that wasn't made, `` after `` `-ESRCH` for an unregistered engine, `` in the paragraph that begins `The errors are exactly those`, where the phrase spans a line break, and add after that paragraph:

```markdown
A side module's `create-engine` handler fails a `CreateEngine` with a reason by calling
`ibusweb_factory_fail_create(reason)` and returning `NULL`. The call stops the emission, so the factory makes no
engine, and the factory writes a `CreateEngineFailed` record with the reason on the request's context before the
`-EIO` reply, which hands the page both together. The first reason counts, invalid UTF-8 in it is replaced, and a
reason fails the creation even when its handler also returned an engine. A creation that ends without an engine for
any other reason replies `-EIO` with no record. Called outside a `create-engine` emission, the function logs a
critical.
```

In the `### API` table, add after the `ibusweb_register_module` row:

```markdown
| `ibusweb_factory_fail_create(reason)` | From a `create-engine` handler: fails the `CreateEngine` in progress with `reason` (Protocol, dispatch and output, above). |
```

and in `### Tests`, insert `engine creation failures, ` before `logs and settings (69 C cases in total)`.

In `docs/protocol.md`, add after the paragraph that begins `` `Crashed (us)` (kind 34) is written by the host only``:

```markdown
`CreateEngineFailed (s)` (kind 35) is written by the runtime on the request's context, ahead of the `-EIO` reply to a
`CreateEngine` that the engine failed with a reason ([runtime.md](runtime.md#protocol-dispatch-and-output)). Its
`message` is that reason.
```

In `docs/core.md`, add after the paragraph that begins `` `router.select(module, engine?)` selects an engine``:

```markdown
Creating a surface's engine can fail. `CreateEngineError` carries the module, the engine and the engine's `reason`,
taken from the runtime's `CreateEngineFailed` record when the engine gave one; otherwise its message names the reply.
`select` reconciles every surface and then rejects with the first such failure; `override` rejects with its surface's.
A surface whose engine failed stays on native input, and its next focus tries again. A failure on focus has no caller
to reject, so it is logged as a warning. The module stays ready, and its other contexts keep working.
```

In `docs/ibus-web.md`, add after the sentence that ends `rejects before anything changes.`:

```markdown
When a focused surface's engine fails to start, `select` rejects with a `CreateEngineError` whose message carries the
engine's reason (for a table engine, the parser's `path:line: reason`), and that surface stays on native input.
```

In `docs/specs/2026-09-26-ibus-web-design.md`, replace `` `ESRCH` for an unregistered engine, `` with `` `ESRCH` for an unregistered engine, `EIO` for a registered engine that wasn't made, ``.

```bash
nix develop -c oxfmt docs/runtime.md docs/protocol.md docs/core.md docs/ibus-web.md docs/specs/2026-09-26-ibus-web-design.md runtime/libibus-web/src/ibus/README.md
nix develop -c hk check -S links
nix run .#write-files
git status --short
```

Expected: oxfmt pads the API table and rewraps the paragraphs; the links step passes; `write-files` leaves nothing new to change.

- [ ] **Step 11: Commit**

```bash
nix develop -c git commit -m "feat(runtime): fail CreateEngine with the engine's reason" -- packages/protocol/src/messages/records.ts packages/protocol/src/index.ts packages/protocol/test/messages/kinds.test.ts packages/protocol/test/messages/codec.test.ts packages/protocol/test/parity/parity.test.ts packages/protocol/test/parity/c/parity.c packages/protocol/PROTOCOL.md runtime/libibus-web/include/ibus-web/protocol.h runtime/libibus-web/include/ibus-web/runtime.h runtime/libibus-web/src/ibus/ibusfactory.c runtime/libibus-web/src/ibus/ibusweb-private.h runtime/libibus-web/src/dispatch.c runtime/libibus-web/tests/test-dispatch.c runtime/libibus-web/src/ibus/README.md packages/core/src/router/router.ts packages/core/src/page/index.ts packages/core/test/browser/router/switching.test.ts docs/runtime.md docs/protocol.md docs/core.md docs/ibus-web.md docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 2: The glue and the side module

**Files:**

- Create: `engines/table/src/glue.cpp`, `engines/table/_package.nix`, `engines/table/side-module.nix`, `engines/table/cast-audit.jsonc`
- Modify: `engines/table/overlay.nix`, `engines/table/options.nix`, `docs/table.md`

**Interfaces:**

- Consumes (B): `ibusweb::table::{Table, ParseError, Candidate, Sink, Session, makeSession, pageSize}`; `config.ibusWeb.engines.table.{sources, tables}`; `pkgsWasm.marisa`. Consumes (Task 1): `ibusweb_factory_fail_create`.
- Produces: `pkgsWasm.ibus-web-table` (a `callPackage` result, so `.override { tables = …; }` works) with `$out/table.wasm` and `passthru` `{ schemas, settingsSchemaDir, tables, auditCflags, auditSources }`; `meta.license.spdxId = "(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C"`; `version = "0.1.0"`. Per-system option `ibusWeb.engines.table.module` (that package) and `packages.ibus-web-table`. Checks `table-imports`, `table-cast-audit`, `table-data-closure`. In the side module: engine names = the `*.table` stems in the table directory; a CreateEngine whose table doesn't parse returns `-EIO` after a `CreateEngineFailed` record on the request's context whose `message` is `ParseError::message()`, and logs nothing.

Facts this task relies on, checked against the repository:

- `IBusEngine`'s `engine-name` is `G_PARAM_CONSTRUCT_ONLY` (`runtime/libibus-web/src/ibus/ibusengine.c`): it is set after instance init and before `constructed`, so the session, which needs the table the name picks, is made in `constructed`.
- `ibusweb_factory_create` (`runtime/libibus-web/src/ibus/ibusfactory.c`) emits `create-engine`, a `G_SIGNAL_RUN_LAST` signal whose accumulator continues past a handler that returns `NULL`. A handler that returns `NULL` lets the class handler make the engine; one that calls `ibusweb_factory_fail_create(reason)` (Task 1) stops the emission, so CreateEngine replies `-EIO` after a `CreateEngineFailed` record carrying the reason, and the page's `select` rejects with a `CreateEngineError` whose `reason` it is, leaving the field to native input.
- `write_log` (`runtime/libibus-web/src/log.c`) turns every `g_warning` into a `Log` record on context 0, `(level, domain, message)`.
- The panel shows `<label> <candidate text>` and sends a page-relative `CandidateClicked` index (`docs/panel.md`).
- `checkSideModuleLibraries` (`runtime/ibus-runtime/side-module-libs.sh`) rejects a link library the runtime carries; `-lmarisa` isn't one.
- Hand-registering the type with `g_type_register_static_simple` and callbacks of exactly `GClassInitFunc`/`GInstanceInitFunc` types leaves no function-pointer cast for the audit; `G_DEFINE_TYPE`'s instance-init adapter would add one.

- [ ] **Step 1: Check what Plan B left**

```bash
nix develop -c ls engines/table/src/table.hpp engines/table/src/session.hpp engines/table/src/sink.hpp engines/table/_marisa.nix engines/table/options.nix engines/table/overlay.nix LICENSES/W3C.txt docs/table.md
nix develop -c grep -n "sources\|tables\|tools" engines/table/options.nix
```

Expected: every file listed; `options.nix` declares `sources`, `tables` and `tools`. `options.nix`'s `sources` is `command.cpp continuous.cpp session.cpp table.cpp utf8.cpp`. If a file is missing, stop and reconcile with Plan B.

- [ ] **Step 2: Write the failing check**

```bash
nix build .#packages.x86_64-linux.ibus-web-table -L
```

Expected: FAIL, `does not provide attribute 'packages.x86_64-linux.ibus-web-table'`.

- [ ] **Step 3: Write `engines/table/src/glue.cpp`**

```cpp
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
#define G_LOG_DOMAIN "ibus-web-table"

#include "session.hpp"
#include "sink.hpp"
#include "table.hpp"

#include <algorithm>
#include <cstddef>
#include <exception>
#include <expected>
#include <filesystem>
#include <functional>
#include <ibus-web/runtime.h>
#include <ibus.h>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

using ibusweb::table::Candidate;
using ibusweb::table::makeSession;
using ibusweb::table::pageSize;
using ibusweb::table::Session;
using ibusweb::table::Sink;
using ibusweb::table::Table;

// A store path, compiled in so that the tables stay in the side module's
// data closure. Each engine is named for its table's file.
constexpr char tableDir[] = IBUSWEB_TABLE_DIR;

// Parsed on first use and kept for the module's lifetime, which is the
// Worker's: sessions hold their table by reference.
std::map<std::string, Table, std::less<>> tables;

// The engine's table, parsed on first use, or the parser's path:line: reason
// if it doesn't parse.
std::expected<const Table *, std::string> loadTable(std::string_view name) {
  if (auto found = tables.find(name); found != tables.end())
    return &found->second;

  auto table = Table::load(std::filesystem::path(tableDir) /
                           (std::string(name) + ".table"));
  if (!table)
    return std::unexpected(table.error().message());
  return &tables.emplace(std::string(name), *std::move(table)).first->second;
}

// An engine instance's C++ half: its session, and the Sink the session
// writes to, which turns what it writes into the engine's output.
class Context final : public Sink {
public:
  explicit Context(IBusEngine *engine) : engine_(engine) {}

  void start(const Table &table) { session_ = makeSession(table, *this); }

  Session *session() const { return session_.get(); }

  // The panel counts a click's index from the visible page's first
  // candidate. A position no candidate holds is ignored.
  void clicked(guint index) {
    if (session_ && index < pageLength_)
      session_->candidateClicked(pageStart_ + index);
  }

  void reset() {
    if (session_)
      session_->reset();
    pageStart_ = pageLength_ = 0;
  }

  void commit(std::string_view text) override {
    ibus_engine_commit_text(engine_,
                            ibus_text_new_from_string(std::string(text).c_str()));
  }

  void preedit(std::string_view text) override {
    if (text.empty()) {
      ibus_engine_update_preedit_text_with_mode(
          engine_, ibus_text_new_from_static_string(""), 0, FALSE,
          IBUS_ENGINE_PREEDIT_COMMIT);
      return;
    }

    IBusText *shown = ibus_text_new_from_string(std::string(text).c_str());
    const guint length = ibus_text_get_length(shown);
    ibus_text_append_attribute(shown, IBUS_ATTR_TYPE_UNDERLINE,
                               IBUS_ATTR_UNDERLINE_SINGLE, 0,
                               static_cast<gint>(length));
    ibus_engine_update_preedit_text_with_mode(engine_, shown, length, TRUE,
                                              IBUS_ENGINE_PREEDIT_COMMIT);
  }

  // Only the cursor's page goes to the panel: a bare trigger completes to
  // every command in the table, thousands of candidates.
  void candidates(std::span<const Candidate> all, std::size_t cursor,
                  bool cursorShown) override {
    if (all.empty()) {
      pageStart_ = pageLength_ = 0;
      ibus_engine_hide_lookup_table(engine_);
      return;
    }

    pageStart_ = cursor / pageSize * pageSize;
    pageLength_ = std::min(pageSize, all.size() - pageStart_);
    IBusLookupTable *table =
        ibus_lookup_table_new(pageSize, 0, cursorShown, FALSE);
    for (const Candidate &candidate : all.subspan(pageStart_, pageLength_)) {
      const std::string text = candidate.output + " " + candidate.key;
      ibus_lookup_table_append_candidate(
          table, ibus_text_new_from_string(text.c_str()));
    }
    ibus_lookup_table_set_cursor_pos(table, cursor - pageStart_);
    ibus_engine_update_lookup_table(engine_, table, TRUE);
  }

private:
  IBusEngine *engine_;
  std::unique_ptr<Session> session_;
  std::size_t pageStart_ = 0;
  std::size_t pageLength_ = 0;
};

// GObject allocates instances as zeroed C memory, so the C++ half lives
// behind a pointer: made in instance init, deleted in finalize.
struct Engine {
  IBusEngine parent;
  Context *context;
};

struct EngineClass {
  IBusEngineClass parent;
};

GObjectClass *parentClass;

Engine *engineOf(gpointer instance) { return static_cast<Engine *>(instance); }

Session *sessionOf(IBusEngine *engine) {
  return engineOf(engine)->context->session();
}

gboolean processKeyEvent(IBusEngine *engine, guint keyval, guint, guint state) {
  Session *session = sessionOf(engine);
  return session != nullptr &&
         session->processKey(keyval, ibus_keyval_to_unicode(keyval), state);
}

void resetEngine(IBusEngine *engine) { engineOf(engine)->context->reset(); }

void pageUp(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->pageUp();
}

void pageDown(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->pageDown();
}

void cursorUp(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->cursorUp();
}

void cursorDown(IBusEngine *engine) {
  if (Session *session = sessionOf(engine))
    session->cursorDown();
}

void candidateClicked(IBusEngine *engine, guint index, guint, guint) {
  engineOf(engine)->context->clicked(index);
}

// engine-name, which picks the table, is a construct property, so it is
// first readable here. The factory's handler has loaded the table by now.
void constructed(GObject *object) {
  parentClass->constructed(object);

  Engine *self = engineOf(object);
  if (auto found = tables.find(ibus_engine_get_name(&self->parent));
      found != tables.end())
    self->context->start(found->second);
}

void finalize(GObject *object) {
  delete engineOf(object)->context;
  parentClass->finalize(object);
}

void classInit(gpointer klass, gpointer) {
  parentClass = static_cast<GObjectClass *>(g_type_class_peek_parent(klass));

  auto *object = static_cast<GObjectClass *>(klass);
  object->constructed = constructed;
  object->finalize = finalize;

  auto *engine = static_cast<IBusEngineClass *>(klass);
  engine->process_key_event = processKeyEvent;
  engine->focus_out = resetEngine;
  engine->reset = resetEngine;
  engine->page_up = pageUp;
  engine->page_down = pageDown;
  engine->cursor_up = cursorUp;
  engine->cursor_down = cursorDown;
  engine->candidate_clicked = candidateClicked;
}

void instanceInit(GTypeInstance *instance, gpointer) {
  Engine *self = engineOf(instance);
  self->context = new Context(&self->parent);
}

GType engineType() {
  static const GType type = g_type_register_static_simple(
      IBUS_TYPE_ENGINE, g_intern_static_string("IBusWebTableEngine"),
      sizeof(EngineClass), classInit, sizeof(Engine), instanceInit,
      static_cast<GTypeFlags>(0));
  return type;
}

// Runs before the factory's own handler, which makes the engine. A table that
// doesn't parse fails CreateEngine with the parser's message, which also
// stops the emission, so no engine is made. An exception unwinding through
// GLib's emission would leave the runtime faulted, so none leaves here.
IBusEngine *createEngine(IBusFactory *, const gchar *name, gpointer) {
  std::string failure;
  try {
    if (auto table = loadTable(name); !table)
      failure = std::move(table.error());
  } catch (const std::exception &error) {
    failure = std::string(name) + ": " + error.what();
  }

  if (!failure.empty())
    ibusweb_factory_fail_create(failure.c_str());
  return nullptr;
}

std::vector<std::string> engineNames() {
  std::vector<std::string> names;
  std::error_code error;
  for (std::filesystem::directory_iterator entry(tableDir, error), end;
       !error && entry != end; entry.increment(error))
    if (entry->path().extension() == ".table")
      names.push_back(entry->path().stem().string());

  if (error)
    g_warning("%s: %s", tableDir, error.message().c_str());
  return names;
}

} // namespace

// Keeps the compiled panel schema, which the module's settings metadata
// lists, in the side module's data closure.
extern "C" const char ibusweb_table_settings_schema_dir[] =
    IBUSWEB_SETTINGS_SCHEMA_DIR;

void ibusweb_module_init(IBusWebModule *) {
  IBusFactory *factory = ibus_factory_new(nullptr);
  g_object_ref_sink(factory);
  g_signal_connect(factory, "create-engine", G_CALLBACK(createEngine), nullptr);
  for (const std::string &name : engineNames())
    ibus_factory_add_engine(factory, name.c_str(), engineType());
  g_object_unref(factory);
}
```

- [ ] **Step 4: Write `engines/table/_package.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  lib,
  stdenv,
  runCommand,
  pkg-config,
  glib,
  libibus-web,
  marisa,
  sideModuleFlags,
  sideModuleLibraryGuard,
  sources,
  tables,
}:
let
  # The panel reads its candidate orientation from this schema.
  schemas = runCommand "ibus-web-table-gsettings-schemas" { } ''
    mkdir -p $out/share/glib-2.0/schemas
    cp ${libibus-web}/share/gsettings-schemas/${libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
      $out/share/glib-2.0/schemas/
    ${glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
  '';
  settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";

  # Both directories are compiled in as store paths, which makes them the
  # side module's data closure.
  cflags = lib.concatStringsSep " " [
    "-std=c++23"
    "'-DIBUSWEB_TABLE_DIR=\"${tables}\"'"
    "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
  ];

  # Relative to src/, which is the build's working directory.
  files = sources ++ [ "glue.cpp" ];
  objects = map (file: "${lib.removeSuffix ".cpp" file}.o") files;
in
stdenv.mkDerivation {
  pname = "ibus-web-table";
  version = "0.1.0";
  src = ./src;

  nativeBuildInputs = [ pkg-config ];
  buildInputs = [
    libibus-web
    marisa
  ];
  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    cflags=(${cflags} $($PKG_CONFIG --cflags ibus-1.0 libibus-web marisa))
    for file in ${lib.escapeShellArgs files}; do
      $CXX "''${cflags[@]}" -c "$file" -o "''${file%.cpp}.o"
    done

    libs="$($PKG_CONFIG --static --libs marisa)"
    source ${sideModuleLibraryGuard}
    checkSideModuleLibraries $libs

    $CXX ${sideModuleFlags} -g0 ${lib.escapeShellArgs objects} $libs -o table.wasm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 table.wasm -t $out
    runHook postInstall
  '';

  passthru = {
    inherit schemas settingsSchemaDir tables;
    auditCflags = cflags;
    auditSources = files;
  };

  # The engine is ours; MARISA is linked in under its BSD-2-Clause option,
  # and the LaTeX table's data is W3C's.
  meta.license = {
    spdxId = "(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C";
    fullName = "MIT OR Apache-2.0, with BSD-2-Clause MARISA and W3C data";
    free = true;
    redistributable = true;
  };
}
```

- [ ] **Step 5: Add `ibus-web-table` to B's overlay**

The overlay needs the per-system `runtime`, `toolchain` and `engines.table` values, so its attribute set moves inside `withSystem`, as Hangul's does. Rewrite `engines/table/overlay.nix` so it reads as below, keeping B's `marisa` line exactly as B wrote it:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm;
in
{
  flake.overlays.table =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, ... }:
        let
          inherit (config.ibusWeb) runtime toolchain;
        in
        {
          marisa = final.callPackage ./_marisa.nix { inherit (prev) marisa; };

          ibus-web-table = final.callPackage ./_package.nix {
            inherit (toolchain) sideModuleFlags;
            inherit (runtime) sideModuleLibraryGuard;
            inherit (config.ibusWeb.engines.table) sources tables;
          };
        }
      )
    );
}
```

- [ ] **Step 6: Declare `ibusWeb.engines.table.module`**

In `engines/table/options.nix`, add this beside B's `tables`, `tools` and `sources` inside `options.ibusWeb.engines.table`:

```nix
      module = lib.mkOption {
        type = lib.types.package;
        description = "The table side module, table.wasm, whose store references are its tables and settings schema.";
      };
```

- [ ] **Step 7: Write `engines/table/cast-audit.jsonc`**

```jsonc
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
{
  "$schema": "../../tools/cast-audit/cast-audit.schema.json",
  "casts": [],
}
```

- [ ] **Step 8: Write `engines/table/side-module.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines runtime toolchain;
      table = toolchain.pkgsWasm.ibus-web-table;
    in
    {
      ibusWeb.engines.table.module = table;

      packages.ibus-web-table = table;

      ibusWeb.toolchain.clangdPathFlags."engines/table/src/glue\\.cpp" = [
        "-std=c++23"
        ''-DIBUSWEB_TABLE_DIR="${table.tables}"''
        ''-DIBUSWEB_SETTINGS_SCHEMA_DIR="${table.settingsSchemaDir}"''
      ];

      # The data closure is the tables and the compiled schema, nothing else.
      checks.table-data-closure = pkgs.runCommand "ibus-web-table-data-closure" { } ''
        closure=${pkgs.closureInfo { rootPaths = [ table ]; }}/store-paths
        grep -Fx ${table.tables} "$closure"
        grep -Fx ${table.schemas} "$closure"
        test "$(wc -l < "$closure")" = 3
        test -f ${table.settingsSchemaDir}/gschemas.compiled

        while IFS= read -r path; do
          if [ "$path" = ${table} ]; then continue; fi
          forbidden=$(find "$path" \( -name lib -o -name include -o -name '*.a' -o -name '*.wasm' -o -name '*.pc' \) -print)
          if [ -n "$forbidden" ]; then echo "non-data closure entries: $forbidden" >&2; exit 1; fi
        done < "$closure"

        cp "$closure" $out
      '';

      checks.table-imports = runtime.checkSideModuleImports {
        name = "table";
        modules = [ "${table}/table.wasm" ];
      };

      checks.table-cast-audit = engines.castAudit {
        name = "table";
        inherit (table) src;
        sources = table.auditSources;
        cflags = table.auditCflags;
        buildInputs = [
          runtime.libibusWeb
          toolchain.pkgsWasm.marisa
        ];
        pkgConfigModules = [
          "ibus-1.0"
          "libibus-web"
          "marisa"
        ];
        allowList = ./cast-audit.jsonc;
      };
    };
}
```

- [ ] **Step 9: Build the side module**

```bash
nix develop -c git add engines/table/src/glue.cpp engines/table/_package.nix engines/table/side-module.nix engines/table/cast-audit.jsonc engines/table/overlay.nix engines/table/options.nix
nix build .#packages.x86_64-linux.ibus-web-table -L
ls result/
```

Expected: the build succeeds; `result/` holds only `table.wasm`.

- [ ] **Step 10: Run the side module's checks**

```bash
nix build .#checks.x86_64-linux.table-imports .#checks.x86_64-linux.table-cast-audit .#checks.x86_64-linux.table-data-closure .#checks.x86_64-linux.toolchain-clangd -L
```

Expected: all four pass. `table-cast-audit`'s report is empty; a finding means a callback whose type differs from the field it is stored in: fix its signature, never allow-list it. `table-data-closure` lists three store paths: the module, the tables, the schemas. An import `table-imports` rejects means the code calls something the runtime doesn't export: change the call.

- [ ] **Step 11: Describe the glue in `docs/table.md`**

Append this section to the end of `docs/table.md`:

```markdown
## In the browser

`engines/table/src/glue.cpp` is the module's only GObject code. One `IBusEngine` subclass, `IBusWebTableEngine`,
serves every engine, and its `engine-name` picks the table. That name is a construct property, set after instance
init, so an instance makes its session in `constructed` and destroys it in `finalize`. The type is registered by hand
with callbacks of exactly the types GLib calls them through, which leaves the cast audit nothing to allow.

`ibusweb_module_init` registers an engine for every `*.table` in the table directory, named for its file. A handler on
the factory's `create-engine` signal runs before the factory makes the engine: it parses the engine's table on first
use and keeps it in a module-level map for the Worker's life, shared by every context of that engine. A table that
doesn't parse fails `CreateEngine` with the parser's `path:line: reason` through `ibusweb_factory_fail_create`, which
stops the emission: the reply is `-EIO`, the page receives the reason in a `CreateEngineFailed` record and `select`
rejects with it, and the field stays on native input. No exception crosses GLib's signal emission, which would leave
the runtime faulted.

The glue is the session's `Sink`:

- `commit` commits the text.
- `preedit` shows the raw buffer, underlined, in COMMIT mode, with the cursor at its end. Empty, it clears and hides
  the preedit.
- `candidates` sends only the cursor's page of 10, each candidate as its output and key (`α \alpha`), since a bare
  trigger completes to every command in the table. Empty, it hides the lookup table. The panel's click index counts
  from the visible page, and the glue adds the page's start; a position no candidate holds is ignored.

A key's character is `ibus_keyval_to_unicode(keyval)`. FocusOut and Reset reset the session, which emits nothing.
PageUp, PageDown, CursorUp and CursorDown go to the session.

`pkgsWasm.ibus-web-table` (`engines/table/_package.nix`) compiles `ibusWeb.engines.table.sources` and the glue as
C++23 with the runtime's toolchain and side-module flags, and links `pkgsWasm.marisa` into `table.wasm` statically;
the runtime's library guard rejects a library the runtime carries. The table directory and the compiled
`org.freedesktop.ibus.panel` schema are compiled in as store paths, which makes them the side module's whole data
closure.

| Check                | Covers                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| `table-imports`      | `table.wasm` imports only what the runtime exports                             |
| `table-cast-audit`   | every source, glue included, under `-Wcast-function-type-strict`, with an empty allow-list |
| `table-data-closure` | the closure is the module, the tables and the compiled schema, all of them data |
```

Then format it:

```bash
nix develop -c oxfmt docs/table.md
nix develop -c hk check -S links
```

Expected: oxfmt rewrites the table's padding; the links step passes.

- [ ] **Step 12: Commit**

```bash
nix develop -c git add docs/table.md
nix develop -c git commit -m "feat(table): build the table engine as a side module" -- engines/table/src/glue.cpp engines/table/_package.nix engines/table/side-module.nix engines/table/cast-audit.jsonc engines/table/overlay.nix engines/table/options.nix docs/table.md
```

---

### Task 3: Engine-module suites in the worker-host tests

The worker-host's Node configuration runs Hangul's suite from three Hangul-specific environment variables. This task makes it run any module's suite from one description, so `table-host` can add a second suite without a second code path. Behaviour is unchanged: `hangul-host` passes before and after.

**Files:**

- Modify: `packages/worker-host/test/node/config.ts`, `packages/worker-host/test/engines/page-session.ts`, `packages/worker-host/test/engines/hangul.test.ts`, `engines/hangul/checks/host/checks.nix`, `docs/worker-host.md`

**Interfaces:**

- Consumes (A): `ModuleManifest` from `@ibus-web/protocol`.
- Produces: environment variable `IBUS_WEB_MODULE_TESTS`, naming a JSON file `{ "suite": string, "dists": { [name]: dir }, "heapBytes": number, "poolBase": number, "texts": { [name]: file } }`; Vitest's provided `module: ModuleBuild`:

  ```ts
  export interface ModuleBuild {
    manifests: Readonly<Record<string, ModuleManifest>>;
    heapBytes: number;
    poolBase: number;
    texts: Readonly<Record<string, string>>;
  }
  ```

  `PageSession.start(h, runtime, manifest: ModuleManifest, options: SessionOptions)` with
  `interface SessionOptions { settings: Init["settings"]; engine: string; ready?: (session: PageSession, ic: number) => Promise<unknown> }`;
  `session.create(ic, engine = options.engine)`; `session.key(ic, keyval, keycode, ret = 1)`, `session.request(ic, request, ret = 0)`, `session.stats()` as before. `CAPABILITIES` and `Key` stay exported from `page-session.ts`.

- [ ] **Step 1: Confirm the suite passes before the change**

```bash
nix build .#checks.x86_64-linux.hangul-host -L
```

Expected: PASS, 20 tests.

- [ ] **Step 2: Rewrite `packages/worker-host/test/engines/page-session.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CreateEngine,
  FocusIn,
  IBusCapability,
  Init,
  ProcessKeyEvent,
  PROTOCOL_VERSION,
  ReqMode,
  SetCapabilities,
  encodeRequest,
  type DecodedRecord,
  type ModuleManifest,
  type Request,
} from "@ibus-web/protocol";
import { expect } from "vitest";
import type { Harness, RuntimeBuild, RunningHost } from "../shared/harness.ts";
import { HostOp, type HostStats } from "../shared/testing.ts";

export const CAPABILITIES =
  IBusCapability.PREEDIT_TEXT |
  IBusCapability.AUXILIARY_TEXT |
  IBusCapability.LOOKUP_TABLE |
  IBusCapability.FOCUS |
  IBusCapability.SURROUNDING_TEXT;
export const Key = {
  hangul: [0xff31, 122],
  f8: [0xffc5, 66],
  f9: [0xffc6, 67],
  pageDown: [0xff56, 109],
  space: [32, 57],
} as const;

// What a module's suite runs against: its distributions' manifests by name,
// with URLs as this environment fetches them, the program break and pool
// it is held to, and texts its build computed.
export interface ModuleBuild {
  manifests: Readonly<Record<string, ModuleManifest>>;
  heapBytes: number;
  poolBase: number;
  texts: Readonly<Record<string, string>>;
}
declare module "vitest" {
  interface ProvidedContext {
    module: ModuleBuild;
  }
}

export interface SessionOptions {
  settings: Init["settings"];
  // The engine create() makes unless told another.
  engine: string;
  // Runs once a context's engine is created and focused.
  ready?: (session: PageSession, ic: number) => Promise<unknown>;
}

// Every exchange checks the output barrier, including requests that emit
// nothing. A warning, critical or error fails it.
export class PageSession {
  private lastSeq = 0;
  readonly host: RunningHost;
  private readonly options: SessionOptions;
  private constructor(host: RunningHost, options: SessionOptions) {
    this.host = host;
    this.options = options;
  }

  static async start(
    h: Harness,
    runtime: RuntimeBuild,
    manifest: ModuleManifest,
    options: SessionOptions,
  ): Promise<PageSession> {
    const engine = { ...manifest, name: `${manifest.name}-${runtime.name}-${crypto.randomUUID()}` };
    const host = await h.start({
      runtime,
      manifest: engine,
      storage: h.storage(engine),
      test: { sides: h.sides.filter((side) => side.name === "settings") },
    });
    const session = new PageSession(host, options);
    try {
      await session.request(0, new Init({ version: PROTOCOL_VERSION, settings: options.settings }));
      await session.create(1);
      return session;
    } catch (error) {
      await host.terminate();
      throw error;
    }
  }

  private checkRecords(outSeq: number): DecodedRecord[] {
    const records = this.host.client.page.records();
    for (const { seq, record } of records) {
      if (seq !== 0) {
        expect(seq).toBe((this.lastSeq + 1) >>> 0 || 1);
        this.lastSeq = seq;
      }
      if (record._tag === "Log") expect(record.level & (4 | 8 | 16), record.message).toBe(0);
    }
    expect(outSeq).toBe(this.lastSeq);
    return records;
  }

  async request(ic: number, request: Request, ret = 0): Promise<DecodedRecord[]> {
    this.host.client.page.post(encodeRequest(ic, request), ReqMode.sync);
    const reply = await this.host.client.page.waitForReply();
    expect(reply.ret, request._tag).toBe(ret);
    return this.checkRecords(reply.outSeq);
  }

  async key(ic: number, keyval: number, keycode: number, ret = 1): Promise<DecodedRecord[]> {
    const press = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 0 }), ret);
    const release = await this.request(ic, new ProcessKeyEvent({ keyval, keycode, state: 1 << 30 }), 0);
    return [...press, ...release];
  }

  async create(ic: number, engine = this.options.engine): Promise<void> {
    await this.request(ic, new CreateEngine({ name: engine }));
    await this.request(ic, new SetCapabilities({ capabilities: CAPABILITIES }));
    await this.request(ic, new FocusIn({}));
    await this.options.ready?.(this, ic);
  }

  async writeStringSetting(kind: number, schema: string, key: string, value: string): Promise<DecodedRecord[]> {
    const payload = new TextEncoder().encode([schema, key, value, ""].join("\0"));
    const reply = await this.host.client.call(kind, payload);
    expect(reply.ret).toBe(4);
    expect(new DataView(reply.bytes.buffer, reply.bytes.byteOffset).getInt32(0, true)).toBe(1);
    return this.checkRecords(reply.outSeq);
  }

  async stats(): Promise<HostStats> {
    const reply = await this.host.client.call(HostOp.stats);
    this.checkRecords(reply.outSeq);
    return JSON.parse(new TextDecoder().decode(reply.bytes)) as HostStats;
  }
}
```

- [ ] **Step 3: Point `hangul.test.ts` at the generic session**

In `packages/worker-host/test/engines/hangul.test.ts`, replace

```ts
import { CAPABILITIES, HANGUL_SCHEMA, Key, PageSession } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("hangul");
```

with

```ts
import { CAPABILITIES, Key, PageSession, type SessionOptions } from "./page-session.ts";

const HANGUL_SCHEMA = "org.freedesktop.ibus.engine.hangul";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["hangul"]!;
const options: SessionOptions = {
  settings: { [HANGUL_SCHEMA]: { "hanja-keys": stringVariant("Hangul_Hanja,F9,F8") } },
  engine: "hangul",
  ready: (session, ic) => session.key(ic, ...Key.hangul),
};
```

replace `session = await PageSession.start(h, runtime, build.manifest);` with
`session = await PageSession.start(h, runtime, manifest, options);`, and replace every remaining `build.manifest.` with
`manifest.` (each is `build.manifest.threads`, in the `afterEach`, the `afterAll` record and the resources test).

```bash
nix develop -c grep -n "build.manifest\|HANGUL_SCHEMA\|inject(" packages/worker-host/test/engines/hangul.test.ts
```

Expected: no `build.manifest`; `HANGUL_SCHEMA` defined once and used by the tests; `inject("module")`.

- [ ] **Step 4: Make `config.ts` generic over modules**

In `packages/worker-host/test/node/config.ts`:

Add to the end of the file's opening comment block, after the paragraph ending `as are the host's own scripts from dist/.`:

```ts
//
// IBUS_WEB_MODULE_TESTS, when set, names a JSON description of an engine
// module's suite, which then runs under Node in place of the host's own:
//
//   { "suite": NAME, "dists": { NAME: DIR }, "heapBytes": N, "poolBase": N,
//     "texts": { NAME: FILE } }
//
// The suite is test/engines/<suite>.test.ts. Each DIR is a module
// distribution, served as module-<NAME>; each text is its FILE's contents.
```

Replace the import `import type { EngineManifest } from "@ibus-web/protocol";` (after Plan A: `ModuleManifest`) with

```ts
import type { ModuleManifest } from "@ibus-web/protocol";
```

and rename any other `EngineManifest` in the file to `ModuleManifest`.

After `readManifest`, add:

```ts
interface ModuleTests {
  suite: string;
  dists: Record<string, string>;
  heapBytes: number;
  poolBase: number;
  texts: Record<string, string>;
}

const readModuleTests = (): ModuleTests | undefined => {
  const path = process.env["IBUS_WEB_MODULE_TESTS"];
  return path === undefined ? undefined : readJson<ModuleTests>(path);
};

// A module distribution's manifest, its files' URLs under base.
const moduleManifest = (dir: string, base: string): ModuleManifest => {
  const manifest = readJson<ModuleManifest>(join(dir, "manifest.json"));
  return {
    ...manifest,
    module: { ...manifest.module, url: `${base}${manifest.module.url}` },
    data: manifest.data.map((entry) => ({ ...entry, url: `${base}${entry.url}` })),
  };
};
```

In `workerHostConfig`, replace

```ts
  const hangulPath = process.env["IBUS_WEB_HANGUL_MANIFEST"];
  const hangul = hangulPath === undefined ? undefined : readJson<EngineManifest>(hangulPath);
  const hangulDir = hangulPath === undefined ? undefined : fileURLToPath(new URL(".", pathToFileURL(hangulPath)));
```

with

```ts
  const moduleTests = readModuleTests();
  const moduleDirs = Object.fromEntries(
    Object.entries(moduleTests?.dists ?? {}).map(([name, dir]) => [`module-${name}`, dir]),
  );
```

replace

```ts
        ...(hangulDir === undefined ? {} : { hangul: hangulDir }),
```

with

```ts
        ...moduleDirs,
```

replace

```ts
        include: [hangul === undefined ? "test/node/**/*.test.ts" : "test/engines/**/*.test.ts"],
```

with

```ts
        include: [
          moduleTests === undefined ? "test/node/**/*.test.ts" : `test/engines/${moduleTests.suite}.test.ts`,
        ],
```

and replace the whole `...(hangul === undefined ? {} : { hangul: { … } }),` entry of `provide` with

```ts
          ...(moduleTests === undefined
            ? {}
            : {
                module: {
                  manifests: Object.fromEntries(
                    Object.entries(moduleTests.dists).map(([name, dir]) => [
                      name,
                      moduleManifest(dir, `${nodeOrigin}${prefix}module-${name}/`),
                    ]),
                  ),
                  heapBytes: moduleTests.heapBytes,
                  poolBase: moduleTests.poolBase,
                  texts: Object.fromEntries(
                    Object.entries(moduleTests.texts).map(([name, file]) => [name, readFileSync(file, "utf8")]),
                  ),
                },
              }),
```

```bash
nix develop -c grep -n "hangul\|HANGUL" packages/worker-host/test/node/config.ts
```

Expected: no match.

- [ ] **Step 5: Describe Hangul's suite in the new format**

Replace `engines/hangul/checks/host/checks.nix` with:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) testing typescript runtime;
      dist = config.packages.ibus-web-hangul-dist;
    in
    {
      checks.hangul-host = testing.vitestCheck {
        name = "hangul-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-hangul-host-tests.json" (
            builtins.toJSON {
              suite = "hangul";
              dists.hangul = "${dist}";
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;
              texts = { };
            }
          );
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
```

- [ ] **Step 6: Run the suite again**

```bash
nix build .#checks.x86_64-linux.hangul-host .#checks.x86_64-linux.worker-host-node -L
nix develop -c hk check -S tsc packages/worker-host/test/engines/page-session.ts packages/worker-host/test/engines/hangul.test.ts packages/worker-host/test/node/config.ts
```

Expected: `hangul-host` passes with the same 20 tests; `worker-host-node` passes; hk's `tsc` step reports nothing.

- [ ] **Step 7: Document module suites in `docs/worker-host.md`**

After the paragraph that ends `it verifies \`SettingWritten\` transport, not an upstream UI action.`, add:

```markdown
An engine module's suite, `test/engines/<suite>.test.ts`, runs under Node in place of the host's own suites when
`IBUS_WEB_MODULE_TESTS` names its description: the module distributions it starts hosts from, the program break and
pool it is held to, and texts its build computed. Its `PageSession` takes the Init settings, the engine each context
creates and what follows creation; a warning, critical or error record fails the exchange that brought it.
`checks.hangul-host` and `checks.table-host` are such suites.
```

```bash
nix develop -c oxfmt docs/worker-host.md
```

- [ ] **Step 8: Commit**

```bash
nix develop -c git commit -m "refactor(worker-host): run any engine module's host suite" -- packages/worker-host/test/node/config.ts packages/worker-host/test/engines/page-session.ts packages/worker-host/test/engines/hangul.test.ts engines/hangul/checks/host/checks.nix docs/worker-host.md
```

---

### Task 4: The distribution and `table-host`

**Files:**

- Create: `engines/table/dist.nix`, `engines/table/checks/host/checks.nix`, `engines/table/checks/host/broken.table`, `packages/worker-host/test/engines/table.test.ts`
- Modify: `docs/engines.md`, `docs/table.md`, `docs/testing.md`

**Interfaces:**

- Consumes: Task 2's `ibusWeb.engines.table.module` (with `.override { tables }`, `.settingsSchemaDir`); B's `ibusWeb.engines.table.{tables, tools}`; A's `mkEngineManifest`; Task 3's `IBUS_WEB_MODULE_TESTS`, `PageSession`, `SessionOptions`, `Key`, `inject("module")`.
- Produces: `packages.ibus-web-table-dist` (manifest `name = "table"`, engines `latex` then `xsampa`, `settingsSchemas = [ "org.freedesktop.ibus.panel" ]`, `passthru.heapBytes`); `checks.table-host`; the record lines `Table <runtime> LaTeX load: {"firstMs":…,"cachedMs":…}` and `Table <runtime> suite peaks: {…}` in the check's `output.txt`.

- [ ] **Step 1: Write the distribution, `engines/table/dist.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) engines;
      inherit (config.ibusWeb.engines) table;

      # Each engine's descriptor comes from its table's frontmatter. LaTeX,
      # listed first, is the module's default.
      descriptors = pkgs.runCommand "ibus-web-table-engines.json" { } ''
        ${table.tools}/bin/table-describe ${table.tables}/latex.table ${table.tables}/xsampa.table > $out
      '';
    in
    {
      packages.ibus-web-table-dist = engines.mkEngineManifest {
        name = "table";
        package = table.module;

        # Checked against table-host's measured peaks, both tables loaded.
        threads = 0;
        heapBytes = 8 * 1024 * 1024;

        inherit (table.module) settingsSchemaDir;
        engines = descriptors;
        settingsSchemas = [ "org.freedesktop.ibus.panel" ];
      };
    };
}
```

```bash
nix develop -c git add engines/table/dist.nix
nix build .#packages.x86_64-linux.ibus-web-table-dist -L
nix develop -c jq '{ name, license, engines: [.engines[].name], settingsSchemas }' result/manifest.json
```

Expected: `{"name":"table","license":"(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C","engines":["latex","xsampa"],"settingsSchemas":["org.freedesktop.ibus.panel"]}` (pretty-printed); `result/` holds `manifest.json`, `settings.json`, `table.wasm` and `data/` with two archives.

- [ ] **Step 2: Write the broken fixture, `engines/table/checks/host/broken.table`**

The gap on the `\a` line is one tab; the `\b` line has none, which is the error.

```
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
# A command table whose second mapping has no output.
name = Broken
languages = und
mode = command
trigger = \
---
\a	α
\b
```

```bash
nix develop -c grep -c "$(printf '\t')" engines/table/checks/host/broken.table
```

Expected: `1`.

- [ ] **Step 3: Write the failing suite, `packages/worker-host/test/engines/table.test.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import {
  CandidateClicked,
  CreateEngine,
  FocusIn,
  FocusOut,
  PageDown,
  Reset,
  type DecodedRecord,
  type OutputRecord,
} from "@ibus-web/protocol";
import { afterAll, afterEach, describe, expect, inject, test } from "vitest";
import { nodeHarness } from "../node/harness.ts";
import { Key, PageSession, type SessionOptions } from "./page-session.ts";

const h = await nodeHarness();
const build = inject("module");
const manifest = build.manifests["table"]!;
afterAll(() => h.cleanUp());

const latex: SessionOptions = { settings: {}, engine: "latex" };
const xsampa: SessionOptions = { settings: {}, engine: "xsampa" };

const tags = (records: DecodedRecord[]) => records.map(({ record }) => record._tag);
const last = <Tag extends OutputRecord["_tag"]>(
  records: DecodedRecord[],
  tag: Tag,
): Extract<OutputRecord, { _tag: Tag }> => {
  const record = records.filter(({ record }) => record._tag === tag).at(-1)?.record;
  expect(record, tag).toBeDefined();
  return record as Extract<OutputRecord, { _tag: Tag }>;
};
const committed = (records: DecodedRecord[]): string =>
  records.map(({ record }) => (record._tag === "CommitText" ? record.text.text : "")).join("");

// Types ASCII, whose keysyms are its code points, expecting every key to be
// consumed.
const typeText = async (session: PageSession, ic: number, text: string): Promise<DecodedRecord[]> => {
  const records: DecodedRecord[] = [];
  for (const character of text) records.push(...(await session.key(ic, character.codePointAt(0)!, 0)));
  return records;
};

describe.each(h.data.runtimes)("the table module through $name host", (runtime) => {
  let current: PageSession | undefined;
  let breakPeak = 0;
  const start = async (options: SessionOptions, dist = manifest): Promise<PageSession> => {
    current = await PageSession.start(h, runtime, dist, options);
    return current;
  };
  afterEach(async () => {
    const running = current;
    current = undefined;
    if (running === undefined) return;
    try {
      const stats = await running.stats();
      breakPeak = Math.max(breakPeak, stats.breakPeak);
      expect(stats.activeThreadsAtRuntimeStart).toBe(0);
      expect(stats.activeThreadsPeak).toBeLessThanOrEqual(manifest.threads);
      expect(stats.breakPeak).toBeGreaterThan(0);
      expect(stats.breakPeak).toBeLessThanOrEqual(build.heapBytes);
      expect(stats.poolWorkersPeak).toBeLessThanOrEqual(build.poolBase + manifest.threads);
    } finally {
      await running.host.terminate();
    }
  });
  afterAll(() => h.record(`Table ${runtime.name} suite peaks`, { breakPeak, heapBytes: build.heapBytes }));

  test("LaTeX shows \\alpha underlined with its candidates and commits α on Space", async () => {
    const session = await start(latex);
    const records = await typeText(session, 1, "\\alpha");
    expect(last(records, "UpdatePreeditText")).toMatchObject({
      text: { text: "\\alpha", attrs: { attributes: [{ type: 1, value: 1, startIndex: 0, endIndex: 6 }] } },
      cursor: 6,
      visible: true,
      mode: 1,
    });
    const { table, visible } = last(records, "UpdateLookupTable");
    expect(visible).toBe(true);
    expect(table.pageSize).toBe(10);
    expect(table.cursorVisible).toBe(true);
    expect(table.candidates[table.cursorPos]?.text).toBe("α \\alpha");
    expect(committed(await session.key(1, ...Key.space))).toBe("α");
  });

  test("LaTeX commits → before a comma, which passes through", async () => {
    const session = await start(latex);
    await typeText(session, 1, "\\to");
    expect(committed(await session.key(1, ",".codePointAt(0)!, 0, 0))).toBe("→");
  });

  test("X-SAMPA beside LaTeX in one Worker turns S@ into ʃə and passes Space through", async () => {
    const session = await start(latex);
    await session.create(2, "xsampa");
    const records = [...(await typeText(session, 2, "S@")), ...(await session.key(2, ...Key.space, 0))];
    expect(committed(records)).toBe("ʃə");
    expect(records.filter(({ record }) => record._tag === "CommitText").every(({ ic }) => ic === 2)).toBe(true);
    await typeText(session, 1, "\\alpha");
    expect(committed(await session.key(1, ...Key.space))).toBe("α");
  });

  test("a click on the second page commits that page's candidate", async () => {
    const session = await start(latex);
    const first = last(await typeText(session, 1, "\\a"), "UpdateLookupTable").table;
    const second = last(await session.request(1, new PageDown({})), "UpdateLookupTable").table;
    expect(second.candidates.map(({ text }) => text)).not.toEqual(first.candidates.map(({ text }) => text));
    const text = second.candidates[1]!.text;
    const clicked = await session.request(1, new CandidateClicked({ index: 1, button: 1, state: 0 }));
    expect(committed(clicked)).toBe(text.slice(0, text.lastIndexOf(" ")));
  });

  test("FocusOut and Reset end a composition without output", async () => {
    const session = await start(latex);
    for (const end of [new FocusOut({}), new Reset({})]) {
      await typeText(session, 1, "\\al");
      expect(tags(await session.request(1, end))).toEqual([]);
      await session.request(1, new FocusIn({}));
      expect(tags(await session.key(1, "x".codePointAt(0)!, 0, 0))).toEqual([]);
    }
  });

  test("LaTeX's table loads once per Worker", async () => {
    const session = await start(xsampa);
    const create = async (ic: number): Promise<number> => {
      const begin = performance.now();
      await session.request(ic, new CreateEngine({ name: "latex" }));
      return performance.now() - begin;
    };
    const firstMs = await create(2);
    const cachedMs = await create(3);
    h.record(`Table ${runtime.name} LaTeX load`, { firstMs, cachedMs });
    expect(cachedMs).toBeLessThan(firstMs);
  });

  test("a table that doesn't parse fails CreateEngine with the parser's message", async () => {
    const session = await start(xsampa, build.manifests["broken"]!);
    const records = await session.request(2, new CreateEngine({ name: "latex" }), -h.data.errno["EIO"]!);
    expect(records.map(({ ic, record }) => ({ ic, record }))).toEqual([
      { ic: 2, record: expect.objectContaining({ _tag: "CreateEngineFailed", message: build.texts["brokenMessage"] }) },
    ]);
    const typed = [...(await typeText(session, 1, "S@")), ...(await session.key(1, ...Key.space, 0))];
    expect(committed(typed)).toBe("ʃə");
  });
});
```

- [ ] **Step 4: Write `engines/table/checks/host/checks.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb)
        engines
        runtime
        testing
        typescript
        ;
      inherit (config.ibusWeb.engines) table;
      dist = config.packages.ibus-web-table-dist;

      # The shipped X-SAMPA table beside a LaTeX table that doesn't parse.
      brokenTables = pkgs.runCommand "ibus-web-table-broken-tables" { } ''
        mkdir $out
        cp ${table.tables}/xsampa.table $out/
        cp ${./broken.table} $out/latex.table
      '';

      brokenModule = table.module.override { tables = brokenTables; };

      brokenDist = engines.mkEngineManifest {
        name = "table";
        package = brokenModule;
        threads = 0;
        inherit (dist) heapBytes;
        inherit (brokenModule) settingsSchemaDir;
        engines = pkgs.runCommand "ibus-web-table-broken-engines.json" { nativeBuildInputs = [ pkgs.jq ]; } ''
          jq .engines ${dist}/manifest.json > $out
        '';
        settingsSchemas = [ "org.freedesktop.ibus.panel" ];
      };

      # What the native parser prints to stderr for the broken table, at the
      # path the side module reads it from.
      brokenMessage = pkgs.runCommand "ibus-web-table-broken-message" { } ''
        if ${table.tools}/bin/table-check ${brokenTables}/latex.table 2> output; then
          echo "the broken table parsed" >&2
          exit 1
        fi
        head -n 1 output | tr -d '\n' > $out
      '';
    in
    {
      checks.table-host = testing.vitestCheck {
        name = "table-host";
        packageDir = "${typescript.workspaceFor [ "packages/worker-host" ]}/packages/worker-host";
        env = {
          IBUS_WEB_WORKER_HOST_TESTS = config.checks.worker-host-node.manifest;
          IBUS_WEB_MODULE_TESTS = pkgs.writeText "ibus-web-table-host-tests.json" (
            builtins.toJSON {
              suite = "table";
              dists = {
                table = "${dist}";
                broken = "${brokenDist}";
              };
              inherit (dist) heapBytes;
              poolBase = runtime.threadPool.size;
              texts.brokenMessage = "${brokenMessage}";
            }
          );
        };
        inBrowsers = false;
        limit = 600;
      };
    };
}
```

- [ ] **Step 5: Run the suite**

```bash
nix develop -c git add engines/table/checks/host/checks.nix engines/table/checks/host/broken.table packages/worker-host/test/engines/table.test.ts
nix build .#checks.x86_64-linux.table-host -L
```

Expected: PASS, 14 tests (seven on each runtime). If a test fails on `breakPeak` against `heapBytes`, go on to Step 6 first, then rerun.

- [ ] **Step 6: Fit `heapBytes` to the measured peak**

```bash
nix log .#checks.x86_64-linux.table-host | grep -E "suite peaks|LaTeX load"
```

Take the larger `breakPeak` of the two `Table … suite peaks` lines. In `engines/table/dist.nix`, set `heapBytes` to the smallest whole MiB at or above it (`<n> * 1024 * 1024`), and write the peaks into the comment above it, in Hangul's form: `# table-host peaks at <asserting> bytes asserting and <released> released, both tables loaded; the manifest builder adds headroom after this whole-MiB declaration.` Then rerun:

```bash
nix build .#checks.x86_64-linux.table-host -L
```

Expected: PASS, 14 tests. Keep the `released` runtime's `Table released LaTeX load` line for Step 7.

- [ ] **Step 7: Document the distribution, the host check and the load time**

Append to `docs/engines.md`:

~~~markdown
## The table module

`engines/table/` is ibus-web's own module: two engines, `latex` and `xsampa`, over one C++23 side module.
[table.md](table.md) describes the table format, the engine and its glue.

```sh
nix build .#ibus-web-table-dist
nix build .#checks.x86_64-linux.table-host
```

`ibus-web-table-dist` is `mkEngineManifest` over `table.wasm`. Its engine descriptors come from the tables'
frontmatter: `table-describe` prints them as JSON and the manifest build reads that file, so Nix needs no build output
at evaluation time. `latex` comes first and is the module's default. The data closure is the two tables and the
compiled `org.freedesktop.ibus.panel` schema, the module's only settings schema. The manifest's licence is
`(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`: the engine, MARISA linked into it, and the LaTeX table's data. It
declares no engine threads and a program break that `checks.table-host` checks with both tables loaded.

The first `CreateEngine` of `latex` in a Worker parses the LaTeX table and builds its MARISA trie: FIRST ms under Node
on the released runtime, against CACHED ms for a second context, which shares the parsed table. `checks.table-host`
records both as `Table released LaTeX load`. There is no target until there is a baseline; this is the baseline.
~~~

replacing FIRST and CACHED with that line's `firstMs` and `cachedMs`, rounded to whole milliseconds (one decimal place below 10).

Append to the `## In the browser` section of `docs/table.md`, after its checks table, one row to that table and a paragraph:

```markdown
| `table-host`         | `table.wasm` in the real runtime under Node: both engines in one Worker, a short trace each, a page-relative click, FocusOut and Reset, and a broken table failing `CreateEngine` with the parser's message |
```

```markdown
`table-host` builds a second distribution whose LaTeX table is a fixture with a malformed line, beside the shipped
X-SAMPA table, and expects `CreateEngine` to fail with `-EIO` after a `CreateEngineFailed` record, and nothing else,
whose message is what `table-check` prints for the same file, while X-SAMPA keeps working in that Worker.
```

In `docs/testing.md`, add `nix build .#checks.x86_64-linux.table-host` after the `hangul-host` line of the command block under `## Worker transport and engine resources`, and after the paragraph that ends `exercise the transport, not a live page router or panel.` add:

```markdown
`table-host` runs the table module's distribution the same way: 14 cases across both builds, with both engines in one
Worker, a page-relative click on the second page, FocusOut and Reset emitting nothing, the LaTeX table's load time,
and a distribution with a malformed table, whose `CreateEngine` must fail with the native parser's message.
```

```bash
nix develop -c oxfmt docs/engines.md docs/table.md docs/testing.md
nix develop -c hk check -S links
```

- [ ] **Step 8: Commit**

```bash
nix develop -c git commit -m "feat(table): distribute the table module and check it in the runtime" -- engines/table/dist.nix engines/table/checks/host/checks.nix engines/table/checks/host/broken.table packages/worker-host/test/engines/table.test.ts docs/engines.md docs/table.md docs/testing.md
```

---

### Task 5: `@ibus-web/engine-table`

**Files:**

- Create: `packages/engines/table/package.json`, `packages/engines/table/README.md`, `packages/engines/table/module.nix`
- Modify: `README.md`, `docs/engines.md`

**Interfaces:**

- Consumes: `packages.ibus-web-table-dist`; `ibusWeb.engines.table.module.meta.license.spdxId`; `ibusWeb.typescript.npmTarball`.
- Produces: `ibusWeb.typescript.npmPackages.engine-table` (`nix build .#npm.engine-table`), part of `checks.typescript-npm`.

- [ ] **Step 1: Write the failing build**

```bash
nix build .#npm.engine-table -L
```

Expected: FAIL, no attribute `engine-table`.

- [ ] **Step 2: Write `packages/engines/table/package.json`**

```json
{
  "name": "@ibus-web/engine-table",
  "version": "0.0.0",
  "description": "ibus-web's table engines, LaTeX to Unicode and X-SAMPA to IPA: their WebAssembly module, tables and manifest.",
  "keywords": [
    "ibus",
    "ime",
    "input-method",
    "ipa",
    "latex",
    "unicode",
    "webassembly",
    "x-sampa"
  ],
  "homepage": "https://github.com/synapdeck/ibus-web/blob/master/docs/table.md",
  "bugs": "https://github.com/synapdeck/ibus-web/issues",
  "license": "(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/synapdeck/ibus-web.git",
    "directory": "packages/engines/table"
  },
  "files": [
    "dist",
    "LICENSES"
  ],
  "exports": {
    "./package.json": "./package.json",
    "./manifest.json": "./dist/manifest.json",
    "./table.wasm": "./dist/table.wasm",
    "./settings.json": "./dist/settings.json",
    "./data/*": "./dist/data/*"
  },
  "publishConfig": {
    "access": "public"
  },
  "ibusWeb": {
    "nixBuilt": true
  }
}
```

- [ ] **Step 3: Write `packages/engines/table/README.md`**

~~~markdown
# @ibus-web/engine-table

ibus-web's table engines, built for the browser: `latex`, which turns LaTeX commands such as `\alpha` into Unicode,
and `xsampa`, which turns X-SAMPA into IPA. Both are in one module and share one Worker. The package holds no
JavaScript: it is the files a host serves and points ibus-web at, `manifest.json` and the WebAssembly module, data
archives and settings metadata it lists.

```ts
import { createIbusWeb } from "ibus-web";

const ibus = createIbusWeb({
  hostUrl: new URL("/ibus-web/host/worker/index.js", location.href),
  runtimeUrl: new URL("/ibus-web/runtime/ibus-runtime.js", location.href),
  modules: { table: new URL("/ibus-web/engines/table/manifest.json", location.href) },
});
await ibus.select("table", "xsampa");
```

`latex` is the module's default; `ibus.engines("table")` lists both with their display names and languages.

Serve `dist/` as it is: the manifest names its files by relative URL, and the data archives are already
Brotli-compressed, so they must be served without `Content-Encoding: br`. Details are in
[docs/table.md](https://github.com/synapdeck/ibus-web/blob/master/docs/table.md).

`dist/` comes from the Nix build of the module, never from this directory: `nix build .#npm.engine-table` packs the
tarball.

Licensed under `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`: the engine is MIT OR Apache-2.0, MARISA, linked into
the module, is BSD-2-Clause, and the LaTeX table, generated from W3C's `unicode.xml`, is W3C. Every text is in
`LICENSES/`; MARISA's is `LICENSES/marisa/COPYING.md`.
~~~

- [ ] **Step 4: Write `packages/engines/table/module.nix`**

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      # The engine and the X-SAMPA table, and the LaTeX table's data. MARISA,
      # linked into the module, has no text in the repository: it ships its
      # own, from its source.
      licenses = [
        "MIT"
        "Apache-2.0"
        "W3C"
      ];

      marisaLicense = "LICENSES/marisa/COPYING.md";
    in
    {
      # The module's distribution as dist/, with the licence texts.
      ibusWeb.typescript.npmPackages.engine-table = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-engine-table";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        files = {
          dist = config.packages.ibus-web-table-dist;
          ${marisaLicense} = "${pkgs.srcOnly config.ibusWeb.toolchain.pkgsWasm.marisa}/COPYING.md";
        };
        inherit licenses;
        license = config.ibusWeb.engines.table.module.meta.license.spdxId;

        # The exports name the rest; the data archives' names are hashes.
        expect = map (id: "LICENSES/${id}.txt") licenses ++ [ marisaLicense ];
      };
    };
}
```

- [ ] **Step 5: Pack it**

```bash
nix develop -c git add packages/engines/table/package.json packages/engines/table/README.md packages/engines/table/module.nix
nix build .#npm.engine-table -L
tar -tzf result/*.tgz | sort
nix build .#checks.x86_64-linux.typescript-npm -L
```

Expected: the tarball lists `package/LICENSES/{Apache-2.0,MIT,W3C}.txt`, `package/LICENSES/marisa/COPYING.md`, `package/dist/manifest.json`, `package/dist/settings.json`, `package/dist/table.wasm`, `package/dist/data/*.tar.br`, `package/package.json` and `package/README.md`; `typescript-npm` passes.

- [ ] **Step 6: Document the package**

In `README.md`'s Packages table, add after the `@ibus-web/engine-hangul` row:

```markdown
| [`@ibus-web/engine-table`](packages/engines/table)   | The LaTeX and X-SAMPA table engines' WebAssembly module, tables and manifest, built by Nix |
```

In `README.md`'s "How it fits together", replace `Engines are GPL, but the page packages are MIT OR Apache-2.0` with
`Engines can be GPL, as Hangul is, but the page packages are MIT OR Apache-2.0`. In its License list, replace the
bullet beginning `- Each engine and its patches:` with:

```markdown
- Each engine and its patches: the engine's own license. ibus-hangul is GPL-2.0-or-later, and its libhangul patch is
  LGPL-2.1-or-later, as libhangul is. The table engine is MIT OR Apache-2.0; its packed module is
  `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`, for MARISA, linked in, and the LaTeX table's data from W3C's
  `unicode.xml`.
```

(If Plan B already added a table-engine licence bullet, merge it into this one.)

Append to `docs/engines.md`'s `## The table module` section:

```markdown
`packages/engines/table/` is `@ibus-web/engine-table`, packed as Hangul's is: `nix build .#npm.engine-table` copies
`ibus-web-table-dist` in as `dist/` and adds the MIT, Apache-2.0 and W3C texts to `LICENSES/` and MARISA's own `COPYING.md`, taken from its source, as `LICENSES/marisa/COPYING.md`, and
`npmTarball` fails unless `package.json`'s `license` is the module's. It exports `manifest.json`, `table.wasm`,
`settings.json` and `data/*`.
```

```bash
nix develop -c oxfmt README.md docs/engines.md packages/engines/table/README.md
nix develop -c hk check -S links
```

- [ ] **Step 7: Commit**

```bash
nix develop -c git commit -m "feat(table): pack the module as @ibus-web/engine-table" -- packages/engines/table/package.json packages/engines/table/README.md packages/engines/table/module.nix README.md docs/engines.md
```

---

### Task 6: The table module in the demo

**Files:**

- Modify: `engines/table/dist.nix`
- Create: `examples/demo/test/e2e/table.spec.ts`

**Interfaces:**

- Consumes (A): `ibusWeb.demo.modules`; `examples/demo/test/e2e/fixtures.ts`'s `test` (which opens the demo) and `expect`; the `#engine-picker` labelled `Input method`, the `#input` field, the Ctrl+Space toggle.
- Produces: `ibusWeb.demo.modules.table`; Playwright cases in Chromium, Firefox and WebKit.

- [ ] **Step 1: Write the failing cases, `examples/demo/test/e2e/table.spec.ts`**

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { Page } from "playwright/test";
import { expect, test } from "./fixtures.ts";

type Engine = "LaTeX" | "X-SAMPA";

// A composition each engine makes at once, and what it leaves in the field.
const probes: Record<Engine, { keys: string; value: string }> = {
  LaTeX: { keys: "\\alpha ", value: "α" },
  "X-SAMPA": { keys: "S@ ", value: "ʃə " },
};

const field = (page: Page) => page.locator("#input");

// Typing stays native until the module's Worker and the field's context are
// ready, so the probe is retried until the engine makes it. Escape ends
// whatever a half-native attempt left composing.
const pick = async (page: Page, engine: Engine) => {
  await page.getByLabel("Input method").selectOption({ label: engine });
  const { keys, value } = probes[engine];
  await expect(async () => {
    await field(page).click();
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type(keys);
    await expect(field(page)).toHaveValue(value, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await field(page).fill("");
};

test("LaTeX turns \\alpha and Space into α", async ({ page }) => {
  await pick(page, "LaTeX");
  await page.keyboard.type("\\alpha");
  await expect(page.locator("[data-ibus-preedit]").filter({ hasText: "\\alpha" })).toBeVisible();
  await expect(page.locator(".ibus-panel [data-candidate]").first()).toContainText("α \\alpha");
  await expect(field(page)).toHaveValue("");
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("α");
});

test("LaTeX commits \\to before the comma that ends it", async ({ page }) => {
  await pick(page, "LaTeX");
  await page.keyboard.type("\\to,");
  await expect(field(page)).toHaveValue("→,");
});

test("X-SAMPA turns S@ and Space into ʃə", async ({ page }) => {
  await pick(page, "X-SAMPA");
  await page.keyboard.type("S@");
  await page.keyboard.press("Space");
  await expect(field(page)).toHaveValue("ʃə ");
});

test("switching between LaTeX and X-SAMPA keeps the module's Worker", async ({ page }) => {
  await pick(page, "LaTeX");
  const hosts: string[] = [];
  page.on("worker", (worker) => {
    if (new URL(worker.url()).pathname.endsWith("/host/worker/index.js")) hosts.push(worker.url());
  });
  await pick(page, "X-SAMPA");
  await pick(page, "LaTeX");
  await page.keyboard.type("\\to,");
  await expect(field(page)).toHaveValue("→,");
  expect(hosts).toEqual([]);
});

test("deselecting gives plain input", async ({ page }) => {
  await pick(page, "X-SAMPA");
  await page.keyboard.press("Control+Space");
  await page.keyboard.type("S@ ");
  await expect(field(page)).toHaveValue("S@ ");
});
```

```bash
nix develop -c git add examples/demo/test/e2e/table.spec.ts
nix build .#packages.x86_64-linux.playwright-integration -L
```

Expected: FAIL in all three browsers: the picker has no LaTeX or X-SAMPA option.

- [ ] **Step 2: Serve the module in the demo**

In `engines/table/dist.nix`, add after `packages.ibus-web-table-dist`:

```nix
      ibusWeb.demo.modules.table = config.packages.ibus-web-table-dist;
```

- [ ] **Step 3: Run the demo's checks**

```bash
nix build .#packages.x86_64-linux.demo .#checks.x86_64-linux.example-demo-smoke -L
nix build .#packages.x86_64-linux.playwright-integration -L
grep -E "table.spec|passed|failed" result/output.txt
```

Expected: the demo builds and its smoke passes; Playwright passes every case, the five table cases in each of Chromium, Firefox and WebKit among them.

- [ ] **Step 4: Commit**

```bash
nix develop -c git commit -m "test(table): type LaTeX and X-SAMPA in the demo" -- engines/table/dist.nix examples/demo/test/e2e/table.spec.ts
```

---

### Task 7: The design spec and the docs index

**Files:**

- Modify: `docs/specs/2026-09-26-ibus-web-design.md`, `docs/README.md`

**Interfaces:**

- Consumes: nothing new.
- Produces: §12's M2 row split into M2.1 (done) and M2.2; §9's licence rows; the index row for `table.md`.

- [ ] **Step 1: Split M2 in §12**

The milestone table's rows are padded to over 2000 characters, so replace the M2 row by script and let oxfmt pad the new ones:

```bash
nix develop -c python3 - <<'PY'
from pathlib import Path

path = Path("docs/specs/2026-09-26-ibus-web-design.md")
lines = path.read_text().split("\n")
(index,) = [i for i, line in enumerate(lines) if line.startswith("| M2 ")]
lines[index : index + 1] = [
    "| M2 | Custom table engine and `contenteditable` adapter, in M2.1–M2.2 |",
    "| ↳ M2.1 | **Done.** (`docs/table.md`) Modules and engines on the page side: engine descriptors, "
    "`select(module, engine?)`, `deselect`, `selectionchange`; the table engine: one C++23 side module with "
    "`latex` (generated from W3C's `unicode.xml`) and `xsampa` (hand-written) over MARISA, command and continuous "
    "modes, `@ibus-web/engine-table`, the table module in the demo |",
    "| ↳ M2.2 | `contenteditable` adapter |",
]
path.write_text("\n".join(lines))
PY
```

- [ ] **Step 2: Update §7.2.3, §9.1 and §9.2**

In §7.2.3, replace `comes with M2. No CodeMirror adapter ships;` with `comes with M2.2. No CodeMirror adapter ships;`.

In §9.1's table, add after the `Engine artifacts` row:

```markdown
| The table engine (`engines/table`) | MIT OR Apache-2.0; its artifact `(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C`, for MARISA, linked in, and the LaTeX table's data |
```

In §9.2, replace rule 4,

```markdown
4. At least one non-GPL engine ships: the custom table engine (MIT), second
   milestone.
```

with

```markdown
4. At least one non-GPL engine ships: the table engine (M2.1), MIT OR
   Apache-2.0, with MARISA (BSD-2-Clause) linked in and W3C-licensed data.
```

- [ ] **Step 3: Index `table.md`**

In `docs/README.md`'s Topics table, change the `engines.md` row's description to
`Engine recipe overrides, FHS data, patch layers, callback audits, Hangul golden tests and the table module`. If the
table has no `table.md` row (Plan B may have added one), add after the `engines.md` row:

```markdown
| [table.md](table.md)             | The table engine: its format, the LaTeX and X-SAMPA tables, MARISA, command and continuous modes, the glue and the side module |
```

If Plan B's row exists, extend its description to mention the glue and the side module.

- [ ] **Step 4: Format and check**

```bash
nix develop -c oxfmt docs/specs/2026-09-26-ibus-web-design.md docs/README.md
nix develop -c hk check -S links
grep -n "M2" docs/specs/2026-09-26-ibus-web-design.md | cut -c1-120
```

Expected: oxfmt pads the new rows; the links step passes; the grep shows the M2, ↳ M2.1 and ↳ M2.2 rows and `comes with M2.2.`.

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "docs(spec): mark M2.1 done and split M2" -- docs/specs/2026-09-26-ibus-web-design.md docs/README.md
```

---

### Task 8: Full verification

**Files:** none, unless a check fails.

- [ ] **Step 1: Generated files**

```bash
nix run .#write-files
git status --short
```

Expected: no changes.

- [ ] **Step 2: The table checks, listed**

```bash
nix eval --json .#checks.x86_64-linux --apply builtins.attrNames | nix develop -c jq -r '.[]' | grep -E '^table-|^hangul-host$|^typescript-npm$'
```

Expected: `hangul-host`, `table-cast-audit`, `table-data-closure`, `table-golden`, `table-host`, `table-imports`, `table-marisa`, `table-parse`, `typescript-npm`.

- [ ] **Step 3: The default gates**

```bash
nix flake check -L
```

Expected: PASS.

- [ ] **Step 4: The extended matrices**

```bash
nix build .#integration-checks -L
```

Expected: PASS, the Playwright run with the table cases included.

- [ ] **Step 5: Every hk step over the tree**

```bash
nix develop -c hk check --all
```

Expected: PASS, `reuse lint` and the links step included.

- [ ] **Step 6: Report**

List each command above with its result. A check that failed and was fixed gets its fix committed under the task it belongs to, and every command above is run again afterwards. Don't report a check you didn't run as passing.
