// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Writing an archive's entries into a directory through WasmFS's FS, so the
// stored layout has the one writer whatever backs the mount. Every call is
// synchronous; the caller waits for whatever it must between them.

import { RuntimeRefused, type RuntimeHandle } from "../runtime.ts";

// The regular files written whole, and the bytes of file data written.
export interface Written {
  files: number;
  bytes: number;
}

// A regular file being written: its data, in order, then end().
export interface FileWriter {
  write(data: Uint8Array): void;
  end(): void;
}

export interface EntryWriter {
  directory(name: string, mode: number): void;
  symlink(name: string, target: string): void;
  // Refuses a file larger than what is left of the limit before making
  // anything of it.
  file(name: string, mode: number, size: number): FileWriter;
  readonly written: Readonly<Written>;
  // Closes the file being written, if any, after a failure. Call it only
  // while the runtime is fit to call.
  abandon(): void;
}

// Writes into dir, an existing directory, at most limit bytes of file data.
// Names are relative to dir, with no empty, "." or ".." components; the
// empty name is dir itself. A failure throws RuntimeRefused, naming the
// entry and the negative errno, and leaves what was written before it.
export const entryWriter = (handle: RuntimeHandle, dir: string, limit: number): EntryWriter => {
  const { FS } = handle.rt;
  const { errno, open, mode: modeBits } = handle.fs;
  const written: Written = { files: 0, bytes: 0 };
  // The file being written, which a failure leaves open.
  let current: { fd: number } | undefined;

  const refused = (name: string, code: number): RuntimeRefused =>
    new RuntimeRefused(`${JSON.stringify(name)}: -${code}`);

  // An ErrnoError leaves the runtime fit to call; anything else thrown from
  // inside it may not.
  const fs = <T>(name: string, call: () => T): T => {
    try {
      return call();
    } catch (error) {
      if (error instanceof FS.ErrnoError) throw refused(name, error.errno);
      throw error;
    }
  };
  // unlink() and symlink() return their errno rather than throw it.
  const fsReturning = (name: string, call: () => number): void => {
    const ret = call();
    if (ret < 0) throw refused(name, -ret);
  };

  const pathOf = (name: string): string => (name === "" ? dir : `${dir}/${name}`);
  const isType = (st: { mode: number }, type: number): boolean => (st.mode & modeBits.S_IFMT) === type;
  // What is at path, not following a link there, or null for nothing.
  const lstat = (name: string, path: string): { mode: number } | null => {
    try {
      return FS.lstat(path);
    } catch (error) {
      if (error instanceof FS.ErrnoError && error.errno === errno.ENOENT) return null;
      if (error instanceof FS.ErrnoError) throw refused(name, error.errno);
      throw error;
    }
  };

  // mkdir() that accepts a directory already there. A link there is no
  // directory, even to one: following it would let the archive write
  // outside dir through a link it made itself.
  const ensureDir = (name: string, path: string, mode: number): void => {
    try {
      FS.mkdir(path, mode);
      return;
    } catch (error) {
      if (!(error instanceof FS.ErrnoError) || error.errno !== errno.EEXIST) {
        if (error instanceof FS.ErrnoError) throw refused(name, error.errno);
        throw error;
      }
    }
    const st = lstat(name, path);
    if (st === null || !isType(st, modeBits.S_IFDIR)) throw refused(name, errno.ENOTDIR);
  };

  // Creates the parents of name that are missing, since an archive need not
  // list them.
  const ensureParents = (name: string): void => {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) ensureDir(name, pathOf(parts.slice(0, i).join("/")), 0o755);
  };

  // The archive's permission bits, plus the owner's read and write, so that
  // an install can always redo what an earlier one wrote.
  const permissions = (mode: number): number => (mode & 0o777) | 0o600;

  const checkDir = (): void => {
    const st = lstat(dir, dir);
    if (st === null) throw refused(dir, errno.ENOENT);
    if (!isType(st, modeBits.S_IFDIR)) throw refused(dir, errno.ENOTDIR);
  };
  checkDir();

  return {
    written,

    directory(name, mode) {
      if (name === "") return;
      ensureParents(name);
      const path = pathOf(name);
      const bits = permissions(mode) | 0o700;
      ensureDir(name, path, bits);
      // mkdir() applies the umask, and leaves a directory already there as
      // it was.
      fs(name, () => FS.chmod(path, bits));
    },

    // A link's target is kept as the archive has it, absolute or relative,
    // and never resolved here: it may name a path another archive installs
    // later.
    symlink(name, target) {
      if (name === "" || target === "") throw refused(name, errno.EINVAL);
      ensureParents(name);
      const path = pathOf(name);
      // Whatever is there but a directory is replaced, never written
      // through.
      const st = lstat(name, path);
      if (st !== null) {
        if (isType(st, modeBits.S_IFDIR)) throw refused(name, errno.EISDIR);
        fsReturning(name, () => FS.unlink(path));
      }
      fsReturning(name, () => FS.symlink(target, path));
    },

    file(name, mode, size) {
      if (name === "") throw refused(name, errno.EINVAL);
      if (size > limit - written.bytes) throw refused(name, errno.EFBIG);
      ensureParents(name);
      const path = pathOf(name);
      const st = lstat(name, path);
      if (st !== null && isType(st, modeBits.S_IFLNK)) fsReturning(name, () => FS.unlink(path));
      const bits = permissions(mode);
      const stream = fs(name, () => FS.open(path, open.O_WRONLY | open.O_CREAT | open.O_TRUNC | open.O_NOFOLLOW, bits));
      current = stream;
      // open() applies the umask, and leaves a file already there its mode.
      fs(name, () => FS.fchmod(stream.fd, bits));
      // Sized before its data arrives, a file in memory takes its size once,
      // where appending each piece would grow it to as much as twice that
      // and need the old copy beside the new while it moves. Until the data
      // is written the file reads as zeros; an install cut short leaves no
      // marker, so nothing trusts such a file.
      if (size > 0) fs(name, () => FS.ftruncate(stream.fd, size));
      let left = size;
      return {
        write(data) {
          if (data.length > left) throw refused(name, errno.EINVAL);
          let at = 0;
          // A short write is retried with what is left.
          while (at < data.length) {
            const count = fs(name, () => FS.write(stream, data, at, data.length - at));
            if (count === 0) throw refused(name, errno.EINVAL);
            at += count;
            left -= count;
            written.bytes += count;
          }
        },
        end() {
          if (left !== 0) throw refused(name, errno.EINVAL);
          current = undefined;
          // fsync() is libc's: it reports failure in errno, and WasmFS's
          // FS has none of its own.
          if (handle.rt._fsync(stream.fd) !== 0) {
            const code = handle.words[handle.rt.___errno_location() / 4]!;
            fs(name, () => FS.close(stream));
            throw refused(name, code);
          }
          fs(name, () => FS.close(stream));
          written.files++;
        },
      };
    },

    abandon() {
      const file = current;
      current = undefined;
      if (file === undefined) return;
      try {
        FS.close(file);
      } catch (error) {
        if (!(error instanceof FS.ErrnoError)) throw error;
      }
    },
  };
};
