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
      # The trace tooling with its dependencies alone, so editing another
      # source reruns no trace check.
      tools = typescript.workspaceFor [ "tools/ibus-test" ];
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
          config.ibusWeb.engines.jsonGlib
        ];
        cflags = "$($PKG_CONFIG --cflags libibus-web json-glib-1.0)";
        libs = "$($PKG_CONFIG --static --libs libibus-web json-glib-1.0)";
        format = null;
        gtest = false;
        linkFlags = config.ibusWeb.lib.testLinkFlagsWithoutNodeFs;
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
      # A session bus of the test's own, which admits anyone on it.
      sessionBusConfig = pkgs.writeText "ibus-web-ibus-test-session-bus.conf" ''
        <busconfig>
          <type>session</type>
          <listen>unix:tmpdir=/tmp</listen>
          <auth>EXTERNAL</auth>
          <policy context="default">
            <allow own="*"/>
            <allow send_destination="*"/>
            <allow receive_sender="*"/>
          </policy>
        </busconfig>
      '';
      # A native IBus session around one engine, as ibusTest's nativeConfig.
      nativeIbusConfig =
        {
          name,
          engine,
          destination,
          env ? { },
        }:
        pkgs.writeText "ibus-web-${name}-native-session.json" (
          builtins.toJSON {
            sessionBus = [
              "${pkgs.dbus}/bin/dbus-daemon"
              "--config-file=${sessionBusConfig}"
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
            adapter = [ "${native}/bin/ibus-test-native" ];
            gdbus = [ "${pkgs.glib.bin}/bin/gdbus" ];
            gsettings = [ "${pkgs.glib.bin}/bin/gsettings" ];
            factory = "/org/freedesktop/IBus/Factory";
            timeoutMs = 5000;
            inherit engine destination env;
          }
        );
      fixtureConfig = nativeIbusConfig {
        name = "ibus-test-conformance";
        engine = [ "${fixtureNative}/bin/conformance-engine" ];
        destination = "org.example.IBusConformance";
        env.GSETTINGS_SCHEMA_DIR = "${fixtureData}/glib-2.0/schemas";
      };
      ibusTest =
        {
          name,
          nativeConfig,
          module,
          settingsSchemaDir,
          traces,
          expectedDifferences ? null,
          coverage ? null,
          versions ? { },
          testEnvironment ? { },
        }:
        assert pkgs.stdenv.hostPlatform.isLinux;
        assert traces != [ ];
        let
          manifest = pkgs.writeText "${name}-manifest.json" (
            builtins.toJSON {
              inherit
                nativeConfig
                traces
                expectedDifferences
                coverage
                versions
                ;
              traceNames = map (trace: lib.removeSuffix ".json" (builtins.baseNameOf trace)) traces;
              wasmCommand = [
                "${typescript.nodejs}/bin/node"
                "${wasm}/ibus-test-wasm.js"
                "--schemas"
                settingsSchemaDir
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
                  cd ${tools}/tools/ibus-test
                  timeout --kill-after=10 ${
                    toString (90 + 15 * builtins.length traces)
                  } node node_modules/vitest/vitest.mjs run \
                    --configLoader native --reporter=default --reporter=json \
                    --outputFile.json=$out/results.json conformance.test.ts
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
        clangdPathFlags."tools/ibus-test/wasm/.*" = [
          "-I${config.ibusWeb.engines.jsonGlib}/include/json-glib-1.0"
        ];
        clangdFragments = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ nativeClangd ];
        clangdQueryDrivers = lib.optionals pkgs.stdenv.hostPlatform.isLinux [ "${pkgs.stdenv.cc}/bin/cc" ];
      };
      ibusWeb.engines.ibusTest = ibusTest;
      ibusWeb.lib.nativeIbusConfig = nativeIbusConfig;
      packages = {
        ibus-test-wasm = wasm;
      }
      // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux { ibus-test-native = native; };
      checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-test-native = native;
        ibus-test-conformance = (
          ibusTest {
            name = "ibus-test-conformance";
            nativeConfig = fixtureConfig;
            module = "${fixtureModule}/conformance.wasm";
            settingsSchemaDir = "${fixtureData}/glib-2.0/schemas";
            traces = [ ../../tools/ibus-test/fixtures/lifecycle.json ];
            testEnvironment.IBUS_TEST_FIXTURE = "1";
          }
        );
      };
    };
}
