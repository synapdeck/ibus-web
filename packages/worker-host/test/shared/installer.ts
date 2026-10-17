// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The installer's policy, held against the real runtime: each scenario
// extracts archives with HostOp.install into a memory mount of its own and
// looks at what it made through HostOp.fs, so it runs in any environment.

import { expect } from "vitest";
import type { Client } from "./client.ts";
import type { Harness, RunningHost } from "./harness.ts";
import { opsOf, stats } from "./scenarios.ts";
import { counts } from "./install.ts";
import { replyFile } from "./storage.ts";
import type { Member } from "./tar.ts";
import {
  HostOp,
  type ArchivePart,
  type FsAction,
  type FsResult,
  type InstallOpReply,
  type InstallOpRequest,
} from "./testing.ts";

const MOUNT = "/ibus-web-install-test";
const BASE = "00000000000000000000000000000000-base";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Requests that do a whole install are no keystroke, and their time is no
// criterion; they let the page go at once, since in Firefox a response body
// the host fetches waits while the page spins.
const UNHELD = { budgetMs: 1 };

const json = async <T>(client: Client, op: number, request: unknown): Promise<T> => {
  const { ret, bytes } = await client.call(op, encoder.encode(JSON.stringify(request)), UNHELD);
  if (ret < 0) throw new Error(`host op ${op}: ${ret}`);
  return JSON.parse(decoder.decode(bytes)) as T;
};

export const fs = (client: Client, actions: readonly FsAction[]): Promise<FsResult[]> =>
  json<FsResult[]>(client, HostOp.fs, actions);

const one = async (client: Client, action: FsAction): Promise<FsResult> => (await fs(client, [action]))[0]!;

const install = (client: Client, request: InstallOpRequest): Promise<InstallOpReply> =>
  json<InstallOpReply>(client, HostOp.install, request);

const mounted = new WeakSet<Client>();
let made = 0;

// A directory of its own on the tests' memory mount for each install.
const freshDir = async (client: Client): Promise<string> => {
  if (!mounted.has(client)) {
    expect(await one(client, { op: "mount", path: MOUNT }), "the tests' mount").toEqual({});
    mounted.add(client);
  }
  const dir = `${MOUNT}/${made++}`;
  expect(await one(client, { op: "mkdir", path: dir }), dir).toEqual({});
  return dir;
};

const errno = (h: Harness, name: string): number => {
  const value = h.data.errno[name];
  if (value === undefined) throw new Error(`no ${name} in Emscripten's errno.h`);
  return value;
};

// The refusal the installer reports for the entry and errno.
const refusal = (h: Harness, name: string, errnoName: string): string =>
  `install: ${JSON.stringify(name)}: -${errno(h, errnoName)}`;

const exists = async (client: Client, path: string): Promise<boolean> =>
  (await one(client, { op: "lstat", path })).errno === undefined;

const read = async (client: Client, path: string): Promise<unknown> => (await one(client, { op: "read", path })).value;

const modeOf = async (client: Client, path: string): Promise<number> =>
  ((await one(client, { op: "lstat", path })).value as { mode: number }).mode;

const listing = async (h: Harness, client: Client, path: string): Promise<string | number> => {
  const reply = replyFile(await client.call(opsOf(h).listTree, encoder.encode(path), UNHELD));
  return reply.text ?? reply.status;
};

const members = (...list: readonly (Member | ArchivePart)[]): InstallOpRequest["archive"] => ({
  parts: [...list, { zeros: 1024 }],
});

const file = (name: string, data = "data\n", more: Partial<Member> = {}): Member => ({
  name: `${BASE}/${name}`,
  data,
  ...more,
});

// The test archive's tree, whole, in pieces of each size: header and data
// boundaries fall anywhere within a piece, and its counts are the
// listing's. Byte by byte, which Firefox's streams take some 40 s over for
// the whole tree, an archive of pax headers and a file goes in.
export const installWhole = async (h: Harness, host: RunningHost): Promise<void> => {
  const { tree } = h.data.archives;
  const { base, data, long } = h.data.archives.installer;
  for (const piece of [7, 511, 513, 65536, 1 << 20]) {
    const dir = await freshDir(host.client);
    const reply = await install(host.client, { dir, storeName: data, archive: { url: tree.url }, piece });
    expect(reply, `pieces of ${piece} bytes`).toEqual({ ok: true, ...counts(tree) });
    expect(await listing(h, host.client, `${dir}/${data}`), `pieces of ${piece} bytes`).toBe(tree.listing);
  }
  const dir = await freshDir(host.client);
  expect(
    await install(host.client, { dir, storeName: long.storeName, archive: { url: `${base}long.tar` }, piece: 1 }),
  ).toEqual({ ok: true, files: 1, bytes: 5 });
  expect(await read(host.client, `${dir}/${long.storeName}/${long.name}`)).toBe("long\n");
};

// An install cut short, over files longer than the archive's, then a whole
// one over that: every file the archive has is the archive's, truncated
// and rewritten.
export const installOverPartial = async (h: Harness, host: RunningHost): Promise<void> => {
  const { tree } = h.data.archives;
  const { data } = h.data.archives.installer;
  const dir = await freshDir(host.client);
  const root = `${dir}/${data}`;
  expect(
    await fs(host.client, [
      { op: "mkdir", path: root },
      { op: "mkdir", path: `${root}/share` },
      { op: "mkdir", path: `${root}/share/dict` },
      { op: "write", path: `${root}/share/dict/main.dict`, size: 700_000 },
      { op: "write", path: `${root}/README`, size: 4096 },
    ]),
  ).toEqual([{}, {}, {}, {}, {}]);
  const half = await install(host.client, {
    dir,
    storeName: data,
    archive: { url: tree.url },
    cut: Math.floor(tree.size / 2),
    piece: 4096,
  });
  expect(half).toEqual({ ok: false, message: "install: Tar archive is truncated." });
  expect(await install(host.client, { dir, storeName: data, archive: { url: tree.url } })).toEqual({
    ok: true,
    ...counts(tree),
  });
  expect(await listing(h, host.client, root)).toBe(tree.listing);
};

// Each refused archive's first file is taken; the refusal is its second
// member's, and nothing of it is made.
export const installRefused = async (h: Harness, host: RunningHost): Promise<void> => {
  const { base, refused } = h.data.archives.installer;
  const cases = [
    ["absolute", "/ibus-web-escape.txt", "EINVAL"],
    ["dotdot", `${refused}/../../ibus-web-escape.txt`, "EINVAL"],
    ["hardlink", `${refused}/hard`, "EOPNOTSUPP"],
    ["fifo", `${refused}/fifo`, "EINVAL"],
  ] as const;
  for (const [archive, name, errnoName] of cases) {
    const dir = await freshDir(host.client);
    const reply = await install(host.client, {
      dir,
      storeName: refused,
      archive: { url: `${base}refused/${archive}.tar` },
    });
    expect(reply, archive).toEqual({ ok: false, message: refusal(h, name, errnoName) });
    expect(await read(host.client, `${dir}/${refused}/ok.txt`), archive).toBe("accepted\n");
    for (const escape of [`${dir}/ibus-web-escape.txt`, `${MOUNT}/ibus-web-escape.txt`, "/ibus-web-escape.txt"])
      expect(await exists(host.client, escape), `${archive}: ${escape}`).toBe(false);
    for (const made of [`${dir}/${refused}/hard`, `${dir}/${refused}/fifo`])
      expect(await exists(host.client, made), `${archive}: ${made}`).toBe(false);
  }
  const dir = await freshDir(host.client);
  expect(
    await install(host.client, { dir, storeName: refused, archive: { url: `${base}refused/outside.tar` } }),
  ).toEqual({ ok: false, message: `install: archive entry "ibus-web-escape.txt" lies outside ${refused}` });
  expect(await exists(host.client, `${dir}/ibus-web-escape.txt`)).toBe(false);
};

// What the strict decoder refuses fails the install: a broken checksum, an
// archive cut short anywhere, a lone zero block, and anything but zeros
// after the end.
export const installMalformed = async (h: Harness, host: RunningHost): Promise<void> => {
  const { base, data } = h.data.archives.installer;
  const check = async (what: string, request: Omit<InstallOpRequest, "dir">, message: string): Promise<void> => {
    const dir = await freshDir(host.client);
    expect(await install(host.client, { dir, ...request }), what).toEqual({
      ok: false,
      message: `install: ${message}`,
    });
  };
  await check(
    "corrupt.tar",
    { storeName: data, archive: { url: `${base}corrupt.tar` } },
    "Invalid tar header checksum.",
  );
  const twoFiles = members(file("a"), file("b", "b".repeat(600)));
  for (const [where, cut] of [
    ["mid-header", 512 + 512 + 100],
    ["mid-file", 512 + 512 + 512 + 2],
    ["between members", 512 + 512],
    ["before its end-of-archive blocks", 512 + 512 + 512 + 1024],
  ] as const)
    await check(`cut ${where}`, { storeName: BASE, archive: twoFiles, cut, piece: 512 }, "Tar archive is truncated.");
  await check(
    "a lone zero block",
    { storeName: BASE, archive: members(file("a"), { zeros: 512 }, file("b")) },
    "Invalid tar header.",
  );
  await check(
    "trailing bytes",
    { storeName: BASE, archive: { parts: [file("a"), { zeros: 1024 }, { text: "trailing" }] } },
    "Invalid EOF.",
  );
  await check(
    "a checksum summed as signed bytes",
    { storeName: BASE, archive: members(file("signed", "signed\n", { signedSum: true })) },
    "Invalid tar header checksum.",
  );
  const dir = await freshDir(host.client);
  expect(
    await install(host.client, {
      dir,
      storeName: data,
      archive: { parts: [{ text: "" }] },
    }),
    "no archive at all",
  ).toEqual({ ok: false, message: "install: Tar archive is truncated." });
  // GNU tar pads an archive to a whole record with zeros.
  const padded = await freshDir(host.client);
  expect(
    await install(host.client, {
      dir: padded,
      storeName: BASE,
      archive: { parts: [file("a"), { zeros: 1024 }, { zeros: 9216 }] },
    }),
  ).toEqual({ ok: true, files: 1, bytes: 5 });
};

// The limit refuses a file that would pass it before its parents or the
// file are made; a limit of the data's exact size, or of nothing for no
// data, is met.
export const installLimit = async (h: Harness, host: RunningHost): Promise<void> => {
  const big = file("too-large/file", undefined, { sizeField: [...encoder.encode("77777777777\0")] });
  for (const limit of [0, 3]) {
    const dir = await freshDir(host.client);
    const reply = await install(host.client, {
      dir,
      storeName: BASE,
      limit,
      archive: { parts: [file("ok", "abc"), big] },
      piece: 7,
    });
    expect(reply, `limit ${limit}`).toEqual({
      ok: false,
      message: refusal(h, limit === 0 ? `${BASE}/ok` : `${BASE}/too-large/file`, "EFBIG"),
    });
    expect(await exists(host.client, `${dir}/${BASE}/too-large`), `limit ${limit}`).toBe(false);
    expect(await exists(host.client, `${dir}/${BASE}/ok`), `limit ${limit}`).toBe(limit === 3);
  }
  for (const data of ["", "abc"]) {
    const dir = await freshDir(host.client);
    expect(
      await install(host.client, {
        dir,
        storeName: BASE,
        limit: data.length,
        archive: members(file("f", data)),
        piece: 1,
      }),
    ).toEqual({ ok: true, files: 1, bytes: data.length });
  }
};

// Entries take the archive's mode plus the owner's read and write (and
// search, for a directory), whether new or there already.
export const installModes = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  const root = `${dir}/${BASE}`;
  expect(
    await fs(host.client, [
      { op: "mkdir", path: root },
      { op: "mkdir", path: `${root}/old`, mode: 0o700 },
      { op: "chmod", path: `${root}/old`, mode: 0o700 },
      { op: "write", path: `${root}/old/file`, text: "oooooooooo", mode: 0o666 },
      { op: "chmod", path: `${root}/old/file`, mode: 0o666 },
    ]),
  ).toEqual([{}, {}, {}, {}, {}]);
  const reply = await install(host.client, {
    dir,
    storeName: BASE,
    archive: members(
      { name: `${BASE}/old/`, type: "5", mode: 0o751 },
      file("old/file", "old\n", { mode: 0o640 }),
      { name: `${BASE}/new/`, type: "5", mode: 0o555 },
      file("new/file", "new\n", { mode: 0o444 }),
    ),
  });
  expect(reply).toEqual({ ok: true, files: 2, bytes: 8 });
  const modes = [];
  for (const path of ["old", "old/file", "new", "new/file"])
    modes.push((await modeOf(host.client, `${root}/${path}`)) & 0o7777);
  expect(modes).toEqual([0o751, 0o640, 0o755, 0o644]);
  expect(await read(host.client, `${root}/old/file`)).toBe("old\n");
};

// A symbolic link is made with its target as the archive has it, relative
// or absolute, and reads through to it; it counts as no file and no bytes.
// Its parents are made as a file's are, and a link to "/" is a link like
// any other.
export const installSymlinks = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  const root = `${dir}/${BASE}`;
  const absolute = `${root}/data.txt`;
  const reply = await install(host.client, {
    dir,
    storeName: BASE,
    piece: 7,
    archive: members(
      { name: `${BASE}/`, type: "5", mode: 0o755 },
      file("data.txt", "data\n", { mode: 0o444 }),
      { name: `${BASE}/relative`, type: "2", linkname: "data.txt" },
      { name: `${BASE}/absolute`, type: "2", linkname: absolute },
      { name: `${BASE}/sub/deep`, type: "2", linkname: "../data.txt" },
      { name: `${BASE}/dir-link`, type: "2", linkname: "sub" },
    ),
  });
  expect(reply).toEqual({ ok: true, files: 1, bytes: 5 });
  const results = await fs(host.client, [
    { op: "readlink", path: `${root}/relative` },
    { op: "readlink", path: `${root}/absolute` },
    { op: "readlink", path: `${root}/sub/deep` },
    ...["relative", "absolute", "sub/deep", "dir-link/deep"].map((path): FsAction => ({
      op: "read",
      path: `${root}/${path}`,
    })),
  ]);
  expect(results.map(({ value }) => value)).toEqual([
    "data.txt",
    absolute,
    "../data.txt",
    "data\n",
    "data\n",
    "data\n",
    "data\n",
  ]);

  const { base, refused } = h.data.archives.installer;
  const rooted = await freshDir(host.client);
  expect(
    await install(host.client, { dir: rooted, storeName: refused, archive: { url: `${base}symlink.tar` } }),
  ).toEqual({
    ok: true,
    files: 1,
    bytes: 9,
  });
  expect((await one(host.client, { op: "readlink", path: `${rooted}/${refused}/link` })).value).toBe("/");
};

// The 5b-style archive: a name and a link target longer than ustar holds,
// from pax headers.
export const installLongNames = async (h: Harness, host: RunningHost): Promise<void> => {
  const { base, long } = h.data.archives.installer;
  const dir = await freshDir(host.client);
  expect(await install(host.client, { dir, storeName: long.storeName, archive: { url: `${base}long.tar` } })).toEqual({
    ok: true,
    files: 1,
    bytes: 5,
  });
  const root = `${dir}/${long.storeName}`;
  expect(await read(host.client, `${root}/${long.name}`)).toBe("long\n");
  expect((await one(host.client, { op: "readlink", path: `${root}/data/link` })).value).toBe(long.target);
};

// A link's name is held to a file's rules, and it names something; a hard
// link fails before anything is made of it.
export const installLinksRefused = async (h: Harness, host: RunningHost): Promise<void> => {
  const cases: [Member, string, string][] = [
    [{ name: `/${BASE}/escape`, type: "2", linkname: "x" }, `/${BASE}/escape`, "EINVAL"],
    [{ name: `${BASE}/sub/../../escape`, type: "2", linkname: "x" }, `${BASE}/sub/../../escape`, "EINVAL"],
    [{ name: `${BASE}/empty`, type: "2", linkname: "" }, `${BASE}/empty`, "EINVAL"],
    [{ name: `${BASE}/b`, type: "1", linkname: `${BASE}/a` }, `${BASE}/b`, "EOPNOTSUPP"],
  ];
  for (const [link, name, errnoName] of cases) {
    const dir = await freshDir(host.client);
    expect(await install(host.client, { dir, storeName: BASE, archive: members(file("a"), link) }), name).toEqual({
      ok: false,
      message: refusal(h, name, errnoName),
    });
    for (const escape of [`${dir}/escape`, `${MOUNT}/escape`, "/escape", `${dir}/${BASE}/b`])
      expect(await exists(host.client, escape), `${name}: ${escape}`).toBe(false);
  }
};

// Nothing is written through a link the archive made: an entry under a
// link fails, and a file or link at a link's name replaces the link; a
// link also replaces a file, and fails on a directory, as a file does.
export const installThroughLinks = async (h: Harness, host: RunningHost): Promise<void> => {
  const elsewhere = await freshDir(host.client);
  expect(await one(host.client, { op: "write", path: `${elsewhere}/target`, text: "ttt" })).toEqual({});
  for (const under of [file("out/escaped.txt", "escaped\n"), { name: `${BASE}/out/sub/`, type: "5" }] as Member[]) {
    const dir = await freshDir(host.client);
    expect(
      await install(host.client, {
        dir,
        storeName: BASE,
        archive: members({ name: `${BASE}/out`, type: "2", linkname: elsewhere }, under),
      }),
      under.name,
    ).toEqual({ ok: false, message: refusal(h, under.name.replace(/\/$/, ""), "ENOTDIR") });
  }
  expect(await exists(host.client, `${elsewhere}/escaped.txt`)).toBe(false);
  expect(await exists(host.client, `${elsewhere}/sub`)).toBe(false);

  const dir = await freshDir(host.client);
  const target = `${elsewhere}/target`;
  expect(
    await install(host.client, {
      dir,
      storeName: BASE,
      archive: members(
        { name: `${BASE}/file`, type: "2", linkname: target },
        file("file", "file\n"),
        file("link", "link\n"),
        { name: `${BASE}/link`, type: "2", linkname: target },
      ),
    }),
  ).toEqual({ ok: true, files: 2, bytes: 10 });
  expect(await read(host.client, `${dir}/${BASE}/file`)).toBe("file\n");
  expect((await one(host.client, { op: "readlink", path: `${dir}/${BASE}/link` })).value).toBe(target);
  expect(await read(host.client, target)).toBe("ttt");

  for (const [over, errnoName] of [
    [{ name: `${BASE}/dir`, type: "2", linkname: "elsewhere" }, "EISDIR"],
    [file("dir", "file\n"), "EISDIR"],
  ] as [Member, string][]) {
    const into = await freshDir(host.client);
    expect(
      await install(host.client, {
        dir: into,
        storeName: BASE,
        archive: members({ name: `${BASE}/dir/`, type: "5", mode: 0o755 }, over),
      }),
      over.type ?? "file",
    ).toEqual({ ok: false, message: refusal(h, `${BASE}/dir`, errnoName) });
    expect(((await modeOf(host.client, `${into}/${BASE}/dir`)) & 0o170000) === 0o040000).toBe(true);
  }
};

// The installer's directory must be one.
export const installTarget = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  expect(await one(host.client, { op: "write", path: `${dir}/file`, text: "z" })).toEqual({});
  for (const [target, errnoName] of [
    [`${dir}/missing`, "ENOENT"],
    [`${dir}/file`, "ENOTDIR"],
  ] as const)
    expect(await install(host.client, { dir: target, storeName: BASE, archive: members(file("a")) }), target).toEqual({
      ok: false,
      message: `install: ${JSON.stringify(target)}: -${errno(h, errnoName)}`,
    });
};

// A host that mounts the engine's data in memory adds the data's size, in
// whole pages, to the runtime's memory, so a large file has to fit in about
// its own size: grown piece by piece, the memory backend's buffer would
// reach twice the file and need the old buffer beside the new while it
// moves. The install runs with the rest of the memory taken, leaving the
// file's pages and a headroom that stands for what the runtime's own
// memory has spare.
export const installLargeFile = async (h: Harness, host: RunningHost): Promise<void> => {
  const size = 16 * 1024 * 1024 + 1;
  const dir = await freshDir(host.client);
  const reply = await install(host.client, {
    dir,
    storeName: BASE,
    archive: members(file("large.bin", undefined, { data: { size } })),
    squeeze: { file: size, headroom: 1024 * 1024 },
  });
  expect(reply).toEqual({ ok: true, files: 1, bytes: size });
  const path = `${dir}/${BASE}/large.bin`;
  expect((await one(host.client, { op: "pattern", path })).value).toEqual({ size });
  expect(await one(host.client, { op: "unlink", path })).toEqual({});
};

// WasmFS's memory backend keeps a file object and a directory entry for each
// directory, file and link it holds, beside a file's data, which the memory
// fallback allows memoryFileBytes for: an install of many small entries
// takes no more than that each beyond the data.
export const installPerEntry = async (h: Harness, host: RunningHost): Promise<void> => {
  // As many as the request slot carries as JSON.
  const dirs = 25;
  const filesEach = 16;
  const list: Member[] = [{ name: `${BASE}/`, type: "5", mode: 0o755 }];
  for (let d = 0; d < dirs; d++) {
    list.push({ name: `${BASE}/d${d}/`, type: "5", mode: 0o755 });
    for (let f = 0; f < filesEach; f++) list.push(file(`d${d}/f${f}`, "x"));
    list.push({ name: `${BASE}/d${d}/link`, type: "2", linkname: "f0" });
  }
  const entries = list.length;
  const bytes = dirs * filesEach;

  const dir = await freshDir(host.client);
  const before = (await stats(host.client)).heapInUse;
  expect(await install(host.client, { dir, storeName: BASE, archive: members(...list) })).toEqual({
    ok: true,
    files: bytes,
    bytes,
  });
  const after = (await stats(host.client)).heapInUse;
  const each = (after - before - bytes) / entries;
  h.record("install per entry", {
    entries,
    bytes,
    heapInUse: after - before,
    each,
    allowed: h.data.constants.memoryFileBytes,
  });
  expect(each).toBeGreaterThan(0);
  expect(each).toBeLessThanOrEqual(h.data.constants.memoryFileBytes);
};

// Each FS call the installer makes, made to fail: WasmFS's JavaScript layer
// gives the errno libc would.
export const fsFailures = async (h: Harness, host: RunningHost): Promise<void> => {
  const dir = await freshDir(host.client);
  const [{ value }] = (await fs(host.client, [{ op: "failures", dir }])) as [{ value: Record<string, number> }];
  const want = (name: string): number => errno(h, name);
  expect(value).toEqual({
    mkdirExisting: want("EEXIST"),
    mkdirMissingParent: want("ENOENT"),
    mkdirUnderFile: want("ENOTDIR"),
    mkdirUnderLink: want("ENOTDIR"),
    lstatMissing: want("ENOENT"),
    lstatUnderFile: want("ENOTDIR"),
    unlinkMissing: want("ENOENT"),
    unlinkDirectory: want("EISDIR"),
    symlinkExisting: want("EEXIST"),
    symlinkMissingParent: want("ENOENT"),
    openDirectory: want("EISDIR"),
    openLink: want("ELOOP"),
    openMissingParent: want("ENOENT"),
    chmodMissing: want("ENOENT"),
    fchmodClosed: want("EBADF"),
    ftruncateClosed: want("EBADF"),
    writeClosed: want("EBADF"),
    closeClosed: want("EBADF"),
    fsyncClosed: want("EBADF"),
  });
};
