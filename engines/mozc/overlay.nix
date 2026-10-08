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

              # Data the dictionary build reads, so the build machine's copy.
              inherit (final.buildPackages) jp-zip-codes;

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
                    ];

                    bazelTargets = [
                      "//data_manager/oss:mozc_dataset_for_oss"
                      "//session:session_handler"
                      "//engine:engine_factory"
                      "//client:client"
                      "//ibus_web_converter_check:converter.js"
                    ];

                    buildAttrs = args.buildAttrs // {
                      installPhase = ''
                        runHook preInstall
                        install -Dm444 bazel-bin/data_manager/oss/mozc.data -t $out/share/mozc
                        install -Dm444 bazel-bin/ibus_web_converter_check/converter.js -t $check
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

                # The converter check's program, kept out of the package.
                outputs = [
                  "out"
                  "check"
                ];

                patches = (old.patches or [ ]) ++ patchesIn ./patches/port;

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
                    --replace-fail @strip@ "$(command -v $STRIP)"
                  substitute ${./bazel/cc} src/ibus_web_toolchain/cc \
                    --replace-fail @shell@ "${final.buildPackages.runtimeShell}" \
                    --replace-fail @cc@ "$(command -v $CC)" \
                    --replace-fail @cxx@ "$(command -v $CXX)"
                  chmod +x src/ibus_web_toolchain/cc

                  cp -r --no-preserve=mode ${./in_process} src/ibus_web_in_process

                  mkdir src/ibus_web_converter_check
                  cp ${./checks/converter/converter.cc} src/ibus_web_converter_check/converter.cc
                  substitute ${./checks/converter/BUILD.bazel} src/ibus_web_converter_check/BUILD.bazel \
                    --replace-fail @testMemoryFlags@ "${config.ibusWeb.toolchain.testMemoryFlags}"
                '';

                # Bazel builds protoc and the dictionary generators for the build
                # machine, configuring its host toolchain from $CC.
                depsBuildBuild = (old.depsBuildBuild or [ ]) ++ [ final.buildPackages.stdenv.cc ];

                preBuild = (old.preBuild or "") + ''
                  export CC=$CC_FOR_BUILD
                  bazelFlagsArray+=("--sandbox_writable_path=$EM_CACHE")

                  # Mozc's pkg_config_repository runs `pkg-config` by that name.
                  mkdir -p "$NIX_BUILD_TOP/pkg-config-bin"
                  ln -sf "$(command -v "$PKG_CONFIG")" "$NIX_BUILD_TOP/pkg-config-bin/pkg-config"
                  export PATH="$NIX_BUILD_TOP/pkg-config-bin:$PATH"
                '';
              });
        }
      )
    );
}
