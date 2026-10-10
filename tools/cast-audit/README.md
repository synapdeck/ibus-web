# Function-pointer cast audit

`cast-audit.ts report <sarif...>` reads Clang diagnostics from the current source directory. It writes normalized JSON
to stdout and a readable report to stderr. `cast-audit.ts compare <report.json> <allow.jsonc>` requires multiset
equality, ignoring line numbers and allowance explanations. Both new casts and stale allowances fail the check. The
allow-list is validated against `cast-audit.schema.json` with Ajv before comparing, so a misspelled or extra field, or
an entry without a `reason`, fails with a message naming the entry.

The SARIF object model, URI reconstruction, and line indexing come from `@microsoft/sarif`. The native `tree-sitter`
binding parses source with the official C and C++ grammars. Only an identifier directly used as a cast operand gets a
function name; expressions and macro expansions are reported with `null`. The compiler remains responsible for deciding
whether types mismatch.

Clang currently gives SARIF diagnostics numeric rule IDs and empty names. The audit recognizes its
incompatible-function-type message, which also supplies the displayed types. Casts to `GCallback` are excluded because
that cast alone cannot establish handler arity. Generic `void (*)(void)` casts are audited, including directly invoked
mismatches. Malformed compiler output fails the audit.

Run the unit tests with `pnpm --dir tools test`. The Nix checks are `tools-cast-audit` and `engines-cast-audit-fixture`;
the latter compiles the fixture with the project's WASM compiler and checks its explicit allowances and rejection by an
empty allow-list, including the direct zero-argument call in isolation, which `select.ts <report.json> <function>`
extracts from the report.

## Refreshing the compiler fixture

Run from the repository root in the development shell:

```sh
wasm32-unknown-none-cc -fsyntax-only -Wno-everything -Wcast-function-type-strict \
  -fdiagnostics-format=sarif $(wasm32-unknown-none-pkg-config --cflags gobject-2.0) \
  tools/cast-audit/fixtures/casts.c 2> /tmp/casts.sarif
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { readSarif } from './tools/cast-audit/sarif.ts';
const log = readSarif(readFileSync('/tmp/casts.sarif', 'utf8'));
for (const run of log.runs) {
  for (const artifact of run.artifacts ?? []) artifact.location.uri = 'casts.c';
  for (const result of run.results ?? []) {
    for (const location of result.locations ?? []) {
      location.physicalLocation.artifactLocation.uri = 'casts.c';
    }
  }
}
writeFileSync('tools/cast-audit/fixtures/casts.sarif', JSON.stringify(log, null, 2) + '\n');
JS
```

Only source URIs are normalized; messages, numeric IDs, and regions remain compiler output.
