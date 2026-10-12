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
      inherit (config.ibusWeb) testing toolchain typescript;
      inherit (toolchain) pkgsWasm;
      inherit (pkgsWasm) pkgsBuildBuild;

      # The gate, beside the dependencies its package installs. Those come
      # without the workspace's sources, so editing them doesn't rerun GLib's
      # tests.
      gate = pkgs.runCommand "ibus-web-glib-tests-gate-script" { } ''
        mkdir $out
        cp ${../../../../tools/glib-test-gate/gate.ts} $out/gate.ts
        ln -s ${typescript.packageNodeModules ../../../../tools/glib-test-gate} $out/node_modules
      '';

      setupExcludes = ./setup-excludes.py;

      # Runs a test under Node with a TMPDIR of its own, removed afterwards
      # however the test set its modes. Node runs in the background because
      # bash only handles a signal once its foreground child has exited, and
      # without the explicit redirection a background job reads /dev/null.
      # Meson's timeout sends SIGTERM, which goes on to Node so that nothing
      # outlives the wrapper. A test killed by a signal is reported the same
      # way, by the wrapper dying of it too, so Meson doesn't take it for an
      # exit status.
      nodeWithTmpdir = pkgsBuildBuild.writeShellScript "ibus-web-node-with-tmpdir" ''
        dir=$(mktemp -d)

        cleanup() {
          chmod -R u+rwx "$dir"
          rm -r "$dir"
        }

        die() {
          trap - "$1"
          kill -s "$1" $$
        }

        trap 'kill -s TERM "$node" 2> /dev/null; wait "$node"; cleanup; die TERM' TERM
        TMPDIR=$dir ${lib.getExe typescript.nodejs} "$@" <&0 &
        node=$!
        wait "$node"
        status=$?
        cleanup

        if [ "$status" -gt 128 ] && sig=$(kill -l "$status" 2> /dev/null); then
          die "$sig"
        fi

        exit $status
      '';

      nodeRawFs = "-sNODERAWFS=1";

      testsCrossFile = pkgsBuildBuild.writeText "ibus-web-glib-tests-cross.ini" ''
        [binaries]
        exe_wrapper = ['${nodeWithTmpdir}']
      '';
    in
    {
      # GLib's own tests, built by the same recipe with tests enabled and run
      # through Meson's exe wrapper (Node). nixpkgs never runs checkPhase when
      # the build machine can't execute host binaries, so the tests run here.
      checks.glib-tests = pkgsWasm.glib.overrideAttrs (old: {
        pname = "ibus-web-glib-tests";

        # The tests link against WasmFS, the file system the runtime ships,
        # rather than the tools' JavaScript one. So does every executable this
        # build links, including the in-tree tools Meson runs while building;
        # they only ever write fresh outputs here, which WasmFS handles. If the
        # C and C++ link arguments stop naming the setting, evaluation fails
        # instead of the tests quietly keeping it.
        mesonFlags =
          assert lib.count (lib.hasInfix nodeRawFs) old.mesonFlags == 2;
          map (lib.replaceStrings [ nodeRawFs ] [ toolchain.nodeHostFsFlags ]) old.mesonFlags
          ++ [ "-Dtests=true" ];

        # After the toolchain's cross file, whose exe_wrapper this replaces.
        preConfigure = (old.preConfigure or "") + ''
          mesonFlagsArray+=("--cross-file=${testsCrossFile}")
        '';

        # The tests of GLib's tools run them under Node themselves.
        nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
          pkgsWasm.python3
          typescript.nodejs
        ];

        outputs = [ "out" ];

        # Excluded tests never run: several busy-wait until Meson's timeout
        # and hold cores the other tests need. The gate prints the
        # `meson test` invocations that select the rest, one per line, and
        # their logs are joined into one.
        installPhase = ''
          runHook preInstall
          # The pkg-config tests point PKG_CONFIG_PATH at the build tree,
          # which nixpkgs' pkg-config wrapper replaces with its role's search
          # path; the unwrapped pkg-config honours it.
          export PATH=${pkgsWasm.pkgsBuildBuild.pkg-config-unwrapped}/bin:$PATH

          gate() {
            ${lib.getExe typescript.nodejs} ${gate}/gate.ts "$1" meson-info/intro-tests.json default-tests \
              excluded-suites ${./baseline.toml} "''${@:2}"
          }

          # Invocations come on fd 3, since tests inherit stdin and may read
          # it; Meson's report goes to stderr, stdout carries the joined log.
          # Quiet, and with no terminal to redraw its progress on, Meson
          # prints the tests that fail, with their logs, and its summary.
          runTests() {
            local base=$1 jobs=$2 n=0 selection
            while read -r -a selection <&3; do
              TERM=dumb meson test --no-rebuild --quiet --print-errorlogs --timeout-multiplier 4 \
                --num-processes "$jobs" --logbase "$base-$n" "''${selection[@]}" >&2 || true
              n=$((n + 1))
            done 3< "$3"
            cat meson-logs/"$base"-*.json 2> /dev/null || true
          }

          mkdir -p $out
          meson test --no-rebuild --list > default-tests
          meson runpython ${setupExcludes} > excluded-suites
          gate runnable > runnable
          runTests run $NIX_BUILD_CORES runnable > $out/testlog.json
          gate failing $out/testlog.json > failing

          rerun=()
          if [ -s failing ]; then
            runTests rerun 1 failing > $out/rerun.json
            rerun=($out/rerun.json)
          fi

          gate report $out/testlog.json $out "''${rerun[@]}"
          runHook postInstall
        '';

        postInstall = "";
        preFixup = "";
        postFixup = "";
      });

      # The gate's test selection, run against Meson on a small project
      # whose tests collide in the ways GLib's could, and its report.
      checks.glib-tests-gate = testing.programs {
        name = "glib-tests-gate";
        environments = [ "node" ];
        programs = [ ];
        nodeTests = ../../../../tools/glib-test-gate;

        nodeTestData = {
          gate = "${gate}/gate.ts";
          inherit setupExcludes;
          baseline = "${./baseline.toml}";
          path = lib.makeBinPath [
            pkgsBuildBuild.meson
            pkgsBuildBuild.ninja
            pkgsBuildBuild.coreutils
          ];
        };
      };
    };
}
