# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  perSystem =
    { config, lib, ... }:
    let
      inherit (config.ibusWeb.toolchain) pkgsWasm;
      inherit (pkgsWasm) glib;
    in
    {
      # A Meson project calling the gnome module helpers that run a GLib tool
      # at build time (gdbus_codegen, compile_resources, genmarshal,
      # mkenums_simple, compile_schemas), the way a library built on this
      # GLib would, with the build machine's GLib (and its tools) on PATH as
      # well and no depsBuildBuild. gnome.post_install, which runs
      # glib-compile-schemas and gio-querymodules at install time, is not
      # exercised. A tool run by plain name from PATH is this GLib's too.
      checks.glib-meson-tools = pkgsWasm.stdenv.mkDerivation {
        name = "ibus-web-glib-meson-tools";
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./meson.build
            ./main.c
            ./example.xml
            ./example.gresource.xml
            ./example-marshal.list
            ./example-color.h
            ./org.example.Consumer.gschema.xml
          ];
        };
        nativeBuildInputs = [
          pkgsWasm.meson
          pkgsWasm.ninja
          pkgsWasm.pkg-config
          glib
          config.ibusWeb.typescript.nodejs
        ];
        buildInputs = [ glib ];
        installPhase = ''
          runHook preInstall
          for tool in gdbus-codegen glib-compile-resources glib-compile-schemas \
            glib-genmarshal glib-mkenums; do
            grep -qF "${glib.dev}/bin/$tool" build.ninja
          done

          for tool in ${glib.dev}/bin/* ${glib.bin}/bin/*; do
            name=''${tool##*/}
            case $name in
              *.js) ;;
              *)
                if [ "$(command -v "$name")" != "$tool" ]; then
                  echo "$name runs $(command -v "$name"), not $tool" >&2
                  exit 1
                fi
                ;;
            esac
          done
          # The build machine's gdbus-codegen emits one-argument interface
          # init functions.
          gdbus-codegen --generate-c-code from-path --c-namespace Example \
            --interface-prefix org.example. ../example.xml
          grep -qF "example_counter_proxy_iface_init (ExampleCounterIface *iface, gpointer iface_data);" from-path.c

          # gnome.gdbus_codegen() picks its options by the build machine's
          # GLib version, and warns when it can't read one.
          test -s meson-logs/meson-log.txt
          if grep -F "assuming 2.54" meson-logs/meson-log.txt; then
            exit 1
          fi
          mkdir -p $out
          node consumer.js | tee $out/output.txt
          grep -qx "counter 7 /org/example/Counter" $out/output.txt
          grep -qx "resource 1" $out/output.txt
          grep -qx "enum green" $out/output.txt
          grep -qx "marshal 3 three" $out/output.txt
          GSETTINGS_SCHEMA_DIR=. GSETTINGS_BACKEND=memory \
            ${glib.bin}/bin/gsettings get org.example.Consumer greeting > $out/greeting
          test "$(cat $out/greeting)" = "'hello'"
          runHook postInstall
        '';
      };
    };
}
