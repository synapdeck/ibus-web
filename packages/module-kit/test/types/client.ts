// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// Type assertions, checked by tsc and never run: a `?ibus-module` import, as
// the package's `client` entry declares it.

import manifestUrl from "../fixtures/build/module.js?ibus-module";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const holds = <T extends true>(): T | undefined => undefined;

holds<Equal<typeof manifestUrl, string>>();

// @ts-expect-error A module's import gives its manifest's URL, not the module.
export const engines: object = manifestUrl;
