# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: BSD-3-Clause
{
  config,
  lib,
  withSystem,
  ...
}:
let
  inherit (config.ibusWeb.lib) isEmscriptenWasm patchesIn;
in
{
  flake.overlays.mozc =
    final: prev:
    lib.optionalAttrs (isEmscriptenWasm prev.stdenv.hostPlatform) (
      withSystem prev.stdenv.buildPlatform.system (
        { config, ... }:
        let
          inherit (config.ibusWeb) toolchain;

          # Mozc's own settings, and the panel's, which it reads its candidate
          # orientation from.
          schemas = prev.runCommand "ibus-web-mozc-gsettings-schemas" { } ''
            mkdir -p $out/share/glib-2.0/schemas
            cp ${./org.freedesktop.ibus.engine.mozc.gschema.xml} $out/share/glib-2.0/schemas/org.freedesktop.ibus.engine.mozc.gschema.xml
            cp ${final.libibus-web}/share/gsettings-schemas/${final.libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
              $out/share/glib-2.0/schemas/
            ${final.glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
          '';
          settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";

          # The machine Bazel runs the cross tools on, as @platforms names it.
          bazelCpu = if final.stdenv.buildPlatform.isAarch64 then "aarch64" else "x86_64";
          bazelOs = if final.stdenv.buildPlatform.isDarwin then "osx" else "linux";
        in
        {
          mozc =
            (prev.mozc.override {
              # Bazel and the tools it runs belong to the build machine.
              # buildPackages' Bazel targets WebAssembly, which pulls a
              # WebAssembly shell into Bazel itself.
              bazel_7 = final.pkgsBuildBuild.bazel_7;
              qt6 = {
                wrapQtAppsHook = null;
                qtbase = null;
              };

              # The browser launcher's path is compiled in, but nothing in a Worker
              # can start a process; this keeps the store path out of the module.
              xdg-utils = "/usr";

              # Data the dictionary build reads and the tool that merges the UT
              # dictionaries, so the build machine's.
              inherit (final.buildPackages) jp-zip-codes merge-ut-dictionaries;

              # In a browser Mozc only ever runs as an IBus engine.
              withIbus = true;
              ibus = final.libibus-web;

              buildBazelPackage =
                args:
                final.buildBazelPackage (
                  args
                  // {
                    # Bazel's platforms have no Emscripten OS; nixpkgs' wasm32-unknown-none
                    # names the same pair.
                    bazelFlags = [
                      "--config=oss_wasm"
                      "--compilation_mode=opt"
                      "--force_pic"
                      "--platforms=//ibus_web_toolchain:wasm"
                      "--cpu=wasm32"
                      "--extra_toolchains=//ibus_web_toolchain:cc-toolchain-wasm"
                      "--action_env=EM_CACHE"
                      "--action_env=HOME"

                      # Abseil's Emscripten stack traces and symbolizer call
                      # Emscripten's JavaScript, which a side module can't
                      # import; its standalone builds use neither.
                      "--per_file_copt=external/com_google_absl/absl/debugging/.*@-DSTANDALONE_WASM"
                    ]
                    # apple_support registers an Xcode toolchain for the build
                    # machine's tools, which needs an SDK the sandbox doesn't
                    # have; Bazel's own then configures one from $CC, archiving
                    # with Apple's libtool.
                    ++ lib.optionals final.stdenv.buildPlatform.isDarwin [
                      "--repo_env=BAZEL_NO_APPLE_CPP_TOOLCHAIN=1"
                      "--repo_env=LIBTOOL=${final.pkgsBuildBuild.cctools.libtool}/bin/libtool"
                    ];

                    bazelTargets = [
                      "//data_manager/oss:mozc_dataset_for_oss"
                      "//session:session_handler"
                      "//engine:engine_factory"
                      "//client:client"
                      "//ibus_web_module:mozc.wasm"
                      "//ibus_web_converter_check:converter.js"
                    ];

                    buildAttrs = args.buildAttrs // {
                      installPhase = ''
                        runHook preInstall
                        install -Dm444 bazel-bin/ibus_web_module/mozc.wasm -t $out
                        install -Dm444 bazel-bin/data_manager/oss/mozc.data -t $data/share/mozc
                        install -Dm444 bazel-bin/ibus_web_converter_check/converter.js -t $check

                        # The cast audit's reports that found something, and the
                        # sources they name. Clang names a source by its real path,
                        # under the source tree or an action's execroot; both are
                        # made relative, which the execroot resolves either way.
                        mkdir -p $casts/reports $casts/src
                        execroot=$(find "$bazelOut/execroot" -mindepth 1 -maxdepth 1 -type d)
                        for report in "$NIX_BUILD_TOP"/casts/*.sarif; do
                          name=$(basename "$report")
                          grep -m1 '^{' "$report" \
                            | sed -e "s|\"uri\":\"file://$PWD/|\"uri\":\"|g" \
                              -e 's|"uri":"file://[^"]*/execroot/[^/"]*/|"uri":"|g' > "$name"
                          files=$(jq -r '.runs[] | .artifacts as $artifacts | .results[]?.locations[]?.physicalLocation.artifactLocation
                            | ($artifacts[.index // -1].location.uri // .uri) // empty' "$name" | sort -u)
                          if [ -n "$files" ]; then
                            cp "$name" $casts/reports/
                          fi
                          for file in $files; do
                            case "$file" in
                              file://*) ;;
                              *) install -Dm444 "$execroot/$file" "$casts/src/$file" ;;
                            esac
                          done
                          rm "$name"
                        done
                        runHook postInstall
                      '';
                    };
                  }
                );
            }).overrideAttrs
              (old: {
                # The dependency fetch is the native recipe's: the WebAssembly
                # build needs no external repository the native one lacks.
                deps = final.pkgsBuildBuild.mozc.deps;

                # The side module alone in out, so that its store references are
                # its data closure; the converter check's program and the cast
                # audit's reports kept apart.
                outputs = [
                  "out"
                  "data"
                  "check"
                  "casts"
                ];

                patches = (old.patches or [ ]) ++ patchesIn ./patches/port;

                # The static stdenv propagates every build input, which would put
                # the runtime's library, and everything it references, in the
                # module's closure.
                buildInputs = [ final.libibus-web ];
                propagatedBuildInputs = [ ];

                # The toolchain package names the cross tools by store path and
                # the build's Emscripten cache, which Bazel's sandbox can't see
                # through the stdenv's environment.
                postPatch = (old.postPatch or "") + ''
                  mkdir src/ibus_web_toolchain
                  substitute ${./bazel/BUILD.bazel} src/ibus_web_toolchain/BUILD.bazel \
                    --replace-fail @emCache@ "$EM_CACHE" \
                    --replace-fail @ar@ "$(command -v $AR)" \
                    --replace-fail @ld@ "$(command -v $LD)" \
                    --replace-fail @nm@ "$(command -v $NM)" \
                    --replace-fail @objcopy@ "$(command -v $OBJCOPY)" \
                    --replace-fail @objdump@ "$(command -v $OBJDUMP)" \
                    --replace-fail @strip@ "$(command -v $STRIP)" \
                    --replace-fail @execCpu@ ${bazelCpu} \
                    --replace-fail @execOs@ ${bazelOs}
                  substitute ${./bazel/cc} src/ibus_web_toolchain/cc \
                    --replace-fail @shell@ "${final.buildPackages.runtimeShell}" \
                    --replace-fail @cc@ "$(command -v $CC)" \
                    --replace-fail @cxx@ "$(command -v $CXX)" \
                    --replace-fail @castReports@ "$NIX_BUILD_TOP/casts"
                  chmod +x src/ibus_web_toolchain/cc

                  cp -r --no-preserve=mode ${./in_process} src/ibus_web_in_process

                  mkdir src/ibus_web_module
                  cp ${./module/settings.h} src/ibus_web_module/settings.h
                  cp ${./module/settings.cc} src/ibus_web_module/settings.cc
                  substitute ${./module/module.cc} src/ibus_web_module/module.cc \
                    --replace-fail @dataFile@ "$data/share/mozc/mozc.data" \
                    --replace-fail @settingsSchemaDir@ ${settingsSchemaDir}
                  substitute ${./module/BUILD.bazel} src/ibus_web_module/BUILD.bazel \
                    --replace-fail @libibusWebCflags@ "$($PKG_CONFIG --cflags-only-I libibus-web)" \
                    --replace-fail @sideModuleFlags@ "${toolchain.sideModuleFlags}"

                  mkdir src/ibus_web_converter_check
                  cp ${./checks/converter/converter.cc} src/ibus_web_converter_check/converter.cc
                  substitute ${./checks/converter/BUILD.bazel} src/ibus_web_converter_check/BUILD.bazel \
                    --replace-fail @testMemoryFlags@ "${toolchain.testMemoryFlags}"
                '';

                # Bazel builds protoc and the dictionary generators for the build
                # machine, configuring its host toolchain from $CC.
                depsBuildBuild = (old.depsBuildBuild or [ ]) ++ [ final.buildPackages.stdenv.cc ];

                nativeBuildInputs = old.nativeBuildInputs ++ [ final.buildPackages.jq ];

                preBuild = (old.preBuild or "") + ''
                  export CC=$CC_FOR_BUILD
                  bazelFlagsArray+=("--sandbox_writable_path=$EM_CACHE")

                  mkdir "$NIX_BUILD_TOP/casts"
                  bazelFlagsArray+=("--sandbox_writable_path=$NIX_BUILD_TOP/casts")

                  mkdir -p "$NIX_BUILD_TOP/pkg-config-bin"
                  substitute ${./bazel/pkg-config} "$NIX_BUILD_TOP/pkg-config-bin/pkg-config" \
                    --replace-fail @shell@ "${final.buildPackages.runtimeShell}" \
                    --replace-fail @pkgConfig@ "$(command -v "$PKG_CONFIG")"
                  chmod +x "$NIX_BUILD_TOP/pkg-config-bin/pkg-config"
                  export PATH="$NIX_BUILD_TOP/pkg-config-bin:$PATH"
                '';

                # What the side module and its data set carry, from Mozc's own
                # credits: Mozc, Protocol Buffers and the usage dictionary, Abseil,
                # IPAdic, the Tamachi phonetic alphabet and Unicode's JIS tables.
                # The Okinawa dictionary and Japan Post's zip codes are in the
                # public domain, which has no SPDX identifier.
                meta = old.meta // {
                  license = with lib.licenses; [
                    bsd3
                    asl20
                    naist-2003
                    mit
                    unicode-dfs-2015
                  ];
                };

                passthru = (old.passthru or { }) // {
                  inherit schemas settingsSchemaDir;
                };
              });

          # Mozc with nixpkgs' UT dictionaries merged into its own. They are
          # data the build reads, so the build machine's; their names are
          # mozc-ut's own arguments.
          mozc-ut =
            let
              dictionaries = lib.filterAttrs (name: _: lib.hasPrefix "mozcdic-ut-" name) (
                lib.functionArgs prev.mozc-ut.override
              );
              chosen = lib.mapAttrs (name: _: final.buildPackages.${name}) dictionaries;
            in
            (prev.mozc-ut.override chosen).overrideAttrs (old: {
              meta = old.meta // {
                license = lib.unique (
                  old.meta.license
                  ++ lib.concatMap (dictionary: lib.toList dictionary.meta.license) (lib.attrValues chosen)
                );
              };

              passthru = old.passthru // {
                dictionaries = chosen;
              };
            });
        }
      )
    );
}
