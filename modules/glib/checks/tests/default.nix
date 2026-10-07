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

      # Node makes its stdout non-blocking once a program starts its thread
      # pool, and a write that meets a full pipe fails with EAGAIN instead of
      # waiting, so a test writing faster than Meson reads loses TAP lines.
      # Files never fill up; the wrapper replays them once the test exits,
      # or when Meson's timeout sends SIGTERM, so a timed-out test still
      # shows how far it got. Node runs in the background because bash
      # only handles a signal once its foreground child has exited; without
      # the explicit redirection a background job reads /dev/null. A test
      # killed by a signal is reported the same way, by the wrapper dying of
      # it too, so Meson doesn't take it for an exit status. Each test gets a
      # TMPDIR of its own, and what it leaves there goes with the rest,
      # however it set the modes.
      nodeToFiles = pkgsBuildBuild.writeShellScript "node-to-files" ''
        dir=$(mktemp -d)
        replay() {
          cat "$dir/stdout"
          cat "$dir/stderr" >&2
          chmod -R u+rwx "$dir"
          rm -r "$dir"
        }
        die() {
          trap - "$1"
          kill -s "$1" $$
        }
        trap 'replay; die TERM' TERM
        mkdir "$dir/tmp"
        TMPDIR=$dir/tmp ${lib.getExe pkgsBuildBuild.nodejs} "$@" <&0 > "$dir/stdout" 2> "$dir/stderr" &
        wait $!
        status=$?
        replay
        if [ "$status" -gt 128 ] && sig=$(kill -l "$status" 2> /dev/null); then
          die "$sig"
        fi
        exit $status
      '';
      nodeRawFs = "-sNODERAWFS=1";
      memoryGrowth = "-sALLOW_MEMORY_GROWTH=1";
      testsCrossFile = pkgsBuildBuild.writeText "glib-tests-cross.ini" ''
        [binaries]
        exe_wrapper = ['${nodeToFiles}']
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
        # they only ever write fresh outputs here, which WasmFS handles. They
        # also get the tests' fixed memory in place of growth. If the C and
        # C++ link arguments stop naming either setting, evaluation fails
        # instead of the tests quietly keeping it.
        mesonFlags =
          assert lib.count (lib.hasInfix nodeRawFs) old.mesonFlags == 2;
          assert lib.count (lib.hasInfix memoryGrowth) old.mesonFlags == 2;
          map (lib.replaceStrings
            [ nodeRawFs memoryGrowth ]
            [ toolchain.nodeHostFsFlags toolchain.testMemoryFlags ]
          ) old.mesonFlags
          ++ [ "-Dtests=true" ];
        # After the toolchain's cross file, whose exe_wrapper this replaces.
        preConfigure = (old.preConfigure or "") + ''
          mesonFlagsArray+=("--cross-file=${testsCrossFile}")
        '';
        # The tests of GLib's tools run them under Node themselves.
        nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
          pkgsWasm.python3
          pkgsWasm.nodejs
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
