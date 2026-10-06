// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
/** Copy the complete ibus-web/host directory together at deployment time.
 * Bundlers must preserve its sibling assets; otherwise pass an explicit hostUrl.
 * This module exports URLs only and never imports a Worker implementation.
 */
export const workerUrl = new URL("./host/index.js", import.meta.url);
export const relayUrl = new URL("./host/relay.js", import.meta.url);
export const brotliFallbackUrl = new URL("./host/brotli-fallback.js", import.meta.url);
export default workerUrl;
