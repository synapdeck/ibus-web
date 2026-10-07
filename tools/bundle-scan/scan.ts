// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { build, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ChunkEvidence {
  fileName: string;
  modules: string[];
  imports: string[];
  dynamicImports: string[];
  sha256: string;
}
const hash = (code: string) => createHash("sha256").update(code).digest("hex");
export function scanChunk(code: string, modules: readonly string[]): void {
  for (const id of modules) {
    const path = id.replaceAll("\\", "/");
    // Only the shared transport/control ABI is page code; executable hosts never are.
    if (
      (/worker-host\/(?:src|dist)\//.test(path) &&
        !/worker-host\/(?:src|dist)\/shared\/(?:index|control|messages|naming|config)\.[cm]?[jt]s$/.test(path)) ||
      /ibus-web\/dist\/host\/|\/runtime\/|brotli-dec-wasm/.test(path)
    )
      throw new Error(`Worker/runtime implementation in page graph: ${id}`);
  }
  // Bundlers emit licenses separately and sourcemaps are assets, not executable chunks.
  const executable = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (
    executable.includes("\0asm") ||
    /\\(?:x00|u0000)asm|AGFzbQ|_ibusweb_|\bHEAP(?:U?8|U?16|U?32|F32|F64)\b|\b(?:wasmBinary|instantiateWasm|createWasm)\b|WebAssembly\s*\.\s*(?:instantiate|compile|Module|Instance)\b|class\s+WorkerHost\b/.test(
      executable,
    )
  )
    throw new Error("Worker/runtime or Emscripten executable marker in page chunk");
}
export function pageBoundaryPlugin(): Plugin {
  return {
    name: "ibus-web-page-boundary",
    generateBundle(_options, bundle) {
      const chunks: ChunkEvidence[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        const modules = Object.keys(item.modules);
        scanChunk(item.code, modules);
        for (const imported of [...item.imports, ...item.dynamicImports])
          if (!bundle[imported]) throw new Error(`Unscanned external page import: ${imported}`);
        chunks.push({
          fileName: item.fileName,
          modules,
          imports: item.imports,
          dynamicImports: item.dynamicImports,
          sha256: hash(item.code),
        });
      }
      if (!chunks.length) throw new Error("No executable page chunks to scan");
      this.emitFile({ type: "asset", fileName: "page-bundle-graph.json", source: JSON.stringify(chunks, null, 2) });
    },
  };
}
export async function scanBuild(directory: string): Promise<void> {
  const chunks = JSON.parse(await readFile(resolve(directory, "page-bundle-graph.json"), "utf8")) as ChunkEvidence[];
  if (!chunks.length) throw new Error("Empty page graph");
  const names = new Set(chunks.map((chunk) => chunk.fileName));
  for (const chunk of chunks) {
    const code = await readFile(resolve(directory, chunk.fileName), "utf8");
    if (hash(code) !== chunk.sha256) throw new Error(`Page chunk changed after graph capture: ${chunk.fileName}`);
    for (const imported of [...chunk.imports, ...chunk.dynamicImports])
      if (!names.has(imported)) throw new Error(`Unscanned page import: ${imported}`);
    scanChunk(code, chunk.modules);
  }
  console.log(
    `Scanned ${directory}: ${chunks.length} executable page chunks, ${chunks.reduce((n, c) => n + c.modules.length, 0)} modules; URL assets excluded.`,
  );
}
const entries = [
  "ibus-web",
  "ibus-web/effect",
  "ibus-web/panel",
  "ibus-web/worker",
  "@ibus-web/core",
  "@ibus-web/panel",
  "@ibus-web/protocol",
];
async function main() {
  const root = import.meta.dirname;
  const temp = await mkdtemp(resolve(root, ".bundle-scan-"));
  try {
    for (const [index, entry] of entries.entries()) {
      const source = resolve(temp, `entry-${index}.ts`);
      await writeFile(source, `export * from ${JSON.stringify(entry)};\n`);
      const outDir = resolve(process.env["IBUS_WEB_SCAN_OUTPUT"] ?? temp, `entry-${index}`);
      await build({
        configFile: false,
        root,
        logLevel: "warn",
        plugins: [pageBoundaryPlugin()],
        build: {
          outDir,
          emptyOutDir: true,
          minify: true,
          sourcemap: false,
          lib: { entry: source, formats: ["es"], fileName: "page" },
        },
      });
      await scanBuild(outDir);
      console.log(`PASS published entry ${entry}`);
    }
    const demo = process.env["IBUS_WEB_DEMO_PAGE"];
    if (!demo) throw new Error("IBUS_WEB_DEMO_PAGE is required");
    await scanBuild(demo);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
