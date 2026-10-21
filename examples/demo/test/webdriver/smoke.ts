// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The production demo driven through W3C WebDriver, for browsers Playwright
// can't drive, Safari above all:
//
//   IBUS_WEB_DEMO_PAGE=<built demo> IBUS_WEB_WEBDRIVER=<driver> \
//     IBUS_WEB_WEBDRIVER_CAPABILITIES=<JSON> node test/webdriver/smoke.ts
//
// It serves the page, starts the driver (safaridriver, or geckodriver, which
// both take --port), and checks Hangul typing, a Rime install and
// conversion, learning that survives a reload, and the IndexedDB backend in
// the module's Workers. Drivers that serve one session at a time, as
// safaridriver does, are why it runs as one session.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { Key, Session, driverReady, waitFor } from "./webdriver.ts";

const driverCommand = process.env["IBUS_WEB_WEBDRIVER"];
const page = process.env["IBUS_WEB_DEMO_PAGE"];
if (!driverCommand || !page) throw new Error("IBUS_WEB_WEBDRIVER and IBUS_WEB_DEMO_PAGE are required");
const capabilities = JSON.parse(process.env["IBUS_WEB_WEBDRIVER_CAPABILITIES"] ?? "{}") as Record<string, unknown>;
const pagePort = process.env["IBUS_WEB_DEMO_PORT"] ?? "5191";
const driverPort = process.env["IBUS_WEB_WEBDRIVER_PORT"] ?? "4444";
const origin = `http://127.0.0.1:${pagePort}`;

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await once(child, "exit");
}

async function preview(): Promise<ChildProcess> {
  const args = ["preview", "--host", "127.0.0.1", "--port", pagePort, "--strictPort", "--outDir", page!];
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  // Vite colours its output wherever CI is set, even into a pipe, with the
  // port in bold, and the address can arrive split across chunks.
  let output = "";
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on("data", (chunk: Buffer) => {
      output += stripVTControlCharacters(chunk.toString());
      if (output.includes(`127.0.0.1:${pagePort}`)) resolve();
    });
    server.once("exit", (code) => reject(new Error(`the preview server exited: ${code}`)));
    server.once("error", reject);
  });
  return server;
}

const step = (what: string) => console.log(`- ${what}`);

// The module's state reads ready and the page reports no error.
async function ready(session: Session) {
  await waitFor("the module to be ready", async () => (await session.text(await session.find("#engine"))) === "ready");
}

async function healthy(session: Session) {
  assert.equal(await session.text(await session.find("#error")), "");
  assert.doesNotMatch(await session.text(await session.find("#log")), /error \[/);
}

// Selects the engine whose option is named, or labelled, engine.
async function select(session: Session, engine: string) {
  await session.execute(
    `const picker = document.querySelector("#engine-picker");
     const option = [...picker.options].find((option) =>
       option.dataset.engine === arguments[0] || option.text === arguments[0]);
     picker.value = option.value;
     picker.dispatchEvent(new Event("change", { bubbles: true }));`,
    engine,
  );
}

async function clearField(session: Session) {
  const field = await session.find("#input");
  await session.click(field);
  await session.keys([Key.Escape]);
  await session.clear(field);
  await session.click(field);
}

// Keys pass through natively until the engine is ready and while Rime's
// maintenance runs, so this types until Rime alone makes the value.
async function probe(session: Session, keys: string, value: string) {
  const field = await session.find("#input");
  await waitFor(
    `${JSON.stringify(keys)} to type ${value}`,
    async () => {
      await clearField(session);
      await session.type(keys);
      return await waitFor("the value", async () => (await session.value(field)) === value, 2_000).catch(() => false);
    },
    120_000,
  );
  await clearField(session);
}

const candidates = (session: Session) => session.findAll(".ibus-panel [data-candidate]");

// A candidate's button reads its label, a space and the candidate.
const candidateText = async (session: Session, element: string) => {
  const text = await session.text(element);
  return text.slice(text.indexOf(" ") + 1);
};

// The candidates once every key has reached Rime and the list stops changing.
async function settledCandidates(session: Session, keys: string): Promise<string[]> {
  await session.type(keys);
  let shown = "";
  return await waitFor(
    `the candidates for ${keys}`,
    async () => {
      const texts = await Promise.all((await candidates(session)).map((element) => candidateText(session, element)));
      const previous = shown;
      shown = texts.join("\n");
      return texts.length > 0 && shown === previous && texts;
    },
    15_000,
    300,
  );
}

async function hangul(session: Session) {
  step("Hangul composes 한 from gks and commits it on blur");
  await select(session, "Hangul");
  await ready(session);
  const field = await session.find("#input");
  await session.click(field);
  await waitFor("English mode", async () => (await session.text(await session.find("#mode"))) === "EN");
  await session.keys([Key.Shift, Key.Space]);
  await waitFor("Hangul mode", async () => (await session.text(await session.find("#mode"))) === "한");
  await session.type("gks");
  await waitFor("the preedit", async () =>
    (await session.text(await session.find("[data-ibus-preedit]"))).includes("한"),
  );
  assert.equal(await session.value(field), "");
  await session.click(await session.find("#single-line"));
  await waitFor("the commit", async () => (await session.value(field)) === "한");
  await session.clear(field);
}

async function rime(session: Session) {
  step("rime_ice installs its dictionaries and converts nihao");
  await select(session, "rime:rime_ice");
  await waitFor(
    "rime_ice's dictionaries",
    async () => /^Installed rime:rime_ice: \d+\.\d MB$/.test(await session.text(await session.find("#install"))),
    240_000,
    500,
  );
  await probe(session, "nihao ", "你好");
}

async function learning(session: Session) {
  step("a candidate chosen below the first comes first after a reload, from IndexedDB");
  await clearField(session);
  const shown = await settledCandidates(session, "shi");
  assert.ok(shown.length >= 3, `three candidates for shi, not ${shown.length}`);
  const chosen = shown[2]!;
  assert.notEqual(chosen, shown[0]);
  await session.click((await candidates(session))[2]!);
  const field = await session.find("#input");
  const committed = await waitFor("the commit", async () => (await session.value(field)) || false);
  assert.ok(chosen.startsWith(committed), `${committed} commits ${chosen}`);

  // A Worker's Web Locks can outlive its page briefly, and a host that
  // started then would mount Rime's files read-only.
  await session.refresh();
  await ready(session);
  await session.executeAsync(
    `const done = arguments[arguments.length - 1];
     navigator.locks.request("ibus-web:writer:rime", () => undefined).then(() => done());`,
  );
  await select(session, "rime:rime_ice");
  await probe(session, "nihao ", "你好");
  assert.equal(await session.text(await session.find("#storage")), "persistent (writable)");
  const after = await settledCandidates(session, "shi");
  assert.equal(after[0], chosen);
  await clearField(session);
}

const server = await preview();
try {
  const driver = spawn(driverCommand, ["--port", driverPort], { stdio: ["ignore", "inherit", "inherit"] });
  try {
    const base = `http://127.0.0.1:${driverPort}`;
    await driverReady(base);
    const session = await Session.start(base, capabilities);
    try {
      console.log(`${String(session.capabilities["browserName"])} ${String(session.capabilities["browserVersion"])}`);
      step("the page is cross-origin isolated and starts its default module");
      await session.navigate(origin);
      await ready(session);
      assert.equal(await session.execute<boolean>("return crossOriginIsolated;"), true);

      await hangul(session);
      await rime(session);
      await learning(session);
      await healthy(session);
      console.log("WebDriver smoke passed.");
    } finally {
      await session.end();
    }
  } finally {
    await stop(driver);
  }
} finally {
  await stop(server);
}
