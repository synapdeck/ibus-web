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
      inherit (config.ibusWeb)
        testing
        typescript
        toolchain
        runtime
        ;
      toolsSource = lib.fileset.toSource {
        root = ../..;
        fileset = lib.fileset.unions [
          ../../tools/package.json
          ../../tools/vitest.config.ts
          ../../tools/tsconfig.json
          ../../tools/ibus-test
          ../../tsconfig.base.json
          ../../tsconfig.node-scripts.json
        ];
      };
      testTools = pkgs.runCommand "ibus-web-ibus-test-tools" { } ''
        cp -R ${toolsSource} $out
        chmod u+w $out/tools
        ln -s ${typescript.packageNodeModules ../../tools} $out/tools/node_modules
      '';
      native = pkgs.stdenv.mkDerivation {
        pname = "ibus-test-native";
        version = "0.1.0";
        src = ../../tools/ibus-test/native;
        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          pkgs.pkg-config
        ];
        buildInputs = [
          pkgs.glib
          pkgs.json-glib
          pkgs.ibus
        ];
        nativeCheckInputs = [ pkgs.dbus ];
        doCheck = true;
        # nixpkgs otherwise disables Meson's own timeout globally.
        mesonCheckFlags = [ "--timeout-multiplier=1" ];
      };
      # Test-only cross build; production runtime dependencies remain unchanged.
      wasmJson = toolchain.pkgsWasm.stdenv.mkDerivation {
        pname = "ibus-test-json-glib";
        inherit (pkgs.json-glib) version src;
        nativeBuildInputs = [
          pkgs.meson
          pkgs.ninja
          toolchain.pkgsWasm.pkg-config
        ];
        buildInputs = [ toolchain.pkgsWasm.glib ];
        mesonFlags = [
          "-Dintrospection=disabled"
          "-Ddocumentation=disabled"
          "-Dtests=false"
          "-Dinstalled_tests=false"
          "-Dnls=disabled"
        ];
      };
      wasm = testing.program {
        name = "ibus-test-wasm";
        src = ../../tools/ibus-test;
        sources = [
          "wasm/main.c"
          "wasm/driver.c"
          "native/values.c"
        ];
        nativeBuildInputs = [ toolchain.pkgsWasm.pkg-config ];
        buildInputs = [
          runtime.libibusWeb
          wasmJson
        ];
        cflags = "$($PKG_CONFIG --cflags libibus-web json-glib-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web json-glib-1.0)";
        format = null;
        gtest = false;
        linkFlags = [
          toolchain.commonFlags
        ]
        ++ lib.filter (flag: !(lib.hasSuffix "/node-host-fs.o" flag)) toolchain.testMainFlagList;
      };
      fixtureModule =
        (runtime.mkSideModule {
          name = "conformance";
          src = ../../tools/ibus-test/fixtures;
          sources = [
            "engine.c"
            "module.c"
          ];
        }).overrideAttrs
          {
            NIX_CFLAGS_COMPILE = "-I${runtime.libibusWeb}/include/ibus-1.0";
          };
      fixtureNative = pkgs.stdenv.mkDerivation {
        name = "ibus-test-conformance-engine";
        src = ../../tools/ibus-test/fixtures;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.ibus ];
        buildPhase = ''
          $CC -Wall -Wextra -Werror $(pkg-config --cflags ibus-1.0) \
            engine.c native.c $(pkg-config --libs ibus-1.0) -o conformance-engine
        '';
        installPhase = ''
          install -Dm755 conformance-engine $out/bin/conformance-engine
        '';
      };
      fixtureData =
        pkgs.runCommand "ibus-test-conformance-data"
          {
            nativeBuildInputs = [ pkgs.glib ];
          }
          ''
            mkdir -p $out/glib-2.0/schemas
            cp ${../../tools/ibus-test/fixtures/org.example.IBusConformance.gschema.xml} $out/glib-2.0/schemas/
            glib-compile-schemas $out/glib-2.0/schemas
          '';
      fixtureBus = pkgs.writeText "ibus-test-conformance-bus.conf" ''
        <busconfig>
          <type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth>
          <policy context="default">
            <allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/>
          </policy>
        </busconfig>
      '';
      fixtureConfig = pkgs.writeText "ibus-test-conformance-config.json" (
        builtins.toJSON {
          sessionBus = [
            "${pkgs.dbus}/bin/dbus-daemon"
            "--config-file=${fixtureBus}"
          ];
          daemon = [
            "${pkgs.ibus}/bin/ibus-daemon"
            "--single"
            "--emoji-extension=disable"
          ];
          daemonDestination = "org.freedesktop.IBus";
          configService = {
            command = [ "${pkgs.ibus}/libexec/ibus-dconf" ];
            destination = "org.freedesktop.IBus.Config";
          };
          engine = [ "${fixtureNative}/bin/conformance-engine" ];
          adapter = [ "${native}/bin/ibus-test-native" ];
          gdbus = [ "${pkgs.glib.bin}/bin/gdbus" ];
          gsettings = [ "${pkgs.glib.bin}/bin/gsettings" ];
          destination = "org.example.IBusConformance";
          factory = "/org/freedesktop/IBus/Factory";
          env.GSETTINGS_SCHEMA_DIR = "${fixtureData}/glib-2.0/schemas";
          timeoutMs = 5000;
        }
      );
      ibusTest =
        {
          name,
          nativeConfig,
          module,
          data,
          traces,
          testEnvironment ? { },
        }:
        assert pkgs.stdenv.hostPlatform.isLinux;
        assert traces != [ ];
        let
          manifest = pkgs.writeText "${name}-manifest.json" (
            builtins.toJSON {
              inherit nativeConfig traces;
              wasmCommand = [
                "${typescript.nodejs}/bin/node"
                "${wasm}/ibus-test-wasm.js"
                "--data"
                data
                "--module"
                module
              ];
            }
          );
          # Materialize failed runs too, so the verdict cannot discard diagnostics.
          results =
            pkgs.runCommand "ibus-web-${name}-results"
              (
                {
                  nativeBuildInputs = [ typescript.nodejs ];
                  IBUS_TEST_CONFORMANCE = manifest;
                  CI = "1";
                }
                // testEnvironment
              )
              ''
                mkdir -p $out/artifacts
                export IBUS_TEST_ARTIFACTS=$out/artifacts
                export IBUS_WEB_TEST_CACHE_DIR=$TMPDIR/vite
                export XDG_DATA_HOME=$TMPDIR/vitest-data
                status=0
                (
                  cd ${testTools}/tools
                  timeout --kill-after=10 ${
                    toString (90 + 15 * builtins.length traces)
                  } node node_modules/vitest/vitest.mjs run \
                    --configLoader native --reporter=default --reporter=json \
                    --outputFile.json=$out/results.json ibus-test/conformance.test.ts
                ) > $out/output.txt 2>&1 || status=$?
                cat $out/output.txt
                printf '%s\n' "$status" > $out/status
              '';
          verdict =
            output:
            pkgs.runCommand "ibus-web-${name}"
              {
                nativeBuildInputs = [ typescript.nodejs ];
                passthru.results = output;
              }
              ''
                status=$(cat ${output}/status)
                if [ "$status" != 0 ]; then
                  echo "Trace check failed (status $status); retained results: ${output}" >&2
                  cat ${output}/output.txt >&2
                  exit 1
                fi
                node --input-type=module - ${output}/results.json <<'JS'
                import { readFileSync } from 'node:fs';
                const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
                if (result.success !== true || result.numFailedTests !== 0 || result.numPassedTests < 1) {
                  throw new Error('Trace check has no successful test report');
                }
                JS
                ln -s ${output} $out
              '';
        in
        verdict results;
      nativeClangd =
        pkgs.runCommand "ibus-test-native-clangd"
          {
            inherit (native) buildInputs;
            nativeBuildInputs = [ pkgs.pkg-config ];
          }
          ''
            {
              echo 'If:'
              echo '  PathMatch: tools/ibus-test/(native/.*|fixtures/native\.c)'
              echo 'CompileFlags:'
              echo '  Compiler: ${pkgs.stdenv.cc}/bin/cc'
              echo '  Remove: [-isystem, -fwasm-exceptions, -mextended-const]'
              echo '  Add:'
              for flag in $(pkg-config --cflags gio-2.0 json-glib-1.0 ibus-1.0); do
                echo "    - $flag"
              done
            } > $out
          '';
    in
    {
      ibusWeb.toolchain = {
        clangdPathFlags."tools/ibus-test/wasm/.*" = [ "-I${wasmJson}/include/json-glib-1.0" ];
        clangdFragments = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ nativeClangd ];
        clangdQueryDrivers = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ "${pkgs.stdenv.cc}/bin/cc" ];
      };
      ibusWeb.engines.ibusTest = ibusTest;
      packages = {
        ibus-test-wasm = wasm;
        ibus-test-tools = testTools;
      }
      // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux { ibus-test-native = native; };
      checks = {
        engines-ibus-test-script = testing.vitestCheck {
          name = "engines-ibus-test-script";
          packageDir = "${testTools}/tools";
          env = { };
          inBrowsers = false;
          limit = 60;
          vitestArgs = [ "ibus-test" ];
        };
      }
      // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-test-native = native;
        ibus-test-conformance = (
          ibusTest {
            name = "ibus-test-conformance";
            nativeConfig = fixtureConfig;
            module = "${fixtureModule}/conformance.wasm";
            data = "${fixtureData}";
            traces = [ ../../tools/ibus-test/fixtures/lifecycle.json ];
            testEnvironment.IBUS_TEST_FIXTURE = "1";
          }
        );
      };
    };
}
