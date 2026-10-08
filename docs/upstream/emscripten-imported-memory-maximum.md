# MAXIMUM_MEMORY is ignored for an imported memory without growth

**Done upstream: don't post.** Filed as
[#27859](https://github.com/emscripten-core/emscripten/issues/27859) and
fixed by [#27862](https://github.com/emscripten-core/emscripten/pull/27862)
("Honor MAXIMUM_MEMORY for an imported memory without growth", merged
2026-10-02 as 994494bf2). Its `tools/link.py` and `tools/building.py` hunks
are 0016's; the settings text is reworded (the module takes the embedder's
word that the memory isn't grown from outside), and its test is one more
line in `other.test_bad_memory_size` instead of the test below. It landed
after 6.0.11 (a0014542110d, marked released 2026-10-02), so the first
release with it is 6.0.12; drop 0016 then.

Checked against `main` 5977ecc (2026-10-02), with emsdk's toolchain for it
(`test/emsdk_version.txt` dbaebb43: clang 24.0.0git d3e9891b, Binaryen 133)
and Node 24.21.0: `other.test_imported_memory_maximum_no_growth` from
`emscripten-imported-memory-maximum.tests.patch` (applied with `-C1`, since
#27862 changed the lines around it) passes on `main`, and fails with
#27862's `tools/` hunks reverted (the `-Werror` warning);
`other.test_bad_memory_size` passes. 0016 itself no longer applies to
`main`.

**Draft: new issue, with a PR.** No existing issue asks for it. The
nearest is #25905 ("ios 26.2 shared memory issues", open), where the
workaround offered for a growth bug in WebKit is to turn growth off and
pick a fixed `INITIAL_MEMORY` at link time; with this change that size can
be picked when the module is loaded instead.

## Issue title

Allow an imported memory larger than INITIAL_MEMORY without memory growth (honour MAXIMUM_MEMORY with IMPORTED_MEMORY)

## Issue body

---

Without `ALLOW_MEMORY_GROWTH`, emcc links with `--no-growable-memory`, so
the memory a module imports is declared with its maximum equal to
`INITIAL_MEMORY`, and an instance accepts only a memory of exactly that
size. A `MAXIMUM_MEMORY` given on the command line is lowered to
`INITIAL_MEMORY`, with a warning that it is "only meaningful with
ALLOW_MEMORY_GROWTH".

For an imported memory it does mean something. The embedder makes the
memory, and the module can run in any memory from its initial size to its
declared maximum without ever growing it. That lets one build run in a
fixed memory whose size is chosen at load time, by the embedder from
whatever it knows then (the data it will load, a user setting), rather
than linking one build per size or turning growth on. Growth on shared
memory has costs and bugs of its own (`-Wpthreads-mem-growth`, and engine
bugs such as WebKit's in #25905 or V8's issues 529880019 and 533026477,
where an atomic access to memory another thread grew can trap).

`wasm-ld` itself is right to reject `--max-memory` together with
`--no-growable-memory`. emcc is what decides to pass the latter whenever
growth is off.

**Version of emscripten/emsdk:**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.9-git
clang version 22.1.8
Target: wasm32-unknown-emscripten
Thread model: posix
InstalledDir: /nix/store/a0h9ym1ai9yawkmymx2wp0vnh64hsv0r-clang-22.1.8/bin
```

This is the 6.0.9 release tag as packaged by nixpkgs. nixpkgs builds it against
its own LLVM 22.1.8, so there is no commit hash. Node.js v24.20.0, x86_64 Linux.

**Test case** (`main.c`, and `pre.js`, which has Emscripten make a 48 MiB
memory; passing a `wasmMemory` of that size does the same):

```c
#include <emscripten/heap.h>
#include <stdio.h>
#include <stdlib.h>

void *volatile block;

int main(void) {
  size_t size = emscripten_get_heap_max();
  printf("heap max: %zu MiB\n", size >> 20);
  block = malloc(size);
  printf("malloc(heap max): %s\n", block ? "succeeded" : "failed");
  printf("heap max after: %zu MiB\n", emscripten_get_heap_max() >> 20);
  return 0;
}
```

```js
Module.INITIAL_MEMORY = 48 * 1024 * 1024;
```

**Failing command line in full:**

```
$ emcc -O2 -pthread -sIMPORTED_MEMORY -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=64MB \
    -sABORTING_MALLOC=0 --pre-js pre.js main.c -o main.js
emcc: warning: MAXIMUM_MEMORY is only meaningful with ALLOW_MEMORY_GROWTH [-Wunused-command-line-argument]
$ node main.js
failed to asynchronously prepare wasm: LinkError: WebAssembly.instantiate(): Import #0 "env" "memory": memory import has a larger maximum size 768 than the module's declared maximum 256
Aborted(LinkError: WebAssembly.instantiate(): Import #0 "env" "memory": memory import has a larger maximum size 768 than the module's declared maximum 256)
(Node's report of the uncaught RuntimeError follows)
[exit status 1]
```

(The same without `-pthread`, which only implies `IMPORTED_MEMORY`.)

**Where:**

- `set_max_memory()` warns and lowers the maximum
  ([link.py#L554-L559](https://github.com/emscripten-core/emscripten/blob/6.0.9/tools/link.py#L554-L559)).
- The link passes `--no-growable-memory` whenever growth is off
  ([building.py#L251-L254](https://github.com/emscripten-core/emscripten/blob/6.0.9/tools/building.py#L251-L254)).

Nothing else depends on the maximum without growth:
`emscripten_resize_heap()` fails (or aborts with `ABORTING_MALLOC`) and
`getHeapMax()` is `HEAPU8.length`
([libcore.js#L180-L264](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/lib/libcore.js#L180-L264)),
and a memory Emscripten makes itself has its maximum at its initial size
([runtime_init_memory.js#L37-L48](https://github.com/emscripten-core/emscripten/blob/6.0.9/src/runtime_init_memory.js#L37-L48)).
`CAN_ADDRESS_2GB` is derived from `MAXIMUM_MEMORY` once it is settled
([link.py#L1686-L1688](https://github.com/emscripten-core/emscripten/blob/6.0.9/tools/link.py#L1686-L1688)),
so it follows the kept maximum: a 4 GiB maximum makes pointers unsigned in
JavaScript, a 2 GiB one doesn't.

**Suggested fix:** with `IMPORTED_MEMORY` and a `MAXIMUM_MEMORY` the user
set, keep the maximum and pass it to `wasm-ld` as `--max-memory`, even
without growth, and don't warn. Everything else stays as it is without
growth. 20 lines added and 5 removed, the settings reference regenerated
with `tools/maint/update_settings_docs.py`. Against `main`:

```diff
diff --git a/site/source/docs/tools_reference/settings_reference.rst b/site/source/docs/tools_reference/settings_reference.rst
index 3480cd2..8b0a6ed 100644
--- a/site/source/docs/tools_reference/settings_reference.rst
+++ b/site/source/docs/tools_reference/settings_reference.rst
@@ -219,8 +219,13 @@ MAXIMUM_MEMORY
 ==============

 Set the maximum size of memory in the wasm module (in bytes). This is only
-relevant when ALLOW_MEMORY_GROWTH is set, as without growth, the size of
-INITIAL_MEMORY is the final size of memory anyhow.
+relevant when ALLOW_MEMORY_GROWTH or IMPORTED_MEMORY is set; otherwise the
+size of INITIAL_MEMORY is the final size of memory anyhow. Without growth,
+an imported memory may be any size from INITIAL_MEMORY up to this maximum,
+and the module uses the memory it is given without ever growing it, so a
+single build can run in a memory whose size is chosen when it is loaded
+(passed as ``wasmMemory``, or made from ``INITIAL_MEMORY`` on the Module
+object).

 Note that the default value here is 2GB, which means that by default if you
 enable memory growth then we can grow up to 2GB but no higher. 2GB is a
diff --git a/src/settings.js b/src/settings.js
index 77bf740..a4e1671 100644
--- a/src/settings.js
+++ b/src/settings.js
@@ -189,8 +189,13 @@ var INITIAL_HEAP = 16777216;
 var INITIAL_MEMORY = -1;

 // Set the maximum size of memory in the wasm module (in bytes). This is only
-// relevant when ALLOW_MEMORY_GROWTH is set, as without growth, the size of
-// INITIAL_MEMORY is the final size of memory anyhow.
+// relevant when ALLOW_MEMORY_GROWTH or IMPORTED_MEMORY is set; otherwise the
+// size of INITIAL_MEMORY is the final size of memory anyhow. Without growth,
+// an imported memory may be any size from INITIAL_MEMORY up to this maximum,
+// and the module uses the memory it is given without ever growing it, so a
+// single build can run in a memory whose size is chosen when it is loaded
+// (passed as ``wasmMemory``, or made from ``INITIAL_MEMORY`` on the Module
+// object).
 //
 // Note that the default value here is 2GB, which means that by default if you
 // enable memory growth then we can grow up to 2GB but no higher. 2GB is a
diff --git a/tools/building.py b/tools/building.py
index 230c5eb..ee30303 100644
--- a/tools/building.py
+++ b/tools/building.py
@@ -248,7 +248,9 @@ def lld_flags_for_executable(external_symbols):
   if not settings.SIDE_MODULE:
     cmd += ['-z', f'stack-size={settings.STACK_SIZE}']

-    if settings.ALLOW_MEMORY_GROWTH:
+    # Without growth, an imported memory may still be declared with a maximum
+    # above its initial size, so that the embedder can pass a larger one.
+    if settings.ALLOW_MEMORY_GROWTH or (settings.IMPORTED_MEMORY and settings.MAXIMUM_MEMORY > settings.INITIAL_MEMORY):
       cmd += [f'--max-memory={settings.MAXIMUM_MEMORY}']
     else:
       cmd += ['--no-growable-memory']
diff --git a/tools/link.py b/tools/link.py
index 62e88d7..771d37a 100644
--- a/tools/link.py
+++ b/tools/link.py
@@ -546,9 +546,12 @@ def set_max_memory():
   # With INITIAL_HEAP, we only know the lower bound on initial memory size.
   initial_memory_known = settings.INITIAL_MEMORY != -1

-  if not settings.ALLOW_MEMORY_GROWTH:
+  # An imported memory can be larger than INITIAL_MEMORY, up to a maximum the
+  # user sets, even without growth: the module then runs in the memory it is
+  # given and never grows it.
+  if not settings.ALLOW_MEMORY_GROWTH and not (settings.IMPORTED_MEMORY and 'MAXIMUM_MEMORY' in user_settings):
     if 'MAXIMUM_MEMORY' in user_settings:
-      diagnostics.warning('unused-command-line-argument', 'MAXIMUM_MEMORY is only meaningful with ALLOW_MEMORY_GROWTH')
+      diagnostics.warning('unused-command-line-argument', 'MAXIMUM_MEMORY is only meaningful with ALLOW_MEMORY_GROWTH or IMPORTED_MEMORY')
     # Optimization: lower the default maximum memory to initial memory if possible.
     if initial_memory_known:
       settings.MAXIMUM_MEMORY = settings.INITIAL_MEMORY
```

With this applied to 6.0.9:

```
$ emcc -O2 -pthread -sIMPORTED_MEMORY -sINITIAL_MEMORY=16MB -sMAXIMUM_MEMORY=64MB \
    -sABORTING_MALLOC=0 --pre-js pre.js main.c -o main.js
$ node main.js
heap max: 48 MiB
malloc(heap max): failed
heap max after: 48 MiB
[exit status 0]
```

An 80 MiB memory is still a `LinkError`, and `-sMAXIMUM_MEMORY` without
`IMPORTED_MEMORY` still warns, now that it is "only meaningful with
ALLOW_MEMORY_GROWTH or IMPORTED_MEMORY" (`other.test_invalid_memory_max`
looks for the old text, which the new one starts with, and passes). The
module's import is `(memory 256 1024 shared)`, and its JavaScript is that
of a link without growth.

A ChangeLog line for the PR: "`MAXIMUM_MEMORY` now applies to an imported
memory without `ALLOW_MEMORY_GROWTH`: the module accepts a memory of any
size up to it, and never grows it."

**Test for the PR,** in the suite's format (also as
`emscripten-imported-memory-maximum.tests.patch` beside this draft):
`other.test_imported_memory_maximum_no_growth`, with and without
`-pthread`. `-Werror` makes the old warning fail it too.

```diff
diff --git a/test/test_other.py b/test/test_other.py
index b5ad68b..22ae290 100644
--- a/test/test_other.py
+++ b/test/test_other.py
@@ -8488,6 +8488,39 @@ int main() {
     # and with memory growth, all should be good
     self.do_runf_out_file('hello_world.c', cflags=['-sINITIAL_MEMORY=16mb', '--pre-js', 'pre.js', '-sALLOW_MEMORY_GROWTH', '-sIMPORTED_MEMORY'])

+  @parameterized({
+    '': ([],),
+    'pthread': (['-pthread'],),
+  })
+  def test_imported_memory_maximum_no_growth(self, args):
+    # Without memory growth, an imported memory may still be any size up to
+    # MAXIMUM_MEMORY. The module uses the memory it is given and never grows
+    # it.
+    create_file('main.c', r'''
+      #include <emscripten/heap.h>
+      #include <stdio.h>
+      #include <stdlib.h>
+
+      void* volatile block;
+
+      int main() {
+        size_t size = emscripten_get_heap_max();
+        printf("heap max: %zuMB\n", size / (1024 * 1024));
+        block = malloc(size);
+        printf("malloc beyond it: %s\n", block ? "succeeded" : "failed");
+        printf("heap max after: %zuMB\n", emscripten_get_heap_max() / (1024 * 1024));
+        return 0;
+      }
+    ''')
+    create_file('pre.js', 'Module.INITIAL_MEMORY = 48 * 1024 * 1024;')
+    cflags = ['-Werror', '-sIMPORTED_MEMORY', '-sINITIAL_MEMORY=16MB', '-sMAXIMUM_MEMORY=64MB',
+              '-sABORTING_MALLOC=0', '--pre-js=pre.js'] + args
+    self.do_runf('main.c', 'heap max: 48MB\nmalloc beyond it: failed\nheap max after: 48MB\n', cflags=cflags)
+    # A memory above the maximum is refused.
+    create_file('pre.js', 'Module.INITIAL_MEMORY = 80 * 1024 * 1024;')
+    out = self.do_runf('main.c', cflags=cflags, assert_returncode=NON_ZERO)
+    self.assertContained('LinkError', out)
+
   @parameterized({
     '': ([], 16 * 1024 * 1024), # Default behavior: 16MB initial heap
     'explicit': (['-sINITIAL_HEAP=64KB'], 64 * 1024), # Explicitly set initial heap is passed
```

---

## Evidence

- **Kind of report.** A behaviour change more than a bug: the current
  behaviour is documented ("This is only relevant when ALLOW_MEMORY_GROWTH
  is set"). Framed as a request with a small PR.
- **The test's `volatile`.** clang assumes an allocation whose result is
  only compared with `NULL` succeeds and drops it, so the result is stored
  first; the first version of the test "succeeded" at a `malloc()` that
  never ran.
- **Testing.** On Emscripten's runner, through the `emcc` of the
  toolchain's whole stack (0001-0016): both new tests pass, and both fail
  on stock 6.0.9 (the `-Werror` warning); `test_invalid_memory_max` and
  `test_bad_memory_size` pass on both. The 202-test pthread selection the
  0014/0015 drafts used gives the same results as with 0001-0015 (168 ok,
  the same environment failures), but for
  `other.test_pthread_print_override_modularize`, which failed in that
  earlier run under load and passes now.
- **Behaviour change for existing builds.** A link that passes
  `MAXIMUM_MEMORY` with pthreads (so `IMPORTED_MEMORY`) and without growth
  used to get a warning and a module fixed at `INITIAL_MEMORY`; it now
  gets a module that also accepts larger memories. A memory Emscripten
  makes itself is unchanged.
- **Duplicate search.** "no-growable-memory", "MAXIMUM_MEMORY is only
  meaningful", "IMPORTED_MEMORY MAXIMUM_MEMORY", "imported memory
  maximum", "wasmMemory larger maximum" and "imported memory larger than
  INITIAL_MEMORY" in issues and PRs: nothing on this; #25905 as above.
- **Tip-of-tree.** `main` (04df3de, 2026-10-01) has the same code; the fix
  above is against it (`building.py` uses an f-string there, which the
  6.0.9 patch doesn't). The test patch applies to both, with offsets on
  `main`.
- ibus-web carries this fix as
  `modules/emscripten/patches/0016-imported-memory-maximum.patch`, and
  links ibus-runtime with `-sIMPORTED_MEMORY -sINITIAL_MEMORY=32MB
-sMAXIMUM_MEMORY=2GB` and no growth.
