// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A Vite application's import of a module from its own build, as the kit's
// Vite plugin resolves it.

declare module "*?ibus-module" {
  /** The URL of the module's manifest, under the application's `base`, for `ModuleRegistry.layer`'s `modules`. */
  const manifestUrl: string;
  export default manifestUrl;
}
