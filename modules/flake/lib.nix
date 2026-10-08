# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  config,
  lib,
  flake-parts-lib,
  ...
}:
let
  flakeLib = config.ibusWeb.lib;
in
{
  options.ibusWeb.lib = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = ''
      The helpers that depend on no system, for code outside perSystem: an overlay
      decides whether it applies before it picks a system, so that in any package
      set but the WebAssembly one it evaluates nothing of the flake's. perSystem's
      ibusWeb.lib has them too.
    '';
  };

  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.lib = lib.mkOption {
      type = lib.types.lazyAttrsOf lib.types.raw;
      default = { };
      description = ''
        Helpers more than one module needs, by name, so that each is written once. The
        general ones are defined here; a module that owns a helper's subject defines that
        helper beside it.
      '';
    };
  };

  config.ibusWeb.lib = {
    # The .patch files under a directory, sorted by path, so 0001-… applies
    # first; a README beside them is not a patch.
    patchesIn =
      dir:
      lib.filter (path: lib.hasSuffix ".patch" (toString path)) (lib.filesystem.listFilesRecursive dir);

    # Whether a platform is the WebAssembly one pkgsWasm builds for. Overlays
    # gate on the platform because it can be read without evaluating the
    # compiler.
    isEmscriptenWasm = platform: platform.isWasm && (platform.useEmscripten or false);
  };

  config.perSystem =
    { config, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      emscriptenRoot = "${toolchain.emscripten}/share/emscripten";
    in
    {
      ibusWeb.lib = {
        inherit (flakeLib) patchesIn isEmscriptenWasm;

        # Emscripten's installed tree: its system libraries' sources, its
        # JavaScript libraries and its tools.
        inherit emscriptenRoot;

        # WasmFS's internal headers, for code that subclasses its backends or
        # reaches into its threads.
        wasmfsIncludeFlag = "-I${emscriptenRoot}/system/lib/wasmfs";

        # A Node-run test program's link flags without the object that roots
        # WasmFS at the host's files: the memory root keeps writes isolated, and
        # store paths stay readable.
        testLinkFlagsWithoutNodeFs = [
          toolchain.commonFlags
        ]
        ++ lib.filter (flag: !(lib.hasSuffix "/node-host-fs.o" flag)) toolchain.testMainFlagList;

        # Shell that runs a Meson build's tests and fails unless some ran and all
        # passed. Meson exits 0 for a skipped test, as when a cross file loses its
        # exe wrapper, so the summary is checked too. `what` names the tests.
        mesonAllTestsRan = what: ''
          meson test --no-rebuild --print-errorlogs | tee meson-summary.txt
          [ "''${PIPESTATUS[0]}" -eq 0 ]
          if ! grep -Eq '^Ok:[[:space:]]+[1-9]' meson-summary.txt ||
            grep -Eq '^(Skipped|Fail|Timeout|Unexpected Pass|Expected Fail):[[:space:]]+[1-9]' meson-summary.txt; then
            echo ${lib.escapeShellArg "${what}: tests did not all run and pass"} >&2
            exit 1
          fi
        '';
      };
    };
}
