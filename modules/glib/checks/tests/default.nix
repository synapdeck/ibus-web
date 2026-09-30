# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb) toolchain;
      inherit (toolchain) pkgsWasm;
      inherit (pkgsWasm) pkgsBuildBuild;

      # Node makes its stdout non-blocking once a program starts its thread
      # pool, and a write that meets a full pipe fails with EAGAIN instead of
      # waiting, so a test writing faster than Meson reads loses TAP lines.
      # Files never fill up; the wrapper replays them once the test exits,
      # or when Meson's timeout sends SIGTERM, so a timed-out test still
      # shows how far it got. Node runs in the background because bash
      # only handles a signal once its foreground child has exited; without
      # the explicit redirection a background job reads /dev/null. A test
      # killed by a signal is reported the same way, by the wrapper dying of
      # it too, so Meson doesn't take it for an exit status. TMPDIR names a
      # directory the host doesn't have, which the tests' file system then
      # keeps in memory, as the browser keeps temporary files.
      nodeToFiles = pkgsBuildBuild.writeShellScript "node-to-files" ''
        dir=$(mktemp -d)
        replay() {
          cat "$dir/stdout"
          cat "$dir/stderr" >&2
          rm -r "$dir"
        }
        die() {
          trap - "$1"
          kill -s "$1" $$
        }
        trap 'replay; die TERM' TERM
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
        # they only ever write fresh outputs here, which WasmFS handles. If the C and C++ link
        # arguments stop naming the latter, evaluation fails instead of the
        # tests quietly staying on it.
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
            python3 ${./gate.py} "$1" meson-info/intro-tests.json default-tests \
              excluded-suites ${./baseline.toml} "''${@:2}"
          }
          # Invocations come on fd 3, since tests inherit stdin and may read
          # it; Meson's report goes to stderr, stdout carries the joined log.
          runTests() {
            local base=$1 jobs=$2 n=0 selection
            while read -r -a selection <&3; do
              meson test --no-rebuild --print-errorlogs --timeout-multiplier 4 \
                --num-processes "$jobs" --logbase "$base-$n" "''${selection[@]}" >&2 || true
              n=$((n + 1))
            done 3< "$3"
            cat meson-logs/"$base"-*.json 2> /dev/null || true
          }
          mkdir -p $out
          meson test --no-rebuild --list > default-tests
          meson runpython ${./setup-excludes.py} > excluded-suites
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
      # whose tests collide in the ways GLib's could.
      checks.glib-tests-gate =
        pkgsWasm.buildPackages.runCommand "ibus-web-glib-tests-gate"
          {
            nativeBuildInputs = [
              pkgsWasm.meson
              pkgsWasm.ninja
              pkgsWasm.python3
            ];
          }
          ''
            python3 ${./gate-test.py} ${./gate.py} ${./setup-excludes.py} | tee $out
          '';
    };
}
