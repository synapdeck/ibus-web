// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The backend for a WebAssembly module: the runtime, with the engine module
// loaded into it after the first successful Init.

import { CrashReason, requestKinds } from "@ibus-web/protocol";
import type { RuntimeDistributionConstants } from "./startup.ts";
import type { Backend } from "./backend.ts";
import { RuntimeStopped } from "./failure.ts";
import type { Instruments } from "./instruments.ts";
import type { HostRuntimeShape } from "./layers/runtime.ts";
import { topUp } from "./loop.ts";
import { drainOutput, type OutputRing } from "./output.ts";
import { alloc, faultReason, loadSides, pump, RuntimeRefused, wait, warmPool } from "./runtime.ts";
import { EngineScopes } from "./scopes.ts";

interface RuntimeBackendInit {
  readonly runtime: HostRuntimeShape;
  readonly constants: RuntimeDistributionConstants;
  // The engine module's bytes.
  readonly module: ArrayBuffer;
  readonly instruments: Instruments;
  readonly ring: OutputRing;
}

// Calls into the runtime to allocate, so it runs where a throw stops the
// host.
export const runtimeBackend = ({ runtime, constants, module, instruments, ring }: RuntimeBackendInit): Backend => {
  const { handle, wakeIndex, buffers } = runtime;
  const { rt } = handle;
  const scopes = new EngineScopes(buffers.request, constants.canceled);
  const outputLength = new Int32Array(handle.bytes.buffer, alloc(handle, 4), 1);
  let moduleLoaded = false;

  // drainOutput advances lastSeq record by record, so the ring's is the
  // one it moves, even when it throws partway.
  const output = {
    control: ring.control,
    postDoorbell: ring.postDoorbell,
    handle,
    wakeIndex,
    constants,
    get lastSeq() {
      return ring.lastSeq;
    },
    set lastSeq(seq: number) {
      ring.lastSeq = seq;
    },
  };
  const drain = (): number => drainOutput(rt, ring.writer, outputLength, output);

  const fault = (): string | undefined => {
    const reason = faultReason(handle);
    return reason === undefined ? undefined : `an engine threw: ${reason}`;
  };

  const loadEngine = (): void => {
    if (moduleLoaded) return;
    try {
      loadSides(handle, [{ name: "engine", bytes: module }]);
    } catch (error) {
      // A refused load leaves the runtime fit to call, so its account of
      // the failure reaches the page ahead of the Crashed record.
      if (error instanceof RuntimeRefused)
        try {
          drain();
        } catch {
          // The crash is already LOAD's; a failed drain only loses records.
        }
      throw new RuntimeStopped({ error, reason: CrashReason.load });
    }
    moduleLoaded = true;
    instruments.warm(() => warmPool(handle));
  };

  return {
    wake: { words: handle.words, index: wakeIndex },
    dispatch: (request) => {
      handle.bytes.set(request, buffers.request);
      const ret = rt._ibusweb_dispatch(buffers.request, request.length);
      if (ret === constants.canceled) return { ret, fault: fault() ?? "ibusweb_dispatch returned -ECANCELED" };

      if (ret === 0 && request.length >= 8) {
        const header = new DataView(request.buffer, request.byteOffset, 8);
        const kind = header.getUint16(0, true);
        const ic = header.getUint32(4, true);
        if (kind === requestKinds.get("Init")) loadEngine();
        else if (kind === requestKinds.get("CreateEngine")) scopes.opened(ic);
        else if (kind === requestKinds.get("DestroyEngine")) scopes.closed(ic);
      }
      return { ret };
    },
    pump: () => pump(rt, constants),
    drain,
    wait: (seen, timeoutMs) => wait(rt, constants, seen, timeoutMs),
    fault,
    pool: {
      lowWater: constants.poolLowWater,
      idle: () => rt.PThread.unusedWorkers.length,
      topUp: (want, limitMs) => topUp(rt, want, limitMs),
      warm: () => warmPool(handle),
    },
    close: (intact) => scopes.closeAll(rt, intact),
  };
};
