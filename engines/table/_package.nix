# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0
{
  lib,
  stdenv,
  runCommand,
  pkg-config,
  glib,
  libibus-web,
  marisa,
  sideModuleFlags,
  sideModuleLibraryGuard,
  sources,
  tables,
}:
let
  # The panel reads its candidate orientation from this schema.
  schemas = runCommand "ibus-web-table-gsettings-schemas" { } ''
    mkdir -p $out/share/glib-2.0/schemas
    cp ${libibus-web}/share/gsettings-schemas/${libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
      $out/share/glib-2.0/schemas/
    ${glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
  '';
  settingsSchemaDir = "${schemas}/share/glib-2.0/schemas";

  # Both directories are compiled in as store paths, which makes them the
  # side module's data closure.
  cflags = lib.concatStringsSep " " [
    "-std=c++23"
    "'-DIBUSWEB_TABLE_DIR=\"${tables}\"'"
    "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
  ];

  # Every .cpp in src/, the glue included, by name: src/ is the build's
  # working directory.
  files = sources;
  objects = map (file: "${lib.removeSuffix ".cpp" file}.o") files;

  inputs = [
    libibus-web
    marisa
  ];
in
(stdenv.mkDerivation {
  pname = "ibus-web-table";
  version = "0.1.0";
  src = ./src;

  nativeBuildInputs = [ pkg-config ];
  buildInputs = inputs;
  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    cflags=(${cflags} $($PKG_CONFIG --cflags ibus-1.0 libibus-web marisa))
    for file in ${lib.escapeShellArgs files}; do
      $CXX "''${cflags[@]}" -c "$file" -o "''${file%.cpp}.o"
    done

    libs="$($PKG_CONFIG --static --libs marisa)"
    source ${sideModuleLibraryGuard}
    checkSideModuleLibraries $libs

    $CXX ${sideModuleFlags} -g0 ${lib.escapeShellArgs objects} $libs -o table.wasm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 table.wasm -t $out
    runHook postInstall
  '';

  passthru = {
    inherit schemas settingsSchemaDir tables;
    auditCflags = cflags;
    auditSources = files;
  };

  # The engine is ours; MARISA is linked in under its BSD-2-Clause option,
  # and the LaTeX table's data is W3C's.
  meta.license = {
    spdxId = "(MIT OR Apache-2.0) AND BSD-2-Clause AND W3C";
    fullName = "MIT OR Apache-2.0, with BSD-2-Clause MARISA and W3C data";
    free = true;
    redistributable = true;
  };
})
# The static stdenv propagates every build input, which would put the
# libraries, and everything they reference, in the module's closure.
.overrideAttrs
  {
    buildInputs = inputs;
    propagatedBuildInputs = [ ];
  }
