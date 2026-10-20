// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { pageBoundaryPlugin } from "../../tools/bundle-scan/scan.ts";
import ibusModule from "@ibus-web/module-kit/vite";
import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type PreviewServer } from "vite";
import { crossOriginIsolation, serveDirs, servePlugin } from "@ibus-web/test-programs/vitest";

export default defineConfig(({ command, isPreview }) => {
  const directories: Record<string, string> = {};
  if (!isPreview)
    for (const name of ["runtime", "host", "modules"]) {
      const path = process.env[`IBUS_WEB_DEMO_${name.toUpperCase()}`];
      if (!path)
        throw new Error(`IBUS_WEB_DEMO_${name.toUpperCase()} is required; run nix run .#demo or enter the dev shell`);
      directories[name] = path;
    }
  return {
    server: { headers: crossOriginIsolation },
    preview: { headers: crossOriginIsolation },
    plugins: [
      ibusModule(),
      ...(command === "build" ? [pageBoundaryPlugin()] : []),
      {
        ...servePlugin("ibus-web-distributions", serveDirs("/ibus-web/", directories)),
        configurePreviewServer(server: PreviewServer) {
          const root = resolve(server.config.root, server.config.build.outDir, "ibus-web");
          server.middlewares.use(
            serveDirs(
              "/ibus-web/",
              Object.fromEntries(["runtime", "host", "modules"].map((name) => [name, resolve(root, name)])),
            ),
          );
        },
      },
      ...(command === "build"
        ? [
            {
              name: "copy-ibus-web-distributions",
              async writeBundle(options: { dir?: string }) {
                // The modules directory links to each distribution; the built page holds copies.
                for (const [name, directory] of Object.entries(directories))
                  await cp(directory, resolve(options.dir ?? "dist", "ibus-web", name), {
                    recursive: true,
                    dereference: true,
                  });
              },
            },
          ]
        : []),
    ],
  };
});
