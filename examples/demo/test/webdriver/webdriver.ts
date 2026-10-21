// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// The few W3C WebDriver commands the smoke suite needs, over fetch, so the
// one suite drives safaridriver, geckodriver or chromedriver alike.

// The key codes WebDriver's key actions use for keys that type nothing.
export const Key = {
  Shift: "\uE008",
  Escape: "\uE00C",
  Space: " ",
} as const;

// A WebDriver error, under the name the driver reported it with.
export class WebDriverError extends Error {
  readonly error: string;

  constructor(error: string, message: string) {
    super(`${error}: ${message}`);
    this.error = error;
  }
}

// A driver that never answers, as one waiting on a browser that can't
// start, would otherwise hold the suite until its job is killed.
const commandTimeout = 120_000;

async function command(url: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<unknown> {
  const signal = AbortSignal.timeout(commandTimeout);
  const response = await fetch(
    url,
    body === undefined
      ? { method, signal }
      : { method, signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  ).catch((error: unknown) => {
    throw new Error(`${method} ${url}`, { cause: error });
  });
  const { value } = (await response.json()) as { value: unknown };
  if (!response.ok) {
    const { error, message } = value as { error: string; message: string };
    throw new WebDriverError(error, message);
  }
  return value;
}

// Calls check until it returns something other than undefined or false, or
// throws once timeout milliseconds have passed, with what it last threw.
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeout = 15_000,
  interval = 200,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const result = await check();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}`, last === undefined ? undefined : { cause: last });
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Waits until the driver at base says it can start a session.
export async function driverReady(base: string, timeout = 30_000): Promise<void> {
  await waitFor(
    `the WebDriver server at ${base}`,
    async () => ((await command(`${base}/status`, "GET")) as { ready?: boolean }).ready === true,
    timeout,
  );
}

const elementKey = "element-6066-11e4-a52e-4f735466cecf";

export class Session {
  private readonly base: string;
  readonly capabilities: Record<string, unknown>;

  private constructor(base: string, capabilities: Record<string, unknown>) {
    this.base = base;
    this.capabilities = capabilities;
  }

  static async start(driver: string, alwaysMatch: Record<string, unknown>): Promise<Session> {
    const { sessionId, capabilities } = (await command(`${driver}/session`, "POST", {
      capabilities: { alwaysMatch },
    })) as { sessionId: string; capabilities: Record<string, unknown> };
    return new Session(`${driver}/session/${sessionId}`, capabilities);
  }

  private call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    return command(`${this.base}${path}`, method, body);
  }

  end(): Promise<unknown> {
    return this.call("DELETE", "");
  }

  async navigate(url: string): Promise<void> {
    await this.call("POST", "/url", { url });
  }

  async refresh(): Promise<void> {
    await this.call("POST", "/refresh", {});
  }

  // The element id of the first element the selector matches.
  async find(selector: string): Promise<string> {
    const element = (await this.call("POST", "/element", { using: "css selector", value: selector })) as Record<
      string,
      string
    >;
    return element[elementKey]!;
  }

  async findAll(selector: string): Promise<string[]> {
    const elements = (await this.call("POST", "/elements", { using: "css selector", value: selector })) as Record<
      string,
      string
    >[];
    return elements.map((element) => element[elementKey]!);
  }

  async click(element: string): Promise<void> {
    await this.call("POST", `/element/${element}/click`, {});
  }

  async clear(element: string): Promise<void> {
    await this.call("POST", `/element/${element}/clear`, {});
  }

  async text(element: string): Promise<string> {
    return (await this.call("GET", `/element/${element}/text`)) as string;
  }

  async value(element: string): Promise<string> {
    return (await this.call("GET", `/element/${element}/property/value`)) as string;
  }

  // Types into the focused element through the driver's key actions, as a
  // user's keystrokes: each chord's keys pressed in order and released in
  // reverse, one chord after another.
  async keys(...chords: string[][]): Promise<void> {
    const actions = chords.flatMap((chord) => [
      ...chord.map((value) => ({ type: "keyDown", value })),
      ...chord.toReversed().map((value) => ({ type: "keyUp", value })),
    ]);
    await this.call("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions }] });
    await this.call("DELETE", "/actions");
  }

  // Types text one key at a time.
  type(text: string): Promise<void> {
    return this.keys(...[...text].map((key) => [key]));
  }

  async execute<T>(script: string, ...args: unknown[]): Promise<T> {
    return (await this.call("POST", "/execute/sync", { script, args })) as T;
  }

  async executeAsync<T>(script: string, ...args: unknown[]): Promise<T> {
    return (await this.call("POST", "/execute/async", { script, args })) as T;
  }
}
