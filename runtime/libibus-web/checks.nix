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
        ${config.ibusWeb.typescript.nodejs}/bin/node \
          ${
            config.ibusWeb.typescript.workspaceFor [ "tools/vendor-inventory" ]
          }/tools/vendor-inventory/cli.ts \
          --root ${runtime.libibusWeb.src} --readme ${./src/ibus/README.md} \
          --upstream ${pkgs.ibus.src} --version ${pkgs.ibus.version} \
          --hash ${pkgs.ibus.src.outputHash} > $out
        cat $out
      '';

      checks.libibus-web-cast-audit =
        let
          # Paths are relative to Meson's build directory, where the audit
          # compiles; Meson's own generated sources sit beside it.
          cSources =
            dir:
            map (name: "../${dir}/${name}") (
              lib.filter (name: lib.hasSuffix ".c" name) (
                lib.attrNames (lib.filterAttrs (_: type: type == "regular") (builtins.readDir ./${dir}))
              )
            );
          generated = [
            "src/ibus/ibusenumtypes.c"
            "src/ibus/ibusmarshalers.c"
          ];
          sources = cSources "src" ++ cSources "src/ibus" ++ generated;
        in
        (config.ibusWeb.engines.castAudit {
          name = "libibus-web";
          src = runtime.libibusWeb.src;
          inherit sources;
          cflags = "-DIBUS_COMPILATION -I../include -I../include/ibus-1.0 -I../src/ibus -Isrc/ibus";
          buildInputs = [ toolchain.pkgsWasm.glib ];
          pkgConfigModules = [
            "gio-2.0"
            "gmodule-no-export-2.0"
          ];
          allowList = ./cast-audit.jsonc;
        }).overrideAttrs
          (old: {
            # Generate the same headers and sources as the library before
            # compiling diagnostics.
            dontConfigure = false;
            nativeBuildInputs = old.nativeBuildInputs ++ [
              toolchain.pkgsWasm.meson
              toolchain.pkgsWasm.ninja
              pkgs.jq
            ];
            postConfigure = ''
              ninja ${lib.escapeShellArgs (map (name: lib.removeSuffix ".c" name + ".h") generated ++ generated)}
              # The audit must cover exactly the C the library compiles.
              jq -r '.[].file | select(endswith(".c"))' compile_commands.json | sort > built.txt
              printf '%s\n' ${lib.escapeShellArgs sources} | sort > audited.txt
              diff -u built.txt audited.txt
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
          ${config.ibusWeb.lib.mesonAllTestsRan "libibus-web"}
          mkdir -p $out
          cp meson-logs/testlog.txt $out/
          runHook postInstall
        '';
      });
    };
}
