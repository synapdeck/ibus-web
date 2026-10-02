# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) testing;
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      fixtures = ../../tests/browser/fixtures;

      # A directory holding one fixture program: name.js, name.wasm and, if
      # the fixture has one, name.args.
      fixture =
        name:
        let
          args = fixtures + "/${name}.args";
          hasArgs = builtins.pathExists args;
        in
        pkgsWasm.stdenv.mkDerivation {
          name = "ibus-web-browser-fixture-${name}";
          src = lib.fileset.toSource {
            root = fixtures;
            fileset = lib.fileset.unions ([ (fixtures + "/${name}.c") ] ++ lib.optional hasArgs args);
          };
          dontFixup = true;
          buildPhase = ''
            runHook preBuild
            $CC -c ${name}.c -o ${name}.o
            $CC ${testing.browserLinkFlags} ${name}.o -o ${name}.js
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 -t $out ${name}.js ${name}.wasm ${lib.optionalString hasArgs "${name}.args"}
            runHook postInstall
          '';
        };
    in
    {
      # The runner's own test: a program that exits 0, with arguments, and a
      # pair whose second run reads what the first stored in IndexedDB.
      checks.browser-run = testing.browserRun {
        name = "fixtures";
        programs = map fixture [
          "exit0"
          "persist.1"
          "persist.2"
        ];
      };
    };
}
