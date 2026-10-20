// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { errorReport, type JsModuleManifest } from "@ibus-web/protocol";
import type { ModuleScript } from "@ibus-web/protocol/module-script";
import { Context, Effect, Layer } from "effect";
import type { StartupRefusal } from "../../shared/messages.ts";
import { StartupFailed, startupFailed } from "../failure.ts";
import { checkScript } from "../script.ts";

// The module script's scope: its default export, imported from the
// manifest's URL and checked against the manifest. Nothing to release: a
// module stays loaded until the Worker ends.
interface HostScriptShape {
  readonly manifest: JsModuleManifest;
  readonly script: ModuleScript;
}

export class HostScript extends Context.Service<HostScript, HostScriptShape>()("@ibus-web/worker-host/HostScript") {}

// How a failed import() is refused. A browser's rejects with a TypeError
// when the script fails to fetch, which a restart may get past, but a script
// that throws a TypeError as it evaluates rejects the same way. Fetching the
// script again tells them apart: if that succeeds the script was delivered
// and the throw is its own, as it would be again. Any other rejection is the
// script's own.
export const importRefusal = async (
  error: unknown,
  url: string,
  probe: (url: string) => Promise<Pick<Response, "ok">> = fetch,
): Promise<StartupRefusal | undefined> => {
  if (!(error instanceof TypeError)) return "manifest";

  const fetched = await probe(url).then(
    (response) => response.ok,
    () => false,
  );
  return fetched ? "manifest" : undefined;
};

// import() takes the script by URL, so the host can't check its bytes, and
// fetches it only once: it is named for its content, so its URL is the
// identity of what runs.
export const scriptLayer = (manifest: JsModuleManifest): Layer.Layer<HostScript, StartupFailed> =>
  Layer.effect(
    HostScript,
    Effect.gen(function* () {
      const { url } = manifest.module;
      const exports = yield* Effect.tryPromise({
        try: async () => {
          try {
            return (await import(/* @vite-ignore */ url)) as { default?: unknown };
          } catch (error) {
            const refused = await importRefusal(error, url);
            throw new StartupFailed({
              message: `module script ${url}: ${errorReport(error)}`,
              ...(refused === undefined ? {} : { refused }),
            });
          }
        },
        catch: (error) => error as StartupFailed,
      });

      const script = yield* Effect.try({
        try: () => checkScript(exports.default, manifest),
        catch: (error) => (error instanceof StartupFailed ? error : startupFailed(error)),
      });
      return { manifest, script };
    }),
  );
