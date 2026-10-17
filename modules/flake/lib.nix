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

    # GNU tar's flags for an archive of engine data. pax keeps a name or a
    # link target longer than ustar's 100 bytes in an extended header; the
    # rest make the same tree give the same bytes whatever its files' times
    # and owners: pax would otherwise record each file's atime and ctime, and
    # name its extended headers after the writer's pid.
    archiveTarFlags = lib.concatStringsSep " " [
      "--format=pax"
      "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime"
      "--sort=name"
      "--mtime=@0"
      "--owner=0"
      "--group=0"
      "--numeric-owner"
    ];

    # Shell words for the flags automake compiles a configured source
    # directory's files with, read from its Makefile, which holds them only
    # as make variables. They start with the options configure added to CC
    # (the C standard). `target` is the Makefile variable of the per-target
    # flags, such as AM_CFLAGS or libinternal_a_CFLAGS.
    makeCflags =
      target:
      "$(make -s --no-print-directory -f Makefile -f - print-cflags <<< 'print-cflags: ; @echo $(wordlist 2,$(words $(CC)),$(CC)) $(DEFS) $(DEFAULT_INCLUDES) $(INCLUDES) $(AM_CPPFLAGS) $(CPPFLAGS) $(${target}) $(CFLAGS)')";
  };

  config.perSystem =
    { config, pkgs, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      spdxPython = pkgs.python3.withPackages (ps: [ ps.license-expression ]);
      emscriptenRoot = "${toolchain.emscripten}/share/emscripten";
    in
    {
      # Deprecated ids are renamed and repeats dropped, but no license is
      # merged into another, and an id SPDX doesn't know fails. A summary
      # takes in what a GPL in it can, and fails on anything else.
      checks.flake-spdx-expression =
        let
          inherit (config.ibusWeb.lib) spdxExpression;
          inherit (lib.licenses) bsd3 gpl2 gpl2Plus;
          table = {
            spdxId = "(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C";
          };
        in
        pkgs.runCommand "ibus-web-flake-spdx-expression" { nativeBuildInputs = [ spdxPython ]; } ''
          test "$(< ${
            spdxExpression [
              bsd3
              gpl2
              gpl2Plus
              bsd3
            ]
          })" = "BSD-3-Clause AND GPL-2.0-only AND GPL-2.0-or-later"
          test "$(< ${spdxExpression table})" = ${lib.escapeShellArg table.spdxId}
          test "$(< ${spdxExpression gpl2Plus})" = GPL-2.0-or-later
          if python3 ${./spdx-expression.py} Nonsense-1.0; then
            echo "an unknown id was accepted" >&2
            exit 1
          fi

          summary() { python3 ${./spdx-expression.py} --summary "$@"; }
          test "$(summary GPL-3.0-only GPL-3.0-or-later MIT Apache-2.0 LGPL-3.0-only CC-BY-4.0)" = GPL-3.0-only
          test "$(summary GPL-2.0-or-later GPL-2.0+ LGPL-2.1-or-later BSD-3-Clause)" = GPL-2.0-or-later
          test "$(summary 'GPL-2.0-only AND CC-BY-SA-4.0' GPL-2.0 GPL-2.0-or-later CC-BY-SA-4.0 NAIST-2003)" \
            = "GPL-2.0-only AND CC-BY-SA-4.0"
          for refused in "GPL-2.0-only Apache-2.0" "GPL-2.0-only GPL-3.0-only" "MIT BSD-3-Clause" \
            "GPL-3.0-only CC-BY-SA-4.0"; do
            if summary $refused 2>/dev/null; then
              echo "summary $refused was accepted" >&2
              exit 1
            fi
          done
          if summary GPL-3.0-only "MIT OR Apache-2.0" 2>/dev/null; then
            echo "a choice of licenses was summarized" >&2
            exit 1
          fi
          touch $out
        '';

      ibusWeb.lib = {
        inherit (flakeLib)
          patchesIn
          isEmscriptenWasm
          makeCflags
          archiveTarFlags
          ;

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

        # A file holding the SPDX expression for contents under all of
        # licenses, nixpkgs license attribute sets: each license once, under
        # its current identifier, none merged into another.
        spdxExpression =
          licenses:
          pkgs.runCommand "ibus-web-license-expression" { nativeBuildInputs = [ spdxPython ]; } ''
            python3 ${./spdx-expression.py} ${
              lib.escapeShellArgs (map (license: license.spdxId) (lib.toList licenses))
            } > $out
          '';

        # A file holding summary, an SPDX conjunction the contents under all of
        # licenses can be passed on under as a whole: every license is one of
        # its or one a GNU GPL in it takes in, else the build fails.
        spdxSummary =
          summary: licenses:
          pkgs.runCommand "ibus-web-license-summary" { nativeBuildInputs = [ spdxPython ]; } ''
            python3 ${./spdx-expression.py} --summary ${lib.escapeShellArg summary} ${
              lib.escapeShellArgs (map (license: license.spdxId) (lib.toList licenses))
            } > $out
          '';

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
