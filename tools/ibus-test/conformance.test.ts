// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkExpectedDifference, compareTranscripts, validateExpectedDifferences } from "./compare.ts";
import { checkCoverage, validateCoverage } from "./coverage.ts";
import { AdapterRunError, runAdapter } from "./process.ts";
import { withNativeSession, type NativeEngineConfig } from "./session.ts";
import { validateTrace } from "./trace.ts";
import type { Step, Trace, TranscriptRecord } from "./types.ts";

const manifestPath = process.env["IBUS_TEST_CONFORMANCE"];
const directories: string[] = [];
const artifactRoot = process.env["IBUS_TEST_ARTIFACTS"];
const create = (context = "a"): Step => ({ op: "create", context, engine: "conformance" });
const destroy = (context = "a"): Step => ({ op: "destroy", context });
const key = (value: number, context = "a"): Step => ({
  op: "call",
  context,
  method: "ProcessKeyEvent",
  args: `(uint32 ${value}, uint32 0, uint32 0)`,
});
const wait = (event: string, context = "a"): Step => ({ op: "wait", context, event, timeoutMs: 500 });
const trace = (...steps: Step[]): Trace => ({ version: 1, settings: [], steps });

function artifacts() {
  if (artifactRoot) mkdirSync(artifactRoot, { recursive: true });
  const directory = mkdtempSync(join(artifactRoot ?? tmpdir(), "ibus-conformance-"));
  if (!artifactRoot) directories.push(directory);
  return directory;
}

type CorpusManifest = {
  nativeConfig: string;
  wasmCommand: string[];
  traces: string[];
  traceNames: string[];
  expectedDifferences?: string | null;
  coverage?: string | null;
  versions?: Record<string, string>;
};

function manifest(): CorpusManifest {
  return JSON.parse(readFileSync(manifestPath!, "utf8"));
}

function nativeEngineStderr(directory: string): string {
  const nativeDirectory = join(directory, "native");
  const files = readdirSync(nativeDirectory).filter((name) => /^\d+-engine\.stderr\.txt$/.test(name));
  if (files.length !== 1) throw new Error(`expected one owned native engine stderr file, found ${files.length}`);
  return readFileSync(join(nativeDirectory, files[0]!), "utf8");
}

type PairContext = {
  configuration: CorpusManifest;
  directory: string;
  metadata: Record<string, unknown>;
};

async function runBoth(input: Trace, pair?: PairContext) {
  const configuration = pair?.configuration ?? manifest();
  const nativeConfig: NativeEngineConfig = JSON.parse(readFileSync(configuration.nativeConfig, "utf8"));
  const directory = pair?.directory ?? artifacts();
  writeFileSync(join(directory, "trace.json"), `${JSON.stringify(input, null, 2)}\n`);
  const metadata: Record<string, unknown> = pair?.metadata ?? { versions: configuration.versions ?? {} };
  try {
    const result = await withNativeSession(
      nativeConfig,
      input.settings,
      async (session) => {
        const native = await session.run(input).catch((error: unknown) => {
          metadata["native"] =
            error instanceof AdapterRunError
              ? {
                  reason: error.reason,
                  artifactDir: error.artifactDir,
                  exitCode: error.result.exitCode,
                  signal: error.result.signal,
                  error: error.message,
                }
              : { error: error instanceof Error ? error.message : String(error) };
          throw error;
        });
        metadata["native"] = { exitCode: native.exitCode, signal: native.signal, artifactDir: native.artifactDir };
        const wasm = await runAdapter(configuration.wasmCommand, input, {
          artifactDir: join(directory, "wasm"),
          timeoutMs: 5000,
          signal: session.signal,
        });
        metadata["wasm"] = { exitCode: wasm.exitCode, signal: wasm.signal, artifactDir: wasm.artifactDir };
        metadata["differences"] = compareTranscripts(native.records, wasm.records);
        return { native, wasm };
      },
      { artifactDir: join(directory, "native") },
    );
    return { ...result, directory };
  } catch (error) {
    metadata["error"] = error instanceof Error ? error.message : String(error);
    if (error instanceof AdapterRunError) {
      metadata["adapterFailure"] = {
        reason: error.reason,
        artifactDir: error.artifactDir,
        exitCode: error.result.exitCode,
        signal: error.result.signal,
      };
    }
    throw error;
  } finally {
    metadata["firstDivergence"] = (metadata["differences"] as unknown[] | undefined)?.[0] ?? null;
    writeFileSync(join(directory, "result.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

async function expectEquivalent(input: Trace): Promise<TranscriptRecord[]> {
  const { native, wasm } = await runBoth(input);
  expect(native.exitCode, native.stderr).toBe(0);
  expect(wasm.exitCode, wasm.stderr).toBe(0);
  expect(compareTranscripts(native.records, wasm.records)).toEqual([]);
  return wasm.records;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!manifestPath || !process.env["IBUS_TEST_FIXTURE"])("native and WASM adapter conformance", () => {
  test("creates and destroys two contexts, retaining output in order", async () => {
    const records = await expectEquivalent(
      trace(create("한글"), create("b"), key(0, "b"), key(1, "한글"), key(1, "b"), destroy("한글"), destroy("b")),
    );
    expect(records.filter((record) => record.kind === "event")).toMatchObject([
      { step: 3, context: "한글", name: "CommitText" },
      { step: 4, context: "b", name: "CommitText" },
    ]);
    expect(records[2]).toEqual({ kind: "reply", step: 2, value: false });
  });

  test("preserves Unicode and typed attachments through independent serializers", async () => {
    const records = await expectEquivalent(trace(create(), key(1), destroy()));
    expect(records[1]).toMatchObject({ kind: "event", step: 1, context: "a", name: "CommitText" });
    const event = records[1];
    if (event?.kind !== "event") throw new Error("missing commit");
    expect(event.payload.signature).toBe("(v)");
    expect(event.payload.text).toContain("한글 🐈");
    expect(event.payload.text).toContain("'typed': <<uint32 42>>");
  });

  test("retains empty updates and consumes preceding nonmatching checkpoints", async () => {
    const records = await expectEquivalent(
      trace(create(), key(3), wait("CommitText"), wait("UpdatePreeditText"), destroy()),
    );
    expect(records.slice(1, 4)).toMatchObject([
      { kind: "event", step: 1, name: "UpdatePreeditText" },
      { kind: "event", step: 1, name: "CommitText" },
      { kind: "reply", step: 1, value: true },
    ]);
  });

  test("waits for delayed output with an explicit event checkpoint", async () => {
    const records = await expectEquivalent(trace(create(), key(2), wait("CommitText"), destroy()));
    expect(records[1]).toEqual({ kind: "reply", step: 1, value: true });
    expect(records[2]).toMatchObject({ kind: "event", step: 2, name: "CommitText" });
  });

  test("maps ContentType and unit methods while retaining output", async () => {
    const records = await expectEquivalent(
      trace(
        create(),
        { op: "call", context: "a", method: "SetContentType", args: "(uint32 2, uint32 7)" },
        { op: "call", context: "a", method: "Reset", args: "()" },
        destroy(),
      ),
    );
    expect(records.filter((record) => record.kind === "event")).toMatchObject([
      { step: 1, name: "ForwardKeyEvent", payload: { signature: "(uuu)", text: "(uint32 2, uint32 7, uint32 0)" } },
      { step: 2, name: "CommitText", payload: { text: expect.stringContaining("reset output") } },
    ]);
    expect(records.at(-1)).toEqual({ kind: "reply", step: 3, value: null });
  });

  test("drops output from an engine after its context is destroyed", async () => {
    const records = await expectEquivalent(trace(create(), key(8), destroy(), create("b"), key(9, "b"), destroy("b")));
    expect(records.filter((record) => record.kind === "event")).toEqual([]);
    expect(records.at(-2)).toEqual({ kind: "reply", step: 4, value: true });
  });

  test("applies initial settings before module creation", async () => {
    const input = trace(create(), key(4), destroy());
    input.settings = [{ schema: "org.example.IBusConformance", key: "initial-text", value: "'初期 🐈'" }];
    const records = await expectEquivalent(input);
    expect(JSON.stringify(records)).toContain("初期 🐈");
  });

  test.each([
    [
      "invalid initial value",
      { schema: "org.example.IBusConformance", key: "initial-text", value: "uint32 42" },
      "Invalid value for settings key: /org/example/ibus-conformance/initial-text",
    ],
    [
      "unknown initial schema",
      { schema: "org.example.MissingConformance", key: "initial-text", value: "'text'" },
      "Unknown settings schema: org.example.MissingConformance",
    ],
  ])("fails startup for %s before creating an engine", async (_name, setting, diagnostic) => {
    const input = trace(create(), destroy());
    input.settings = [setting];
    const result = await runAdapter(manifest().wasmCommand, input, {
      artifactDir: artifacts(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(result.records.length).toBeGreaterThan(0);
    for (const record of result.records) {
      expect(record).toMatchObject({
        kind: "error",
        step: 0,
        message: expect.stringContaining(`unexpected runtime log [16] ibus-web: ${diagnostic}`),
      });
    }
  });

  test.each([
    ["unknown method", trace(create(), { op: "call", context: "a", method: "NoSuchMethod", args: "()" }, destroy()), 1],
    [
      "wrong argument signature",
      trace(create(), { op: "call", context: "a", method: "ProcessKeyEvent", args: "('wrong',)" }, destroy()),
      1,
    ],
    ["wait deadline", trace(create(), wait("CommitText"), destroy()), 1],
    ["old lifetime checkpoint", trace(create(), key(1), destroy(), create(), wait("CommitText"), destroy()), 4],
  ])("rejects %s in both adapters", async (_name, input, step) => {
    const { native, wasm } = await runBoth(input);
    for (const result of [native, wasm]) {
      expect(result.exitCode).toBe(1);
      expect(result.records[0]).toEqual({ kind: "reply", step: 0, value: null });
      expect(result.records.at(-1)).toMatchObject({ kind: "error", step });
    }
  });

  test("rejects global settings output with its typed diagnostic", async () => {
    const input = trace(create(), key(7), destroy());
    input.settings = [{ schema: "org.example.IBusConformance", key: "initial-text", value: "'text'" }];
    const result = await runAdapter(manifest().wasmCommand, input, {
      artifactDir: artifacts(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.records.at(-1)).toMatchObject({
      kind: "error",
      step: 1,
      message: expect.stringContaining("kind=32 context=0 signature=(ssv)"),
    });
    expect(JSON.stringify(result.records)).toContain("written by engine");
  });

  test("preserves log diagnostics separately and fails warnings", async () => {
    const command = manifest().wasmCommand;
    const logged = await runAdapter(command, trace(create(), key(5), destroy()), {
      artifactDir: artifacts(),
      timeoutMs: 5000,
    });
    expect(logged.exitCode, logged.stderr).toBe(0);
    expect(logged.stderr).toContain("conformance diagnostic");
    expect(logged.records.every((record) => record.kind !== "error")).toBe(true);
    const warned = await runAdapter(command, trace(create(), key(6), destroy()), {
      artifactDir: artifacts(),
      timeoutMs: 5000,
    });
    expect(warned.exitCode).toBe(1);
    expect(warned.stderr).toContain("conformance warning");
    expect(warned.records.at(-1)).toMatchObject({ kind: "error", step: 1 });
  });
});

async function replayScenario(path: string, configuration: CorpusManifest, directory = artifacts()) {
  const scenario = configuration.traceNames[configuration.traces.indexOf(path)];
  const metadata: Record<string, unknown> = {
    versions: configuration.versions ?? {},
    scenario: scenario ?? null,
    expectedDifference: null,
    assertion: { matched: false },
  };
  try {
    if (!scenario) throw new Error(`manifest has no scenario name for ${path}`);
    const declarationDocument = configuration.expectedDifferences
      ? JSON.parse(readFileSync(configuration.expectedDifferences, "utf8"))
      : null;
    const declared = declarationDocument?.differences?.find(
      (item: { scenario?: string }) => item?.scenario === scenario,
    );
    metadata["intendedDifference"] = declared ?? null;
    if (declared) {
      metadata["expectedDifference"] = { scenario, triggerStep: declared.triggerStep ?? null, matched: false };
    }
    const declarations = declarationDocument
      ? validateExpectedDifferences(declarationDocument, configuration.traceNames)
      : new Map();
    const coverage = configuration.coverage
      ? validateCoverage(JSON.parse(readFileSync(configuration.coverage, "utf8")), configuration.traceNames)
      : undefined;
    const input = validateTrace(JSON.parse(readFileSync(path, "utf8")));
    const { native, wasm } = await runBoth(input, { configuration, directory, metadata });
    expect(native.exitCode, native.stderr).toBe(0);
    expect(native.signal).toBeNull();
    expect(wasm.exitCode, wasm.stderr).toBe(0);
    expect(wasm.signal).toBeNull();
    expect(native.stderr).toBe("");
    expect(wasm.stderr).not.toMatch(/\b(?:WARNING|CRITICAL|ERROR)\b/);
    const engineStderr = nativeEngineStderr(directory);
    const declaration = declarations.get(scenario);
    if (declaration) {
      expect(input.steps[declaration.triggerStep]?.op).toBe("call");
      checkExpectedDifference(native.records, wasm.records, declaration, engineStderr);
      metadata["expectedDifference"] = { scenario, triggerStep: declaration.triggerStep, matched: true };
    } else {
      expect(engineStderr).toBe("");
      expect(compareTranscripts(native.records, wasm.records)).toEqual([]);
    }
    const requiredCoverage = coverage?.get(scenario);
    if (requiredCoverage) {
      checkCoverage(native.records, requiredCoverage);
      checkCoverage(wasm.records, requiredCoverage);
    }
    metadata["assertion"] = { matched: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    metadata["assertion"] = { matched: false, error: message };
    metadata["error"] ??= message;
    throw error;
  } finally {
    writeFileSync(join(directory, "result.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  }
}

describe.skipIf(!manifestPath)("configured engine traces", () => {
  test.each(manifestPath ? manifest().traces : ["unconfigured"])(
    "replays %s",
    async (path) => replayScenario(path, manifest()),
    15000,
  );
});

describe.skipIf(!manifestPath || !process.env["IBUS_TEST_FIXTURE"])("failed pair artifacts", () => {
  test("retains identity on declaration validation and coverage failures", async () => {
    const directory = artifacts();
    const tracePath = join(directory, "diagnostic-trace.json");
    const declarationPath = join(directory, "invalid-declaration.json");
    const coveragePath = join(directory, "missing-coverage.json");
    const scenario = "diagnostic-scenario";
    writeFileSync(tracePath, `${JSON.stringify(trace(create(), key(1), destroy()))}\n`);
    writeFileSync(
      declarationPath,
      `${JSON.stringify({ version: 1, differences: [{ scenario, triggerStep: "invalid" }] })}\n`,
    );
    writeFileSync(
      coveragePath,
      `${JSON.stringify({
        version: 1,
        scenarios: [{ scenario, required: [{ kind: "event", step: 1, name: "NeverEmitted" }], forbidden: [] }],
      })}\n`,
    );
    const configuration: CorpusManifest = {
      ...manifest(),
      traces: [tracePath],
      traceNames: [scenario],
      expectedDifferences: declarationPath,
      coverage: null,
      versions: { fixture: "diagnostic" },
    };

    await expect(replayScenario(tracePath, configuration, directory)).rejects.toThrow(
      /expected difference has unexpected fields/,
    );
    let result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    expect(result).toMatchObject({
      scenario,
      versions: { fixture: "diagnostic" },
      intendedDifference: { scenario, triggerStep: "invalid" },
      expectedDifference: { scenario, triggerStep: "invalid", matched: false },
      assertion: { matched: false, error: expect.stringContaining("expected difference") },
    });

    configuration.expectedDifferences = null;
    configuration.coverage = coveragePath;
    await expect(replayScenario(tracePath, configuration, directory)).rejects.toThrow(/missing ordered/);
    result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    expect(result).toMatchObject({
      scenario,
      versions: { fixture: "diagnostic" },
      native: { exitCode: 0 },
      wasm: { exitCode: 0 },
      differences: [],
      firstDivergence: null,
      expectedDifference: null,
      assertion: { matched: false, error: expect.stringContaining("missing ordered") },
    });
  });
});
