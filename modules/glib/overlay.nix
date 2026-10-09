# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  config,
  lib,
  withSystem,
  ...
}:
{
  flake.overlays.glib =
    final: prev:
    let
      inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
    in
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) {
      glib = prev.glib.overrideAttrs (
        old:
        let
          # Built for the host they'd be for a native GLib, these have no use
          # in the browser; Emscripten's musl provides iconv and gettext.
          unwanted = [
            "bash-interactive"
            "gnum4"
            "libsysprof-capture"
            "gettext"
            "libiconv"
          ];
          # The lists also hold GLib's setup hook, a path with no name.
          depName = d: if lib.isDerivation d then lib.getName d else null;
          # Each name must be there to remove, so a rename upstream fails
          # evaluation instead of letting the input back in.
          inputNames = map depName ((old.buildInputs or [ ]) ++ (old.propagatedBuildInputs or [ ]));
          keep =
            assert lib.all (name: lib.elem name inputNames) unwanted;
            lib.filter (d: !(lib.elem (depName d) unwanted));
          # GLib's executables (its tools, and its tests when enabled) only
          # ever run under Node, so they get a real filesystem and threads
          # that start without returning to the event loop. Static
          # libraries don't see link arguments. Emscripten's default 64 KiB
          # stack is too small for the regex test, which needs between 448
          # and 480 KiB; 1 MiB leaves it room. Links inherit the wrapper's
          # -O2, which turns Emscripten's runtime assertions off; tests and
          # tools keep them.
          nodeLinkArgs = "-sNODERAWFS=1 -sEXIT_RUNTIME=1 -sPTHREAD_POOL_SIZE=8 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sASSERTIONS=1";
          # Edits to nixpkgs' scripts must find what they edit, so a change
          # upstream fails evaluation instead of silently doing nothing.
          replaceIn =
            from: to: script:
            assert lib.all (pattern: lib.hasInfix pattern script) from;
            lib.replaceStrings from to script;
          # The tools are named after the program with Emscripten's .js
          # suffix, and nixpkgs files their completions and man pages by
          # program name.
          programName = replaceIn [ "\${i##*/}" ] [ "$(basename \"$i\" .js)" ];
          inherit (final) pkgsBuildBuild;

          # Emscripten writes the wrapped tools for the workspace's Node, which
          # its minimum version comes from.
          node = withSystem prev.stdenv.buildPlatform.system (
            { config, ... }: lib.getExe config.ibusWeb.typescript.nodejs
          );
          buildPkgConfig = lib.getExe' pkgsBuildBuild.pkg-config-unwrapped "pkg-config";
        in
        {
          patches = (old.patches or [ ]) ++ patchesIn ./patches;
          # With documentation off nothing lands in devdoc, and Nix fails a
          # build that leaves an output unwritten.
          outputs = lib.remove "devdoc" old.outputs;
          # The .pc files name each tool without its suffix, and consumers
          # run what they name on the build machine, so every tool gets a
          # wrapper under its plain name that runs it with the build
          # machine's Node.
          postInstall = programName old.postInstall + ''
            for js in $bin/bin/*.js $dev/bin/*.js; do
              if [ -e "''${js%.js}.wasm" ]; then
                makeWrapper ${node} "''${js%.js}" --add-flag "$js"
              fi
            done
          '';
          # The makeWrapper this cross set splices in writes the host's
          # shell, a WebAssembly bash, into the wrappers' interpreter line.
          nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgsBuildBuild.makeWrapper ];
          # Runs in every build that depends on this GLib, never in its own.
          # The build fills in @dev@; with structured attributes it sees only
          # exported variables, so the rest are filled in here.
          setupHooks = (old.setupHooks or [ ]) ++ [
            (pkgsBuildBuild.replaceVars ./glib-tools-hook.sh {
              dev = null;
              inherit buildPkgConfig;
              buildGlibPkgConfigPath = "${pkgsBuildBuild.glib.dev}/lib/pkgconfig";
            })
          ];
          # The .pc files' tool variables (the values under a bin
          # directory) go into a cross file the setup hook hands Meson,
          # whose gnome module takes a tool from the host machine's cross
          # files before the build machine's GLib. A variable that names a
          # missing program would hand consumers a dead path, so each one
          # is checked once every output is final. Meson rejects a cross
          # file that repeats a key, and would do so in every consumer, so
          # a tool two .pc files both name fails here instead.
          postFixup =
            programName (replaceIn [ "moveToOutput \"share/doc\" \"$devdoc\"" ] [ "" ] old.postFixup)
            + ''
              pcQuery() {
                PKG_CONFIG_PATH=$dev/lib/pkgconfig ${buildPkgConfig} "$@"
              }
              ini=$dev/nix-support/glib-tools-cross.ini
              mkdir -p $dev/nix-support
              echo "[binaries]" > $ini
              declare -A toolModule=()
              for pc in $dev/lib/pkgconfig/*.pc; do
                module=$(basename "$pc" .pc)
                variables=$(pcQuery --print-variables "$module")
                for variable in $variables; do
                  value=$(pcQuery --variable="$variable" "$module")
                  if [[ $value == */bin/* ]]; then
                    if [[ ! -x $value ]]; then
                      echo "$module.pc: $variable names $value, which is not installed" >&2
                      exit 1
                    fi
                    key=''${variable//_/-}
                    if [[ -v toolModule[$key] ]]; then
                      echo "$module.pc and ''${toolModule[$key]}.pc both name a $key tool" >&2
                      exit 1
                    fi
                    toolModule[$key]=$module
                    echo "$key = '$value'" >> $ini
                  fi
                done
              done
            '';
          buildInputs = keep (old.buildInputs or [ ]);
          propagatedBuildInputs = keep (old.propagatedBuildInputs or [ ]);
          mesonFlags = (old.mesonFlags or [ ]) ++ [
            "-Dnls=disabled"
            "-Dsysprof=disabled"
            "-Ddocumentation=false"
            "-Dtests=false"
            # Emscripten's libc has no getxattr, and GLib refuses to configure
            # with xattr support it can't find.
            "-Dxattr=false"
            "-Dc_link_args=${nodeLinkArgs}"
            "-Dcpp_link_args=${nodeLinkArgs}"
          ];
        }
      );
    };
}
