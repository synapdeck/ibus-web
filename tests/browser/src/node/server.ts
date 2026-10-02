// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A static HTTP server for pages driven in browsers. Every response, errors
// included, carries the headers that make the page cross-origin isolated,
// which SharedArrayBuffer, and so any program with threads, needs.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { pipeline } from "node:stream";
import type { AddressInfo } from "node:net";
import { extname, join, resolve as resolvePath, sep } from "node:path";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".tar": "application/x-tar",
};

export interface Server {
  // The origin, such as http://127.0.0.1:41234.
  origin: string;
  close(): Promise<void>;
}

const fail = (response: ServerResponse, status: number): void => {
  response.writeHead(status, {
    ...isolation,
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(`${status}\n`);
};

// Serves index at / and each directory under its URL prefix ("/dist/", say).
// Only the types above are served.
export const serve = async (
  index: string,
  dirs: Readonly<Record<string, string>>,
): Promise<Server> => {
  const resolve = (pathname: string): string | null => {
    if (pathname === "/" || pathname === "/index.html") return index;
    for (const [prefix, dir] of Object.entries(dirs)) {
      if (!pathname.startsWith(prefix)) continue;
      const root = resolvePath(dir);
      const file = join(root, pathname.slice(prefix.length));
      return file.startsWith(root + sep) ? file : null;
    }
    return null;
  };

  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD")
      return fail(response, 405);
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    } catch {
      return fail(response, 400);
    }
    const file = resolve(pathname);
    const type = file === null ? undefined : types[extname(file)];
    if (file === null || type === undefined) return fail(response, 404);
    stat(file).then(
      (info) => {
        if (!info.isFile()) return fail(response, 404);
        response.writeHead(200, {
          ...isolation,
          "Content-Type": type,
          "Content-Length": info.size,
          "Cache-Control": "no-store",
        });
        if (request.method === "HEAD") response.end();
        // The status is out by now, so a read that fails can only cut the
        // response short, which pipeline() does by destroying it; the
        // browser sees a failed load.
        else pipeline(createReadStream(file), response, () => {});
      },
      () => fail(response, 404),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
