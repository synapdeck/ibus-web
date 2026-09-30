# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
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
      # it too, so Meson doesn't take it for an exit status.
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
        ${lib.getExe pkgsBuildBuild.nodejs} "$@" <&0 > "$dir/stdout" 2> "$dir/stderr" &
        wait $!
        status=$?
        replay
        if [ "$status" -gt 128 ] && sig=$(kill -l "$status" 2> /dev/null); then
          die "$sig"
        fi
        exit $status
      '';
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
        mesonFlags = (old.mesonFlags or [ ]) ++ [ "-Dtests=true" ];
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
        # The pkg-config tests point PKG_CONFIG_PATH at the build tree, which
        # nixpkgs' pkg-config wrapper replaces with its role's search path;
        # the unwrapped pkg-config honours it.
        installPhase = ''
          runHook preInstall
          PATH=${pkgsWasm.pkgsBuildBuild.pkg-config-unwrapped}/bin:$PATH \
            meson test --no-rebuild --print-errorlogs --timeout-multiplier 4 \
            --num-processes $NIX_BUILD_CORES || true
          mkdir -p $out
          cp meson-logs/testlog.json $out/
          python3 ${./gate.py} $out/testlog.json ${./baseline.toml} $out
          runHook postInstall
        '';
        postInstall = "";
        preFixup = "";
        postFixup = "";
      });
    };
}
