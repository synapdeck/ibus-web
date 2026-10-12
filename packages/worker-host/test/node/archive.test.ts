// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What the installer leaves to modern-tar's strict decoder, and what it
// checks itself: these run the decoder alone, and the installer over a file
// system that only records what it was asked to do.

import { createTarDecoder, type TarHeader } from "modern-tar";
import { describe, expect, test } from "vitest";
import { extract, placeEntry, relativeName } from "../../src/worker/install/archive.ts";
import type { FsConstants } from "../../src/shared/messages.ts";
import { RuntimeRefused, type EmscriptenFs, type RuntimeHandle } from "../../src/worker/runtime.ts";
import { archive, concat, END, gnuLong, member, pax, type Member } from "../shared/tar.ts";

const BASE = "00000000000000000000000000000000-data";

const fs: FsConstants = {
  errno: { EEXIST: 20, EFBIG: 22, EINVAL: 28, EISDIR: 31, ENOENT: 44, ENOTDIR: 54, EOPNOTSUPP: 138 },
  open: { O_WRONLY: 1, O_CREAT: 64, O_TRUNC: 512, O_NOFOLLOW: 131072 },
  mode: { S_IFMT: 61440, S_IFDIR: 16384, S_IFLNK: 40960 },
};

// The bytes as a stream in pieces of the size.
const streamOf = (bytes: Uint8Array, piece: number): ReadableStream<Uint8Array> => {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) controller.close();
      else controller.enqueue(bytes.slice(at, (at += piece)));
    },
  });
};

interface Decoded {
  headers: TarHeader[];
  data: string[];
  error?: string;
}

const text = new TextDecoder();

// Every entry the strict decoder gives for the archive, fed in pieces of the
// size, with its data, and the error that ended it early, if any.
const decode = async (bytes: Uint8Array, piece = 512): Promise<Decoded> => {
  const decoded: Decoded = { headers: [], data: [] };
  const entries = streamOf(bytes, piece)
    .pipeThrough(createTarDecoder({ strict: true }))
    .getReader();
  try {
    for (;;) {
      const next = await entries.read();
      if (next.done) break;
      decoded.headers.push(next.value.header);
      decoded.data.push(text.decode(await new Response(next.value.body).arrayBuffer()));
    }
  } catch (error) {
    decoded.error = (error as Error).message;
  }
  return decoded;
};

const file = (name: string, data = "data\n", more: Partial<Member> = {}): Member => ({ name, data, ...more });

describe("the strict decoder", () => {
  test("refuses a header whose checksum doesn't match", async () => {
    const bytes = archive([file(`${BASE}/a`), file(`${BASE}/b`)]);
    bytes[1024] ^= 1;
    const { headers, error } = await decode(bytes);
    expect(headers.map(({ name }) => name)).toEqual([`${BASE}/a`]);
    expect(error).toBe("Invalid tar header checksum.");
  });

  test("refuses a header summed as signed bytes", async () => {
    expect((await decode(archive([file(`${BASE}/a`, "a", { signedSum: true })]))).error).toBe(
      "Invalid tar header checksum.",
    );
  });

  test.each([
    ["mid-header", 512 + 512 + 100],
    ["mid-file", 512 + 512 + 512 + 2],
    ["between members", 512 + 512],
    ["without its end-of-archive blocks", 512 + 512 + 512 + 512],
    ["after one end-of-archive block", 512 + 512 + 512 + 512 + 512],
  ])("refuses an archive cut short %s", async (_, cut) => {
    const bytes = archive([file(`${BASE}/a`), file(`${BASE}/b`, "b".repeat(600))]).subarray(0, cut);
    expect((await decode(bytes, 7)).error).toBe("Tar archive is truncated.");
  });

  test("refuses a lone zero block before a member", async () => {
    const bytes = concat(member(file(`${BASE}/a`)), new Uint8Array(512), member(file(`${BASE}/b`)), END);
    expect((await decode(bytes)).error).toBe("Invalid tar header.");
  });

  test("takes zeros after the end-of-archive blocks, and refuses anything else", async () => {
    const bytes = archive([file(`${BASE}/a`)]);
    expect((await decode(concat(bytes, new Uint8Array(9216)))).error).toBeUndefined();
    expect((await decode(concat(bytes, new TextEncoder().encode("trailing")))).error).toBe("Invalid EOF.");
  });

  test("takes a name and a link target longer than ustar's from a pax header", async () => {
    const name = `${BASE}/${"n".repeat(120)}.txt`;
    const target = `/nix/store/${"t".repeat(120)}/share/data`;
    const { headers, data, error } = await decode(
      archive([
        pax({ path: name, mtime: "0" }),
        file(`${BASE}/short`, "long\n"),
        pax({ linkpath: target }),
        { name: `${BASE}/link`, type: "2" },
      ]),
      13,
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ name, type, linkname }) => [name, type, linkname])).toEqual([
      [name, "file", ""],
      [`${BASE}/link`, "symlink", target],
    ]);
    expect(data[0]).toBe("long\n");
  });

  // A later global header's records replace an earlier one's, though what
  // the earlier one set, such as a name, stays.
  test("applies a global header's records to every member after it", async () => {
    const { headers, error } = await decode(
      archive([
        pax({ comment: "global" }, "g"),
        file(`${BASE}/a`),
        pax({ path: "elsewhere/x" }, "g"),
        file(`${BASE}/b`),
      ]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ name, pax }) => [name, pax?.["comment"]])).toEqual([
      [`${BASE}/a`, "global"],
      ["elsewhere/x", undefined],
    ]);
  });

  test("takes GNU's long names and link targets", async () => {
    const name = `${BASE}/${"g".repeat(150)}`;
    const target = `/nix/store/${"k".repeat(150)}`;
    const { headers, error } = await decode(
      archive([gnuLong("L", name), file(`${BASE}/x`), gnuLong("K", target), { name: `${BASE}/link`, type: "2" }]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ name, linkname }) => [name, linkname])).toEqual([
      [name, ""],
      [`${BASE}/link`, target],
    ]);
  });

  test("frames a member's data by a pax size record", async () => {
    const { headers, data, error } = await decode(
      archive([
        pax({ size: "3" }),
        file(`${BASE}/a`, "abc", { sizeField: [...new TextEncoder().encode("00000000007\0")] }),
      ]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ size, pax }) => [size, pax?.["size"]])).toEqual([[3, "3"]]);
    expect(data).toEqual(["abc"]);
  });

  test.each([
    ["a length past its newline", "30 path=short\n", `short\n`],
    ["a length short of its newline", "13 path=short\n", "shor"],
  ])("misreads a pax record with %s", async (_, records, name) => {
    const { headers, error } = await decode(archive([pax(records), file(`${BASE}/a`)]));
    expect(error).toBeUndefined();
    expect(headers.map(({ name }) => name)).toEqual([name]);
  });

  test.each([
    ["no length", "path=short\n"],
    ["a length that isn't a number", "x2 path=short\n"],
    ["no key", "9 =value\n"],
  ])("ignores a pax record with %s", async (_, records) => {
    const { headers, error } = await decode(archive([pax(records), file(`${BASE}/a`)]));
    expect(error).toBeUndefined();
    expect(headers.map(({ name }) => name)).toEqual([`${BASE}/a`]);
  });

  test("reads a size field that isn't octal as a number all the same", async () => {
    const { headers, error } = await decode(
      archive([file(`${BASE}/a`, "12345", { sizeField: [...new TextEncoder().encode("0000000001a\0")] })]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ size }) => size)).toEqual([57]);
  });

  test("takes GNU's base-256 size", async () => {
    const { headers, data } = await decode(
      archive([file(`${BASE}/a`, "12345", { sizeField: [0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5] })]),
    );
    expect(headers.map(({ size }) => size)).toEqual([5]);
    expect(data).toEqual(["12345"]);
  });

  test("reads a whole 100-byte name and 155-byte prefix", async () => {
    const name = "n".repeat(100);
    const prefix = "p".repeat(155);
    const { headers } = await decode(archive([file(name), file("f.txt", "x", { prefix })]));
    expect(headers.map(({ name }) => name)).toEqual([name, `${prefix}/f.txt`]);
  });

  test("gives a directory or link no data, whatever its size field", async () => {
    const one = [...new TextEncoder().encode("00000000001\0")];
    const { headers, error } = await decode(
      archive([
        { name: `${BASE}/dir/`, type: "5", sizeField: one },
        { name: `${BASE}/link`, type: "2", linkname: "x", sizeField: one },
      ]),
    );
    expect(error).toBeUndefined();
    expect(headers.map(({ type, size }) => [type, size])).toEqual([
      ["directory", 0],
      ["symlink", 0],
    ]);
  });

  test("names the types it knows, and takes any other as a regular file", async () => {
    const { headers } = await decode(
      archive([
        { name: `${BASE}/hard`, type: "1", linkname: `${BASE}/a` },
        { name: `${BASE}/chr`, type: "3" },
        { name: `${BASE}/fifo`, type: "6" },
        { name: `${BASE}/contiguous`, type: "7" },
        { name: `${BASE}/sparse`, type: "S" },
      ]),
    );
    expect(headers.map(({ type }) => type)).toEqual(["link", "character-device", "fifo", "file", "file"]);
  });

  test("reads a header without ustar's magic", async () => {
    const bytes = archive([file(`${BASE}/a`)]);
    bytes.fill(0, 257, 265);
    // The checksum covers the magic.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : bytes[i]!;
    bytes.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    const { headers, error } = await decode(bytes);
    expect(error).toBeUndefined();
    expect(headers.map(({ name }) => name)).toEqual([`${BASE}/a`]);
  });
});

describe("the installer's checks of each entry", () => {
  const placed = (header: Partial<TarHeader>): string =>
    placeEntry({ size: 0, type: "file", ...header } as TarHeader, BASE, fs);

  test("resolve names relative to the store's root", () => {
    expect(relativeName(`./${BASE}//a/./b`)).toBe(`${BASE}/a/b`);
    expect(relativeName("./")).toBe("");
    for (const name of ["", "/abs", `${BASE}/../x`, `${BASE}/a/..`]) expect(relativeName(name)).toBeNull();
    expect(placed({ name: `./${BASE}/a` })).toBe(`${BASE}/a`);
    expect(placed({ name: BASE, type: "directory" })).toBe(BASE);
  });

  test.each([
    ["an absolute name", { name: `/${BASE}/a` }, fs.errno.EINVAL],
    ["a .. component", { name: `${BASE}/../${BASE}/a` }, fs.errno.EINVAL],
    ["a hard link", { name: `${BASE}/a`, type: "link" }, fs.errno.EOPNOTSUPP],
    ["a device", { name: `${BASE}/a`, type: "character-device" }, fs.errno.EINVAL],
    ["a FIFO", { name: `${BASE}/a`, type: "fifo" }, fs.errno.EINVAL],
    ["a pax size", { name: `${BASE}/a`, pax: { size: "1" } }, fs.errno.EINVAL],
    ["a newline in its name", { name: `${BASE}/a\n` }, fs.errno.EINVAL],
    ["a NUL in its link target", { name: `${BASE}/a`, type: "symlink", linkname: "x\0y" }, fs.errno.EINVAL],
  ] as const)("refuse %s", (_, header, errno) => {
    expect(() => placed(header as Partial<TarHeader>)).toThrow(
      new RuntimeRefused(`${JSON.stringify(header.name)}: -${errno}`),
    );
  });

  test.each(["elsewhere/x", `${BASE}x/a`, "."])("refuse %s, outside the store path", (name) => {
    expect(() => placed({ name })).toThrow("lies outside");
  });
});

// A file system that records each call, failing the one named.
const recording = (failing: { call: keyof EmscriptenFs; with: "errno" | "trap" }) => {
  const calls: string[] = [];
  class ErrnoError extends Error {
    readonly errno: number;
    constructor(errno: number) {
      super(`errno ${errno}`);
      this.errno = errno;
    }
  }
  const call =
    <T>(name: keyof EmscriptenFs, result: T) =>
    (...args: unknown[]): T => {
      calls.push(`${name} ${args.map((arg) => (typeof arg === "object" ? "-" : String(arg))).join(" ")}`);
      if (failing.call === name) {
        if (failing.with === "trap") throw new WebAssembly.RuntimeError("unreachable");
        throw new ErrnoError(5);
      }
      return result;
    };
  const FS = {
    ErrnoError,
    mkdir: call("mkdir", undefined),
    symlink: call("symlink", 0),
    unlink: call("unlink", 0),
    lstat: (path: string) => {
      calls.push(`lstat ${path}`);
      if (path === "/root") return { mode: fs.mode.S_IFDIR | 0o755, size: 0 };
      throw new ErrnoError(fs.errno.ENOENT);
    },
    chmod: call("chmod", undefined),
    open: call("open", { fd: 7 }),
    fchmod: call("fchmod", undefined),
    ftruncate: call("ftruncate", undefined),
    write: (stream: { fd: number }, data: Uint8Array, offset: number, length: number) =>
      call("write", length)(stream.fd, data, offset, length),
    close: call("close", undefined),
  };
  const handle = {
    rt: { FS, _fsync: () => 0, ___errno_location: () => 0 },
    words: new Int32Array(1),
    fs,
  } as unknown as RuntimeHandle;
  return { handle, calls };
};

describe("the installer's writes", () => {
  const tree = archive([file(`${BASE}/a`, "x".repeat(70_000))]);

  test("go in 64 KiB pieces from the file's start, each file's fsync()ed and closed", async () => {
    const { handle, calls } = recording({ call: "symlink", with: "errno" });
    const written = await extract(
      handle,
      streamOf(tree, 100_000),
      "test",
      "/root",
      BASE,
      70_000,
      { fed: 0, files: 0, bytes: 0 },
      {},
    );
    expect(written).toEqual({ files: 1, bytes: 70_000 });
    expect(calls.filter((call) => /^(open|ftruncate|write|close)/.test(call))).toEqual([
      `open /root/${BASE}/a ${fs.open.O_WRONLY | fs.open.O_CREAT | fs.open.O_TRUNC | fs.open.O_NOFOLLOW} ${0o644}`,
      "ftruncate 7 70000",
      "write 7 - 0 65536",
      "write 7 - 0 4464",
      "close -",
    ]);
  });

  test.each([
    ["errno", true],
    ["trap", false],
  ] as const)("that fail with %s close the file only while the runtime is fit to call", async (failure, closes) => {
    const { handle, calls } = recording({ call: "write", with: failure });
    const result = extract(
      handle,
      streamOf(tree, 512),
      "test",
      "/root",
      BASE,
      70_000,
      { fed: 0, files: 0, bytes: 0 },
      {},
    );
    if (closes) await expect(result).rejects.toThrow(new RuntimeRefused(`test: "${BASE}/a": -5`));
    else await expect(result).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
    expect(calls.includes("close -")).toBe(closes);
  });
});
