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
      inherit (config.ibusWeb) runtime;
      inherit (config.ibusWeb.toolchain) pkgsWasm;

      # What a host serves; the export lists are for building side modules.
      dist = pkgs.runCommand "ibus-web-runtime-dist" { } ''
        mkdir $out
        cp ${runtime.ibusRuntime}/{ibus-runtime.js,ibus-runtime.wasm,constants.json} $out/
      '';

      # The libraries linked into the runtime besides GLib, each with its own
      # license file. The toolchain's runtime libraries need none: LLVM's
      # carry the LLVM exception for exactly this, and nothing compiled with
      # Emscripten ships musl's or its glue's notice.
      upstreamLicenses = {
        "LICENSES/glib/COPYING" = "${pkgs.srcOnly pkgsWasm.glib}/COPYING";
        "LICENSES/pcre2/LICENCE.md" = "${pkgs.srcOnly pkgsWasm.pcre2}/LICENCE.md";
        "LICENSES/zlib/LICENSE" = "${pkgs.srcOnly pkgsWasm.zlib}/LICENSE";
        "LICENSES/libffi/LICENSE" = "${pkgs.srcOnly pkgsWasm.libffi}/LICENSE";
      };
    in
    {
      ibusWeb.typescript.npmPackages.runtime = config.ibusWeb.typescript.npmTarball {
        name = "ibus-web-npm-runtime";

        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./README.md
          ];
        };

        # libibus-web is LGPL-2.1-or-later; the IndexedDB backend is ours,
        # MIT OR Apache-2.0.
        files = upstreamLicenses // {
          inherit dist;
          "LICENSES/ibus-web/LICENSE-MIT" = ../../LICENSE-MIT;
          "LICENSES/ibus-web/LICENSE-APACHE" = ../../LICENSE-APACHE;
        };
        licenses = [ "LGPL-2.1-or-later" ];
        license = "LGPL-2.1-or-later";

        expect = lib.attrNames upstreamLicenses ++ [
          "LICENSES/LGPL-2.1-or-later.txt"
          "LICENSES/ibus-web/LICENSE-MIT"
          "LICENSES/ibus-web/LICENSE-APACHE"
        ];
      };
    };
}
