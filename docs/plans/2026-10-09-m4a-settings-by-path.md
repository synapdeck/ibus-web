# M4 Phase 1: Settings by Path and the US Keymap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase 1 of `docs/specs/2026-10-09-m4-m17n.md`: GSettings settings addressed by path from the build to the runtime and the page, so relocatable schemas work end to end; a real US keymap in libibus-web; and `ibus_engine_simple_add_table_by_locale`. No m17n code is involved; everything is tested with fixtures and the existing engines.

**Architecture:** A setting's address becomes its schema instance (a schema id at a path) plus a key. `settings.json` lists each schema once with its `paths`; `Init` declares every instance with its stored values (`a(ssa{sv})`); `SettingChanged` and `SettingWritten` carry the path where they carried the schema id. The runtime's GSettings backend keeps an instance table built from `Init` and resolves every read, change and write through it. On the page, a `SettingsChange` names both the schema id and the path, because modules may declare different schemas at one path; the persister and the cross-tab broadcast were already keyed by path. The US keymap is a C table generated from the same xkeyboard-config export as the page's, with flags that make the C lookup apply the page's exact rules, checked against vectors the page's own `usKeysym` writes.

**Tech Stack:** C (GLib/GIO 2.88, Emscripten), TypeScript 7 on Node 24, Effect 4, Vitest, Meson, Nix flake-parts, hk, oxfmt, clang-format.

## Global Constraints

- Work on branch `typedrat/m4a-settings-by-path`, cut from `master`. Phase 2 (m17n under Node) is planned separately and builds on this branch's result.
- `PROTOCOL_VERSION` and `IBUSWEB_RUNTIME_ABI` stay at 1. Nothing is published yet, so wire and ABI changes are made in place.
- Names other phases rely on are fixed: the metadata field `paths`; `mkEngineManifest`'s and `mkSettingsMetadata`'s argument `settingsPaths` (an attribute set from schema id to a list of paths, or a JSON file of that shape); the protocol's `Init.settings` entries `{ schemaId, path, values }`; `SettingChanged`/`SettingWritten` fields `path`, `key`, `value`; core's `SettingsInstance = { schemaId, path }`, `SettingsChange = { schemaId, path, key, value, origin? }`, `SettingsSnapshot` keyed by path then key; the settings API `get(module, path, key)`, `set(module, path, key, value)`, `reset(module, path, key)`; the option `ibusWeb.keysyms.usKeymapVectors`.
- Run every command inside the dev shell (`nix develop -c …`). `git add` a new file before any `nix` command that should see it.
- Commit with `nix develop -c git add <paths>` then `nix develop -c git commit -m "<type>(<scope>): <summary>" -- <paths>`. Stage named paths only, never `git add -A`. No attribution trailers. If hk's hook rewrites a file, re-add it and commit again; never bypass the hook.
- Comments explain why, never what; no history, no references to other files or plans. Separate logical blocks with one blank line; never a blank line right after an opening token or right before a closing one, nor between a comment and its code.
- Docs change in the same commit as the code they describe. Format Markdown with `nix develop -c oxfmt <file>`; never run oxfmt on `docs/plans/`.
- Generated files (`runtime/libibus-web/include/ibus-web/protocol.h`, `packages/protocol/PROTOCOL.md`, the new `runtime/libibus-web/src/ibus/us-keymap.generated.h`) are never edited by hand: change their source and run `nix run .#write-files`.
- **Sequencing.** Tasks 1–5 change one interface in lockstep. hk's pre-commit hook typechecks only the packages a commit touches, so each commit goes through, but between Task 3 and Task 5 the packages downstream of a finished task may not build. Each task lists the checks that must pass at its end; Task 8 runs everything.

### Decisions this plan makes where the spec is silent

- **Runtime warnings.** An `Init` entry for an unknown schema logs `Unknown settings schema: <id>`; a fixed schema at another path logs `Settings schema <id> has the fixed path <fixed>, not <path>`; a path that doesn't start and end with `/` or contains `//` logs `Invalid settings path: <path>`. Each entry is skipped. A change or write under no declared path logs `Unknown settings path: <path>` (`-ENOENT` for a change); an unknown key logs `Unknown settings key: <path><key>`; an invalid value logs `Invalid value for settings key: <path><key>`.
- **Writes need a declared instance.** Engines can no longer write a fixed schema the page didn't declare; every schema an engine writes is in its manifest's `settingsSchemas`, so this only tightens test fixtures.
- **`mkSettingsMetadata` helper arguments.** The WASM helper takes `SCHEMA_DIR ARG…`, where each `ARG` is a schema id, which adds the schema, or `ID=PATH`, which adds a path to a schema also named on its own. The helper fails on a relocatable schema without paths, on paths for a fixed schema, and on paths for an unnamed schema.
- **Shared paths across modules.** The persister registers schemas by id and records which ids each path holds. A schema id registered twice must have the same keys (paths are merged); a change at a path reaches every schema registered there whose key accepts the value.
- **The keymap's table** stores, per evdev code, the level-1 and level-2 keysyms and two flags: *letter* (the level-1 character is `a`–`z`) and *keypad* (some DOM code for that evdev code starts with `Numpad`). `ibus_keymap_lookup_keysym` returns level 2 when the key is keypad and NumLock (`IBUS_MOD2_MASK`) is set; when it is a letter and exactly one of Shift and Lock is set; otherwise when Shift is set; and level 1 in every other case or when there is no level 2. Mod5 is ignored. A `NULL` keymap or unknown code gives `IBUS_VoidSymbol`.
- **Parity vectors** are a text file of `evdev state keyval` lines, one per DOM code the page knows and each of the 8 combinations of Shift (1), Lock (2) and NumLock (16), each repeated with Mod5 (128) set, for every combination where `usKeysym` returns a value. libibus-web's `engine` test reads it from `IBUSWEB_TEST_US_KEYMAP`.
- **The demo's settings form** shows every instance of every schema; a schema at more than one path qualifies later controls' ids with the path's index.

---

## File structure

| Path | Change |
| --- | --- |
| `packages/protocol/src/settings.ts` | Metadata schemas carry `paths`; paths unique in a file |
| `packages/protocol/src/messages/requests.ts`, `records.ts` | `Init` instances; `SettingChanged`/`SettingWritten` carry `path` |
| `runtime/libibus-web/src/settings.{c,h}` | Instance table from `Init`; resolution by path |
| `runtime/libibus-web/src/dispatch.c`, `include/ibus-web/runtime.h` | `SettingChanged` by path |
| `runtime/libibus-web/tests/test-settings.c`, `test-dispatch.c` | Path-addressed settings, relocatable instances, refusals |
| `engines/hangul/checks/golden/harness.{c,h}`, `golden.c` | Init instances, settings by path |
| `tools/ibus-test/wasm/driver.c` | Init instances from fixed schemas' paths |
| `packages/protocol/test/…`, `packages/worker-host/test/…`, `packages/core/test/node/connection/connection.test.ts`, `packages/core/test/browser/real-host.ts` | The new wire shapes |
| `tools/gschema/metadata.{c,ts}`, `metadata.test.ts`, `fixture.gschema.xml` | `ID=PATH` arguments; `paths` output |
| `modules/engines/settings-metadata.nix`, `manifest.nix` | `settingsPaths` |
| `packages/core/src/services/settings.ts`, `settings/persister.ts`, `settings/api.ts`, `services/modules.ts`, `page/index.ts` | Instances on the page |
| `packages/core/test/…` | Page settings tests by path |
| `packages/ibus-web/src/index.ts`, `test/browser/facade.test.ts`, `examples/demo/src/main.ts` | API by path; panel orientation at its path |
| `tools/keysyms/us-c.ts`, `us-vectors.ts`, `us-c.test.ts`, `module.nix`, `options.nix` | The C table and the parity vectors |
| `runtime/libibus-web/src/ibus/ibuskeymap.c`, `us-keymap.generated.h`, `meson.options`, `tests/meson.build`, `tests/test-engine.c`, `checks.nix` | The US keymap and its tests |
| `runtime/libibus-web/src/ibus/ibusenginesimple.c` | `ibus_engine_simple_add_table_by_locale` |
| `docs/runtime.md`, `docs/core.md`, `docs/engines.md`, `docs/ibus-web.md`, `docs/known-gaps.md`, `docs/specs/2026-09-26-ibus-web-design.md` | The pages each change affects |

---

### Task 1: Settings metadata lists paths

**Files:**
- Modify: `packages/protocol/src/settings.ts`
- Test: `packages/protocol/test/engine/settings.test.ts`

**Interfaces:**
- Produces: `SettingsMetadata["schemas"][number]` is `{ id: string; paths: readonly string[]; keys: … }`. Each path is canonical (`/` … `/`, no empty, `.` or `..` component); a schema has at least one path; ids and paths are unique across the file.

- [ ] **Step 1: Write the failing tests**

Replace `packages/protocol/test/engine/settings.test.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { expect, test } from "vitest";
import { SettingsMetadata, decodeSettingsMetadata, encodeSettingsMetadata } from "../../src/index.ts";

const metadata = (type = "s", value: unknown = { _tag: "s", value: "2" }) => ({
  schemas: [{ id: "org.test", paths: ["/org/test/"], keys: [{ name: "keyboard", type, default: value }] }],
});

test("decodes settings metadata and round-trips bigint defaults through JSON", () => {
  expect(Schema.decodeUnknownSync(SettingsMetadata)(metadata())).toEqual(metadata());
  const value = metadata("t", { _tag: "t", value: "18446744073709551615" });
  const decoded = decodeSettingsMetadata(value);
  expect(decoded.schemas[0]!.keys[0]!.default).toEqual({ _tag: "t", value: 18446744073709551615n });
  expect(JSON.parse(JSON.stringify(encodeSettingsMetadata(decoded)))).toEqual(value);
});

test("decodes a schema at several paths", () => {
  const value = metadata();
  value.schemas[0]!.paths = ["/org/test/a/", "/org/test/b/"];
  expect(decodeSettingsMetadata(value).schemas[0]!.paths).toEqual(["/org/test/a/", "/org/test/b/"]);
});

test.each(["", "relative/", "/org//test/", "/org/test", "/org/../test/"])("rejects invalid path %s", (path) => {
  const value = metadata();
  value.schemas[0]!.paths = [path];
  expect(() => decodeSettingsMetadata(value)).toThrow();
});

test("rejects a schema without paths", () => {
  const value = metadata();
  value.schemas[0]!.paths = [];
  expect(() => decodeSettingsMetadata(value)).toThrow();
});

test("rejects values inconsistent with their declared type", () => {
  expect(() => decodeSettingsMetadata(metadata("i"))).toThrow();
  expect(() => decodeSettingsMetadata(metadata("y", { _tag: "y", value: 256 }))).toThrow();
});

test("rejects duplicate schema ids, paths and keys", () => {
  const value = metadata();
  expect(() => decodeSettingsMetadata({ schemas: [...value.schemas, ...value.schemas] })).toThrow();
  expect(() =>
    decodeSettingsMetadata({ schemas: [...value.schemas, { ...value.schemas[0]!, id: "org.other" }] }),
  ).toThrow("duplicate settings paths");
  value.schemas[0]!.paths = ["/org/test/", "/org/test/"];
  expect(() => decodeSettingsMetadata(value)).toThrow("duplicate settings paths");
  value.schemas[0]!.paths = ["/org/test/"];
  value.schemas[0]!.keys.push(value.schemas[0]!.keys[0]!);
  expect(() => decodeSettingsMetadata(value)).toThrow();
});

test.each([Infinity, -Infinity, NaN, -0])("round-trips special double %s through JSON", (number) => {
  const decoded = {
    schemas: [
      {
        id: "org.test",
        paths: ["/org/test/"],
        keys: [{ name: "double", type: "d", default: { _tag: "d" as const, value: number } }],
      },
    ],
  };
  const json = JSON.parse(JSON.stringify(encodeSettingsMetadata(decoded)));
  const result = decodeSettingsMetadata(json).schemas[0]!.keys[0]!.default;
  expect(result).toEqual({ _tag: "d", value: number });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nix develop -c bash -c 'cd packages/protocol && pnpm exec vitest run --configLoader native test/engine/settings.test.ts'`
Expected: FAIL (`paths` is not a known field).

- [ ] **Step 3: Implement**

In `packages/protocol/src/settings.ts`, replace the `SettingsMetadata` definition (from `export const SettingsMetadata` through its closing `);`) with:

```ts
const path = Schema.String.check(
  Schema.isPattern(/^\/(?:[^/\0]+\/)*$/),
  Schema.makeFilter(
    (path) => !path.split("/").some((part) => part === "." || part === "..") || "schema path must be canonical",
  ),
);

export const SettingsMetadata = Schema.toCodecJson(
  Schema.Struct({
    schemas: Schema.Array(
      Schema.Struct({
        id: nonEmpty,
        // A fixed schema lives at its one path; a relocatable one at each path the build declares.
        paths: Schema.Array(path).check(Schema.isMinLength(1)),
        keys: Schema.Array(key).check(
          Schema.makeFilter(
            (keys) => new Set(keys.map((key) => key.name)).size === keys.length || "duplicate settings keys",
          ),
        ),
      }),
    ).check(
      Schema.makeFilter(
        (schemas) => new Set(schemas.map((schema) => schema.id)).size === schemas.length || "duplicate schema ids",
      ),
      Schema.makeFilter((schemas) => {
        const paths = schemas.flatMap((schema) => schema.paths);
        return new Set(paths).size === paths.length || "duplicate settings paths";
      }),
    ),
  }),
);
```

If `Schema.isMinLength` is not the name in the pinned Effect 4 release, use the check the package already uses for non-empty arrays: `Schema.isNonEmpty()` (as `packages/protocol/src/manifest.ts` does for `engines`).

- [ ] **Step 4: Run the tests to see them pass**

Run: `nix develop -c bash -c 'cd packages/protocol && pnpm exec vitest run --configLoader native test/engine/settings.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "feat(protocol): list each settings schema's paths in its metadata" -- packages/protocol/src/settings.ts packages/protocol/test/engine/settings.test.ts
```

---

### Task 2: The metadata tool and the manifest take settings paths

**Files:**
- Modify: `tools/gschema/metadata.c`, `tools/gschema/metadata.ts`, `tools/gschema/metadata.test.ts`
- Modify: `modules/engines/settings-metadata.nix`, `modules/engines/manifest.nix`
- Docs: `docs/engines.md`, `docs/specs/2026-09-26-ibus-web-design.md` (§7.1.4 **Metadata.**)

**Interfaces:**
- Consumes: Task 1's metadata shape.
- Produces: `ibusWeb.engines.mkSettingsMetadata { settingsSchemaDir, settingsSchemas, settingsPaths ? { } }` and `ibusWeb.engines.mkEngineManifest { …, settingsPaths ? { } }`, where `settingsPaths` is an attribute set from schema id to a list of paths, or a JSON file (a store path or derivation) holding such an object.

- [ ] **Step 1: Write the failing tests**

In `tools/gschema/metadata.test.ts`, replace the test `rejects relocatable and missing schemas before producing metadata` with:

```ts
test("lists a relocatable schema at each path it is given", () => {
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        paths.helper,
        paths.schemas,
        "org.test.Metadata",
        "org.test.Relocatable",
        "org.test.Relocatable=/org/test/first/",
        "org.test.Relocatable=/org/test/second/",
      ],
      { encoding: "utf8" },
    ),
  );
  expect(output.schemas.map((schema: { id: string; paths: string[] }) => [schema.id, schema.paths])).toEqual([
    ["org.test.Metadata", ["/org/test/metadata/"]],
    ["org.test.Relocatable", ["/org/test/first/", "/org/test/second/"]],
  ]);
});
test.each([
  [["org.test.Relocatable"], "org.test.Relocatable"],
  [["org.test.Missing"], "org.test.Missing"],
  [["org.test.Metadata", "org.test.Metadata=/org/test/elsewhere/"], "org.test.Metadata"],
  [["org.test.Relocatable=/org/test/first/"], "org.test.Relocatable"],
])("refuses %j before producing metadata", (args, id) => {
  const result = spawnSync(process.execPath, [paths.helper, paths.schemas, ...args], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(id);
});
```

and in `ships Hangul and panel metadata and an accurate manifest asset`, change `expect(hangul.path).toBe("/org/freedesktop/ibus/engine/hangul/");` to `expect(hangul.paths).toEqual(["/org/freedesktop/ibus/engine/hangul/"]);`.

- [ ] **Step 2: Run the test to see it fail**

Run: `nix develop -c git add tools/gschema && nix build .#checks.x86_64-linux.engines-settings-metadata -L`
Expected: FAIL (the helper refuses `org.test.Relocatable` and prints `path`, not `paths`).

- [ ] **Step 3: Implement the helper**

Replace `main` in `tools/gschema/metadata.c` and add the helpers above it:

```c
typedef struct {
  gchar *id;
  GPtrArray *paths;
} Entry;

static void entry_free(gpointer data) {
  Entry *entry = data;
  g_free(entry->id);
  g_ptr_array_unref(entry->paths);
  g_free(entry);
}

static Entry *entry_for(GPtrArray *entries, const gchar *id) {
  for (guint i = 0; i < entries->len; i++) {
    Entry *entry = g_ptr_array_index(entries, i);
    if (g_str_equal(entry->id, id))
      return entry;
  }
  return NULL;
}

static void keys(JsonBuilder *json, GSettingsSchema *schema) {
  json_builder_set_member_name(json, "keys");
  json_builder_begin_array(json);
  gchar **names = g_settings_schema_list_keys(schema);
  for (gchar **name = names; *name; name++) {
    GSettingsSchemaKey *key = g_settings_schema_get_key(schema, *name);
    json_builder_begin_object(json);
    string(json, "name", *name);
    string(json, "type",
           g_variant_type_peek_string(
               g_settings_schema_key_get_value_type(key)));
    GVariant *value = g_settings_schema_key_get_default_value(key);
    variant(json, "default", value);
    g_variant_unref(value);
    string(json, "summary", g_settings_schema_key_get_summary(key));
    string(json, "description", g_settings_schema_key_get_description(key));
    GVariant *range = g_settings_schema_key_get_range(key), *detail;
    const gchar *kind;
    g_variant_get(range, "(&sv)", &kind, &detail);
    if (g_str_equal(kind, "range")) {
      json_builder_set_member_name(json, "range");
      json_builder_begin_object(json);
      GVariant *min = g_variant_get_child_value(detail, 0),
               *max = g_variant_get_child_value(detail, 1);
      variant(json, "min", min);
      variant(json, "max", max);
      g_variant_unref(min);
      g_variant_unref(max);
      json_builder_end_object(json);
    } else if (g_str_equal(kind, "enum") || g_str_equal(kind, "flags")) {
      json_builder_set_member_name(json, "choices");
      json_builder_begin_array(json);
      GVariantIter iter;
      const gchar *choice;
      g_variant_iter_init(&iter, detail);
      while (g_variant_iter_next(&iter, "&s", &choice))
        json_builder_add_string_value(json, choice);
      json_builder_end_array(json);
    } else if (!g_str_equal(kind, "type")) {
      g_error("Unsupported GSettings range kind: %s", kind);
    }
    g_variant_unref(detail);
    g_variant_unref(range);
    json_builder_end_object(json);
    g_settings_schema_key_unref(key);
  }
  g_strfreev(names);
  json_builder_end_array(json);
}

/* Each argument after the directory is a schema id, which lists the schema,
 * or ID=PATH, which adds a path to a schema also listed on its own. */
int main(int argc, char **argv) {
  if (argc < 2) {
    g_printerr("usage: metadata SCHEMA_DIR [SCHEMA_ID | SCHEMA_ID=PATH]...\n");
    return 1;
  }
  GError *error = NULL;
  GSettingsSchemaSource *source =
      g_settings_schema_source_new_from_directory(argv[1], NULL, FALSE, &error);
  if (!source) {
    g_printerr("%s\n", error->message);
    g_error_free(error);
    return 1;
  }

  GPtrArray *entries = g_ptr_array_new_with_free_func(entry_free);
  for (int i = 2; i < argc; i++) {
    if (strchr(argv[i], '=') == NULL && entry_for(entries, argv[i]) == NULL) {
      Entry *entry = g_new(Entry, 1);
      entry->id = g_strdup(argv[i]);
      entry->paths = g_ptr_array_new_with_free_func(g_free);
      g_ptr_array_add(entries, entry);
    }
  }
  int status = 0;
  for (int i = 2; i < argc && status == 0; i++) {
    const gchar *separator = strchr(argv[i], '=');
    if (separator == NULL)
      continue;
    g_autofree gchar *id = g_strndup(argv[i], separator - argv[i]);
    Entry *entry = entry_for(entries, id);
    if (entry == NULL) {
      g_printerr("%s: a path was given for a schema that isn't listed\n", id);
      status = 1;
    } else {
      g_ptr_array_add(entry->paths, g_strdup(separator + 1));
    }
  }

  JsonBuilder *json = json_builder_new();
  json_builder_begin_object(json);
  json_builder_set_member_name(json, "schemas");
  json_builder_begin_array(json);
  for (guint i = 0; i < entries->len && status == 0; i++) {
    Entry *entry = g_ptr_array_index(entries, i);
    GSettingsSchema *schema =
        g_settings_schema_source_lookup(source, entry->id, FALSE);
    const gchar *fixed = schema ? g_settings_schema_get_path(schema) : NULL;
    if (!schema) {
      g_printerr("%s: schema missing\n", entry->id);
      status = 1;
    } else if (fixed && entry->paths->len > 0) {
      g_printerr("%s: paths were given for a schema with a fixed path\n",
                 entry->id);
      status = 1;
    } else if (!fixed && entry->paths->len == 0) {
      g_printerr("%s: a relocatable schema needs its paths\n", entry->id);
      status = 1;
    } else {
      json_builder_begin_object(json);
      string(json, "id", entry->id);
      json_builder_set_member_name(json, "paths");
      json_builder_begin_array(json);
      if (fixed)
        json_builder_add_string_value(json, fixed);
      for (guint j = 0; j < entry->paths->len; j++)
        json_builder_add_string_value(json,
                                      g_ptr_array_index(entry->paths, j));
      json_builder_end_array(json);
      keys(json, schema);
      json_builder_end_object(json);
    }
    if (schema)
      g_settings_schema_unref(schema);
  }
  json_builder_end_array(json);
  json_builder_end_object(json);
  if (status == 0) {
    JsonNode *root = json_builder_get_root(json);
    gchar *output = json_to_string(root, FALSE);
    puts(output);
    g_free(output);
    json_node_unref(root);
  }
  g_object_unref(json);
  g_ptr_array_unref(entries);
  g_settings_schema_source_unref(source);
  return status;
}
```

Add `#include <string.h>` beside the existing includes.

In `tools/gschema/metadata.ts`, change `path: string;` in `RawMetadata` to `paths: string[];`. `convertMetadata` passes `paths` through unchanged.

- [ ] **Step 4: Thread `settingsPaths` through Nix**

In `modules/engines/settings-metadata.nix`, change the option's description to `"Generate settings.json from compiled GSettings schemas using pinned GLib: fixed schemas at their paths, relocatable ones at the paths settingsPaths gives."` and the function to:

```nix
      ibusWeb.engines.mkSettingsMetadata =
        {
          settingsSchemaDir,
          settingsSchemas,
          settingsPaths ? { },
        }:
        let
          # A derivation building the paths is itself an attribute set.
          pathsFile =
            if builtins.isAttrs settingsPaths && !lib.isDerivation settingsPaths then
              pkgs.writeText "ibus-web-settings-paths.json" (builtins.toJSON settingsPaths)
            else
              settingsPaths;
        in
        pkgs.runCommand "ibus-web-settings.json"
          {
            nativeBuildInputs = [
              typescript.nodejs
              pkgs.jq
            ];
          }
          ''
            mapfile -t instances < <(jq -r 'to_entries[] | .key as $id | .value[] | "\($id)=\(.)"' ${pathsFile})
            node ${helper}/metadata.js ${lib.escapeShellArg settingsSchemaDir} ${lib.escapeShellArgs settingsSchemas} "''${instances[@]}" > raw.json
            node ${../../tools/gschema/metadata.ts} ${
              typescript.workspaceFor [ "packages/protocol" ]
            }/packages/protocol/dist/index.js raw.json $out
          '';
```

In `modules/engines/manifest.nix`, add `settingsPaths ? { },` after `settingsSchemas,` in the arguments, and pass it on: `settingsMetadata = config.ibusWeb.engines.mkSettingsMetadata { inherit settingsSchemaDir settingsSchemas settingsPaths; };`.

- [ ] **Step 5: Update the docs**

In `docs/engines.md`, replace `It records each listed schema's fixed path, key names/types, defaults, descriptions and any range/choices supplied by GLib; relocatable schemas fail the build.` with `It records each listed schema's paths (a fixed schema's own path; a relocatable schema's paths from the manifest's `settingsPaths`, which the build fails without), key names/types, defaults, descriptions and any range/choices supplied by GLib.` In the design spec's §7.1.4 **Metadata.** bullet, replace `A relocatable schema fails the build, since it has no fixed path.` with `A relocatable schema lists the paths the build declares for it, and fails the build without any.` and `Each key's schema path,` with `Each key's schema paths,`. Format both with oxfmt.

- [ ] **Step 6: Run the checks**

Run, all expected to PASS:

```bash
nix develop -c git add tools/gschema modules/engines docs/engines.md docs/specs/2026-09-26-ibus-web-design.md
nix build .#checks.x86_64-linux.engines-settings-metadata -L
nix build .#ibus-web-hangul-dist .#ibus-web-mozc-dist -L
```

- [ ] **Step 7: Commit**

```bash
nix develop -c git commit -m "feat(engines): give settings metadata each schema's paths, relocatable ones from settingsPaths" -- tools/gschema modules/engines/settings-metadata.nix modules/engines/manifest.nix docs/engines.md docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 3: The wire carries schema instances and paths

The protocol's `Init`, `SettingChanged` and `SettingWritten` change shape, and every producer and consumer of the wire changes with them: the runtime's settings backend and dispatcher, the C test programs, the Hangul golden harness, the IBus test driver, the protocol's parity and kind tests, and the worker-host tests. Core's registry follows in Task 4.

**Files:**
- Modify: `packages/protocol/src/messages/requests.ts`, `packages/protocol/src/messages/records.ts`
- Modify: `runtime/libibus-web/src/settings.c`, `runtime/libibus-web/src/settings.h`, `runtime/libibus-web/src/dispatch.c`, `runtime/libibus-web/include/ibus-web/runtime.h`
- Modify: `runtime/libibus-web/tests/test-settings.c`, `runtime/libibus-web/tests/test-dispatch.c`
- Modify: `engines/hangul/checks/golden/harness.c`, `engines/hangul/checks/golden/harness.h`, `engines/hangul/checks/golden/golden.c`
- Modify: `tools/ibus-test/wasm/driver.c`
- Modify: `packages/protocol/test/messages/kinds.test.ts`, `packages/protocol/test/scripts/protocol-h.test.ts`, `packages/protocol/test/parity/corpus.ts`, `packages/protocol/test/parity/c/parity.c`
- Modify: `packages/worker-host/test/shared/engine.ts`, `packages/worker-host/test/shared/protocol.ts`, `packages/worker-host/test/shared/ring.ts`, `packages/worker-host/test/engines/hangul.test.ts`, `packages/worker-host/test/engines/mozc.test.ts`, `packages/worker-host/test/engines/table.test.ts`
- Modify: `packages/core/test/node/connection/connection.test.ts`
- Regenerate: `runtime/libibus-web/include/ibus-web/protocol.h`, `packages/protocol/PROTOCOL.md`
- Docs: `docs/runtime.md`, `docs/specs/2026-09-26-ibus-web-design.md` (§5.2.3, §5.2.5, §6.1.3, §6.1.4)

**Interfaces:**
- Produces (TypeScript): `new Init({ version, settings: [{ schemaId, path, values }] })` with signature `(ua(ssa{sv}))`; `new SettingChanged({ path, key, value })` and `SettingWritten` records `{ path, key, value }`, both `(ssv)`.
- Produces (C): `void ibusweb_settings_init(GVariant *instances)` takes `a(ssa{sv})`; `int ibusweb_settings_changed(const char *path, const char *key, GVariant *value)`.

- [ ] **Step 1: Change the protocol schemas**

In `packages/protocol/src/messages/requests.ts`, replace the `Init` class with:

```ts
export const SettingsInstance = Schema.Struct({
  schemaId: Str.annotate({ description: "GSettings schema id." }),
  path: Str.annotate({ description: "Path the schema is instantiated at, ending in /." }),
  values: Schema.Record(Str, GVariantVariant).annotate({ description: "The instance's stored values, by key." }),
});

export class Init extends Schema.TaggedClass<Init>()(
  "Init",
  {
    version: Uint32.annotate({ description: "Protocol version supported by the host." }),
    settings: Schema.Array(SettingsInstance).annotate({
      description: "Every GSettings schema instance the module declares, with its stored values.",
    }),
  },
  { kind: 1, description: "Initialize the runtime with the host's protocol version and settings." },
) {}
```

and the `SettingChanged` class's fields with:

```ts
  {
    path: Str.annotate({ description: "Path of the schema instance holding the changed key." }),
    key: Str.annotate({ description: "GSettings key that changed." }),
    value: GVariantVariant.annotate({ description: "New typed GSettings value." }),
  },
```

In `packages/protocol/src/messages/records.ts`, replace the `SettingWritten` fields with:

```ts
  {
    path: Str.annotate({ description: "Path of the schema instance holding the written key." }),
    key: Str.annotate({ description: "GSettings key written by the engine." }),
    value: GVariantVariant.annotate({ description: "Typed value the host should persist." }),
  },
```

If `packages/protocol/src/index.ts` re-exports request schemas by name rather than with `export *`, add `SettingsInstance` beside `Init`.

- [ ] **Step 2: Update the protocol's tests**

In `packages/protocol/test/messages/kinds.test.ts`, change `["Init", 1, "(ua{sa{sv}})"]` to `["Init", 1, "(ua(ssa{sv}))"]`. In `packages/protocol/test/scripts/protocol-h.test.ts`, change `["INIT", 1, "(ua{sa{sv}})"]` to `["INIT", 1, "(ua(ssa{sv}))"]`. The generic signature tests in `test/gvariant/vectors.test.ts`, `test/gvariant/type.test.ts` and `test/ibus/signature.test.ts` use `(ua{sa{sv}})` only as a sample type and stay as they are.

In `packages/protocol/test/parity/corpus.ts`, below `export const schemaId = "org.example.Parity";` add:

```ts
export const path = "/org/example/parity/";
```

replace the `init` entry with:

```ts
  init: new P.Init({
    version: 1,
    settings: [
      { schemaId, path, values: { sample: { _tag: "v", type: "s", value: { _tag: "s", value: "initial" } } } },
    ],
  }),
```

and the `SettingChanged` request with:

```ts
    new P.SettingChanged({
      path,
      key: "sample",
      value: { _tag: "v", type: "s", value: { _tag: "s", value: "changed" } },
    }),
```

In `packages/protocol/test/parity/c/parity.c`, in `setting_changed` change `string_member(calls, "schemaId", "org.example.Parity");` to `string_member(calls, "path", "/org/example/parity/");`, and in `emit_records` change `string_member(records, "schemaId", "org.example.Parity");` to `string_member(records, "path", "/org/example/parity/");`.

- [ ] **Step 3: Regenerate the protocol's generated files**

Run: `nix develop -c git add packages/protocol/src && nix run .#write-files && git status --short`
Expected: `runtime/libibus-web/include/ibus-web/protocol.h` and `packages/protocol/PROTOCOL.md` modified; the header's `Init` signature reads `(ua(ssa{sv}))`.

- [ ] **Step 4: Write the failing runtime tests**

Replace `runtime/libibus-web/tests/test-settings.c` with:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#define G_SETTINGS_ENABLE_BACKEND
#include "../src/settings.h"
#include <errno.h>
#include <gio/gio.h>
#include <gio/gsettingsbackend.h>
#include <ibus-web/protocol.h>
#include <ibus-web/runtime.h>
#include <string.h>

#define SCHEMA "org.ibus-web.Test"
#define PATH "/org/ibus-web/test/"
#define CHILD "org.ibus-web.Test.Child"
#define CHILD_PATH "/org/ibus-web/test/nested/"
#define RELOCATABLE "org.ibus-web.Test.Relocatable"
#define FIRST "/org/ibus-web/relocatable/first/"
#define SECOND "/org/ibus-web/relocatable/second/"

static void output_empty(void) {
  guint32 length;
  g_assert_null(ibusweb_output_peek(&length));
  g_assert_cmpuint(length, ==, 0);
}

static void expect_write(const gchar *path, const gchar *key, GVariant *value) {
  guint32 length;
  const guint8 *data = ibusweb_output_peek(&length);
  g_assert_nonnull(data);
  IBusWebRecordHeader header;
  g_assert_cmpuint(length, >=, sizeof header);
  memcpy(&header, data, sizeof header);
  g_assert_cmpuint(GUINT32_FROM_LE(header.ic), ==, 0);
  g_assert_cmpuint(GUINT16_FROM_LE(header.kind), ==,
                   IBUSWEB_REC_SETTING_WRITTEN);
  guint payload_length = GUINT32_FROM_LE(header.len);
  GVariant *payload = g_variant_ref_sink(
      g_variant_new_from_data(G_VARIANT_TYPE("(ssv)"), data + sizeof header,
                              payload_length, FALSE, NULL, NULL));
  GVariant *expected =
      g_variant_ref_sink(g_variant_new("(ssv)", path, key, value));
  g_assert_true(g_variant_is_normal_form(payload));
  g_assert_true(g_variant_equal(payload, expected));
  g_variant_unref(payload);
  g_variant_unref(expected);
  ibusweb_output_consume((sizeof header + payload_length + 7) & ~7u);
}

/* Adds one Init entry; a NULL key leaves the instance without values. */
static void add_instance(GVariantBuilder *builder, const gchar *schema,
                         const gchar *path, const gchar *key,
                         GVariant *value) {
  GVariantBuilder values;
  g_variant_builder_init(&values, G_VARIANT_TYPE("a{sv}"));
  if (key != NULL)
    g_variant_builder_add(&values, "{sv}", key, value);
  g_variant_builder_add(builder, "(ss@a{sv})", schema, path,
                        g_variant_builder_end(&values));
}

static GVariant *snapshot_value(const gchar *key, GVariant *value) {
  GVariantBuilder builder;
  g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
  add_instance(&builder, SCHEMA, PATH, key, value);
  return g_variant_builder_end(&builder);
}

static void apply(GVariant *instances) {
  g_variant_ref_sink(instances);
  ibusweb_settings_init(instances);
  g_variant_unref(instances);
}

static void seed(const gchar *key, GVariant *value) {
  apply(snapshot_value(key, value));
}

static void declare(void) {
  GVariantBuilder builder;
  g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
  add_instance(&builder, SCHEMA, PATH, NULL, NULL);
  add_instance(&builder, CHILD, CHILD_PATH, NULL, NULL);
  add_instance(&builder, RELOCATABLE, FIRST, NULL, NULL);
  add_instance(&builder, RELOCATABLE, SECOND, NULL, NULL);
  apply(g_variant_builder_end(&builder));
}

static gint change(const gchar *path, const gchar *key, GVariant *value) {
  g_variant_ref_sink(value);
  gint result = ibusweb_settings_changed(path, key, value);
  g_variant_unref(value);
  return result;
}

static void count_changes(GSettings *settings G_GNUC_UNUSED,
                          const gchar *key G_GNUC_UNUSED, gpointer data) {
  ++*(guint *)data;
}

static void registration(void) {
  g_assert_null(g_getenv("GSETTINGS_BACKEND"));
  GSettingsBackend *backend = g_settings_backend_get_default();
  g_assert_cmpstr(G_OBJECT_TYPE_NAME(backend), ==, "IBusWebSettingsBackend");
  g_object_unref(backend);
}

static void defaults(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_autofree gchar *mode = g_settings_get_string(settings, "mode");
  g_assert_cmpstr(layout, ==, "2");
  g_assert_cmpstr(mode, ==, "latin");
  g_assert_true(g_settings_get_boolean(settings, "enabled"));
  g_assert_cmpint(g_settings_get_int(settings, "page-size"), ==, 9);
  g_assert_true(g_settings_is_writable(settings, "layout"));
  g_object_unref(settings);
  output_empty();
}

static void snapshot(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  guint changed = 0;
  g_signal_connect(settings, "changed", G_CALLBACK(count_changes), &changed);
  seed("layout", g_variant_new_string("3f"));
  seed("enabled", g_variant_new_boolean(FALSE));
  seed("page-size", g_variant_new_int32(7));
  seed("mode", g_variant_new_string("hangul"));
  ibusweb_pump();
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_autofree gchar *mode = g_settings_get_string(settings, "mode");
  g_assert_cmpstr(layout, ==, "3f");
  g_assert_cmpstr(mode, ==, "hangul");
  g_assert_false(g_settings_get_boolean(settings, "enabled"));
  g_assert_cmpint(g_settings_get_int(settings, "page-size"), ==, 7);
  g_assert_cmpuint(changed, ==, 0);
  g_object_unref(settings);
  output_empty();
}

static void notification(void) {
  seed("layout", g_variant_new_string("before"));
  GSettings *settings = g_settings_new(SCHEMA);
  guint changed = 0;
  g_signal_connect(settings, "changed::layout", G_CALLBACK(count_changes),
                   &changed);
  g_assert_cmpint(change(PATH, "layout", g_variant_new_string("after")), ==,
                  0);
  ibusweb_pump();
  g_assert_cmpuint(changed, ==, 1);
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(layout, ==, "after");
  g_assert_cmpint(change(PATH, "layout", g_variant_new_string("after")), ==,
                  0);
  ibusweb_pump();
  g_assert_cmpuint(changed, ==, 1);
  g_object_unref(settings);
  output_empty();
}

static void invalid_values(void) {
  const struct {
    const gchar *path;
    const gchar *key;
    gint error;
    const gchar *message;
  } cases[] = {
      {"/org/ibus-web/missing/", "layout", -ENOENT, "*Unknown settings path*"},
      {PATH, "missing", -ENOENT, "*Unknown settings key*"},
      {PATH, "page-size", -EINVAL, "*Invalid value*"},
      {PATH, "mode", -EINVAL, "*Invalid value*"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(cases); ++i) {
    g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, cases[i].message);
    g_assert_cmpint(
        change(cases[i].path, cases[i].key, g_variant_new_string("invalid")),
        ==, cases[i].error);
    g_test_assert_expected_messages();
  }
  seed("page-size", g_variant_new_int32(9));
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "*Invalid value*");
  seed("page-size", g_variant_new_string("invalid"));
  g_test_assert_expected_messages();
  GSettings *settings = g_settings_new(SCHEMA);
  g_assert_cmpint(g_settings_get_int(settings, "page-size"), ==, 9);
  g_object_unref(settings);
  output_empty();
}

static void writes(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  g_assert_true(g_settings_set_string(settings, "layout", "written"));
  expect_write(PATH, "layout", g_variant_new_string("written"));
  g_assert_true(g_settings_set_boolean(settings, "enabled", TRUE));
  expect_write(PATH, "enabled", g_variant_new_boolean(TRUE));
  g_assert_true(g_settings_set_int(settings, "page-size", 5));
  expect_write(PATH, "page-size", g_variant_new_int32(5));
  g_settings_reset(settings, "layout");
  expect_write(PATH, "layout", g_variant_new_string("2"));
  g_autofree gchar *layout = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(layout, ==, "2");
  g_object_unref(settings);
  settings = g_settings_new(CHILD);
  g_assert_true(g_settings_set_string(settings, "layout", "nested"));
  expect_write(CHILD_PATH, "layout", g_variant_new_string("nested"));
  g_object_unref(settings);
  output_empty();
}

static void tree_writes(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  GSettings *observer = g_settings_new(SCHEMA);
  g_settings_delay(settings);
  g_assert_true(g_settings_set_boolean(settings, "enabled", FALSE));
  g_assert_true(g_settings_set_string(settings, "layout", "delayed"));
  output_empty();
  g_settings_apply(settings);
  expect_write(PATH, "enabled", g_variant_new_boolean(FALSE));
  expect_write(PATH, "layout", g_variant_new_string("delayed"));
  g_autofree gchar *layout = g_settings_get_string(observer, "layout");
  g_assert_cmpstr(layout, ==, "delayed");
  g_assert_false(g_settings_get_boolean(observer, "enabled"));
  g_settings_reset(settings, "layout");
  g_settings_apply(settings);
  expect_write(PATH, "layout", g_variant_new_string("2"));
  g_object_unref(observer);
  g_object_unref(settings);
  output_empty();
}

static void relocatable(void) {
  GSettings *first = g_settings_new_with_path(RELOCATABLE, FIRST);
  GSettings *second = g_settings_new_with_path(RELOCATABLE, SECOND);
  guint changed = 0;
  g_signal_connect(second, "changed::layout", G_CALLBACK(count_changes),
                   &changed);
  g_assert_cmpint(change(FIRST, "layout", g_variant_new_string("first")), ==,
                  0);
  ibusweb_pump();
  g_assert_cmpuint(changed, ==, 0);
  g_autofree gchar *one = g_settings_get_string(first, "layout");
  g_autofree gchar *two = g_settings_get_string(second, "layout");
  g_assert_cmpstr(one, ==, "first");
  g_assert_cmpstr(two, ==, "relocatable");
  g_assert_true(g_settings_set_string(second, "layout", "second"));
  expect_write(SECOND, "layout", g_variant_new_string("second"));
  g_object_unref(first);
  g_object_unref(second);
  output_empty();
}

static void refused_instances(void) {
  const struct {
    const gchar *schema;
    const gchar *path;
    const gchar *message;
  } cases[] = {
      {"org.ibus-web.Missing", "/org/ibus-web/missing/",
       "*Unknown settings schema*"},
      {SCHEMA, "/org/ibus-web/elsewhere/", "*has the fixed path*"},
      {RELOCATABLE, "relative/", "*Invalid settings path*"},
      {RELOCATABLE, "/org//double/", "*Invalid settings path*"},
  };
  for (guint i = 0; i < G_N_ELEMENTS(cases); ++i) {
    GVariantBuilder builder;
    g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
    add_instance(&builder, cases[i].schema, cases[i].path, "layout",
                 g_variant_new_string("refused"));
    g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, cases[i].message);
    apply(g_variant_builder_end(&builder));
    g_test_assert_expected_messages();

    g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                          "*Unknown settings path*");
    g_assert_cmpint(
        change(cases[i].path, "layout", g_variant_new_string("refused")), ==,
        -ENOENT);
    g_test_assert_expected_messages();
  }

  GSettings *undeclared = g_settings_new_with_path(
      RELOCATABLE, "/org/ibus-web/relocatable/undeclared/");
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING,
                        "*Unknown settings path*");
  g_assert_false(g_settings_set_string(undeclared, "layout", "lost"));
  g_test_assert_expected_messages();
  g_object_unref(undeclared);
  output_empty();
}

static gint request(guint16 kind, GVariant *payload) {
  g_variant_ref_sink(payload);
  gsize length = sizeof(IBusWebRequestHeader) + g_variant_get_size(payload);
  guint8 *bytes = g_malloc(length);
  IBusWebRequestHeader header = {.kind = GUINT16_TO_LE(kind)};
  memcpy(bytes, &header, sizeof header);
  g_variant_store(payload, bytes + sizeof header);
  gint result = ibusweb_dispatch(bytes, length);
  /* The host reuses the request slot before the next pump. */
  memset(bytes, 0xa5, length);
  g_free(bytes);
  g_variant_unref(payload);
  ibusweb_pump();
  return result;
}

static void protocol(void) {
  GSettings *settings = g_settings_new(SCHEMA);
  guint changed = 0;
  g_signal_connect(settings, "changed::layout", G_CALLBACK(count_changes),
                   &changed);
  g_assert_cmpint(
      request(IBUSWEB_REQ_INIT,
              g_variant_new(
                  "(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                  snapshot_value("layout", g_variant_new_string("initial")))),
      ==, 0);
  g_autofree gchar *initial = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(initial, ==, "initial");
  g_assert_cmpuint(changed, ==, 0);
  output_empty();
  for (guint i = 0; i < 2; ++i) {
    g_assert_cmpint(request(IBUSWEB_REQ_SETTING_CHANGED,
                            g_variant_new("(ssv)", PATH, "layout",
                                          g_variant_new_string("host-change"))),
                    ==, 0);
    g_assert_cmpuint(changed, ==, 1);
    g_autofree gchar *layout = g_settings_get_string(settings, "layout");
    g_assert_cmpstr(layout, ==, "host-change");
    output_empty();
  }
  g_test_expect_message("ibus-web", G_LOG_LEVEL_WARNING, "*Invalid value*");
  g_assert_cmpint(request(IBUSWEB_REQ_SETTING_CHANGED,
                          g_variant_new("(ssv)", PATH, "layout",
                                        g_variant_new_boolean(TRUE))),
                  ==, -EINVAL);
  g_test_assert_expected_messages();
  g_assert_cmpuint(changed, ==, 1);
  g_autofree gchar *unchanged = g_settings_get_string(settings, "layout");
  g_assert_cmpstr(unchanged, ==, "host-change");
  output_empty();
  g_object_unref(settings);
}

int main(int argc, char **argv) {
  static int32_t wake_word;
  g_unsetenv("GSETTINGS_BACKEND");
  g_test_init(&argc, &argv, NULL);
  g_assert_cmpint(ibusweb_runtime_init(&wake_word), ==, 0);
  declare();
  g_test_add_func("/settings/registration", registration);
  g_test_add_func("/settings/defaults", defaults);
  g_test_add_func("/settings/snapshot", snapshot);
  g_test_add_func("/settings/notification", notification);
  g_test_add_func("/settings/invalid", invalid_values);
  g_test_add_func("/settings/writes", writes);
  g_test_add_func("/settings/tree", tree_writes);
  g_test_add_func("/settings/relocatable", relocatable);
  g_test_add_func("/settings/refused", refused_instances);
  g_test_add_func("/settings/protocol", protocol);
  return g_test_run();
}
```

In `runtime/libibus-web/tests/test-dispatch.c`, replace `snapshot()` with:

```c
static GVariant *snapshot(guint version) {
  GVariantBuilder builder;
  g_variant_builder_init(&builder, G_VARIANT_TYPE("a(ssa{sv})"));
  g_variant_builder_add_parsed(&builder,
                               "('review', '/review/', {'value': <true>})");
  return g_variant_new("(u@a(ssa{sv}))", version,
                       g_variant_builder_end(&builder));
}
```

and the `SettingChanged` check near the end of `main` with:

```c
  g_assert_cmpint(send(IBUSWEB_REQ_SETTING_CHANGED, 0,
                       g_variant_new("(ssv)", "/review/", "value",
                                     g_variant_new_boolean(TRUE))),
                  ==, -ENOENT);
  expect_log(G_LOG_LEVEL_WARNING, "ibus-web",
             "Unknown settings path: /review/");
```

The `expect_log(…, "Unknown settings schema: review")` after the first successful `Init` stays: the Init entry's unknown schema still logs that text.

- [ ] **Step 5: Run the runtime tests to see them fail**

Run: `nix develop -c git add runtime/libibus-web && nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: FAIL (the payload type and `ibusweb_settings_changed`'s meaning have changed; the settings tests fail).

- [ ] **Step 6: Rewrite the settings backend**

In `runtime/libibus-web/src/settings.h`, replace the two declarations with:

```c
/* Arguments are borrowed; stored values acquire their own references. The
 * instances are Init's a(ssa{sv}): schema id, path and stored values. */
G_GNUC_INTERNAL void ibusweb_settings_init(GVariant *instances);
G_GNUC_INTERNAL int ibusweb_settings_changed(const char *path, const char *key,
                                             GVariant *value);
```

Replace `runtime/libibus-web/src/settings.c` with:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#define G_SETTINGS_ENABLE_BACKEND
#include "settings.h"
#include "output.h"
#include <errno.h>
#include <gio/gio.h>
#include <gio/gsettingsbackend.h>
#include <ibus-web/protocol.h>
#include <string.h>

typedef struct {
  GSettingsBackend parent;
  GMutex lock;
  /* Full key paths to values; a missing value has the schema's default. */
  GHashTable *values;
  /* Instance paths to their schemas, as Init declared them. */
  GHashTable *instances;
} IBusWebSettingsBackend;
typedef struct {
  GSettingsBackendClass parent;
} IBusWebSettingsBackendClass;
G_DEFINE_TYPE(IBusWebSettingsBackend, ibusweb_settings_backend,
              G_TYPE_SETTINGS_BACKEND)

typedef struct {
  gchar *instance;
  gchar *name;
  gchar *path;
  GSettingsSchemaKey *definition;
} SettingKey;

static void key_free(gpointer data) {
  SettingKey *key = data;
  g_free(key->instance);
  g_free(key->name);
  g_free(key->path);
  g_settings_schema_key_unref(key->definition);
  g_free(key);
}
G_DEFINE_AUTOPTR_CLEANUP_FUNC(SettingKey, key_free)

static SettingKey *key_new(GSettingsSchema *schema, const gchar *instance,
                           const gchar *name) {
  SettingKey *key = g_new(SettingKey, 1);
  key->instance = g_strdup(instance);
  key->name = g_strdup(name);
  key->path = g_strconcat(instance, name, NULL);
  key->definition = g_settings_schema_get_key(schema, name);
  return key;
}

/* GSettings' own rule for a path: absolute, a directory, no empty
 * component. */
static gboolean path_valid(const gchar *path) {
  return path[0] == '/' && g_str_has_suffix(path, "/") &&
         strstr(path, "//") == NULL;
}

static gboolean declare(IBusWebSettingsBackend *backend, const gchar *id,
                        const gchar *path) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  g_autoptr(GSettingsSchema) schema =
      source == NULL ? NULL : g_settings_schema_source_lookup(source, id, TRUE);
  if (schema == NULL) {
    g_warning("Unknown settings schema: %s", id);
    return FALSE;
  }
  if (!path_valid(path)) {
    g_warning("Invalid settings path: %s", path);
    return FALSE;
  }
  const gchar *fixed = g_settings_schema_get_path(schema);
  if (fixed != NULL && !g_str_equal(fixed, path)) {
    g_warning("Settings schema %s has the fixed path %s, not %s", id, fixed,
              path);
    return FALSE;
  }
  g_mutex_lock(&backend->lock);
  g_hash_table_replace(backend->instances, g_strdup(path),
                       g_settings_schema_ref(schema));
  g_mutex_unlock(&backend->lock);
  return TRUE;
}

static GSettingsSchema *instance_at(IBusWebSettingsBackend *backend,
                                    const gchar *path) {
  g_mutex_lock(&backend->lock);
  GSettingsSchema *schema = g_hash_table_lookup(backend->instances, path);
  if (schema != NULL)
    g_settings_schema_ref(schema);
  g_mutex_unlock(&backend->lock);
  return schema;
}

static SettingKey *resolve_key(IBusWebSettingsBackend *backend,
                               const gchar *path, const gchar *name,
                               gint *error) {
  g_autoptr(GSettingsSchema) schema = instance_at(backend, path);
  if (schema == NULL) {
    g_warning("Unknown settings path: %s", path);
    *error = -ENOENT;
    return NULL;
  }
  if (!g_settings_schema_has_key(schema, name)) {
    g_warning("Unknown settings key: %s%s", path, name);
    *error = -ENOENT;
    return NULL;
  }
  *error = 0;
  return key_new(schema, path, name);
}

/* A key path belongs to the longest declared instance path that prefixes it
 * and whose schema has the rest as a key. */
static SettingKey *resolve_path(IBusWebSettingsBackend *backend,
                                const gchar *path) {
  g_autoptr(GSettingsSchema) best = NULL;
  g_autofree gchar *best_path = NULL;
  gsize best_length = 0;
  g_mutex_lock(&backend->lock);
  GHashTableIter iter;
  gpointer instance, schema;
  g_hash_table_iter_init(&iter, backend->instances);
  while (g_hash_table_iter_next(&iter, &instance, &schema)) {
    gsize length = strlen(instance);
    if (length > best_length && g_str_has_prefix(path, instance) &&
        g_settings_schema_has_key(schema, path + length)) {
      g_clear_pointer(&best, g_settings_schema_unref);
      g_clear_pointer(&best_path, g_free);
      best = g_settings_schema_ref(schema);
      best_path = g_strdup(instance);
      best_length = length;
    }
  }
  g_mutex_unlock(&backend->lock);
  if (best == NULL) {
    g_warning("Unknown settings path: %s", path);
    return NULL;
  }
  return key_new(best, best_path, path + best_length);
}

static gboolean value_valid(SettingKey *key, GVariant *value) {
  if (g_variant_is_of_type(
          value, g_settings_schema_key_get_value_type(key->definition)) &&
      g_settings_schema_key_range_check(key->definition, value))
    return TRUE;
  g_warning("Invalid value for settings key: %s", key->path);
  return FALSE;
}

/* Caller holds the store lock; a missing value has the schema's default. */
static gboolean store_value(IBusWebSettingsBackend *backend, SettingKey *key,
                            GVariant *value) {
  GVariant *old = g_hash_table_lookup(backend->values, key->path);
  g_autoptr(GVariant) fallback = NULL;
  if (old == NULL) {
    fallback = g_settings_schema_key_get_default_value(key->definition);
    old = fallback;
  }
  gboolean changed = !g_variant_equal(old, value);
  g_hash_table_replace(backend->values, g_strdup(key->path),
                       g_variant_ref(value));
  return changed;
}

static void emit_write(SettingKey *key, GVariant *value) {
  ibusweb_output_append(
      0, IBUSWEB_REC_SETTING_WRITTEN,
      g_variant_new("(ssv)", key->instance, key->name, value));
}

static gboolean write_value(IBusWebSettingsBackend *backend, SettingKey *key,
                            GVariant *value, gpointer origin) {
  if (!value_valid(key, value))
    return FALSE;
  g_mutex_lock(&backend->lock);
  gboolean changed = store_value(backend, key, value);
  g_mutex_unlock(&backend->lock);
  if (changed)
    g_settings_backend_changed(G_SETTINGS_BACKEND(backend), key->path, origin);
  emit_write(key, value);
  return TRUE;
}

static GVariant *read_value(GSettingsBackend *base, const gchar *path,
                            const GVariantType *type, gboolean default_value) {
  if (default_value)
    return NULL;
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_mutex_lock(&backend->lock);
  GVariant *value = g_hash_table_lookup(backend->values, path);
  value = value != NULL && g_variant_is_of_type(value, type)
              ? g_variant_ref(value)
              : NULL;
  g_mutex_unlock(&backend->lock);
  return value;
}

static gboolean writable(GSettingsBackend *base G_GNUC_UNUSED,
                         const gchar *path G_GNUC_UNUSED) {
  return TRUE;
}

static gboolean backend_write(GSettingsBackend *base, const gchar *path,
                              GVariant *value, gpointer origin) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_autoptr(SettingKey) key = resolve_path(backend, path);
  return key != NULL && write_value(backend, key, value, origin);
}

static void reset(GSettingsBackend *base, const gchar *path, gpointer origin) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_autoptr(SettingKey) key = resolve_path(backend, path);
  if (key == NULL)
    return;
  g_autoptr(GVariant) value =
      g_settings_schema_key_get_default_value(key->definition);
  write_value(backend, key, value, origin);
}

typedef struct {
  SettingKey *key;
  GVariant *value;
} PendingWrite;

static void pending_free(gpointer data) {
  PendingWrite *pending = data;
  key_free(pending->key);
  g_variant_unref(pending->value);
  g_free(pending);
}

typedef struct {
  IBusWebSettingsBackend *backend;
  GPtrArray *writes;
  gboolean valid;
} WriteTree;

static gboolean prepare_write(gpointer path, gpointer value, gpointer data) {
  WriteTree *tree = data;
  SettingKey *key = resolve_path(tree->backend, path);
  if (key == NULL) {
    tree->valid = FALSE;
    return TRUE;
  }
  GVariant *resolved =
      value == NULL ? g_settings_schema_key_get_default_value(key->definition)
                    : g_variant_ref(value);
  if (!value_valid(key, resolved)) {
    key_free(key);
    g_variant_unref(resolved);
    tree->valid = FALSE;
    return TRUE;
  }
  PendingWrite *pending = g_new(PendingWrite, 1);
  pending->key = key;
  pending->value = resolved;
  g_ptr_array_add(tree->writes, pending);
  return FALSE;
}

static gboolean write_tree(GSettingsBackend *base, GTree *values,
                           gpointer origin) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  g_autoptr(GPtrArray) pending = g_ptr_array_new_with_free_func(pending_free);
  WriteTree tree = {backend, pending, TRUE};
  g_tree_foreach(values, prepare_write, &tree);
  if (!tree.valid)
    return FALSE;
  g_mutex_lock(&backend->lock);
  for (guint i = 0; i < pending->len; ++i) {
    PendingWrite *entry = g_ptr_array_index(pending, i);
    store_value(backend, entry->key, entry->value);
  }
  g_mutex_unlock(&backend->lock);
  /* Observers see the complete transaction before receiving any notification.
   */
  g_settings_backend_changed_tree(base, values, origin);
  for (guint i = 0; i < pending->len; ++i) {
    PendingWrite *entry = g_ptr_array_index(pending, i);
    emit_write(entry->key, entry->value);
  }
  return TRUE;
}

static void value_unref(gpointer data) { g_variant_unref(data); }

static void schema_unref(gpointer data) { g_settings_schema_unref(data); }

static void finalize(GObject *object) {
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)object;
  g_hash_table_unref(backend->values);
  g_hash_table_unref(backend->instances);
  g_mutex_clear(&backend->lock);
  G_OBJECT_CLASS(ibusweb_settings_backend_parent_class)->finalize(object);
}

static void
ibusweb_settings_backend_class_init(IBusWebSettingsBackendClass *klass) {
  GSettingsBackendClass *backend = G_SETTINGS_BACKEND_CLASS(klass);
  backend->read = read_value;
  backend->get_writable = writable;
  backend->write = backend_write;
  backend->write_tree = write_tree;
  backend->reset = reset;
  G_OBJECT_CLASS(klass)->finalize = finalize;
}

static void ibusweb_settings_backend_init(IBusWebSettingsBackend *backend) {
  g_mutex_init(&backend->lock);
  backend->values =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, value_unref);
  backend->instances =
      g_hash_table_new_full(g_str_hash, g_str_equal, g_free, schema_unref);
}

static GSettingsBackend *default_backend(void) {
  GSettingsBackend *backend = g_settings_backend_get_default();
  if (!G_TYPE_CHECK_INSTANCE_TYPE(backend,
                                  ibusweb_settings_backend_get_type())) {
    g_warning("The default settings backend is not ibus-web");
    g_object_unref(backend);
    return NULL;
  }
  return backend;
}

void ibusweb_settings_init(GVariant *instances) {
  g_autoptr(GSettingsBackend) base = default_backend();
  if (base == NULL)
    return;
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  GVariantIter entries;
  const gchar *id, *path;
  GVariant *values;
  g_variant_iter_init(&entries, instances);
  while (g_variant_iter_next(&entries, "(&s&s@a{sv})", &id, &path, &values)) {
    if (declare(backend, id, path)) {
      GVariantIter keys;
      const gchar *name;
      GVariant *value;
      g_variant_iter_init(&keys, values);
      while (g_variant_iter_next(&keys, "{&sv}", &name, &value)) {
        gint error;
        g_autoptr(SettingKey) key = resolve_key(backend, path, name, &error);
        if (key != NULL && value_valid(key, value)) {
          g_mutex_lock(&backend->lock);
          store_value(backend, key, value);
          g_mutex_unlock(&backend->lock);
        }
        g_variant_unref(value);
      }
    }
    g_variant_unref(values);
  }
}

int ibusweb_settings_changed(const char *path, const char *name,
                             GVariant *value) {
  g_autoptr(GSettingsBackend) base = default_backend();
  if (base == NULL)
    return -ENOTSUP;
  IBusWebSettingsBackend *backend = (IBusWebSettingsBackend *)base;
  gint error;
  g_autoptr(SettingKey) key = resolve_key(backend, path, name, &error);
  if (key == NULL)
    return error;
  if (!value_valid(key, value))
    return -EINVAL;
  g_mutex_lock(&backend->lock);
  gboolean changed = store_value(backend, key, value);
  g_mutex_unlock(&backend->lock);
  if (changed)
    g_settings_backend_changed(base, key->path, NULL);
  return 0;
}

void ibusweb_settings_register(void) {
  /* The memory backend registers GIO's extension points through public API. */
  GSettingsBackend *bootstrap = g_memory_settings_backend_new();
  g_object_unref(bootstrap);
  g_io_extension_point_implement(G_SETTINGS_BACKEND_EXTENSION_POINT_NAME,
                                 ibusweb_settings_backend_get_type(),
                                 "ibus-web", 1000);
}
```

In `runtime/libibus-web/src/dispatch.c`, replace the `SettingChanged` branch with:

```c
  if (kind == IBUSWEB_REQ_SETTING_CHANGED) {
    const gchar *path, *key;
    g_autoptr(GVariant) value = NULL;
    g_variant_get(payload, "(&s&sv)", &path, &key, &value);
    return ibusweb_settings_changed(path, key, value);
  }
```

In `runtime/libibus-web/include/ibus-web/runtime.h`, replace the paragraph beginning `SettingChanged ignores the header's ic` with:

```c
 * SettingChanged ignores the header's ic, so its ENOENT means a path no Init
 * entry declared or a key its schema lacks, never a missing context; it
 * returns EINVAL for a value outside the key's type or range, or ENOTSUP for a
 * default settings backend other than the runtime's. Each of these also
 * writes a Log record.
```

- [ ] **Step 7: Run the runtime tests to see them pass**

Run: `nix develop -c git add runtime/libibus-web && nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: PASS, with `/settings/relocatable` and `/settings/refused` among the passing cases.

- [ ] **Step 8: Update the Hangul golden harness**

In `engines/hangul/checks/golden/harness.h`, below `#define HANGUL_SCHEMA …` add:

```c
#define HANGUL_PATH "/org/freedesktop/ibus/engine/hangul/"
#define PANEL_SCHEMA "org.freedesktop.ibus.panel"
#define PANEL_PATH "/desktop/ibus/panel/"
```

and change the `golden_setting` declaration to:

```c
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value);
```

In `engines/hangul/checks/golden/harness.c`, change `golden_setting` to:

```c
void golden_setting(Fixture *fixture, const gchar *path, const gchar *key,
                    GVariant *value) {
  g_assert_cmpint(golden_request(fixture, IBUSWEB_REQ_SETTING_CHANGED,
                                 g_variant_new("(ssv)", path, key, value)),
                  ==, 0);
  g_assert_cmpuint(golden_count(fixture, IBUSWEB_REC_SETTING_WRITTEN), ==, 0);
}
```

replace `reset_schemas`, `baseline` and `reset_settings` with:

```c
static const struct {
  const gchar *schema;
  const gchar *path;
} reset_instances[] = {{HANGUL_SCHEMA, HANGUL_PATH}, {PANEL_SCHEMA, PANEL_PATH}};

static GVariant *baseline(GSettingsSchemaKey *key, const gchar *schema) {
  if (g_str_equal(schema, HANGUL_SCHEMA) &&
      g_str_equal(g_settings_schema_key_get_name(key), "hanja-keys"))
    return g_variant_ref_sink(g_variant_new_string(golden_hanja_keys));
  return g_settings_schema_key_get_default_value(key);
}

static void reset_settings(Fixture *fixture) {
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  for (guint i = 0; i < G_N_ELEMENTS(reset_instances); ++i) {
    g_autoptr(GSettingsSchema) schema = g_settings_schema_source_lookup(
        source, reset_instances[i].schema, TRUE);
    g_assert_nonnull(schema);
    g_auto(GStrv) names = g_settings_schema_list_keys(schema);
    for (gchar **name = names; *name != NULL; ++name) {
      g_autoptr(GSettingsSchemaKey) key =
          g_settings_schema_get_key(schema, *name);
      g_autoptr(GVariant) value = baseline(key, reset_instances[i].schema);
      golden_setting(fixture, reset_instances[i].path, *name, value);
    }
  }
}
```

and in `golden_init` replace the snapshot built from `schemas` with:

```c
  GVariantBuilder keys, instances;
  g_variant_builder_init(&keys, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&keys, "{sv}", "hanja-keys",
                        g_variant_new_string(golden_hanja_keys));
  g_variant_builder_init(&instances, G_VARIANT_TYPE("a(ssa{sv})"));
  g_variant_builder_add(&instances, "(ss@a{sv})", HANGUL_SCHEMA, HANGUL_PATH,
                        g_variant_builder_end(&keys));
  g_variant_builder_add_parsed(&instances, "(%s, %s, @a{sv} {})",
                               PANEL_SCHEMA, PANEL_PATH);
  Fixture fixture = {.records = g_ptr_array_new_with_free_func(record_free)};
  g_assert_cmpint(
      golden_request(&fixture, IBUSWEB_REQ_INIT,
                     g_variant_new("(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION,
                                   g_variant_builder_end(&instances))),
      ==, 0);
```

In `engines/hangul/checks/golden/golden.c`, change the three calls: `golden_setting(fixture, HANGUL_SCHEMA, "hanja-keys", …)` → `golden_setting(fixture, HANGUL_PATH, "hanja-keys", …)`; `golden_setting(fixture, "org.freedesktop.ibus.panel", "lookup-table-orientation", …)` → `golden_setting(fixture, PANEL_PATH, "lookup-table-orientation", …)`; `golden_setting(fixture, HANGUL_SCHEMA, "hangul-keyboard", …)` → `golden_setting(fixture, HANGUL_PATH, "hangul-keyboard", …)`.

- [ ] **Step 9: Update the IBus test driver**

Traces name settings by schema; the driver finds each fixed schema's path. In `tools/ibus-test/wasm/driver.c`, replace the part of `settings_snapshot` from `GVariantBuilder snapshot;` to the end of the function with:

```c
  GVariantBuilder snapshot;
  g_variant_builder_init(&snapshot, G_VARIANT_TYPE("a(ssa{sv})"));
  GSettingsSchemaSource *source = g_settings_schema_source_get_default();
  GHashTableIter iterator;
  gpointer schema, keys;
  g_hash_table_iter_init(&iterator, schemas);
  while (ok && g_hash_table_iter_next(&iterator, &schema, &keys)) {
    g_autoptr(GSettingsSchema) found =
        source == NULL ? NULL
                       : g_settings_schema_source_lookup(source, schema, TRUE);
    const gchar *path = found == NULL ? NULL : g_settings_schema_get_path(found);
    if (path == NULL) {
      g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                  "trace settings schema %s has no fixed path",
                  (const gchar *)schema);
      ok = FALSE;
      break;
    }
    g_variant_builder_add(&snapshot, "(ss@a{sv})", (gchar *)schema, path,
                          g_variant_builder_end(keys));
  }
  g_hash_table_unref(schemas);
  if (!ok) {
    g_variant_builder_clear(&snapshot);
    return NULL;
  }
  return g_variant_builder_end(&snapshot);
}
```

and in `ibus_test_wasm_run` change `g_variant_new("(u@a{sa{sv}})", IBUSWEB_PROTOCOL_VERSION, snapshot)` to `g_variant_new("(u@a(ssa{sv}))", IBUSWEB_PROTOCOL_VERSION, snapshot)`.

- [ ] **Step 10: Update the worker-host and core tests**

In `packages/worker-host/test/shared/engine.ts`, `init` becomes:

```ts
const init = () =>
  new Init({
    version: PROTOCOL_VERSION,
    settings: [{ schemaId: "org.example.echo", path: "/org/example/echo/", values: { value: stringVariant("snapshot") } }],
  });
```

and the `SettingWritten` expectation becomes `expect.objectContaining({ _tag: "SettingWritten", path: "/org/example/echo/" })`.

In `packages/worker-host/test/shared/protocol.ts`, the `replySequence` Init becomes:

```ts
      new Init({
        version: PROTOCOL_VERSION,
        settings: [
          { schemaId: "org.example.absent", path: "/org/example/absent/", values: { unknown: stringVariant("ignored") } },
        ],
      }),
```

and every other `new Init({ version: PROTOCOL_VERSION, settings: {} })` in that file and in `packages/worker-host/test/shared/ring.ts` and `packages/core/test/node/connection/connection.test.ts` becomes `new Init({ version: PROTOCOL_VERSION, settings: [] })`.

In `packages/worker-host/test/engines/table.test.ts`, `settings: {}` becomes `settings: []` in both `SessionOptions`.

In `packages/worker-host/test/engines/hangul.test.ts`, below `const HANGUL_SCHEMA = …` add `const HANGUL_PATH = "/org/freedesktop/ibus/engine/hangul/";`; the options' `settings` becomes `[{ schemaId: HANGUL_SCHEMA, path: HANGUL_PATH, values: { "hanja-keys": stringVariant("Hangul_Hanja,F9,F8") } }]`; `new SettingChanged({ schemaId: HANGUL_SCHEMA, … })` becomes `new SettingChanged({ path: HANGUL_PATH, key: "hangul-keyboard", value: stringVariant("39") })`; and the written record's expectation becomes `{ _tag: "SettingWritten", path: HANGUL_PATH, key: "hangul-keyboard", value: stringVariant("39") }`. `writeStringSetting` still takes `HANGUL_SCHEMA`: its test op opens the schema by id.

In `packages/worker-host/test/engines/mozc.test.ts`, below `const MOZC_SCHEMA = …` add `const MOZC_PATH = "/org/freedesktop/ibus/engine/mozc/";`; every `settings: {}` becomes `settings: []`; `{ [MOZC_SCHEMA]: { "punctuation-method": stringVariant("comma-period") } }` becomes `[{ schemaId: MOZC_SCHEMA, path: MOZC_PATH, values: { "punctuation-method": stringVariant("comma-period") } }]`; `{ [MOZC_SCHEMA]: { "active-on-launch": booleanVariant(true) } }` becomes `[{ schemaId: MOZC_SCHEMA, path: MOZC_PATH, values: { "active-on-launch": booleanVariant(true) } }]`; and `new SettingChanged({ schemaId: MOZC_SCHEMA, … })` becomes `new SettingChanged({ path: MOZC_PATH, key: "punctuation-method", value: stringVariant("comma-period") })`.

- [ ] **Step 11: Update the docs**

In `docs/runtime.md`, in the dispatcher's error paragraph replace `` `SettingChanged` ignores the header's `ic`, so its `-ENOENT` means an unknown schema or key, never a missing context; it returns `-EINVAL` for a value outside the key's type or range and `-ENOTSUP` for a relocatable schema or a default settings backend other than the runtime's, and each of these also writes a `Log` record. `` with:

```markdown
`SettingChanged` ignores the header's `ic`, so its `-ENOENT` means a path no
`Init` entry declared or a key its schema lacks, never a missing context; it
returns `-EINVAL` for a value outside the key's type or range and `-ENOTSUP` for
a default settings backend other than the runtime's, and each of these also
writes a `Log` record.
```

and in the settings backend section replace the text from `default. Its per-instance store is keyed` through `different selected backend `-ENOTSUP`.` with:

```markdown
default. `Init` declares the module's schema instances, each a schema id at a
path: a fixed schema at its own path, a relocatable one at any path that is
absolute, ends in `/` and has no empty component. An unknown schema, a fixed
schema at another path or an invalid path is refused with a warning. Values are
keyed by settings path and key, protected by a mutex, and fall back to schema
defaults. Init's values are applied silently. `SettingChanged` names a declared
path and a key and validates the type and range; a different value notifies
listeners, an equal value does nothing, and neither echoes a `SettingWritten`
record.

Engine writes, resets and delayed write-tree transactions belong to the longest
declared path that prefixes their key; they notify listeners and emit
`SettingWritten (ssv)`, with the instance's path, for the page to persist. A
transaction validates all entries and installs the complete batch before
notifying. A write under no declared path, or with an invalid value, is refused
with a warning.
```

In `docs/specs/2026-09-26-ibus-web-design.md`:
- §5.2.3: replace `` `SettingChanged` ignores the header's context, so its `ENOENT` means an unknown schema or key, never a missing context; it returns `EINVAL` for a value outside the key's type or range and `ENOTSUP` for a relocatable schema or a default settings backend other than the runtime's, each with a `Log` record. `` with `` `SettingChanged` ignores the header's context, so its `ENOENT` means a path no `Init` entry declared or a key its schema lacks, never a missing context; it returns `EINVAL` for a value outside the key's type or range and `ENOTSUP` for a default settings backend other than the runtime's, each with a `Log` record. ``
- §5.2.5: replace the **Values.** bullet with `- **Values.** `Init` declares every schema instance the module uses, a schema id at a path (a relocatable schema at as many paths as the build declares), with its stored values. `SettingChanged` requests name a path and a key; they update the backend and call `g_settings_backend_changed`, so engines' own `changed::` handlers fire. Engine writes resolve to the declared instance whose path prefixes their key and emit `SettingWritten` records, with that path, for the page to persist (§7.1.4).`
- §6.1.3: in the table, `Init`'s payload becomes `protocol version, schema instances (id, path, stored values)` and `SettingChanged`'s becomes `path, key, `v``.
- §6.1.4: `plus `SettingWritten (ssv)`` becomes `plus `SettingWritten (ssv)` (path, key, value)`.

Format both: `nix develop -c oxfmt docs/runtime.md docs/specs/2026-09-26-ibus-web-design.md`.

- [ ] **Step 12: Run the wire's checks**

Run each, all expected to PASS:

```bash
nix develop -c git add packages/protocol packages/worker-host/test engines/hangul/checks tools/ibus-test runtime/libibus-web docs/runtime.md docs/specs/2026-09-26-ibus-web-design.md packages/core/test/node/connection/connection.test.ts
nix build .#checks.x86_64-linux.protocol-node -L
nix build .#checks.x86_64-linux.protocol-parity -L
nix build .#checks.x86_64-linux.libibus-web-tests -L
nix build .#checks.x86_64-linux.hangul-golden -L
nix build .#checks.x86_64-linux.worker-host-node -L
nix build .#checks.x86_64-linux.hangul-host -L
nix build .#checks.x86_64-linux.mozc-host -L
nix build .#checks.x86_64-linux.table-host -L
nix build '.#checks.x86_64-linux."files:runtime/libibus-web/include/ibus-web/protocol.h"' -L
```

List the IBus test driver's checks with `nix eval --json .#checks.x86_64-linux --apply builtins.attrNames | tr , '\n' | grep -i ibus-test` and build each; expected PASS. Core's registry still builds the old `Init`, so `core-*` checks fail until Task 4.

- [ ] **Step 13: Commit**

```bash
nix develop -c git commit -m "feat(protocol): declare settings instances in Init and address settings by path" -- packages/protocol runtime/libibus-web engines/hangul/checks tools/ibus-test/wasm/driver.c packages/worker-host/test packages/core/test/node/connection/connection.test.ts docs/runtime.md docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 4: The page handles settings as instances

**Files:**
- Modify: `packages/core/src/services/settings.ts`, `packages/core/src/settings/persister.ts`, `packages/core/src/settings/api.ts`, `packages/core/src/services/modules.ts`, `packages/core/src/page/index.ts`
- Modify: `packages/core/test/browser/settings.test.ts`, `packages/core/test/browser/real-host.ts`, `packages/core/test/node/router/services.test.ts`, `packages/core/test/node/router/async.test.ts`
- Docs: `docs/core.md`, `docs/specs/2026-09-26-ibus-web-design.md` (§7.1.4)

**Interfaces:**
- Consumes: Task 1's metadata; Task 3's `Init`, `SettingChanged` and `SettingWritten`.
- Produces:
  - `export interface SettingsInstance { readonly schemaId: string; readonly path: string }`
  - `export type SettingsSnapshot = Record<string, Record<string, typeof GVariantVariant.Type>>` — path, then key
  - `export type SettingsChange = SettingsInstance & Pick<SettingWritten, "key" | "value"> & { readonly origin?: symbol }`
  - `SettingsSourceService`: `register?(metadata)`, `write?(change)`, `read?(instance: SettingsInstance, key: string)`, `snapshot(instances: readonly SettingsInstance[])`, `written(change)`, `changes`
  - `SettingsApiService`: `schemas(module)`, `get(module, path, key)`, `set(module, path, key, value)`, `reset(module, path, key)`, `changes`
  - `settingsInstances(metadata): SettingsInstance[]` exported from `packages/core/src/settings/api.ts`

- [ ] **Step 1: Update the tests**

`packages/core/test/node/router/async.test.ts`: in both `new SettingChanged({ schemaId: "test", key: "mode", value: booleanVariant(true) })`, replace `schemaId: "test"` with `path: "/test/"`.

`packages/core/test/node/router/services.test.ts`:
- Below `const manifest …` add:

```ts
const metadata = { schemas: [{ id: "settings", paths: ["/settings/"], keys: [] }] };
```

- Add `loadMetadata: async () => metadata,` to every `makeModuleRegistry({ … })` options object in the file that sets `loadManifest: async () => manifest` (the manifest names `settingsSchemas: ["settings"]`, so the registry now always reads its metadata). For every manifest object spread with other `settingsSchemas`, keep it as is.
- Add `settingsMetadata: { url: "settings.json", size: 1 },` to `manifest`.
- Every `settings.written({ schemaId: "settings", key: …, value: … })` and `closed.written({ … })` gains `path: "/settings/",` after `schemaId: "settings",`.
- Every expected `Init` `settings: { settings: { … } }` becomes `settings: [{ schemaId: "settings", path: "/settings/", values: { … } }]`; `{ settings: { settings: {} } }` becomes `{ settings: [{ schemaId: "settings", path: "/settings/", values: {} }] }`.
- `settings.snapshot(["settings"])` becomes `settings.snapshot([{ schemaId: "settings", path: "/settings/" }])`, and its expectations index by path: `toHaveProperty(["/settings/", "x"])` and `toEqual({ "/settings/": {} })`.

`packages/core/test/browser/real-host.ts`: below `export const HANGUL_SCHEMA = …` add `export const HANGUL_PATH = "/org/freedesktop/ibus/engine/hangul/";`, and change `SettingsSource.layer({ [HANGUL_SCHEMA]: { … } })` to `SettingsSource.layer({ [HANGUL_PATH]: { "hanja-keys": stringVariant("Hangul_Hanja,F9,F8") } })`.

Replace `packages/core/test/browser/settings.test.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Effect, Layer, Logger as EffectLogger, Stream } from "effect";
import {
  CreateEngine,
  IBusCapability,
  SetCapabilities,
  Enable,
  FocusIn,
  ProcessKeyEvent,
  encodeSettingsMetadata,
  encodeValue,
  int32Variant,
  stringVariant,
  type Request,
  type ModuleManifest,
  type SettingsMetadata,
} from "@ibus-web/protocol";
import { Connection, SettingsApi, indexedDbSettings } from "../../src/page/index.ts";
import { SettingsSource, type SettingsChange } from "../../src/services/settings.ts";
import { makeModuleRegistry } from "../../src/services/modules.ts";
import { CoreConfig } from "../../src/services/config.ts";
import { Logger, PanelEvents } from "../../src/services/logging.ts";
import { DomConnection, record } from "./support/dom.ts";
import { fixture, key } from "../shared/router.ts";

const PATH = "/test/settings/";
const instance = { schemaId: "test.settings", path: PATH };
const metadata: SettingsMetadata = {
  schemas: [
    {
      id: "test.settings",
      paths: [PATH],
      keys: [
        { name: "mode", type: "s", default: { _tag: "s", value: "default" }, choices: ["default", "chosen", "remote"] },
        {
          name: "count",
          type: "i",
          default: { _tag: "i", value: 1 },
          range: { min: { _tag: "i", value: 0 }, max: { _tag: "i", value: 3 } },
        },
      ],
    },
    {
      id: "test.relocatable",
      paths: ["/test/relocatable/first/", "/test/relocatable/second/"],
      keys: [{ name: "mode", type: "s", default: { _tag: "s", value: "default" } }],
    },
  ],
};
const manifest: ModuleManifest = {
  name: "test",
  version: "1",
  license: "MIT",
  runtimeAbi: 1,
  protocol: 1,
  module: { url: "engine.so", size: 1 },
  memory: 65536,
  threads: 0,
  data: [{ storePath: `/nix/store/${"a".repeat(32)}-test`, url: "data.tar", size: 0, encoding: "identity" }],
  settingsSchemaDir: `/nix/store/${"a".repeat(32)}-test/schemas`,
  engines: [{ name: "test", displayName: "test", languages: [], keyboard: { layout: "us", passThrough: [] } }],
  settingsSchemas: ["test.settings", "test.relocatable"],
  settingsMetadata: { url: "settings.json", size: 1 },
};
const options = {
  modules: { a: new URL("/a/manifest.json", location.href), b: new URL("/b/manifest.json", location.href) },
  loadManifest: async (url: URL) => ({ ...manifest, name: url.pathname.split("/")[1] }),
  loadMetadata: async () => encodeSettingsMetadata(metadata),
};
const base = Layer.mergeAll(CoreConfig.Default, Logger.Default, PanelEvents.Default);
const drop = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("gsettings");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Database still open"));
  });
beforeEach(drop);
afterEach(() => vi.restoreAllMocks());
async function stored() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("gsettings", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("values");
      const request = tx.objectStore("values").getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
const run = (
  body: (
    api: SettingsApi["Service"],
    source: SettingsSource["Service"],
    registry: Effect.Success<ReturnType<typeof makeModuleRegistry>>,
    connections: DomConnection[],
  ) => Promise<void>,
  source = indexedDbSettings(),
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const api = yield* SettingsApi;
        const settings = yield* SettingsSource;
        const connections: DomConnection[] = [];
        const registry = yield* makeModuleRegistry({
          ...options,
          hostUrl: new URL("/host", location.href),
          runtimeUrl: new URL("/runtime", location.href),
          start: async () => {
            const c = new DomConnection();
            connections.push(c);
            return c;
          },
        });
        yield* Effect.promise(() => body(api, settings, registry, connections));
      }).pipe(Effect.provide(SettingsApi.layer(options)), Effect.provide(Layer.mergeAll(base, source))),
    ),
  );

test("API loads validated metadata and persists ArrayBuffers without starting Workers; Init declares every instance", () =>
  run(async (api, source, registry, connections) => {
    expect(await api.schemas("a")).toEqual(metadata.schemas);
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("default"));
    await api.set("a", PATH, "mode", stringVariant("chosen"));
    expect(connections).toHaveLength(0);
    expect(await stored()).toEqual([{ type: "s", bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer }]);
    expect((await stored())[0]).toHaveProperty("bytes", expect.any(ArrayBuffer));
    await Effect.runPromise(registry.ensure("a"));
    expect(connections[0]!.sent[0]!.request).toMatchObject({
      _tag: "Init",
      settings: [
        { schemaId: "test.settings", path: PATH, values: { mode: stringVariant("chosen") } },
        { schemaId: "test.relocatable", path: "/test/relocatable/first/", values: {} },
        { schemaId: "test.relocatable", path: "/test/relocatable/second/", values: {} },
      ],
    });
    expect(await source.snapshot([instance])).toEqual({ [PATH]: { mode: stringVariant("chosen") } });
    await api.set("a", PATH, "mode", stringVariant("default"));
    expect(await stored()).toEqual([]);
    await api.set("a", PATH, "mode", stringVariant("chosen"));
    await api.reset("a", PATH, "mode");
    expect(await stored()).toEqual([]);
  }));
test("relocatable instances keep their own values and changes", () =>
  run(async (api, source, registry, connections) => {
    await Effect.runPromise(registry.ensure("a"));
    connections[0]!.sent.length = 0;
    await api.set("a", "/test/relocatable/second/", "mode", stringVariant("chosen"));
    await connections[0]!.untilSent("SettingChanged");
    expect(connections[0]!.sent.at(-1)!.request).toMatchObject({
      _tag: "SettingChanged",
      path: "/test/relocatable/second/",
      key: "mode",
      value: stringVariant("chosen"),
    });
    expect(await api.get("a", "/test/relocatable/first/", "mode")).toEqual(stringVariant("default"));
    expect(
      await source.snapshot([
        { schemaId: "test.relocatable", path: "/test/relocatable/first/" },
        { schemaId: "test.relocatable", path: "/test/relocatable/second/" },
      ]),
    ).toEqual({ "/test/relocatable/first/": {}, "/test/relocatable/second/": { mode: stringVariant("chosen") } });
  }));
test("engine writes synchronously enqueue, reach the API stream and other Worker, and never echo to writer", () =>
  run(async (api, _source, registry, connections) => {
    await Effect.runPromise(registry.ensure("a"));
    await Effect.runPromise(registry.ensure("b"));
    const f = fixture();
    registry.registerContext("a", f.context);
    const changes: unknown[] = [];
    const controller = new AbortController();
    const watching = Effect.runPromise(
      api.changes.pipe(
        Stream.take(2),
        Stream.runForEach((value) =>
          Effect.sync(() => {
            changes.push(value);
          }),
        ),
      ),
      { signal: controller.signal },
    );
    try {
      await api.set("a", PATH, "mode", stringVariant("remote"));
      connections[0]!.sent.length = 0;
      connections[1]!.sent.length = 0;
      connections[0]!.outcome = {
        _tag: "reply",
        ret: 1,
        records: [record({ _tag: "SettingWritten", path: PATH, key: "mode", value: stringVariant("chosen") })],
      };
      expect(registry.keySink("a", f.context).key(key("a"))).toBe("consumed");
      await connections[1]!.untilSent("SettingChanged");
      await watching;
      expect(changes).toHaveLength(2);
      expect(changes[1]).toMatchObject({ schemaId: "test.settings", path: PATH, value: stringVariant("chosen") });
      expect(connections[0]!.sent.filter(({ request }) => request._tag === "SettingChanged")).toEqual([]);
      expect(connections[1]!.sent.at(-1)!.request).toMatchObject({
        _tag: "SettingChanged",
        path: PATH,
        value: stringVariant("chosen"),
      });
      expect(await stored()).toEqual([{ type: "s", bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer }]);
    } finally {
      controller.abort();
      await watching.catch(() => {});
    }
  }));
test("another page receives exact broadcast bytes and forwards remote changes without writing or rebroadcasting", () =>
  run(async (api, _source, registry, connections) => {
    await Effect.runPromise(registry.ensure("a"));
    const other = new BroadcastChannel("ibus-web:gsettings");
    try {
      const received = new Promise<unknown>((resolve) => {
        other.onmessage = (event) => resolve(event.data);
      });
      await api.set("a", PATH, "mode", stringVariant("chosen"));
      expect(await received).toEqual({
        schemaPath: PATH,
        key: "mode",
        type: "s",
        bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer,
      });
      connections[0]!.sent.length = 0;
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const remove = vi.spyOn(IDBObjectStore.prototype, "delete");
      other.postMessage({
        schemaPath: PATH,
        key: "mode",
        type: "s",
        bytes: encodeValue("s", { _tag: "s", value: "remote" }).buffer,
      });
      await connections[0]!.untilSent("SettingChanged");
      expect(connections[0]!.sent.at(-1)!.request).toMatchObject({ path: PATH, value: stringVariant("remote") });
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      connections[0]!.sent.length = 0;
      other.postMessage({ schemaPath: PATH, key: "mode", type: "s", bytes: null });
      await connections[0]!.untilSent("SettingChanged");
      expect(connections[0]!.sent.at(-1)!.request).toMatchObject({ value: stringVariant("default") });
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      other.close();
    }
  }));
test("rejects unknown paths, keys, signatures, choices and ranges before storage", () =>
  run(async (api) => {
    await expect(api.set("a", "/test/missing/", "mode", stringVariant("chosen"))).rejects.toThrow();
    await expect(api.set("a", PATH, "missing", stringVariant("chosen"))).rejects.toThrow();
    await expect(api.set("a", PATH, "count", stringVariant("chosen"))).rejects.toThrow();
    await expect(api.set("a", PATH, "mode", stringVariant("invalid"))).rejects.toThrow();
    await expect(api.set("a", PATH, "count", int32Variant(4))).rejects.toThrow();
  }));
test("a host-supplied source replaces persistence entirely, including settings API access", async () => {
  const open = vi.spyOn(IDBFactory.prototype, "open");
  await run(async (api, _source, registry) => {
    await api.set("a", PATH, "mode", stringVariant("chosen"));
    await Effect.runPromise(registry.ensure("a"));
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("chosen"));
    expect(open).not.toHaveBeenCalled();
  }, SettingsSource.layer());
});
test("a fresh page reads persisted bytes before starting a real Hangul Worker", async () => {
  const { data, HANGUL_SCHEMA, HANGUL_PATH } = await import("./real-host.ts");
  const realOptions = { modules: { hangul: new URL(data.hangulUrl, location.href) } };
  await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* SettingsApi;
      yield* Effect.promise(() => api.set("hangul", HANGUL_PATH, "initial-input-mode", stringVariant("hangul")));
    }).pipe(Effect.provide(SettingsApi.layer(realOptions)), Effect.provide(indexedDbSettings())),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Request[] = [];
        const registry = yield* makeModuleRegistry({
          ...realOptions,
          hostUrl: new URL(data.hostUrl, location.href),
          runtimeUrl: new URL(data.runtimes[0]!.url, location.href),
          storage: "none",
          start: async (options) => {
            const connection = await Connection.start(options);
            const request = connection.requestAsync.bind(connection);
            connection.requestAsync = (value, ic) => {
              requests.push(value);
              return request(value, ic);
            };
            return connection;
          },
        });
        yield* registry.ensure("hangul");
        expect(requests[0]).toMatchObject({
          _tag: "Init",
          settings: expect.arrayContaining([
            {
              schemaId: HANGUL_SCHEMA,
              path: HANGUL_PATH,
              values: { "initial-input-mode": stringVariant("hangul") },
            },
            { schemaId: "org.freedesktop.ibus.panel", path: "/desktop/ibus/panel/", values: {} },
          ]),
        });
        yield* Effect.promise(async () => {
          for (const request of [
            new CreateEngine({ name: "hangul" }),
            new SetCapabilities({ capabilities: IBusCapability.PREEDIT_TEXT | IBusCapability.FOCUS }),
            new Enable({}),
            new FocusIn({}),
          ])
            expect((await registry.request("hangul", request, 1)).ret).toBeGreaterThanOrEqual(0);
          const reply = await registry.request(
            "hangul",
            new ProcessKeyEvent({ keyval: 103, keycode: 34, state: 0 }),
            1,
          );
          expect(reply.ret).toBe(1);
          expect(
            reply.records.some(({ record }) => record._tag === "UpdatePreeditText" && record.text.text === "ㅎ"),
          ).toBe(true);
        });
      }).pipe(Effect.provide(Layer.mergeAll(base, SettingsSource.Default))),
    ),
  );
});
test("failed storage writes reject API callers and do not stop subsequent settings changes", () =>
  run(async (api) => {
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    await expect(api.set("a", PATH, "mode", stringVariant("chosen"))).rejects.toThrow("disk failure");
    put.mockRestore();
    await api.set("a", PATH, "mode", stringVariant("remote"));
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("remote"));
  }));
test("closed scopes close channels and databases, reject API writes and ignore late synchronous engine writes", async () => {
  let closedSource: SettingsSource["Service"] | undefined;
  let closedApi: SettingsApi["Service"] | undefined;
  const close = vi.spyOn(BroadcastChannel.prototype, "close");
  await run(async (api, source) => {
    closedSource = source;
    closedApi = api;
    await api.set("a", PATH, "mode", stringVariant("chosen"));
  });
  expect(close).toHaveBeenCalledOnce();
  const open = vi.spyOn(IDBFactory.prototype, "open");
  closedSource!.written({ ...instance, key: "mode", value: stringVariant("remote") });
  await expect(closedSource!.write!({ ...instance, key: "mode", value: stringVariant("remote") })).rejects.toThrow(
    "closed",
  );
  await expect(closedApi!.set("a", PATH, "mode", stringVariant("remote"))).rejects.toThrow("closed");
  expect(open).not.toHaveBeenCalled();
  await drop();
});
test("two independent page services broadcast to their own Workers with exactly one database write", () =>
  run(async (writer, _source, registry) => {
    await Effect.runPromise(registry.ensure("a"));
    await run(async (reader, _otherSource, otherRegistry, connections) => {
      await Effect.runPromise(otherRegistry.ensure("a"));
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      await writer.set("a", PATH, "mode", stringVariant("chosen"));
      await connections[0]!.untilSent("SettingChanged");
      expect(await reader.get("a", PATH, "mode")).toEqual(stringVariant("chosen"));
      expect(put).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
    });
  }));
test("synchronous engine writes report asynchronous storage errors and keep processing later writes", async () => {
  const logs: EffectLogger.Options<unknown>[] = [];
  const logger = EffectLogger.make((options) => {
    logs.push(options);
  });
  const source = indexedDbSettings().pipe(Layer.provide(EffectLogger.layer([logger])));
  await run(async (api, settings) => {
    await api.schemas("a");
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new Error("engine disk failure");
    });
    settings.written({ ...instance, key: "mode", value: stringVariant("chosen") });
    settings.written({ ...instance, key: "mode", value: stringVariant("remote") });
    expect(await api.get("a", PATH, "mode")).toEqual(stringVariant("remote"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.logLevel).toBe("Error");
    expect(logs[0]!.message).toContain("Settings change failed");
    put.mockRestore();
  }, source);
});

// Each schema stands for another module's settings.json: a path is unique within one file, not across modules.
const sharedPathSchemas: SettingsMetadata["schemas"] = [
  metadata.schemas[0]!,
  { id: "test.barrier", paths: ["/test/barrier/"], keys: [metadata.schemas[0]!.keys[1]!] },
  { id: "test.disjoint", paths: [PATH], keys: [metadata.schemas[0]!.keys[1]!] },
  {
    id: "test.alias",
    paths: [PATH],
    keys: [{ ...metadata.schemas[0]!.keys[0]!, default: { _tag: "s", value: "remote" } }],
  },
  { id: "test.incompatible", paths: [PATH], keys: [{ name: "mode", type: "i", default: { _tag: "i", value: 2 } }] },
  {
    id: "test.restricted",
    paths: [PATH],
    keys: [{ name: "mode", type: "s", default: { _tag: "s", value: "default" }, choices: ["default"] }],
  },
];
const registerShared = async (source: SettingsSource["Service"]) => {
  for (const schema of sharedPathSchemas) await source.register!({ schemas: [schema] });
};
const at = (schemaId: string) => ({ schemaId, path: PATH });
for (const origin of ["local", "remote"] as const) {
  test(`shared-path ${origin} changes skip disjoint and incompatible keys without losing valid recipients`, () =>
    run(async (api, source) => {
      await api.schemas("a");
      await registerShared(source);
      const changes: SettingsChange[] = [];
      const abort = new AbortController();
      const watching = Effect.runPromise(
        source.changes.pipe(
          Stream.runForEach((change) =>
            Effect.sync(() => {
              changes.push(change);
            }),
          ),
        ),
        { signal: abort.signal },
      );
      const other = new BroadcastChannel("ibus-web:gsettings");
      const token = Symbol("writer");
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      try {
        if (origin === "local") {
          await source.write!({ ...instance, key: "mode", value: stringVariant("chosen"), origin: token });
        } else {
          // A valid following message is a processing barrier even if the preceding change is dropped.
          const done = Effect.runPromise(
            source.changes.pipe(
              Stream.filter((change) => change.schemaId === "test.barrier" && change.key === "count"),
              Stream.take(1),
              Stream.runCollect,
            ),
            { signal: abort.signal },
          );
          other.postMessage({
            schemaPath: PATH,
            key: "mode",
            type: "s",
            bytes: encodeValue("s", { _tag: "s", value: "chosen" }).buffer,
          });
          other.postMessage({
            schemaPath: "/test/barrier/",
            key: "count",
            type: "i",
            bytes: encodeValue("i", { _tag: "i", value: 2 }).buffer,
          });
          await done;
        }
        const aliased = await source.snapshot([at("test.alias")]);
        expect(
          changes
            .filter((change) => change.key === "mode")
            .map(({ schemaId, path, value, origin }) => ({ schemaId, path, value, origin })),
        ).toEqual([
          {
            schemaId: "test.settings",
            path: PATH,
            value: stringVariant("chosen"),
            origin: origin === "local" ? token : undefined,
          },
          {
            schemaId: "test.alias",
            path: PATH,
            value: stringVariant("chosen"),
            origin: origin === "local" ? token : undefined,
          },
        ]);
        if (origin === "local") {
          expect(aliased).toEqual({ [PATH]: { mode: stringVariant("chosen") } });
          expect(await source.snapshot([at("test.disjoint")])).toEqual({ [PATH]: {} });
          await expect(source.snapshot([at("test.incompatible")])).rejects.toThrow("Invalid stored setting");
          await expect(source.snapshot([at("test.restricted")])).rejects.toThrow("Invalid choice");
          expect(put).toHaveBeenCalledTimes(1);
          expect(post).toHaveBeenCalledTimes(1);
        } else {
          expect(aliased).toEqual({ [PATH]: {} });
          expect(put).not.toHaveBeenCalled();
          expect(post).toHaveBeenCalledTimes(2);
        }
      } finally {
        other.close();
        abort.abort();
        await watching.catch(() => {});
      }
    }));
}
test("shared-path deletion notifies each local and remote alias with its own default and leaves the next snapshot empty", () =>
  run(async (api, source) => {
    await api.schemas("a");
    await registerShared(source);
    await source.write!({ ...instance, key: "mode", value: stringVariant("chosen") });
    await run(async (remoteApi, receiver) => {
      await remoteApi.schemas("a");
      await registerShared(receiver);
      const token = Symbol("writer");
      const localChanges: SettingsChange[] = [];
      const remoteChanges: SettingsChange[] = [];
      const abort = new AbortController();
      const localWatching = Effect.runPromise(
        source.changes.pipe(
          Stream.runForEach((change) =>
            Effect.sync(() => {
              localChanges.push(change);
            }),
          ),
        ),
        { signal: abort.signal },
      );
      const remoteWatching = Effect.runPromise(
        receiver.changes.pipe(
          Stream.take(4),
          Stream.runForEach((change) =>
            Effect.sync(() => {
              remoteChanges.push(change);
            }),
          ),
        ),
        { signal: abort.signal },
      );
      const put = vi.spyOn(IDBObjectStore.prototype, "put");
      const remove = vi.spyOn(IDBObjectStore.prototype, "delete");
      const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      try {
        await source.write!({ ...instance, key: "mode", value: stringVariant("default"), origin: token });
        const expected = [
          { schemaId: "test.settings", path: PATH, key: "mode", value: stringVariant("default") },
          { schemaId: "test.alias", path: PATH, key: "mode", value: stringVariant("remote") },
          { schemaId: "test.incompatible", path: PATH, key: "mode", value: int32Variant(2) },
          { schemaId: "test.restricted", path: PATH, key: "mode", value: stringVariant("default") },
        ];
        expect(localChanges).toEqual(expected.map((change) => ({ ...change, origin: token })));
        await remoteWatching;
        expect(remoteChanges).toEqual(expected);
        for (const page of [source, receiver]) {
          for (const change of expected) expect(await page.read!(at(change.schemaId), "mode")).toEqual(change.value);
          for (const schema of sharedPathSchemas)
            expect(await page.snapshot([{ schemaId: schema.id, path: schema.paths[0]! }])).toEqual({
              [schema.paths[0]!]: {},
            });
        }
        expect(await stored()).toEqual([]);
        expect(put).not.toHaveBeenCalled();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledExactlyOnceWith({ schemaPath: PATH, key: "mode", type: "s", bytes: null });
      } finally {
        abort.abort();
        await Promise.all([localWatching.catch(() => {}), remoteWatching.catch(() => {})]);
      }
    });
  }));
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nix develop -c git add packages/core && nix build .#checks.x86_64-linux.core-node -L`
Expected: FAIL (types and behaviour still by schema id). List core's checks with `nix eval --json .#checks.x86_64-linux --apply builtins.attrNames | tr , '\n' | grep core-` if `core-node` is not the exact name.

- [ ] **Step 3: Change the settings service**

Replace the types and the in-memory layer in `packages/core/src/services/settings.ts` with:

```ts
/** A schema id at one of its paths. Modules may declare different schemas at one path. */
export interface SettingsInstance {
  readonly schemaId: string;
  readonly path: string;
}
/** Stored values by instance path, then key. */
export type SettingsSnapshot = Record<string, Record<string, typeof GVariantVariant.Type>>;
export type SettingsChange = SettingsInstance &
  Pick<SettingWritten, "key" | "value"> & { readonly origin?: symbol };
export interface SettingsSourceService {
  /** Optional persistence hooks keep host-provided in-memory sources compatible. */
  register?(metadata: SettingsMetadata): void | Promise<void>;
  write?(record: SettingsChange): Promise<void>;
  read?(instance: SettingsInstance, key: string): Promise<typeof GVariantVariant.Type | undefined>;
  snapshot(instances: readonly SettingsInstance[]): Promise<SettingsSnapshot>;
  /** Enqueue only; the default source reports asynchronous write failures through Effect logging. */
  written(record: SettingsChange): void;
  readonly changes: Stream.Stream<SettingsChange>;
}
```

and in `SettingsSource.layer`, key `values` by path:

```ts
        const values = new Map(Object.entries(initial).map(([path, keys]) => [path, new Map(Object.entries(keys))]));
```

```ts
          snapshot: async (instances: readonly SettingsInstance[]) =>
            Object.fromEntries(instances.map(({ path }) => [path, Object.fromEntries(values.get(path) ?? [])])),
          written: (record: SettingsChange) => {
            if (mailbox.isClosed) return;
            let instance = values.get(record.path);
            if (!instance) {
              instance = new Map();
              values.set(record.path, instance);
            }
            instance.set(record.key, record.value);
            mailbox.enqueue(record);
          },
```

- [ ] **Step 4: Change the settings API**

In `packages/core/src/settings/api.ts`, import `SettingsInstance` beside `SettingsSource, type SettingsChange`, add below `validateSetting`:

```ts
export function settingsInstances(metadata: SettingsMetadata): SettingsInstance[] {
  return metadata.schemas.flatMap((schema) => schema.paths.map((path) => ({ schemaId: schema.id, path })));
}
```

change the service interface to:

```ts
export interface SettingsApiService {
  schemas(module: string): Promise<readonly SettingsSchema[]>;
  get(module: string, path: string, key: string): Promise<SettingValue>;
  set(module: string, path: string, key: string, value: SettingValue): Promise<void>;
  reset(module: string, path: string, key: string): Promise<void>;
  readonly changes: Stream.Stream<SettingsChange>;
}
```

and replace `keyFor`, `set` and the returned object with:

```ts
        const keyFor = async (module: string, path: string, name: string) => {
          const schema = (await schemas(module)).find((schema) => schema.paths.includes(path));
          const key = schema?.keys.find((key) => key.name === name);
          if (!schema || !key) throw new Error(`Unknown setting: ${path}${name}`);
          return { instance: { schemaId: schema.id, path }, key };
        };
        const set = async (module: string, path: string, name: string, value: SettingValue) => {
          const { instance, key } = await keyFor(module, path, name);
          validateSetting(key, value);
          alive();
          const change = { ...instance, key: name, value };
          if (source.write) await source.write(change);
          else source.written(change);
        };
        return {
          schemas,
          set,
          changes: source.changes,
          get: async (module, path, name) => {
            const { instance, key } = await keyFor(module, path, name);
            const stored = source.read
              ? await source.read(instance, name)
              : (await source.snapshot([instance]))[path]?.[name];
            return stored ?? variant(key.type, key.default);
          },
          reset: async (module, path, name) => {
            const { key } = await keyFor(module, path, name);
            await set(module, path, name, variant(key.type, key.default));
          },
        } satisfies SettingsApiService;
```

In `packages/core/src/page/index.ts`, export `type SettingsInstance` beside `type SettingsChange`, and `settingsInstances` beside the other exports from `../settings/api.ts`.

- [ ] **Step 5: Rewrite the persister**

Replace `packages/core/src/settings/persister.ts` with:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Cause, Effect, Layer, PubSub, Stream } from "effect";
import { decodeSettingsMetadata, decodeValue, encodeSettingsMetadata, encodeValue, variant } from "@ibus-web/protocol";
import {
  SettingsSource,
  type SettingsChange,
  type SettingsInstance,
  type SettingsSnapshot,
  type SettingsSourceService,
} from "../services/settings.ts";
import { SyncMailbox } from "../services/logging.ts";
import { validateSetting, type SettingsSchema, type SettingValue } from "./api.ts";
import { decodeSettingsBroadcast, settingsBroadcast, type SettingsBroadcast } from "./broadcast.ts";
interface Job {
  readonly run: () => Promise<readonly SettingsChange[]>;
  readonly resolve?: () => void;
  readonly reject?: (cause: unknown) => void;
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const sameKeys = (a: SettingsSchema, b: SettingsSchema) =>
  JSON.stringify(encodeSettingsMetadata({ schemas: [{ ...a, paths: b.paths }] })) ===
  JSON.stringify(encodeSettingsMetadata({ schemas: [b] }));
/** The database is acquired only by the first read or write, never by importing the service. */
export function indexedDbSettings(): Layer.Layer<SettingsSource> {
  return Layer.effect(
    SettingsSource,
    Effect.gen(function* () {
      // Modules can declare different schemas at one path, so a path holds a set of schema ids.
      const schemas = new Map<string, SettingsSchema>();
      const atPath = new Map<string, Set<string>>();
      const current = new Map<string, SettingValue>();
      const mailbox = new SyncMailbox<Job>();
      const pending = new Set<Job>();
      const transactions = new Set<IDBTransaction>();
      const pubsub = yield* PubSub.unbounded<SettingsChange>();
      let database: Promise<IDBDatabase> | undefined;
      let closed = false;
      const alive = () => {
        if (closed) throw new Error("Settings source closed");
      };
      const open = () => {
        alive();
        return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
          let abandoned = false;
          const request = indexedDB.open("gsettings", 1);
          const failed = (cause: unknown) => {
            abandoned = true;
            database = undefined;
            reject(cause);
          };
          request.onupgradeneeded = () => {
            if (closed || abandoned) request.transaction?.abort();
            else request.result.createObjectStore("values");
          };
          request.onerror = () => failed(request.error);
          request.onblocked = () => failed(new Error("Settings database upgrade blocked"));
          request.onsuccess = () => {
            if (closed || abandoned) {
              request.result.close();
              reject(new Error("Settings source closed"));
              return;
            }
            request.result.onversionchange = () => {
              request.result.close();
              database = undefined;
            };
            resolve(request.result);
          };
        }));
      };
      const transaction = async <A>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => () => A): Promise<A> => {
        const db = await open();
        alive();
        return new Promise<A>((resolve, reject) => {
          const tx = db.transaction("values", mode);
          transactions.add(tx);
          tx.oncomplete = () => {
            transactions.delete(tx);
            resolve(result());
          };
          tx.onabort = tx.onerror = () => {
            transactions.delete(tx);
            reject(tx.error ?? new Error("Settings transaction aborted"));
          };
          let result: () => A;
          try {
            result = body(tx.objectStore("values"));
          } catch (cause) {
            tx.abort();
            reject(cause);
          }
        });
      };
      const schemaOf = (instance: SettingsInstance) => {
        const schema = atPath.get(instance.path)?.has(instance.schemaId) ? schemas.get(instance.schemaId) : undefined;
        if (!schema) throw new Error(`Unknown settings instance: ${instance.schemaId} at ${instance.path}`);
        return schema;
      };
      const setting = (instance: SettingsInstance, name: string) => {
        const key = schemaOf(instance).keys.find((key) => key.name === name);
        if (!key) throw new Error(`Unknown setting: ${instance.path}${name}`);
        return key;
      };
      const memoryKey = (instance: SettingsInstance, key: string) => `${instance.schemaId}\0${instance.path}\0${key}`;
      const remember = (change: SettingsChange) => {
        current.set(memoryKey(change, change.key), change.value);
      };
      const destinations = (message: SettingsBroadcast, origin?: symbol): SettingsChange[] => {
        const supplied: SettingValue | undefined =
          message.bytes === null
            ? undefined
            : variant(message.type, decodeValue(message.type, new Uint8Array(message.bytes)));
        const changes: SettingsChange[] = [];
        for (const id of atPath.get(message.schemaPath) ?? []) {
          const key = schemas.get(id)!.keys.find((key) => key.name === message.key);
          if (!key) continue;
          const value: SettingValue = supplied ?? variant(key.type, key.default);
          try {
            validateSetting(key, value);
          } catch {
            // Shared storage does not make a value valid for every schema using that path.
            continue;
          }
          changes.push({
            schemaId: id,
            path: message.schemaPath,
            key: key.name,
            value,
            ...(origin === undefined ? {} : { origin }),
          });
        }
        return changes;
      };
      const remote = async (input: unknown): Promise<SettingsChange[]> => {
        const changes = destinations(decodeSettingsBroadcast(input));
        for (const change of changes) remember(change);
        return changes;
      };
      const broadcast = settingsBroadcast((value) => {
        if (!closed) mailbox.enqueue({ run: () => remote(value) });
      });
      const persist = async (change: SettingsChange): Promise<SettingsChange[]> => {
        const key = setting(change, change.key);
        const bytes = validateSetting(key, change.value);
        const reset = sameBytes(bytes, encodeValue(key.type, key.default));
        const message: SettingsBroadcast = {
          schemaPath: change.path,
          key: key.name,
          type: key.type,
          bytes: reset ? null : bytes.slice().buffer,
        };
        await transaction("readwrite", (store) => {
          if (reset) store.delete([change.path, key.name]);
          else store.put({ type: key.type, bytes: message.bytes }, [change.path, key.name]);
          return () => undefined;
        });
        alive();
        const changes = destinations(message, change.origin);
        for (const item of changes) remember(item);
        broadcast.post(message);
        return changes;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          mailbox.close();
          broadcast.close();
          for (const tx of transactions) tx.abort();
          for (const job of pending) job.reject?.(new Error("Settings source closed"));
          pending.clear();
          void database?.then(
            (db) => db.close(),
            () => {},
          );
        }),
      );
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      yield* mailbox.take.pipe(
        Effect.flatMap((job) =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({ try: job.run, catch: (cause) => cause }).pipe(Effect.exit);
            if (result._tag === "Success") {
              for (const change of result.value) yield* PubSub.publish(pubsub, change);
              job.resolve?.();
            } else {
              const cause = result.cause;
              if (job.reject) job.reject(Cause.squash(cause));
              else yield* Effect.logError("Settings change failed", cause);
            }
            pending.delete(job);
          }),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const submit = (run: Job["run"]) =>
        new Promise<void>((resolve, reject) => {
          if (closed) {
            reject(new Error("Settings source closed"));
            return;
          }
          const job = { run, resolve, reject };
          pending.add(job);
          mailbox.enqueue(job);
        });
      const snapshot = async (instances: readonly SettingsInstance[]): Promise<SettingsSnapshot> => {
        await submit(async () => []);
        const selected = instances.map((instance) => ({ instance, schema: schemaOf(instance) }));
        const raw = await transaction("readonly", (store) => {
          const requests = selected.map(({ instance, schema }) => ({
            instance,
            keys: schema.keys.map((key) => ({
              key,
              request: store.get([instance.path, key.name]) as IDBRequest<unknown>,
            })),
          }));
          return () => requests;
        });
        return Object.fromEntries(
          raw.map(({ instance, keys }) => [
            instance.path,
            Object.fromEntries(
              keys.flatMap(({ key, request }) => {
                if (request.result === undefined) return [];
                const record = request.result as { type?: unknown; bytes?: unknown };
                if (record.type !== key.type || !(record.bytes instanceof ArrayBuffer))
                  throw new Error(`Invalid stored setting: ${instance.path}${key.name}`);
                const value: SettingValue = variant(key.type, decodeValue(key.type, new Uint8Array(record.bytes)));
                validateSetting(key, value);
                return [[key.name, value]];
              }),
            ),
          ]),
        );
      };
      return {
        register: (metadata) => {
          alive();
          const validated = decodeSettingsMetadata(encodeSettingsMetadata(metadata));
          for (const schema of validated.schemas) {
            const existing = schemas.get(schema.id);
            if (existing && !sameKeys(existing, schema)) throw new Error(`Conflicting settings schema: ${schema.id}`);
          }
          for (const schema of validated.schemas) {
            const existing = schemas.get(schema.id);
            schemas.set(
              schema.id,
              existing ? { ...existing, paths: [...new Set([...existing.paths, ...schema.paths])] } : schema,
            );
            for (const path of schema.paths) {
              let ids = atPath.get(path);
              if (!ids) {
                ids = new Set();
                atPath.set(path, ids);
              }
              ids.add(schema.id);
            }
          }
        },
        snapshot,
        read: async (instance, key) => {
          await submit(async () => []);
          return current.get(memoryKey(instance, key)) ?? (await snapshot([instance]))[instance.path]?.[key];
        },
        written: (change) => {
          if (!closed) mailbox.enqueue({ run: () => persist(change) });
        },
        write: (change) => submit(() => persist(change)),
        changes: Stream.fromPubSub(pubsub),
      } satisfies SettingsSourceService;
    }),
  );
}
```

- [ ] **Step 6: Change the registry**

In `packages/core/src/services/modules.ts`:
- Import `settingsInstances` beside `loadSettingsMetadata` from `../settings/api.ts`.
- Add to `interface Entry`: `readonly instances: Map<string, string>;` with the comment `// The module's settings instances: path to schema id.` above it, and `instances: new Map(),` beside `changes: new Map(),` where entries are created.
- In `flushChanges`, the request becomes `new SettingChanged({ path: change.path, key: change.key, value: change.value })`.
- In `boot`, replace the block from `if (settings.register) {` through the `initial` snapshot with:

```ts
        const metadata = yield* Effect.tryPromise({
          try: (signal) => loadSettingsMetadata(manifest, options.modules[name]!, options, signal),
          catch: asError,
        });
        if (settings.register)
          yield* Effect.tryPromise({
            try: async () => {
              await settings.register!(metadata);
            },
            catch: asError,
          });
        const instances = settingsInstances(metadata);
        entry.instances.clear();
        for (const { schemaId, path } of instances) entry.instances.set(path, schemaId);
        const initial = yield* Effect.tryPromise({
          try: () => settings.snapshot(instances),
          catch: asError,
        });
```

  and the `Init` request with:

```ts
          try: () =>
            entry.router.request(
              new Init({
                version: PROTOCOL_VERSION,
                settings: instances.map(({ schemaId, path }) => ({ schemaId, path, values: initial[path] ?? {} })),
              }),
              0,
            ),
```

- In the router's `enqueue`, replace `else if (record._tag === "SettingWritten") settings.written({ ...record, origin: entry.origin });` with:

```ts
            else if (record._tag === "SettingWritten") {
              const schemaId = entry.instances.get(record.path);
              // The runtime refuses writes under undeclared paths, so this is a runtime fault.
              if (schemaId === undefined)
                logger.enqueue({
                  module: name,
                  ic,
                  record: {
                    _tag: "Log",
                    level: 16,
                    domain: "page-settings",
                    message: `Setting written at an undeclared path: ${record.path}`,
                  },
                });
              else
                settings.written({
                  schemaId,
                  path: record.path,
                  key: record.key,
                  value: record.value,
                  origin: entry.origin,
                });
            }
```

- In the `settings.changes` forwarder, replace the condition `!entry.snapshot.manifest?.settingsSchemas.includes(change.schemaId) ||` with `entry.instances.get(change.path) !== change.schemaId ||`, and the coalescing key with `entry.changes.set(`${change.path}\0${change.key}`, change);`.

- [ ] **Step 7: Update the docs**

In `docs/core.md`, replace the paragraph beginning `` `SettingsSource` supplies `snapshot(schemas)` `` through `the database.` with:

```markdown
A setting the page handles is an instance, a schema id at one of its paths,
plus a key: within one module a path holds one schema, but modules can declare
different schemas at one path. `SettingsSource` supplies
`snapshot(instances): Promise<SettingsSnapshot>`, `written(change)` and a
`changes` Stream. Optional `register(metadata)`, `write(change)` and
`read(instance, key)` hooks support persistent sources while in-memory sources
remain valid. Snapshot values are typed GVariant variants indexed by path and
key; a change names its schema id, path and key. `settingsInstances(metadata)`
lists a module's instances. `SettingsSource.layer(initial)` is in-memory;
`SettingsSource.Default` is a lazy `gsettings` IndexedDB source with
`BroadcastChannel("ibus-web:gsettings")` synchronization. It stores one
origin-wide record keyed by path and key, with GVariant type and normal-form
`ArrayBuffer` bytes, and delivers a stored or broadcast change to every schema
registered at its path whose key accepts it, each with its own default on a
reset. Values equal to the schema default delete the record. The registry loads
metadata and snapshots before Init, which declares every instance with its
stored values, accepts `SettingWritten` by mapping its path to the module's
schema, and forwards changes to the other live modules that declare the same
instance. Cross-tab recipients update their live Workers without writing the
record again. Concurrent writes are last write wins per record; live tabs follow
the last received broadcast, while future Init reads the database.
```

In the design spec's §7.1.4, replace `` - **Starting a Worker.** Before it starts a Worker, the page reads the keys of the engine's schemas and sends them as `Init`'s snapshot. `` with `` - **Starting a Worker.** Before it starts a Worker, the page reads the keys of each of the module's schema instances and sends every instance, with its stored values, in `Init`. ``, and `sends `SettingChanged` to its other live Workers whose engines use the schema,` with `sends `SettingChanged`, with the path, to its other live Workers whose modules declare that schema at that path,`. Format both with oxfmt.

- [ ] **Step 8: Run the tests to see them pass**

Run each, expected PASS:

```bash
nix develop -c git add packages/core docs/core.md docs/specs/2026-09-26-ibus-web-design.md
nix build .#checks.x86_64-linux.core-node -L
nix build .#checks.x86_64-linux.core-browser -L
```

Use the core check names `nix eval` lists if these differ.

- [ ] **Step 9: Commit**

```bash
nix develop -c git commit -m "feat(core): handle settings as schema instances addressed by path" -- packages/core docs/core.md docs/specs/2026-09-26-ibus-web-design.md
```

---

### Task 5: The facade and the demo address settings by path

**Files:**
- Modify: `packages/ibus-web/src/index.ts`, `packages/ibus-web/test/browser/facade.test.ts`, `examples/demo/src/main.ts`
- Docs: `docs/ibus-web.md`

**Interfaces:**
- Consumes: Task 4's `SettingsApiService` and `SettingsChange`.

- [ ] **Step 1: Update the facade test**

In `packages/ibus-web/test/browser/facade.test.ts`, in `settings load without Workers and publish orientation snapshots with context identity`:
- Replace `const schema = "org.freedesktop.ibus.panel", name = "lookup-table-orientation";` with `const schema = "org.freedesktop.ibus.panel", path = "/desktop/ibus/panel/", name = "lookup-table-orientation";`.
- `values[change.schemaId] = …` becomes `values[change.path] = …`.
- The metadata's `path: "/desktop/ibus/panel/",` becomes `paths: [path],`.
- `f.app.settings.get("test", schema, name)`, `set("test", schema, name, …)` (both) and `reset("test", schema, name)` take `path` in place of `schema`.

- [ ] **Step 2: Run the facade test to see it fail**

Run: `nix develop -c git add packages/ibus-web && nix build .#checks.x86_64-linux.ibus-web-browser -L` (or the facade check `nix eval` lists).
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/ibus-web/src/index.ts`:
- Replace the constants with:

```ts
const panelSchema = "org.freedesktop.ibus.panel",
  panelPath = "/desktop/ibus/panel/",
  orientationKey = "lookup-table-orientation";
```

- In `refreshOrientation`, replace `schema.path === "/desktop/ibus/panel/" &&` with `schema.paths.includes(panelPath) &&`, and `api.get(module, panelSchema, orientationKey)` with `api.get(module, panelPath, orientationKey)`.
- In the `settings.changes` listener, replace `if (change.schemaId !== panelSchema || change.key !== orientationKey) return;` with `if (change.schemaId !== panelSchema || change.path !== panelPath || change.key !== orientationKey) return;`.
- In the `settings` object, rename every `schema: string` parameter to `path: string` and pass `path` on.

In `examples/demo/src/main.ts`:
- `controls` entries hold `path` where they held `schema`; `refreshSettings` calls `app.settings.get(module, path, key.name)`.
- In `loadSettings`, wrap the body of `for (const schema of schemas)` in `for (const path of schema.paths)`, compute each control's id as:

```ts
      // Key names repeat across schemas and instances; the first keeps the plain id, later ones are qualified.
      const qualified =
        schema.paths.length > 1
          ? `setting-${schema.id}-${schema.paths.indexOf(path)}-${key.name}`
          : `setting-${schema.id}-${key.name}`;
      control.id = ids.has(`setting-${key.name}`) ? qualified : `setting-${key.name}`;
```

  and call `app.settings.get(module, path, key.name)`, `controls.push({ path, key, control })` and `app.settings.set(module, path, key.name, value)`.

In `docs/ibus-web.md`, replace `` Use `settings.get(module, schemaId, key)`, `set(module, schemaId, key, variant)` and `reset(module, schemaId, key)` `` with `` Each schema lists its `paths`: a fixed schema has one, a relocatable schema one per instance. Use `settings.get(module, path, key)`, `set(module, path, key, variant)` and `reset(module, path, key)` ``, and format it with oxfmt.

- [ ] **Step 4: Run the checks**

Run each, expected PASS:

```bash
nix develop -c git add packages/ibus-web examples/demo docs/ibus-web.md
nix build .#checks.x86_64-linux.ibus-web-browser -L
nix build .#integration-checks -L
```

The integration checks include the demo's Playwright suites, whose Hangul settings cases use `#setting-hangul-keyboard`.

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "feat(ibus-web): address settings by path in the facade and the demo" -- packages/ibus-web examples/demo/src/main.ts docs/ibus-web.md
```

---

### Task 6: libibus-web has the US keymap

**Files:**
- Create: `tools/keysyms/us-c.ts`, `tools/keysyms/us-vectors.ts`, `tools/keysyms/us-c.test.ts`, `tools/keysyms/options.nix`
- Modify: `tools/keysyms/module.nix`
- Create (generated): `runtime/libibus-web/src/ibus/us-keymap.generated.h`
- Modify: `runtime/libibus-web/src/ibus/ibuskeymap.c`, `runtime/libibus-web/meson.options`, `runtime/libibus-web/tests/meson.build`, `runtime/libibus-web/tests/test-engine.c`, `runtime/libibus-web/checks.nix`
- Docs: `docs/runtime.md`, `docs/known-gaps.md`

**Interfaces:**
- Produces: `ibus_keymap_get("us")` returns a new reference to a shared `IBusKeymap`; `ibus_keymap_lookup_keysym(keymap, keycode, state)` as the Decisions section states; option `ibusWeb.keysyms.usKeymapVectors` (a path).

- [ ] **Step 1: Write the generators**

Create `tools/keysyms/us-c.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { parseDomCodes } from "./dom-codes.ts";

// The flags let the C lookup apply the page's rules without DOM codes.
export function generateUSHeader(exportJson: string, domCodeSource: string): string {
  const rows = JSON.parse(exportJson) as [number, [number, number][]][];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty XKB export");
  const keypad = new Set(
    [...parseDomCodes(domCodeSource)].filter(([code]) => code.startsWith("Numpad")).map(([, evdev]) => evdev),
  );
  const entries = rows
    .filter(([, levels]) => levels.length > 0)
    .sort(([a], [b]) => a - b)
    .map(([code, levels]) => {
      const [lower, upper] = levels;
      const flags = [
        lower![1] >= 97 && lower![1] <= 122 ? "US_KEY_LETTER" : undefined,
        keypad.has(code) ? "US_KEY_KEYPAD" : undefined,
      ].filter((flag) => flag !== undefined);
      return `{${code}, ${flags.length ? flags.join(" | ") : "0"}, 0x${lower![0].toString(16)}, 0x${(upper?.[0] ?? 0).toString(16)}},`;
    });
  return `/* SPDX-FileCopyrightText: The xkeyboard-config contributors
 * SPDX-License-Identifier: LicenseRef-xkeyboard-config */
/* Generated from xkeyboard-config US (evdev/pc105/us, empty variant and
 * options), resolved by libxkbcommon, by \`nix run .#write-files\`. Source
 * notices: LICENSES/LicenseRef-xkeyboard-config.txt. */
#pragma once
#include <glib.h>

enum { US_KEY_LETTER = 1, US_KEY_KEYPAD = 2 };

typedef struct {
  guint16 code;
  guint8 flags;
  guint32 lower;
  guint32 upper;
} UsKey;

/* Sorted by evdev code; an upper of 0 means the key has one level. */
static const UsKey us_keys[] = {
${entries.join("\n")}
};
`;
}
if (import.meta.main) {
  const [exportPath, domPath] = process.argv.slice(2);
  if (!exportPath || !domPath) throw new Error("Usage: us-c.ts resolved-keymap.json dom_code_data.inc");
  process.stdout.write(generateUSHeader(readFileSync(exportPath, "utf8"), readFileSync(domPath, "utf8")));
}
```

Create `tools/keysyms/us-vectors.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { parseDomCodes } from "./dom-codes.ts";
import { usKeysym } from "../../packages/core/src/keys/us.ts";

const SHIFT = 1,
  LOCK = 2,
  MOD2 = 16,
  MOD5 = 128;

// Each line is "evdev state keyval": the page's answer, which the runtime's lookup must give too.
export function usVectors(domCodeSource: string): string {
  const lines = new Set<string>();
  for (const [code, evdev] of parseDomCodes(domCodeSource))
    for (let state = 0; state < 8; state++) {
      const shift = (state & 1) !== 0,
        lock = (state & 2) !== 0,
        numLock = (state & 4) !== 0;
      const keyval = usKeysym(evdev, code, shift, lock, numLock);
      if (keyval === undefined) continue;
      const mask = (shift ? SHIFT : 0) | (lock ? LOCK : 0) | (numLock ? MOD2 : 0);
      lines.add(`${evdev} ${mask} ${keyval}`);
      lines.add(`${evdev} ${mask | MOD5} ${keyval}`);
    }
  return [...lines].join("\n") + "\n";
}
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: us-vectors.ts dom_code_data.inc");
  process.stdout.write(usVectors(readFileSync(path, "utf8")));
}
```

Create `tools/keysyms/us-c.test.ts`:

```ts
// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateUSHeader } from "./us-c.ts";
import { usVectors } from "./us-vectors.ts";

const dom = `DOM_CODE(0x070004, 0x0026, 0x001e, 0x0026, 0x0000, "KeyA", US_A),
DOM_CODE(0x070059, 0x0057, 0x004f, 0x0057, 0x0000, "Numpad1", NUMPAD1),`;

test("flags letters and keypad keys and sorts by code", () => {
  const header = generateUSHeader("[[79,[[65436,0],[65457,49]]],[30,[[97,97],[65,65]]]]", dom);
  expect(header.indexOf("{30, US_KEY_LETTER, 0x61, 0x41},")).toBeLessThan(
    header.indexOf("{79, US_KEY_KEYPAD, 0xff9c, 0xffb1},"),
  );
});
test("one-level keys have no upper keysym", () =>
  expect(generateUSHeader("[[1,[[65307,27]]]]", dom)).toContain("{1, 0, 0xff1b, 0x0},"));
test("vectors cover every modifier combination, with Mod5 ignored", () => {
  const path = process.env["IBUS_WEB_DOM_CODES"];
  if (!path) throw new Error("IBUS_WEB_DOM_CODES is required");
  const lines = usVectors(readFileSync(path, "utf8")).trim().split("\n");
  expect(lines).toEqual(expect.arrayContaining(["30 0 97", "30 1 65", "30 2 65", "30 3 97", "30 129 65"]));
  expect(lines).toEqual(expect.arrayContaining(["79 0 65436", "79 16 65457", "79 17 65457"]));
});
```

If the pinned Chromium file writes a row differently from the `dom` fixture above, copy two real rows (`KeyA`, `Numpad1`) from `$IBUS_WEB_DOM_CODES` into it; `parseDomCodes` defines the accepted form.

- [ ] **Step 2: Wire the generators into Nix**

Create `tools/keysyms/options.nix`:

```nix
# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.keysyms.usKeymapVectors = lib.mkOption {
      type = lib.types.package;
      description = "Expected US keymap lookups, one `evdev state keyval` line each, from the page's own translation.";
    };
  };
}
```

In `tools/keysyms/module.nix`, add `toolchain` to the names taken from `config.ibusWeb` (`inherit (config.ibusWeb) typescript testing toolchain;`), and add beside the other `files.file` entries:

```nix
      files.file."runtime/libibus-web/src/ibus/us-keymap.generated.h".source =
        pkgs.runCommand "ibus-web-us-keymap.generated.h" { } ''
          ${typescript.nodejs}/bin/node ${./us-c.ts} ${xkbExport} ${domCodes} \
            | ${toolchain.emscripten.llvmEnv}/bin/clang-format --assume-filename=us-keymap.generated.h > $out
        '';

      ibusWeb.keysyms.usKeymapVectors = pkgs.runCommand "ibus-web-us-keymap-vectors.txt" { } ''
        ${typescript.nodejs}/bin/node ${
          typescript.workspaceFor [
            "tools/keysyms"
            "packages/core"
          ]
        }/tools/keysyms/us-vectors.ts ${domCodes} > $out
      '';
```

Run: `nix develop -c git add tools/keysyms && nix run .#write-files && git status --short`
Expected: `runtime/libibus-web/src/ibus/us-keymap.generated.h` created. `git add` it.

- [ ] **Step 3: Write the failing runtime test**

In `runtime/libibus-web/meson.options`, add:

```meson
option(
  'test_us_keymap',
  type: 'string',
  value: '',
  description: 'Expected US keymap lookups, which the engine tests check',
)
```

In `runtime/libibus-web/tests/meson.build`, replace `test('engine', test_engine, protocol: 'tap')` with:

```meson
engine_env = environment()
engine_env.set('IBUSWEB_TEST_US_KEYMAP', get_option('test_us_keymap'))
test('engine', test_engine, protocol: 'tap', env: engine_env)
```

In `runtime/libibus-web/checks.nix`, add `"-Dtest_us_keymap=${config.ibusWeb.keysyms.usKeymapVectors}"` to `checks.libibus-web-tests`' `mesonFlags`.

In `runtime/libibus-web/tests/test-engine.c`, replace `simple_and_keymap` with:

```c
static void simple_and_keymap(void) {
  IBusEngine *engine =
      g_object_ref_sink(g_object_new(IBUS_TYPE_ENGINE_SIMPLE, NULL));
  gboolean handled = TRUE;
  g_signal_emit_by_name(engine, "process-key-event", IBUS_a, 38u, 0u, &handled);
  g_assert_false(handled);
  g_object_unref(engine);

  g_assert_null(ibus_keymap_get("de"));
  g_assert_cmpuint(ibus_keymap_lookup_keysym(NULL, 30, 0), ==,
                   IBUS_VoidSymbol);
  IBusKeymap *us = ibus_keymap_get("us");
  g_assert_nonnull(us);
  g_assert_true(ibus_keymap_get("us") == us);
  g_object_unref(us);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 30, 0), ==, IBUS_a);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 30, IBUS_SHIFT_MASK), ==,
                   IBUS_A);
  g_assert_cmpuint(
      ibus_keymap_lookup_keysym(us, 30, IBUS_SHIFT_MASK | IBUS_LOCK_MASK), ==,
      IBUS_a);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 2, IBUS_LOCK_MASK), ==,
                   IBUS_1);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 79, IBUS_MOD2_MASK), ==,
                   IBUS_KP_1);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 79, IBUS_SHIFT_MASK), ==,
                   IBUS_KP_End);
  g_assert_cmpuint(ibus_keymap_lookup_keysym(us, 0xfff, 0), ==,
                   IBUS_VoidSymbol);
  g_object_unref(us);
}

static void keymap_matches_page(void) {
  const gchar *path = g_getenv("IBUSWEB_TEST_US_KEYMAP");
  if (path == NULL || *path == '\0') {
    g_test_skip("IBUSWEB_TEST_US_KEYMAP is not set");
    return;
  }
  g_autofree gchar *contents = NULL;
  g_assert_true(g_file_get_contents(path, &contents, NULL, NULL));
  IBusKeymap *us = ibus_keymap_get("us");
  g_auto(GStrv) lines = g_strsplit(contents, "\n", -1);
  guint checked = 0;
  for (gchar **line = lines; *line != NULL; ++line) {
    guint code, state, keyval;
    if (sscanf(*line, "%u %u %u", &code, &state, &keyval) != 3)
      continue;
    if (ibus_keymap_lookup_keysym(us, code, state) != keyval)
      g_error("evdev %u, state %u: expected 0x%x, got 0x%x", code, state,
              keyval, ibus_keymap_lookup_keysym(us, code, state));
    ++checked;
  }
  g_assert_cmpuint(checked, >, 1000);
  g_object_unref(us);
}
```

and register the new case beside the existing one: `g_test_add_func("/engine/keymap-matches-page", keymap_matches_page);` (use the path prefix the file's other registrations use). Add `#include <stdio.h>` if the file lacks it.

Run: `nix develop -c git add runtime/libibus-web && nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: FAIL (`ibus_keymap_get("us")` is `NULL`).

- [ ] **Step 4: Implement the keymap**

Replace `runtime/libibus-web/src/ibus/ibuskeymap.c` with:

```c
/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */
#include "us-keymap.generated.h"
#include <ibus.h>
#include <stdlib.h>

G_DEFINE_TYPE(IBusKeymap, ibus_keymap, IBUS_TYPE_OBJECT)

static void ibus_keymap_class_init(IBusKeymapClass *klass G_GNUC_UNUSED) {}
static void ibus_keymap_init(IBusKeymap *keymap G_GNUC_UNUSED) {}

/* The page translates keys itself; engines that ask for a keymap get US, the
 * layout the page's `us` engines follow. */
IBusKeymap *ibus_keymap_get(const gchar *name) {
  static IBusKeymap *us;
  if (g_strcmp0(name, "us") != 0)
    return NULL;
  if (g_once_init_enter_pointer(&us)) {
    IBusKeymap *keymap = g_object_ref_sink(g_object_new(IBUS_TYPE_KEYMAP, NULL));
    keymap->name = g_strdup("us");
    g_once_init_leave_pointer(&us, keymap);
  }
  return g_object_ref(us);
}

static int compare_code(const void *code, const void *key) {
  return (int)*(const guint16 *)code - (int)((const UsKey *)key)->code;
}

guint ibus_keymap_lookup_keysym(IBusKeymap *keymap, guint16 keycode,
                                guint32 state) {
  if (keymap == NULL)
    return IBUS_VoidSymbol;
  const UsKey *key = bsearch(&keycode, us_keys, G_N_ELEMENTS(us_keys),
                             sizeof *us_keys, compare_code);
  if (key == NULL)
    return IBUS_VoidSymbol;

  /* IBus selects keypad levels by NumLock alone and inverts letter case under
   * Lock; Mod5 plays no part. */
  gboolean shift = (state & IBUS_SHIFT_MASK) != 0;
  gboolean lock = (state & IBUS_LOCK_MASK) != 0;
  gboolean upper = key->flags & US_KEY_KEYPAD ? (state & IBUS_MOD2_MASK) != 0
                   : key->flags & US_KEY_LETTER ? shift != lock
                                                : shift;
  return upper && key->upper != 0 ? key->upper : key->lower;
}
```

If the pinned GLib lacks `g_once_init_enter_pointer` (added in 2.80), use `g_once_init_enter(&us)` with `g_once_init_leave(&us, keymap)`.

Run: `nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: PASS, including `keymap-matches-page`.

- [ ] **Step 5: Update the docs**

In `docs/runtime.md`, replace `` `ibus_keymap_get()` returns `NULL`; keymap lookup returns the input keyval because the page supplies translated keysyms. `` with:

```markdown
`ibus_keymap_get("us")` returns a shared US keymap and any other name `NULL`.
Its lookup maps an evdev code and modifier state to the keysym the page's `us`
translation would give: NumLock alone selects keypad levels, Shift and Lock
invert each other for letters, Shift selects the second level for other keys,
and Mod5 is ignored. Its table is generated from the same xkeyboard-config
export as the page's (`us-keymap.generated.h`), and the `engine` test checks it
against vectors the page's translation writes.
```

In `docs/known-gaps.md`, replace `Keymap lookup uses page-provided keysyms.` with `Only the US keymap exists.` Format both with oxfmt.

- [ ] **Step 6: Run the checks**

Run each, expected PASS:

```bash
nix develop -c git add tools/keysyms runtime/libibus-web docs/runtime.md docs/known-gaps.md
nix build .#checks.x86_64-linux.tools-keysyms -L
nix build .#checks.x86_64-linux.libibus-web-tests -L
nix build '.#checks.x86_64-linux."files:runtime/libibus-web/src/ibus/us-keymap.generated.h"' -L
nix build .#checks.x86_64-linux.ibus-runtime-exports -L
```

- [ ] **Step 7: Commit**

```bash
nix develop -c git commit -m "feat(libibus-web): give engines IBus's US keymap, matching the page's translation" -- tools/keysyms runtime/libibus-web docs/runtime.md docs/known-gaps.md
```

---

### Task 7: `ibus_engine_simple_add_table_by_locale`

**Files:**
- Modify: `runtime/libibus-web/src/ibus/ibusenginesimple.c`, `runtime/libibus-web/tests/test-engine.c`
- Docs: `docs/runtime.md`

- [ ] **Step 1: Write the failing test**

In `runtime/libibus-web/tests/test-engine.c`, in `simple_and_keymap`, before `g_object_unref(engine);` add:

```c
  g_assert_false(ibus_engine_simple_add_table_by_locale(
      IBUS_ENGINE_SIMPLE(engine), NULL));
```

Run: `nix develop -c git add runtime/libibus-web && nix build .#checks.x86_64-linux.libibus-web-tests -L`
Expected: FAIL to link (`undefined symbol: ibus_engine_simple_add_table_by_locale`).

- [ ] **Step 2: Implement**

Append to `runtime/libibus-web/src/ibus/ibusenginesimple.c`:

```c
gboolean ibus_engine_simple_add_table_by_locale(
    IBusEngineSimple *simple G_GNUC_UNUSED, const gchar *locale G_GNUC_UNUSED) {
  /* Compose sequences stay with the browser and the OS, so there is no table
   * to load. */
  return FALSE;
}
```

- [ ] **Step 3: Update the docs**

In `docs/runtime.md`, replace `` `IBusEngineSimple` is a minimal base: compose, Ctrl+Shift+U and emoji input are not implemented. `` with `` `IBusEngineSimple` is a minimal base: compose, Ctrl+Shift+U and emoji input are not implemented, and `ibus_engine_simple_add_table_by_locale()` loads nothing and returns `FALSE`. `` Format with oxfmt.

- [ ] **Step 4: Run the checks**

Run each, expected PASS:

```bash
nix develop -c git add runtime/libibus-web docs/runtime.md
nix build .#checks.x86_64-linux.libibus-web-tests -L
nix build .#checks.x86_64-linux.ibus-runtime-exports -L
```

- [ ] **Step 5: Commit**

```bash
nix develop -c git commit -m "feat(libibus-web): accept IBusEngineSimple compose tables by locale, loading none" -- runtime/libibus-web/src/ibus/ibusenginesimple.c runtime/libibus-web/tests/test-engine.c docs/runtime.md
```

---

### Task 8: Verify the phase

- [ ] **Step 1: Generated files have no drift**

Run: `nix run .#write-files && git status --short`
Expected: no output.

- [ ] **Step 2: Every check**

Run each; all expected to PASS:

```bash
nix flake check -L
nix build .#integration-checks -L
nix develop -c hk check --all
```

- [ ] **Step 3: Report**

Report which commands ran and their results. For anything that failed, give the failing check and its output, fix it in the task it belongs to (amending nothing: a new commit with the same scope), and rerun Step 2.
