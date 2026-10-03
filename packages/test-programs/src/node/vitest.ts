// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// What a Vitest configuration needs to run WebAssembly in browsers: the
// headers that make a page cross-origin isolated, files served as they are
// on disk, and Playwright's browsers as Nix provides them.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream";
import { playwright } from "@vitest/browser-playwright";
import type { Plugin } from "vitest/config";
import type { BrowserConfigOptions } from "vitest/node";

// Every response, errors included, carries these, without which a page has
// no SharedArrayBuffer, and so runs nothing with threads.
export const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const types: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".tar": "application/x-tar",
};

export type Handler = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;

// Serves each directory under prefix + its name, as it is on disk: Vite
// would rewrite module scripts. A request under the prefix that names no
// file of a known type is a 404; any other goes to next().
export const serveDirs = (prefix: string, dirs: Readonly<Record<string, string>>): Handler => {
  const resolve = (pathname: string): string | undefined => {
    const [name, ...rest] = pathname.slice(prefix.length).split("/");
    const dir = dirs[name ?? ""];
    if (dir === undefined) return undefined;
    const root = resolvePath(dir);
    const file = join(root, rest.join("/"));
    return file.startsWith(root + sep) ? file : undefined;
  };
  const fail = (response: ServerResponse, status: number): void => {
    response.writeHead(status, { ...crossOriginIsolation, "Content-Type": "text/plain; charset=utf-8" });
    response.end(`${status}\n`);
  };
  return (request, response, next) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      return next();
    }
    if (!pathname.startsWith(prefix)) return next();
    const file = resolve(pathname);
    const type = file === undefined ? undefined : types[extname(file)];
    if (file === undefined || type === undefined) return fail(response, 404);
    stat(file).then(
      (info) => {
        if (!info.isFile()) return fail(response, 404);
        response.writeHead(200, {
          ...crossOriginIsolation,
          "Content-Type": type,
          "Content-Length": info.size,
          "Cache-Control": "no-store",
        });
        if (request.method === "HEAD") response.end();
        // The status is out by now, so a read that fails can only cut the
        // response short, which pipeline() does by destroying it.
        else pipeline(createReadStream(file), response, () => {});
      },
      () => fail(response, 404),
    );
  };
};

const UNANALYZABLE_IMPORT = "The above dynamic import cannot be analyzed by Vite";

// The handler, in Vite's server.
export const servePlugin = (name: string, handle: Handler): Plugin => ({
  name,
  configureServer: (server) => {
    server.middlewares.use(handle);
  },
  // Vite warns that it can't analyze a dynamic import in Vitest's own
  // module runner, which every browser test file pulls in to reach Vitest.
  // Vitest drops the same warning from its own server's log, but not from
  // the browser server's.
  configResolved: (config) => {
    const { logger } = config;
    const warn = logger.warn.bind(logger);
    logger.warn = (message, options) => {
      if (message.includes(UNANALYZABLE_IMPORT) && message.includes("vite_module-runner")) return;
      warn(message, options);
    };
  },
});

// Playwright says so on stderr every time it launches a browser, which it
// does with host validation off because Nix, not the host's packages,
// provides the browsers' libraries.
const SKIPPING_VALIDATION = "Skipping host requirements validation";
let droppingSkippingValidation = false;
const dropSkippingValidation = (): void => {
  if (droppingSkippingValidation) return;
  droppingSkippingValidation = true;
  const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
    typeof chunk === "string" && chunk.startsWith(SKIPPING_VALIDATION)
      ? true
      : write(chunk, ...rest)) as typeof process.stderr.write;
};

// Playwright turns Chromium's own sandbox off unless asked; runs keep it on,
// as a browser would, unless IBUS_WEB_CHROMIUM_SANDBOX=0.
const chromiumSandbox = process.env["IBUS_WEB_CHROMIUM_SANDBOX"] !== "0";

export type Browser = "chromium" | "firefox";

// Vitest's browser mode over the browsers, headless, with the commands
// test files call.
export const browserMode = (
  browsers: readonly Browser[],
  commands: NonNullable<BrowserConfigOptions["commands"]>,
): BrowserConfigOptions => {
  dropSkippingValidation();
  return {
    enabled: true,
    headless: true,
    // A page shows nothing a test asserts on.
    screenshotFailures: false,
    commands,
    instances: browsers.map((browser) => ({
      browser,
      name: browser,
      provider: playwright({ launchOptions: browser === "chromium" ? { chromiumSandbox } : {} }),
    })),
  };
};
