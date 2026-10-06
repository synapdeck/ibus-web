// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Context, Layer, Schedule } from "effect";
import { transportLayout } from "@ibus-web/worker-host";

export interface CoreConfigValues {
  readonly budgetMs: number;
  readonly hangMs: number;
  readonly initHangMs: number;
  readonly replayLimit: number;
  readonly surroundingWindow: number;
  readonly restart: Schedule.Schedule<unknown>;
  readonly ringBytes: number;
  readonly slotBytes: number;
}

const layout = transportLayout();

export class CoreConfig extends Context.Service<CoreConfig, CoreConfigValues>()("@ibus-web/core/CoreConfig") {
  static readonly defaults: CoreConfigValues = {
    budgetMs: 40,
    hangMs: 2000,
    initHangMs: 30000,
    replayLimit: 64,
    surroundingWindow: 1000,
    restart: Schedule.concat(Schedule.recurs(1), Schedule.exponential(250)),
    ringBytes: layout.ringBytes,
    slotBytes: layout.slotBytes,
  };

  static layer(values: Partial<CoreConfigValues> = {}) {
    return Layer.succeed(CoreConfig, { ...CoreConfig.defaults, ...values });
  }

  static readonly Default = CoreConfig.layer();
}
