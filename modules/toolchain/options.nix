# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: MIT OR Apache-2.0

{ lib, flake-parts-lib, ... }:
{
  options.perSystem = flake-parts-lib.mkPerSystemOption {
    options.ibusWeb.toolchain = {
      emscripten = lib.mkOption {
        type = lib.types.package;
        description = "nixpkgs' Emscripten with the upstream-tracked fixes this project carries; every WASM build's compiler.";
      };
      commonFlags = lib.mkOption {
        type = lib.types.str;
        description = "Compiler flags every WASM object is built with.";
      };
      testMainFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for Node-run test programs, on WasmFS; a combination the library cache covers.";
      };
      dynamicLinkFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags every main or side module link adds, acknowledging that Emscripten's dynamic linking is experimental.";
      };
      runtimeMainFlags = lib.mkOption {
        type = lib.types.str;
        description = "The settings of ibus-runtime's main-module link that select library variants; the cache holds them with and without assertions.";
      };
      sideModuleFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags for side modules a main module loads with dlopen().";
      };
      testMemoryFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags giving Node-run test programs a fixed memory large enough for GLib's tests, in place of memory growth.";
      };
      nodeHostFsFlags = lib.mkOption {
        type = lib.types.str;
        description = "Link flags putting a Node-run program on WasmFS with the host's files at their own paths.";
      };
      emscriptenCache = lib.mkOption {
        type = lib.types.package;
        description = "Emscripten cache prebuilt for this project's library variants.";
      };
      emscriptenCacheHook = lib.mkOption {
        type = lib.types.package;
        description = "Setup hook giving each build a private copy of the cache.";
      };
      mesonCrossFlags = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Meson flags selecting pkgsWasm's cross files, for configuring by hand.";
      };
      devLibraries = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "pkgsWasm libraries whose headers and pkg-config files the dev shell and editor see.";
      };
      pkgsWasm = lib.mkOption {
        type = lib.types.raw;
        description = "nixpkgs for wasm32-unknown-none, compiled with Emscripten.";
      };
    };
  };
}
