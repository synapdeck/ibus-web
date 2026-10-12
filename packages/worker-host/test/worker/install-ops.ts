// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// HostOp.install and HostOp.fs: the installer, and WasmFS's FS beneath it,
// driven directly on a memory mount of the tests' own, so the tests can hold
// the installer to its policy in a host with the real runtime.

import { extract } from "../../src/worker/install/archive.ts";
import { RuntimeRefused, withString, type RuntimeHandle } from "../../src/worker/runtime.ts";
import { member, pattern, patternByte } from "../shared/tar.ts";
import type { FsAction, FsResult, InstallOpReply, InstallOpRequest, ArchivePart } from "../shared/testing.ts";

const encoder = new TextEncoder();
const WASM_PAGE = 65536;

const partBytes = (part: ArchivePart): Uint8Array =>
  "zeros" in part ? new Uint8Array(part.zeros) : "text" in part ? encoder.encode(part.text) : member(part);

const archiveBytes = async (archive: InstallOpRequest["archive"]): Promise<Uint8Array> => {
  if ("url" in archive) {
    const response = await fetch(archive.url);
    if (!response.ok) throw new Error(`fetch ${archive.url}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const parts = archive.parts.map(partBytes);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const streamOf = (bytes: Uint8Array, piece: number): ReadableStream<Uint8Array> => {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, (at += piece)));
    },
  });
};

// Takes the runtime's free memory, in blocks small enough to come from the
// top of its heap, until only budget bytes are left, then runs use and
// gives it back.
const squeezed = async <T>(handle: RuntimeHandle, budget: number, use: () => Promise<T>): Promise<T> => {
  const rt = handle.rt as typeof handle.rt & { _sbrk(increment: number): number };
  const heap = handle.memory.buffer.byteLength;
  if (heap - rt._sbrk(0) <= budget) throw new Error(`only ${heap - rt._sbrk(0)} bytes free, not ${budget}`);
  const blocks: number[] = [];
  try {
    while (heap - rt._sbrk(0) > budget) {
      const block = rt._malloc(65536);
      if (block === 0) break;
      blocks.push(block);
    }
    return await use();
  } finally {
    for (const block of blocks) rt._free(block);
  }
};

export const install = async (handle: RuntimeHandle, request: InstallOpRequest): Promise<InstallOpReply> => {
  let bytes = await archiveBytes(request.archive);
  if (request.cut !== undefined) bytes = bytes.subarray(0, request.cut);
  const run = () =>
    extract(
      handle,
      streamOf(bytes, request.piece ?? 65536),
      "install",
      request.dir,
      request.storeName,
      request.limit ?? Number.MAX_SAFE_INTEGER,
      { fed: 0, files: 0, bytes: 0 },
      {},
    );
  try {
    const written =
      request.squeeze === undefined
        ? await run()
        : await squeezed(
            handle,
            Math.ceil(request.squeeze.file / WASM_PAGE) * WASM_PAGE + request.squeeze.headroom,
            run,
          );
    return { ok: true, ...written };
  } catch (error) {
    if (error instanceof RuntimeRefused) return { ok: false, message: error.message };
    throw error;
  }
};

// Runs each action in turn, through FS where it has the call, and reports
// each one's result or errno.
export const fsActions = (handle: RuntimeHandle, actions: readonly FsAction[]): FsResult[] => {
  const { rt } = handle;
  const { FS } = rt;
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = handle.fs.open;
  const results: FsResult[] = [];
  for (const action of actions) {
    try {
      switch (action.op) {
        case "mount": {
          const backend = rt._wasmfs_create_memory_backend();
          const ret = withString(handle, action.path, (ptr) => rt._wasmfs_create_directory(ptr, 0o777, backend));
          results.push(ret < 0 ? { errno: -ret } : {});
          break;
        }
        case "mkdir":
          FS.mkdir(action.path, action.mode ?? 0o755);
          results.push({});
          break;
        case "write": {
          const stream = FS.open(action.path, O_WRONLY | O_CREAT | O_TRUNC, action.mode ?? 0o644);
          try {
            const data = action.text === undefined ? pattern(action.size ?? 0) : encoder.encode(action.text);
            FS.write(stream, data, 0, data.length);
          } finally {
            FS.close(stream);
          }
          results.push({});
          break;
        }
        case "symlink": {
          const ret = FS.symlink(action.target, action.path);
          results.push(ret < 0 ? { errno: -ret } : {});
          break;
        }
        case "unlink": {
          const ret = FS.unlink(action.path);
          results.push(ret < 0 ? { errno: -ret } : {});
          break;
        }
        case "chmod":
          FS.chmod(action.path, action.mode);
          results.push({});
          break;
        case "lstat": {
          const { mode, size } = FS.lstat(action.path);
          results.push({ value: { mode, size } });
          break;
        }
        case "readlink":
          results.push({ value: (FS as unknown as { readlink(path: string): string }).readlink(action.path) });
          break;
        case "read":
          results.push({
            value: (FS as unknown as { readFile(path: string, opts: { encoding: "utf8" }): string }).readFile(
              action.path,
              { encoding: "utf8" },
            ),
          });
          break;
        // The offset of the first byte that isn't the pattern's, or the
        // file's size if none.
        case "pattern": {
          const data = (FS as unknown as { readFile(path: string): Uint8Array }).readFile(action.path);
          let at = 0;
          while (at < data.length && data[at] === patternByte(at)) at++;
          results.push({ value: at === data.length ? { size: data.length } : { differsAt: at } });
          break;
        }
        // Each call the installer makes, failing, with its errno.
        case "failures": {
          const errnoOf = (call: () => unknown): number | string => {
            try {
              const ret = call();
              return typeof ret === "number" && ret < 0 ? -ret : `returned ${String(ret)}`;
            } catch (error) {
              if (error instanceof FS.ErrnoError) return error.errno;
              throw error;
            }
          };
          const { dir } = action;
          FS.mkdir(`${dir}/sub`, 0o755);
          const file = FS.open(`${dir}/file`, O_WRONLY | O_CREAT, 0o644);
          FS.close(file);
          FS.symlink(`${dir}/file`, `${dir}/link`);
          const closed = FS.open(`${dir}/closed`, O_WRONLY | O_CREAT, 0o644);
          FS.close(closed);
          const fsyncErrno = (): number => {
            if (rt._fsync(closed.fd) === 0) return 0;
            return handle.words[rt.___errno_location() / 4]!;
          };
          results.push({
            value: {
              mkdirExisting: errnoOf(() => FS.mkdir(`${dir}/sub`, 0o755)),
              mkdirMissingParent: errnoOf(() => FS.mkdir(`${dir}/missing/x`, 0o755)),
              mkdirUnderFile: errnoOf(() => FS.mkdir(`${dir}/file/x`, 0o755)),
              mkdirUnderLink: errnoOf(() => FS.mkdir(`${dir}/link/x`, 0o755)),
              lstatMissing: errnoOf(() => FS.lstat(`${dir}/missing`)),
              lstatUnderFile: errnoOf(() => FS.lstat(`${dir}/file/x`)),
              unlinkMissing: errnoOf(() => FS.unlink(`${dir}/missing`)),
              unlinkDirectory: errnoOf(() => FS.unlink(`${dir}/sub`)),
              symlinkExisting: errnoOf(() => FS.symlink("x", `${dir}/file`)),
              symlinkMissingParent: errnoOf(() => FS.symlink("x", `${dir}/missing/x`)),
              openDirectory: errnoOf(() => FS.open(`${dir}/sub`, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644)),
              openLink: errnoOf(() => FS.open(`${dir}/link`, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644)),
              openMissingParent: errnoOf(() =>
                FS.open(`${dir}/missing/x`, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644),
              ),
              chmodMissing: errnoOf(() => FS.chmod(`${dir}/missing`, 0o644)),
              fchmodClosed: errnoOf(() => FS.fchmod(closed.fd, 0o644)),
              ftruncateClosed: errnoOf(() => FS.ftruncate(closed.fd, 1)),
              writeClosed: errnoOf(() => FS.write(closed, new Uint8Array(1), 0, 1)),
              closeClosed: errnoOf(() => FS.close(closed)),
              fsyncClosed: fsyncErrno(),
            },
          });
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof FS.ErrnoError)) throw error;
      results.push({ errno: error.errno });
    }
  }
  return results;
};
