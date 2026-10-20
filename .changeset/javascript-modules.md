---
"@ibus-web/protocol": minor
"@ibus-web/worker-host": minor
"@ibus-web/core": minor
"ibus-web": minor
"@ibus-web/module-kit": minor
---

Run input methods written in JavaScript. A module's manifest can be `kind: "js"`, naming one ES module script that the
Worker host imports and serves through the same protocol as a WebAssembly module, with settings, properties and timers.
`@ibus-web/module-kit` writes such modules (engines, Effect `Schema` settings, candidates, properties and
`transformEngine` for whole-string transliteration) and builds them with `buildModule`, the `ibus-web-module` CLI, or a
plugin for Vite, Rollup, Rolldown, esbuild, webpack and Rspack, including `?ibus-module` imports in Vite. A host refuses
a JavaScript module built for another module ABI with `ModuleAbiMismatch`.
