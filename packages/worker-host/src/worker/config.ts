// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { Context, Layer } from "effect";
import type { HostConfigValues } from "../shared/config.ts";

export type { HostConfigValues };

export const defaultHostConfig: HostConfigValues = {
  topUpLimitMs: 10_000,
  crashWaitMs: 1000,
  lockRoundMs: 1000,
  lockLimitMs: 120_000,
  progressIntervalMs: 1000,
  archiveIdleMs: 30_000,
  deleteLimitMs: 10_000,
  closeWaitMs: 1000,
};

export class HostConfig extends Context.Service<HostConfig, HostConfigValues>()("@ibus-web/worker-host/HostConfig") {
  static readonly layer: Layer.Layer<HostConfig> = Layer.succeed(HostConfig, defaultHostConfig);

  // The defaults with some replaced, as tests that must reach a limit
  // quickly shorten it.
  static readonly layerWith = (overrides: Partial<HostConfigValues>): Layer.Layer<HostConfig> =>
    Layer.succeed(HostConfig, { ...defaultHostConfig, ...overrides });
}
