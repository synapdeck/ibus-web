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
        runtime
        engines
        testing
        toolchain
        typescript
        ;
      inherit (toolchain) pkgsWasm;

      sidesSrc = ./test/sides;
      engineThreads = 4;

      # The test side modules the host's tests load together; their opcodes
      # are unique across them.
      sides =
        map
          (
            source:
            runtime.mkSideModule {
              name = lib.removeSuffix ".c" (lib.removeSuffix ".cpp" source);
              src = sidesSrc;
              sources = [ source ];
            }
          )
          [
            "trivial.c"
            "settings.c"
            "thread.c"
            "throw.cpp"
            "proxy.c"
            "timer.c"
            "memstress.c"
            "fsync.c"
            "bench.c"
            "tree.c"
          ];

      # The echo engine's data holds what store paths can: a file with two
      # names, links relative and absolute, to a file and a directory, into
      # its own store path and into others it references, one of them a
      # store path that is a single file.
      linkTarget = pkgs.runCommand "echo-link-target" { } ''
        mkdir -p $out/share
        printf 'echo link target\n' > $out/share/target.txt
      '';
      singleFile = pkgs.writeText "echo-single-file" "echo single file\n";
      echoData = pkgs.runCommand "echo-data" { } ''
        mkdir -p $out/share/echo
        cd $out/share/echo
        printf 'echo store data\n' > data.txt
        printf 'echo hard link\n' > hard-a.txt
        ln hard-a.txt hard-b.txt
        ln -s data.txt relative.txt
        ln -s ${linkTarget}/share/target.txt absolute.txt
        ln -s ${linkTarget}/share linked-dir
        ln -s ${singleFile} single.txt
      '';
      schemas =
        pkgs.runCommand "echo-schemas"
          {
            nativeBuildInputs = [ pkgsWasm.pkg-config ];
            buildInputs = [ pkgsWasm.glib ];
          }
          ''
            mkdir -p $out/share/glib-2.0/schemas
            cp ${sidesSrc}/echo.gschema.xml $out/share/glib-2.0/schemas/
            cp ${runtime.libibusWeb}/share/gsettings-schemas/${runtime.libibusWeb.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml $out/share/glib-2.0/schemas/
            compiler=$($PKG_CONFIG --variable=glib_compile_schemas gio-2.0)
            "$compiler" --strict $out/share/glib-2.0/schemas
          '';
      settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";
      engineSideWithSchemas =
        schemaDir: name: source:
        let
          side =
            (runtime.mkSideModule {
              inherit name;
              src = sidesSrc;
              sources = [ source ];
            }).overrideAttrs
              {
                NIX_CFLAGS_COMPILE = ''-I${runtime.libibusWeb}/include/ibus-1.0 -DECHO_DATA="${echoData}/share/echo/data.txt" -DECHO_SCHEMAS="${schemaDir}"'';
              };
        in
        pkgs.runCommand "worker-host-${name}"
          {
            version = runtime.libibusWeb.version;
            meta.license = lib.licenses.mit;
          }
          ''
            mkdir $out
            cp ${side}/${name}.wasm $out/
          '';
      engineSide = engineSideWithSchemas settingsSchemaDir;
      rebuiltSchemas = schemas.overrideAttrs (old: {
        buildCommand = old.buildCommand + "\necho rebuilt > $out/build.txt\n";
      });
      rebuiltSchemaDir = "${rebuiltSchemas}/share/glib-2.0/schemas";
      engineSides = {
        echo = engineSide "echo" "engine.c";
        thrower = engineSide "thrower" "engine-throw.cpp";
        empty = engineSide "empty" "engine-empty.c";
      };
      engineDists = lib.mapAttrs (
        name: package:
        engines.mkEngineManifest {
          inherit name package settingsSchemaDir;
          threads = engineThreads;
          heapBytes = 1024 * 1024;
          engines = lib.optional (name != "empty") name;
          settingsSchemas = [
            "org.example.echo"
            "org.freedesktop.ibus.panel"
          ];
        }
      ) engineSides;
      rebuiltDist = engines.mkEngineManifest {
        name = "empty";
        package = engineSideWithSchemas rebuiltSchemaDir "empty" "engine-empty.c";
        settingsSchemaDir = rebuiltSchemaDir;
        threads = engineThreads;
        heapBytes = 1024 * 1024;
        engines = [ ];
        settingsSchemas = [
          "org.example.echo"
          "org.freedesktop.ibus.panel"
        ];
      };
      sidesDir = pkgs.runCommand "ibus-web-worker-host-test-sides" { } ''
        mkdir $out
        ln -s ${toString (map (side: side.wasm) sides)} $out/
      '';

      # The values the tests share with the C side, as the WebAssembly target
      # defines them, and the runtime's memory bounds.
      constants = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-worker-host-test-constants";
        src = sidesSrc;
        nativeBuildInputs = [
          pkgsWasm.pkg-config
          typescript.nodejs
          pkgs.jq
        ];
        buildInputs = [ runtime.libibusWeb ];
        dontFixup = true;
        buildPhase = ''
          runHook preBuild
          $CC $($PKG_CONFIG --cflags libibus-web) -I${runtime.wasmfsIdb}/include \
            -c constants.c -o constants.o
          $CXX ${toolchain.testMainFlags} constants.o -o constants.js
          node constants.js |
            jq -c --argjson minimum ${toString runtime.memory.minimum} \
              --argjson maximum ${toString runtime.memory.maximum} \
              '. + { memory: { $minimum, $maximum } }' > constants.json
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          install -Dm644 constants.json -t $out
          runHook postInstall
        '';
      };

      # Scenarios size their thread counts by the pool the runtime is linked
      # with: its shares, and the spare Workers beyond them, which the host
      # tops the pool back up to. The memory workloads run with the threads
      # the pool plans for alive at once, which leaves the spares idle, so the
      # host never tops up during them, in the runtime's least memory: their
      # heap's break peaked under 20 MiB in every environment.
      manifest =
        environments:
        pkgs.writeText "ibus-web-worker-host-tests.json" (
          builtins.toJSON {
            inherit environments;
            runtimes = {
              asserting = "${runtime.ibusRuntimeAsserting}";
              released = "${runtime.ibusRuntime}";
            };
            sides = "${sidesDir}";
            engines = lib.mapAttrs (_: dist: "${dist}") (engineDists // { rebuilt = rebuiltDist; });
            echoData = "${echoData}/share/echo/data.txt";
            schemas = "${schemas}";
            constants = "${constants}/constants.json";
            errno = "${runtime.nodeHarness}/errno.json";
            archives = "${archives}";
            pool = {
              inherit (runtime.threadPool) lowWater;
              inherit (runtime.threadPool.shares) glib;
              engine = engineThreads;
              size = runtime.threadPool.size + engineThreads;
              planned = runtime.threadPool.planned + engineThreads;
            };
            stress = {
              threads = runtime.threadPool.planned + engineThreads;
              rounds = 24;
              iterations = 10000;
            };
          }
        );

      # The test engines' data is installed at the store's root, so their
      # archives' entries are named from there, under the store path the
      # tests give them.
      testDataName = "00000000000000000000000000000000-test-data";
      archives =
        pkgs.runCommand "ibus-web-worker-host-archives"
          {
            nativeBuildInputs = [
              pkgs.brotli
              pkgs.gnutar
            ];
          }
          ''
            mkdir $out
            cp ${runtime.installArchives}/* $out/
            chmod u+w $out/*
            for archive in tree tree-upgrade; do
              mkdir -p store/${testDataName}
              tar -xf $out/$archive.tar -C store/${testDataName}
              tar --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
                --mode=u+rw,go=rX -C store -cf $out/$archive.tar ${testDataName}
              rm -rf store
            done
            brotli --quality=11 --output=$out/tree.tar.br $out/tree.tar
            head -c -1 $out/tree.tar.br > $out/truncated.tar.br
            printf '\377\377\377\377' > $out/corrupt.tar.br
          '';

      # Each runs the host's tests on the asserting runtime and the released
      # one, from the built package.
      check =
        name: environments:
        testing.vitestCheck {
          inherit name;
          packageDir = "${typescript.workspace}/packages/worker-host";
          env.IBUS_WEB_WORKER_HOST_TESTS = manifest environments;
          inBrowsers = environments != [ "node" ];
          # Vitest holds each test to its own limit.
          limit = 1800;
          passthru = {
            # For running the tests from a checkout.
            manifest = manifest environments;
            inherit constants;
          };
        };
    in
    {
      # The IndexedDB backend's header comes with no pkg-config module.
      ibusWeb.toolchain.clangdPathFlags."packages/worker-host/test/sides/constants\\.c" = [
        "-I${runtime.wasmfsIdb}/include"
      ];

      checks.engine-distribution-identity =
        pkgs.runCommand "engine-distribution-identity" { nativeBuildInputs = [ pkgs.jq ]; }
          ''
            base=$(jq -r .version ${engineDists.empty}/manifest.json)
            test "$base" = "${runtime.libibusWeb.version}+nix.${
              builtins.substring 0 32 (builtins.baseNameOf (toString engineDists.empty))
            }"
            for dist in ${rebuiltDist} ${
              engineDists.empty.overrideAttrs (old: {
                buildCommand = old.buildCommand + "\n# A changed packaging recipe.\n";
              })
            } ${engineDists.empty.overrideAttrs { runtimeBuild = runtime.ibusRuntimeAsserting; }}; do
              test "$(jq -r .version "$dist/manifest.json")" != "$base"
            done
            touch $out
          '';
      checks.worker-host-node = check "worker-host-node" [ "node" ];
      checks.worker-host-browser = check "worker-host-browser" [
        "chromium"
        "firefox"
      ];
      checks.worker-host-side-imports = runtime.checkSideModuleImports {
        name = "worker-host-test-sides";
        modules =
          map (side: side.wasm) sides ++ lib.mapAttrsToList (name: side: "${side}/${name}.wasm") engineSides;
      };
    };
}
