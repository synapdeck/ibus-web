# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later
{
  lib,
  stdenv,
  runCommand,
  pkg-config,
  glib,
  libibus-web,
  librime,
  ibus-engines,
  ibus-web-boost-headers,
  ibus-web-rime-data,
  sideModuleFlags,
  sideModuleLibraryGuard,
  # The schemas to deploy and register as engines; their dependencies
  # deploy whether listed or not. Every engine of the schema table by
  # default.
  schemas ? null,
}:
let
  data = ibus-web-rime-data.override { inherit schemas; };
  inherit (data) common descriptors;

  # The engine's schemas and the panel's, compiled together.
  settingsSchemas = runCommand "ibus-web-rime-gsettings-schemas" { } ''
    mkdir -p $out/share/glib-2.0/schemas
    cp ${./org.freedesktop.ibus.engine.rime.gschema.xml} $out/share/glib-2.0/schemas/org.freedesktop.ibus.engine.rime.gschema.xml
    cp ${libibus-web}/share/gsettings-schemas/${libibus-web.name}/glib-2.0/schemas/org.freedesktop.ibus.gschema.xml \
      $out/share/glib-2.0/schemas/
    ${glib.dev}/bin/glib-compile-schemas --strict $out/share/glib-2.0/schemas
  '';
  settingsSchemaDir = "${settingsSchemas}/share/glib-2.0/schemas";

  # Both directories are compiled in as store paths, which makes them the
  # side module's data closure.
  defines = [
    "'-DIBUSWEB_RIME_SHARED_DATA_DIR=\"${common}\"'"
    "'-DIBUSWEB_SETTINGS_SCHEMA_DIR=\"${settingsSchemaDir}\"'"
    "-I${descriptors}"
    "-I${ibus-engines.rime}/include/ibus-rime"
  ];
  cxxflags = lib.concatStringsSep " " ([ "-std=c++17" ] ++ defines);
  cflags = lib.concatStringsSep " " defines;

  inputs = [
    libibus-web
    librime
    ibus-web-boost-headers
  ];
in
(stdenv.mkDerivation {
  pname = "ibus-web-rime";
  inherit (ibus-engines.rime) version;
  src = ./module;

  nativeBuildInputs = [ pkg-config ];
  buildInputs = inputs;
  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    $CXX ${cxxflags} $($PKG_CONFIG --cflags ibus-1.0 libibus-web rime libglog) -c module.cc -o module.o
    $CC ${cflags} $($PKG_CONFIG --cflags ibus-1.0 libibus-web rime) -c settings.c -o settings.o

    libs="$($PKG_CONFIG --static --libs rime)"
    source ${sideModuleLibraryGuard}
    checkSideModuleLibraries $libs

    $CXX ${sideModuleFlags} -g0 ${ibus-engines.rime}/lib/ibus-rime/rime_engine.o ${ibus-engines.rime}/lib/ibus-rime/rime_settings.o \
      module.o settings.o $libs -o rime.wasm
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 rime.wasm -t $out
    runHook postInstall
  '';

  passthru = {
    inherit (data)
      schemas
      common
      dicts
      deployment
      descriptors
      source
      ;
    inherit settingsSchemas settingsSchemaDir;
    auditCxxflags = cxxflags;
    auditCflags = cflags;
  };

  # ibus-rime's own: what links into it and the data carry licences of their
  # own.
  inherit (ibus-engines.rime) meta;
})
# The static stdenv propagates every build input, which would put the
# libraries, and everything they reference, in the module's closure.
.overrideAttrs
  {
    buildInputs = inputs;
    propagatedBuildInputs = [ ];
  }
