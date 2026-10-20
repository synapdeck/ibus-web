// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

// A webpack loader that strips a TypeScript module's types, since webpack
// reads only JavaScript.

import { transform } from "esbuild";

export default function typescriptLoader(source) {
  const callback = this.async();

  transform(source, { loader: "ts", format: "esm", sourcefile: this.resourcePath }).then(
    ({ code, map }) => callback(null, code, map),
    callback,
  );
}
