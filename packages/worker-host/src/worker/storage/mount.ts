// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Mounting the engine's own files on the backend the plan chose.

import { nodeFs } from "../node-fs.ts";
import { check, RuntimeRefused, withString, type RuntimeHandle } from "../runtime.ts";
import type { Mount } from "../../shared/messages.ts";
import type { StoragePlan } from "./plan.ts";

// What the engine's directory is mounted on.
export interface MountedStorage {
  readonly mount: Mount;
  // Whether the IndexedDB backend's connection has closed under it.
  readonly closed: () => boolean;
  // Makes a read-write IndexedDB backend refuse every change from here on.
  readonly seal?: () => void;
}

// Under Node, the engine's own files are kept apart from its data.
const nodeUserDir = (hostPath: string): string => `${hostPath}/user`;

// mkdir -p; a directory that exists already fails harmlessly.
export const makeDirs = (handle: RuntimeHandle, path: string): void => {
  const parts = path.split("/").filter((part) => part !== "");
  for (let i = 1; i <= parts.length; i++)
    withString(handle, `/${parts.slice(0, i).join("/")}`, (ptr) => handle.rt._mkdir(ptr, 0o755));
};

// Mounts the backend, which is 0 if it couldn't be made, at dir.
export const mountAt = (handle: RuntimeHandle, backend: number, dir: string, what: Mount): void => {
  if (backend === 0)
    throw new RuntimeRefused(
      what === "indexeddb"
        ? `storage failed to open ${dir} on IndexedDB although IndexedDB was available; the backend logged the cause to the Worker's stderr/console`
        : `no ${what} backend for ${dir}`,
    );
  check(
    `mount ${dir}`,
    withString(handle, dir, (ptr) => handle.rt._wasmfs_create_directory(ptr, 0o777, backend)),
  );
};

// Mounts the engine's own files at dir, its parents in memory. The
// IndexedDB backend starts a thread of its own, from the pool, that runs
// its calls for good, and blocks this thread while that thread opens the
// database; it reports why it couldn't on stderr.
export const mount = async (handle: RuntimeHandle, plan: StoragePlan, dir: string): Promise<MountedStorage> => {
  if (plan.mount === "none") return { mount: "none", closed: () => false };
  const { rt } = handle;
  makeDirs(handle, dir.slice(0, dir.lastIndexOf("/")));
  let backend: number;
  switch (plan.mount) {
    case "node": {
      const user = nodeUserDir(plan.hostPath);
      // Fails outside the runtime, which stays fit to call.
      await nodeFs()
        .then((fs) => fs.mkdir(user, { recursive: true }))
        .catch((error: unknown) => {
          throw new RuntimeRefused(`mkdir ${user}: ${String(error)}`);
        });
      backend = withString(handle, user, (ptr) => rt._wasmfs_create_node_backend(ptr));
      break;
    }
    case "indexeddb":
      backend = withString(handle, plan.database, (ptr) => rt._wasmfs_create_idb_backend(ptr, plan.flags));
      break;
    case "memory":
      backend = rt._wasmfs_create_memory_backend();
      break;
  }
  mountAt(handle, backend, dir, plan.mount);
  if (plan.mount !== "indexeddb") return { mount: plan.mount, closed: () => false };
  return {
    mount: plan.mount,
    closed: () => rt._wasmfs_idb_backend_closed(backend) !== 0,
    ...(plan.readOnly ? {} : { seal: () => rt._wasmfs_idb_backend_seal(backend) }),
  };
};
