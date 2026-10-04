// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { CrashReason, DestroyEngine, encodeRequest } from "@ibus-web/protocol";
import { RuntimeStopped } from "./failure.ts";
import type { Runtime } from "./runtime.ts";

export class EngineScopes {
  private readonly instances = new Set<number>();
  private readonly requestBuffer: number;
  private readonly canceled: number;
  constructor(requestBuffer: number, canceled: number) {
    this.requestBuffer = requestBuffer;
    this.canceled = canceled;
  }
  opened(ic: number): void {
    this.instances.add(ic);
  }
  closed(ic: number): void {
    this.instances.delete(ic);
  }
  closeAll(rt: Runtime, intact: boolean): void {
    const instances = [...this.instances];
    this.instances.clear();
    if (!intact) return;
    for (const ic of instances) {
      const request = encodeRequest(ic, new DestroyEngine({}));
      rt.HEAPU8.set(request, this.requestBuffer);
      let result: number;
      try {
        result = rt._ibusweb_dispatch(this.requestBuffer, request.length);
      } catch (error) {
        throw new RuntimeStopped({ error, reason: CrashReason.trap });
      }
      if (result === this.canceled)
        throw new RuntimeStopped({ error: "DestroyEngine returned -ECANCELED", reason: CrashReason.fault });
    }
  }
}
