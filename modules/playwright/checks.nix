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
        {
          linkFlags ? "",
        }:
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
            $CC ${testing.browserLinkFlags} ${linkFlags} ${name}.o -o ${name}.js
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
      # pair whose second run reads what the first stored in IndexedDB, and a
      # program whose last output is printed from a pthread.
      checks.browser-run = testing.browserRun {
        name = "fixtures";
        programs = [
          (fixture "exit0" { })
          (fixture "persist.1" { })
          (fixture "persist.2" { })
          # One pthread, started from the pool so main can join it without
          # yielding to the event loop.
          (fixture "pthread-output" { linkFlags = "-sPTHREAD_POOL_SIZE=1"; })
        ];
      };
    };
}
