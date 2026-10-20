// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { expect, test } from "vitest";
import { build } from "tsdown";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import * as api from "../../src/effect.ts";
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
test("effect consumers retain core services, tagged errors, adapters and protocol schemas", () => {
  expect(api.ModuleRegistry.key).toBe("@ibus-web/core/ModuleRegistry");
  expect(api.Router.Default).toBeDefined();
  expect(api.SettingsApi.layer).toBeTypeOf("function");
  expect(api.textareaAdapter).toBeTypeOf("function");
  expect(new api.CodecError({ message: "invalid" })._tag).toBe("CodecError");
  const crashed = new api.EngineCrashed({ module: "hangul", reason: "FAULT", diagnostic: "boom" });
  expect(crashed).toBeInstanceOf(Error);
  expect(crashed._tag).toBe("EngineCrashed");
  expect(new api.ProtocolError({ module: "m17n" })._tag).toBe("ProtocolError");
  expect(new api.ModuleAbiMismatch({ module: "pinyin" })._tag).toBe("ModuleAbiMismatch");
  expect(new api.ConnectionBusyError()).toBeInstanceOf(Error);
  expect(api.ModuleManifest).toBeDefined();
  expect(api.ProcessKeyEvent).toBeDefined();
});
test("a built package consumer ships URL-only page code and serves every preserved sibling Worker asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "ibus-facade-consumer-"));
  const modules: string[] = [];
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await mkdir(join(root, "node_modules"));
    await symlink(packageRoot, join(root, "node_modules/ibus-web"));
    const entry = join(root, "consumer.ts"),
      out = join(root, "out");
    await writeFile(entry, 'export { workerUrl, relayUrl, brotliFallbackUrl, storageUrl } from "ibus-web/worker";');
    await build({
      config: false,
      entry: [entry],
      outDir: out,
      platform: "neutral",
      format: "esm",
      dts: false,
      deps: { alwaysBundle: ["ibus-web/worker"] },
      plugins: [
        {
          name: "audit-page-modules",
          generateBundle(_options, bundle) {
            for (const item of Object.values(bundle))
              if (item.type === "chunk") modules.push(...Object.keys(item.modules));
          },
        },
      ],
    });
    // This deployment step preserves relative imports and nested Worker URLs.
    await cp(join(packageRoot, "dist/host"), join(out, "host"), { recursive: true });
    // Nix sources are read-only; the temporary deployment must remain removable.
    await chmod(join(out, "host"), 0o755);
    expect(modules.some((path) => /worker-host.*(?:src|dist)\/worker/.test(path))).toBe(false);
    const consumerPath = join(out, "consumer.js");
    const source = await readFile(consumerPath, "utf8");
    expect(source).not.toMatch(/WebAssembly|Emscripten|class WorkerHost|brotli_dec_wasm/);
    const consumer = (await import(pathToFileURL(consumerPath).href)) as {
      workerUrl: URL;
      relayUrl: URL;
      brotliFallbackUrl: URL;
      storageUrl: URL;
    };
    const urls = [consumer.workerUrl, consumer.relayUrl, consumer.brotliFallbackUrl, consumer.storageUrl];
    expect(urls.map((url) => dirname(fileURLToPath(url)))).toEqual([
      join(out, "host"),
      join(out, "host"),
      join(out, "host"),
      join(out, "host"),
    ]);
    const server = createServer((request, response) => {
      void readFile(join(out, new URL(request.url!, "http://localhost").pathname)).then(
        (bytes) => {
          response.setHeader("Content-Type", "text/javascript");
          response.end(bytes);
        },
        () => {
          response.statusCode = 404;
          response.end();
        },
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing address");
      for (const url of urls) {
        const result = await fetch(`http://127.0.0.1:${address.port}/host/${url.pathname.split("/").at(-1)}`);
        expect(result.ok).toBe(true);
        expect(await result.text()).toBe(await readFile(url, "utf8"));
      }
      const host = await readFile(consumer.workerUrl, "utf8");
      expect(host).toContain('"./relay.js"');
      expect(host).toContain('"./brotli-fallback.js"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    expect(await readFile(join(packageRoot, "dist/style.css"), "utf8")).toContain("--ibus-panel-background");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("published facade declarations support typed lifecycle, manual input, settings and panel consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ibus-facade-types-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await mkdir(join(root, "node_modules"));
    await symlink(packageRoot, join(root, "node_modules/ibus-web"));
    const source = join(root, "consumer.ts");
    await writeFile(
      source,
      `// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { CreateEngineError, EngineCrashed, type IbusWeb, type AsyncKeyResult, type SurfaceAdapter } from "ibus-web";
import type { ModuleState, SettingValue } from "ibus-web/effect";
import { createPanel, type PanelHost } from "ibus-web/panel";
import workerUrl from "ibus-web/worker";

/** Compiled against published declarations, including each public subpath. */
export function consumer(app: IbusWeb, adapter: SurfaceAdapter, event: KeyboardEvent) {
  const labels: Record<ModuleState, string> = {
    starting: "Starting",
    ready: "Ready",
    busy: "Busy",
    restarting: "Restarting",
    failed: "Failed",
    unloaded: "Unloaded",
  };
  app.addEventListener("modulestate", ({ detail }) => {
    labels[detail.state].toUpperCase();
    if (detail.error instanceof EngineCrashed) detail.error.reason.toUpperCase();
    detail.error?._tag.toUpperCase();
  });
  app.addEventListener("storage", ({ detail }) => {
    detail.state.toUpperCase();
  });
  app.addEventListener("panel", ({ detail }) => {
    if (detail._tag === "record") detail.record._tag.toUpperCase();
  });
  app.addEventListener("log", ({ detail }) => {
    detail.level.toUpperCase();
  });
  const host: PanelHost = app;
  const panel = createPanel(host);
  const detach = app.attachAdapter(adapter, { keyMode: "manual" });
  const result: Promise<AsyncKeyResult> = app.keyAsync(adapter, event);
  const setting: Promise<SettingValue> = app.settings.get(
    "hangul",
    "org.freedesktop.ibus.panel",
    "lookup-table-orientation",
  );
  const hostUrl: URL = workerUrl;
  const failed = (error: unknown) => error instanceof CreateEngineError && error.diagnostic;
  return { panel, detach, result, setting, hostUrl, failed };
}
`,
    );
    await promisify(execFile)(process.execPath, [
      join(packageRoot, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2023",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      source,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
