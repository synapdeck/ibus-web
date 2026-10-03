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
      inherit (config.ibusWeb) toolchain runtime;
      # Array options take a Python list literal, since flags such as
      # -Wl,... rule out Meson's comma-separated form.
      mesonArray = flags: builtins.toJSON (lib.filter (flag: flag != "") (lib.splitString " " flags));
    in
    {
      checks.libibus-web-vendored = pkgs.runCommand "libibus-web-vendored" { } ''
        ${config.ibusWeb.typescript.nodejs}/bin/node ${../../tools/vendor-inventory.ts} \
          ${runtime.libibusWeb.src} ${./src/ibus/README.md} > $out
        cat $out
      '';

      checks.libibus-web-cast-audit =
        (config.ibusWeb.engines.castAudit {
          name = "libibus-web";
          src = runtime.libibusWeb.src;
          sources = map (name: "../src/ibus/${name}.c") [
            "ibusobject"
            "ibusserializable"
            "ibustext"
            "ibusattribute"
            "ibusattrlist"
            "ibuslookuptable"
            "ibusproperty"
            "ibusproplist"
            "ibuskeys"
            "ibuskeyuni"
            "ibusutil"
            "ibuserror"
          ];
          cflags = "-DIBUS_COMPILATION -I../include/ibus-1.0 -Isrc/ibus";
          buildInputs = [ toolchain.pkgsWasm.glib ];
          pkgConfigModules = [ "gio-2.0" ];
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            # Generate the same headers as the library before compiling diagnostics.
            dontConfigure = false;
            nativeBuildInputs = old.nativeBuildInputs ++ [
              toolchain.pkgsWasm.meson
              toolchain.pkgsWasm.ninja
            ];
            postConfigure = ''
              ninja src/ibus/ibusenumtypes.h src/ibus/ibusmarshalers.h
            '';
          });

      # libibus-web built with its test suite, which Meson runs under Node,
      # the cross file's exe wrapper. nixpkgs never runs checkPhase when the
      # build machine can't execute host binaries, so the tests run here.
      checks.libibus-web = runtime.libibusWeb.overrideAttrs (old: {
        pname = "ibus-web-libibus-web-check";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            old.passthru.fileset
            ./tests
          ];
        };
        mesonFlags = (old.mesonFlags or [ ]) ++ [
          "-Dtests=true"
          "-Dtest_main_link_args=${mesonArray toolchain.testMainFlags}"
          "-Dtest_side_module_link_args=${mesonArray toolchain.sideModuleFlags}"
          "-Dtest_archives=${runtime.installArchives}"
        ];
        installPhase = ''
          runHook preInstall
          # Meson exits 0 for a skipped test, as when a cross file loses its
          # exe wrapper, so the summary must show tests ran and none skipped.
          meson test --no-rebuild --print-errorlogs | tee meson-summary.txt
          [ "''${PIPESTATUS[0]}" -eq 0 ]
          if ! grep -Eq '^Ok:[[:space:]]+[1-9]' meson-summary.txt ||
            grep -Eq '^(Skipped|Fail|Timeout|Unexpected Pass|Expected Fail):[[:space:]]+[1-9]' meson-summary.txt; then
            echo "libibus-web: tests did not all run and pass" >&2
            exit 1
          fi
          mkdir -p $out
          cp meson-logs/testlog.txt $out/
          runHook postInstall
        '';
      });
    };
}
