# Module kit

`@ibus-web/module-kit` is the authoring API for JavaScript input-method modules. A module is a script whose default
export the Worker host drives; the kit implements that contract, so an author writes engines, settings and properties
and never the contract's records.

## Where it sits

The kit runs inside a module's own bundle, in the module's Worker, beside the host that loads it. It depends on
`@ibus-web/protocol` for two subpaths alone: `module-script`, which imports nothing, and `descriptor`, which imports
only `effect`, so the kit adds the contract's constants and the `EngineDescriptor` schema to a bundle and no other code
of the protocol. Its build entry, `@ibus-web/module-kit/build` ([below](#the-post-processor)), runs under Node instead,
with the protocol's main entry and `es-module-lexer`, and so do its bundler plugins ([below](#the-bundler-plugin)), with
`unplugin`; each bundler is an optional peer dependency. `effect` is a peer dependency, since an engine declares its
settings as a `Schema.Struct` of the module's own `effect`; the kit also uses it to decode descriptors, read settings
and run handlers' Effects.

## The contract

The kit implements the module-script contract described in [protocol.md](protocol.md), whose version, `MODULE_ABI`, the
kit's root entry re-exports.

## Writing a module

A module script's default export is `defineModule`'s result, and each of its engines `defineEngine`'s. Settings, the
candidate list and properties, which this example leaves out, have sections of their own below:

```ts
import { defineEngine, defineModule } from "@ibus-web/module-kit";
import { Schema } from "effect";

export default defineModule({
  name: "example-transliteration",
  version: "1.0.0",
  license: "MIT",
  settingsPrefix: "org.example.transliteration",
  engines: {
    hebrew: defineEngine({
      displayName: "Romanized Hebrew",
      languages: ["he"],
      settings: Schema.Struct({
        vowelPoints: Schema.Boolean.annotate({ default: true, title: "Write vowel points" }),
      }),
      create(context) {
        return {
          processKey(keyval, keycode, state, character) {
            if (character !== "a") return false;

            context.commit(context.settings.get("vowelPoints") ? "אַ" : "א");
            return true;
          },
        };
      },
    }),
  },
});
```

`defineModule` takes the module's name, version and license, its engines by IBus engine name (the first is the module's
default), and optional `persist` and `shutdown` hooks, and returns them as plain data carrying the contract's version.
Each engine `defineEngine` made is returned as a new engine that knows its name, so one engine object can sit under
several names, and the object passed in is left as it was. `defineModule` has no side effects, since a build imports the
script to describe it.

### Definition errors

Every refusal, `defineModule`'s and `defineEngine`'s, throws a `ModuleDefinitionError` at definition time: a
`Data.TaggedError` with the `engine` it names, the setting's `key` (its name in the settings struct) where there is one,
and the `reason`. Its message joins them, as
`the engine "hebrew" declares settings, but the module has no settingsPrefix`. It is never a `TypeError`, which the host
would take for a failed fetch. `defineEngine` doesn't know the name its module gives the engine, so its refusals carry
no `engine`.

`defineModule` refuses:

- an engine name that can't end a settings schema id: one or more dot-separated components, each a lowercase letter
  followed by lowercase letters, digits or `-`. This holds whether or not the engine has settings;
- a `settingsPrefix` that isn't such an id;
- an engine with settings in a module without a `settingsPrefix`.

An engine's settings schema id is `<settingsPrefix>.<engine>`, and its path the id's components joined by `/`, as
`/org/example/transliteration/hebrew/`.

## Engines and sessions

### The descriptor

`defineEngine` takes the engine's descriptor, its settings and `create`. It decodes the descriptor with the protocol's
`EngineDescriptor` schema, without the `name`, which is the engine's key in its module, or the `data`, which a
JavaScript module has none of, and its `EngineDescriptor` type is that schema's encoded side. `keyboard` defaults to
`{ layout: "default", passThrough: [] }`, each of its fields on its own. A descriptor the schema refuses, such as an
empty `displayName` or a layout but `us` and `default`, is a `ModuleDefinitionError` whose reason holds the schema's
message. So is a descriptor with `data`, and so is any key that is neither one of the descriptor's fields nor `settings`
or `create`, which catches a misspelled field. `transformEngine` adds `transform` and `alphabet` to the keys it knows.

### Sessions

`create` receives the session's [context](#the-context) and returns a session: an object with any of the contract's
handlers but `settingChanged`, each typed as the contract has it but `propertyActivate`, which is given whether the
activation asks for `checked` as a boolean ([Properties](#properties)). The host calls the kit's session, which calls
the handler the session has when the request arrives, with the session as `this`. A handler may return an `Effect` of
its result, needing no service, instead of the result itself; the kit runs it with `Effect.runSync` and hands the host
its value. An Effect that reaches an asynchronous boundary, such as a promise or a sleep, throws, and so does one that
fails: the throw is the handler's fault, which the host reports with its message, since the host runs no event loop to
wait on. The kit interrupts the fiber of an Effect that went asynchronous, so the rest of it doesn't run later.

A handler a session leaves out does nothing, and a session without `processKey` consumes no key. `create` runs for each
input context; a throw from it fails the engine's creation with the error's message, and a throw from any handler is a
fault that ends the module. Two ways of writing the same handler:

```ts
import { Effect } from "effect";

create(context) {
  return {
    // Plain: returns its result.
    processKey(keyval, keycode, state, character) {
      if (character !== "a") return false;

      context.commit("α");
      return true;
    },

    // Effect: the kit runs it with Effect.runSync, so it must not wait.
    focusOut: () => Effect.sync(() => context.auxiliary("", false)),
  };
}
```

The module's `persist` and `shutdown` hooks are plain functions.

## The context

`create` receives an `EngineContext`: the contract's output calls and settings, with the kit's `candidates`,
`registerProperties` and `updateProperty` in place of the contract's. Each output call queues one record for the request
being served, in call order, and calls on the context of a destroyed session are ignored. Text holding a NUL or a lone
surrogate, which no record can carry, throws.

| Member                                         | Does                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `commit(text)`                                 | Commits text to the client                                                                        |
| `preedit(text, cursor, visible, mode)`         | Shows or hides the preedit; `cursor` counts code points; `mode` is `"clear"` or `"commit"`        |
| `auxiliary(text, visible)`                     | Shows or hides the auxiliary text                                                                 |
| `lookupTable(page, visible)`                   | Shows or hides one page of candidates; [`candidates`](#candidates) does the paging                |
| `candidates(list, options?)`                   | Shows a whole candidate list                                                                      |
| `candidateCursor()`                            | Where the list's cursor is                                                                        |
| `registerProperties(list)`, `updateProperty()` | [Properties](#properties)                                                                         |
| `forwardKey(keyval, keycode, state)`           | Sends a key event on to the client                                                                |
| `deleteSurrounding(offset, count)`             | Deletes `count` code points of the client's text, from `offset` code points after the cursor      |
| `requireSurrounding()`                         | Asks the client for its surrounding text                                                          |
| `settings`                                     | The engine's [settings](#settings)                                                                |
| `after(ms, fn)`                                | Runs `fn` once, `ms` milliseconds from now; returns a function that cancels it                    |
| `log(level, message)`                          | Logs at `debug`, `info`, `warning` or `error`; NULs and lone surrogates become U+FFFD, not throws |

Text is a string or `{ text, attributes }`, attributes decorating a range of code points: an underline, a foreground or
background color, or a hint. The host's side of each call is in [worker-host.md](worker-host.md#backends) and the
contract's types in [protocol.md](protocol.md#module-scripts).

## Settings

An engine's `settings` is a `Schema.Struct` with a field for each setting. The kit reads each field's JSON Schema, as
Effect's `SchemaRepresentation` generates it, into the contract's declaration, which the engine's `settings` holds by
GSettings key. A `Schema.Number`'s JSON Schema is a union with the strings JSON spells NaN and the infinities as, so the
kit takes a number's own type from the field's AST instead:

| Field schema                                                | JSON Schema                            | GVariant type      |
| ----------------------------------------------------------- | -------------------------------------- | ------------------ |
| `Schema.Boolean`                                            | `type: "boolean"`                      | `b`                |
| `Schema.String`                                             | `type: "string"`                       | `s`                |
| `Schema.Literals([...])` of strings, or a union of them     | `type: "string"` with an `enum`        | `s` with choices   |
| `Schema.Int`, or `Schema.Number` with `Schema.isInt()`      | `type: "integer"`                      | `i`, with a range  |
| `Schema.Number` or `Schema.Finite`, with `Schema.isBetween` | `type: "number"`, `minimum`, `maximum` | `d`, with a range  |
| `Schema.Number` or `Schema.Finite` without bounds           | `type: "number"`                       | `d`, without range |
| `Schema.Array(Schema.String)`                               | `type: "array"`, string `items`        | `as`               |

An integer's range is its `minimum` and `maximum`, and int32's bounds for any it lacks, so `Schema.Int` is the whole
32-bit range and `Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))` runs from 0 to 2³¹ − 1. A number has both bounds
or neither. Several checks give the range all of them allow, so `Schema.isInt32()` with an `isBetween` gives the
narrower one. A field's `default` is its default, `title` its summary and `description` its description, wherever its
JSON Schema holds them: annotated before or after its checks, the last one given wins. `defineEngine` refuses:

- a setting name that doesn't map to a GSettings key. Names are camelCase, and each uppercase letter becomes `-` and its
  lowercase, so `vowelPoints` is the key `vowel-points`. A name is a lowercase letter, then letters and digits, at most
  32 characters once mapped; a name the key wouldn't map back to, such as `vowel-points` itself, is refused;
- a field without a `default`, or with one its own schema rejects or that holds a NUL or a lone surrogate;
- a check JSON Schema can't express, such as a `Schema.makeFilter` predicate, on the field or its list's strings;
- any constraint a GSettings key can't hold: an exclusive bound, a number with only one bound, a range no value meets,
  an integer range beyond 32 bits, `multipleOf`, a string's length or pattern, a list's length or a tuple;
- any other shape: a union of anything but string literals, choices that aren't strings or repeat a value, an array of
  anything but unchecked strings, a nested struct, an optional field, or a schema that transforms its value;
- settings that aren't a struct, or a struct with checks or index signatures.

The engine keeps each setting's field schema beside the declarations, off the object the host reads.

`context.settings` is typed from the struct's `Schema.Type`, by the camelCase names:

- `get(name)` returns the setting's value: a choice's is the union of its values;
- `set(name, value)` takes that type, stores it and has the page persist it. The host throws for a value outside the
  setting's range or choices;
- `onChange(name, fn)` calls `fn` with each new value once the store holds it, for the page's changes and for writes by
  any session of the engine, the writer's own included once the handler that wrote it has returned. It returns a
  function that unsubscribes. Subscribers are called in the order they subscribed, each subscription once.

A name the engine doesn't declare is a type error, and an `Error` at run time. The kit's session consumes the contract's
`settingChanged` to call the subscribers, so a session's own `settingChanged` is never called.

## Candidates

The contract's `lookupTable` shows one page, and `candidateClicked`'s index counts from that page. `context.candidates`
takes the whole list instead and does the paging:

```ts
context.candidates(["α", { text: "β", label: "b" }, "γ"], { cursor: 1, cursorVisible: true });
```

Each candidate is a string or `{ text, label? }`. `cursor` is an index into the list and defaults to 0, and a value
outside the list is moved to its nearest end; `cursorVisible` defaults to true.

- The kit sends the page of 10 that holds the cursor, pages starting at multiples of 10, with the cursor's position on
  that page. If any candidate on the page has a label, the panel shows labels for all of them, and a candidate without
  one is labelled with its place on the page, from 1. Otherwise the panel numbers them.
- An empty list hides the table.
- `candidateClicked(index, button, state)` receives the clicked candidate's index in the list, not on the page. A click
  past the page's last candidate, or one while the list is empty or before any table is drawn, never reaches the
  session.
- `context.candidateCursor()` returns `{ index, visible }`, the cursor's index in the list and whether the panel shows
  it, or `undefined` while no list or an empty one is shown. An engine whose Space commits the highlighted candidate
  reads it there.
- A session that draws a page itself with `context.lookupTable` replaces the list: the kit drops it, pages nothing, and
  passes `candidateClicked` the index on that page, until the session calls `candidates` again.
- A session that doesn't define `pageUp`, `pageDown`, `cursorUp` or `cursorDown` has the kit handle it, as the table
  engine does. Paging moves the cursor by a page, which keeps its place on the page and stops on the last candidate of a
  shorter one, and leaves a hidden cursor hidden. `cursorUp` and `cursorDown` show a hidden cursor where it is, and
  otherwise move it by one candidate. Each redraws the table. A move that goes nowhere, such as `pageDown` on the last
  page or `cursorUp` on the first candidate, changes nothing and sends nothing.
- A session that defines one of them handles that one itself, and the kit goes on handling the others. The kit's cursor
  is always the one on the table the kit drew last, so a handler of the session's that moves the cursor reads it from
  `candidateCursor()` and redraws with `candidates(list, { cursor: index, cursorVisible: visible })`, passing the
  cursor's visibility through so that a hidden cursor stays hidden, and the kit's handlers carry on from there.
- The list and the cursor belong to the session and are dropped when it is destroyed.

## Properties

`context.registerProperties(list)` declares the session's properties, each
`{ key, kind, label, symbol?, tooltip?, icon?, sensitive?, visible?, checked?, children? }`, with `kind` one of
`normal`, `toggle`, `radio`, `menu` and `separator`. `checked` is a toggle's or radio's state, which the contract
carries as `unchecked` or `checked`. The kit sends the contract's whole properties. A key used twice throws.

The kit registers the session's properties when the session is created, for a host that never sends FocusIn. The panel
drops a context's properties when it loses focus, so on a FocusIn that follows a FocusOut the kit registers them again,
its settings' and its own as they stand, after the session's `focusIn` has run. The FocusIn that follows creation sends
nothing more, a `focusIn` that calls `registerProperties` itself is not followed by a second registration, and a session
with no properties gets none.

`context.updateProperty(key, changes)` merges `changes` into the registered property, a menu's child included, and sends
all of it. Updating a key that isn't registered throws an `Error`, and so does a change to `undefined`: `""` clears a
`symbol`, `tooltip` or `icon`, and `true` restores `sensitive` or `visible`. A change of `key` or `kind` throws too, as
the key and kind of a property stay as it was registered. As in IBus, activating a toggle or radio changes nothing until
something updates it, so the session's `propertyActivate(key, checked)` does that. `checked` is whether the activation
asks for the property to be checked, which for a toggle or radio is the state the panel wants it in.

### Settings as properties

A boolean field annotated with `property: { label, symbol? }` is a toggle. A literals field annotated with
`property: { label, symbol?, values: { <literal>: label, … } }`, one label for each of its values, is a menu of radios.
The annotation is declared on Effect's annotation interface, so `annotate` completes it:

```ts
settings: Schema.Struct({
  vowelPoints: Schema.Boolean.annotate({ default: true, property: { label: "Vowel points" } }),
  scheme: Schema.Literals(["academic", "simple"]).annotate({
    default: "simple",
    property: { label: "Scheme", values: { academic: "Academic", simple: "Simple" } },
  }),
}),
```

A `property` annotation on a field of any other type, one without a label, a label, symbol or value label that isn't
text or `{ text, attributes }` free of NULs and lone surrogates, whose attributes each have a known `type` and integer
`value`, `start` and `end` with `0 <= start <= end`, or a literals field whose `values` don't match its choices exactly,
is a `ModuleDefinitionError`.

- The key is `<engine>:<GSettings key>`, `hebrew:vowel-points`, where the engine is the name `defineModule` gives it, so
  a page finds a setting's property without a table of its own. A menu's radios are `<menu key>:<literal>`, as
  `hebrew:scheme:academic`. An engine under two names has each name's keys in its sessions. An engine with such a
  setting that isn't the one a module returns throws when a session is created.
- The kit registers them in every session of the engine when it is created, with the properties the session registers,
  keeps them registered when the session registers again, and registers them again on every FocusIn.
- Activating a toggle writes the state the activation asks for, `checked` being true. Activating a radio as `checked`
  writes its value, and any other activation of it writes nothing. An activation that asks for the value the setting
  holds writes nothing, so one repeated, or sent from a stale view, changes nothing.
- Whenever the setting changes, whether this session, another or the page wrote it, the kit updates the property: the
  toggle's state, or the radios whose state changed.
- `propertyActivate` for one of these keys, a menu's included, never reaches the session's handler; any other key does.
- `updateProperty` may change how one of these properties looks, such as its label or `sensitive`, but refuses `checked`
  and `children` with an `Error`, since the kit keeps the state and the radios in step with the setting.

## Transform engines

A transliteration is a pure function of the whole typed word, so `transformEngine` makes an engine of one:

```ts
import { defineModule, transformEngine } from "@ibus-web/module-kit";
import { Schema } from "effect";

export default defineModule({
  name: "example-transliteration",
  version: "1.0.0",
  license: "MIT",
  settingsPrefix: "org.example.transliteration",
  engines: {
    hebrew: transformEngine({
      displayName: "Romanized Hebrew",
      languages: ["he"],
      settings: Schema.Struct({
        vowelPoints: Schema.Boolean.annotate({ default: true, title: "Write vowel points" }),
      }),
      transform: (input, settings) =>
        transliterateHebrew(input, { scheme: "academic", vowelPoints: settings.vowelPoints }),
    }),
  },
});
```

`transformEngine({ ...descriptor, settings?, transform, alphabet? })` takes the descriptor and settings of
`defineEngine` and returns an engine for `defineModule`. `transform(input, settings)` returns the text, or
`{ text, notes? }` with `notes` an array of lines, and `settings` holds the typed values of the settings struct. It may
return an `Effect` of either, which the kit runs with `Effect.runSync`.

Only `notes` reaches the auxiliary text. A function whose result carries its warnings under another field, such as
`{ text, warnings }`, still type-checks as a transform, since the extra field is allowed, and its warnings are dropped
without a word. Map them into `notes`:

```ts
transform: (input) => {
  const { text, warnings } = transliterate(input);
  return { text, notes: warnings.map((warning) => warning.message) };
},
```

The session keeps a raw buffer of the characters typed, and calls `transform` on all of it after every key, so context
rules such as final forms, stacking and breathings are right whatever has been typed so far. A key's character is the
one `processKey` is given.

- A key whose character is in the alphabet is appended to the buffer and consumed. The alphabet is every character but
  whitespace and control characters; `alphabet` narrows it with a string of the allowed characters or a predicate on the
  character.
- The preedit is the transform's text exactly as it returns it, with its cursor at the end and one underline over all of
  it, in COMMIT mode. The auxiliary text is the raw buffer, then one line for each note. When the buffer is empty the
  preedit and auxiliary text are hidden.
- Space, Enter and Tab, and any key whose character is outside the alphabet or absent, commit the transformed buffer and
  pass through. Keypad Space, Enter and Tab act like the main keys.
- An alphabet that holds the space, as a string with `" "` in it or a predicate that accepts it, makes Space part of the
  input instead: it is appended to a pending buffer and consumed, for schemes such as Wylie, where a space between
  syllables is a tsheg (`bod skad` gives `བོད་སྐད`). With nothing pending, Space passes through, so a plain space can be
  typed between words. Enter and Tab still commit. The default alphabet doesn't hold it.
- Backspace deletes the last code point of the buffer and is consumed, or passes through when the buffer is empty.
- Escape commits the raw buffer and is consumed, or passes through when the buffer is empty.
- A key held with Control, Alt or Super commits the transformed buffer and passes through. Modifier keys alone and key
  releases pass through and change nothing.
- `reset` clears the buffer and hides the preedit. `focusOut` clears the buffer and hides the auxiliary text; the page
  commits a COMMIT-mode preedit on blur, as for every engine.
- A change to any of the engine's settings redraws the preedit and auxiliary text with the new values when a buffer is
  pending.
- A `transform` that throws, whose Effect fails, or whose result no record can carry, is not a fault. While the word is
  being typed, the preedit shows the raw buffer, underlined, with the raw buffer as the auxiliary text, and composing
  goes on; the kit logs one warning naming the error for the word, not one for each key. If the transform still throws
  when the word is committed, by Space, Enter, Tab, a key outside the alphabet or a modifier chord, the raw buffer is
  committed. A result no record can carry is anything but a string or `{ text, notes? }`, or text or notes holding a NUL
  or a lone surrogate, which slicing an astral character in half makes.

## The missing event loop

A Worker running a module sleeps in `Atomics.wait()` between requests, so the event loop doesn't run while a module is
serving. A promise's continuation and a `setTimeout` callback wait, and nothing reports it: the callback is queued and
runs only when the host next leaves its synchronous section, such as to take the page's messages: at no time an engine
can count on, and outside any request. An engine can't wait for anything. It computes its answer inside the handler and
returns it.

- **`context.after(ms, fn)`** is the timer. The host's pump runs `fn` once `ms` milliseconds have passed, on a monotonic
  clock, from its pump. The function it returns cancels the timer. A session's timers end with the session. A timer
  scheduled by a timer waits for the next pump, so one that reschedules itself can't hold the host. What a timer writes
  to the context reaches the page like a handler's output. A throw from a timer is a fault, as from a handler. `after`
  throws a `TypeError` for a delay that isn't a finite, non-negative number or a callback that isn't a function.
- **Effect handlers** are run with `Effect.runSync`. An Effect that reaches an asynchronous boundary, such as
  `Effect.sleep`, `Effect.promise` or `Effect.tryPromise`, throws, and the throw is a fault that the host reports with
  its message. The kit interrupts the Effect's fiber first, so its continuation never runs; only a finalizer that itself
  waits could still run later. Use `Effect.sync` and pure combinators; to delay something, call `context.after`. An
  Effect that fails is a fault too, so handle an expected failure in the Effect rather than let it out.
- **`transformEngine`'s `transform`** is held to the same rule. Its Effect is run with `runSync`; a `transform` that
  fails is not a fault, as the section above describes, and one that waits fails the same way, its fiber interrupted:
  the kit uses the raw buffer.

Async work is allowed only where the host leaves its synchronous section, which is at module import; see
[worker-host.md](worker-host.md#the-request-loop) for the loop.

## What a module's top level may not do

The script's top level runs when the host imports it, and a build imports it to describe the module. It should do
nothing but build the module value:

- No side effects: no timers, no network, no storage, no registration with anything outside the module. Work belongs in
  `create` and the handlers it returns.
- No Worker or DOM globals: no `self.postMessage`, `document`, `window` or `localStorage`. The same script is imported
  under Node, where they don't exist, and a script that touches one at its top level fails to import there. Reaching one
  from inside a handler is the same bug later.
- No `import.meta.url` as a base: a build imports the script from a `data:` URL, against which a relative
  `new URL(…, import.meta.url)` doesn't resolve. The script is one file, with nothing beside it to point at.

## Size

A module script is a single file, and `effect` is bundled into it, since the kit and a module's `Schema` structs run in
the module's own Worker. A fixture of two engines with settings comes to about 117 KB minified and 37 KB gzipped (about
560 KB unminified), nearly all of it Effect, so a module ships minified.

## Building a module

A module's build bundles its entry into one ES module file, with the kit and Effect inlined, and hands that script to
the post-processor, which writes the directory a page serves. The bundler plugin does both in the build a project
already has; the command line runs the post-processor on a script bundled any other way.

### The post-processor

`@ibus-web/module-kit/build` runs under Node, and the root entry never imports it, so a module's bundle carries none of
it. It exports `buildModule({ script, sourceMap, outDir })`, an Effect program, and
`buildModuleFiles({ script, sourceMap, sourceMapComment })`, the same without writing, for a bundler that emits the
files itself. `script` is the bundled script's bytes, or its text as UTF-8, and the optional `sourceMap` its source
map's. `sourceMapComment` is true unless given, and false keeps the comment naming the map out of the script. Both
succeed with the decoded manifest and the files, in the order they are written:

- `module.<hash>.js`, the script byte for byte but for a trailing `//# sourceMappingURL=` comment, `<hash>` the first 16
  hexadecimal digits of the SHA-256 of that code, followed, when there is a source map, by the map's bytes as given. The
  name changes with the code and the map, so a server can cache the script and its map as immutable. Minifying is the
  bundler's choice.
- `module.<hash>.js.map`, when there is a source map: `sourceMap`, or, unset, a map the comment inlines as a `data:`
  URL. Its `file` names the script, and the script ends in a comment naming the map, so the map resolves wherever the
  directory is served; with `sourceMapComment: false` the map is still written under that name, and the script has no
  comment. A comment naming a map that isn't given is dropped. The map's `sources` are written as given.
- `settings.json`, when any engine has settings: the `SettingsMetadata` the page validates values and builds its form
  from, each engine's schema `<settingsPrefix>.<engine>` at that id's path, its keys in the order the engine declares
  them with their types, defaults, summaries, descriptions, ranges and choices.
- `manifest.json`: `kind: "js"`, the module's `name` and `license`, the protocol version and `moduleAbi`, the script's
  URL and size (the bytes served, the comment included), each engine's descriptor under its name in the engines' order,
  the settings schema ids and, with settings, the metadata's URL and size. URLs are relative to the manifest. `version`
  is `<version>+js.<hash>`, `<hash>` the first 16 hexadecimal digits of SHA-256 over the script's code followed by
  `settings.json`, so a change to either is a new version. A module version that already carries build metadata, as
  `1.2.0+meta`, gets the hash as a further identifier: `1.2.0+meta.js.<hash>`.

The JSON is written with two-space indentation and a final newline, its keys in the schemas' order, so building the same
script again writes the same bytes. The manifest is written last, so one on disk never names a file not yet written;
files a build of another script left behind stay.

It fails with a `Data.TaggedError` whose `message` says what is wrong, and, but for `WriteFailed`, before writing
anything:

| Tag                       | Fields            | When                                                                                           |
| ------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `ScriptUnreadable`        | `reason`          | the script isn't UTF-8, or `es-module-lexer` can't read it as an ES module                     |
| `ScriptHasImports`        | `imports`         | it has a static import, an `export … from` or a dynamic `import()`; `import.meta` is fine      |
| `ScriptThrew`             | `reason`, `cause` | importing it under Node throws, as a `ModuleDefinitionError` or a top-level Worker global does |
| `ModuleRefused`           | `reason`          | its default export isn't a module script, states another module ABI, or breaks the contract    |
| `SettingsMetadataRefused` | `reason`          | `decodeSettingsMetadata` refuses the settings metadata, as for an engine name with no path     |
| `SourceMapUnreadable`     | `reason`          | the source map isn't a JSON object                                                             |
| `ManifestRefused`         | `reason`          | the JavaScript manifest's decoder refuses the manifest, as for a name or descriptor            |
| `WriteFailed`             | `path`, `reason`  | `outDir` or a file in it can't be written; only `buildModule` fails with it                    |

Each of `imports` is the import's `specifier` (undefined for a computed one) and its `line`. A module script is one
file, so preloading has one URL to fetch and the hash in its name covers everything that runs.

```ts
import { buildModule } from "@ibus-web/module-kit/build";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";

const script = await readFile("dist/module.js");

const built = await Effect.runPromise(
  buildModule({ script, outDir: "dist/module" }).pipe(
    Effect.catchTag("ScriptHasImports", ({ imports }) =>
      Effect.die(`the bundle still imports ${imports.map((item) => item.specifier).join(", ")}`),
    ),
  ),
);

console.log(built.manifest.version);
```

The default export is checked against the contract by the protocol's `scriptProblem`, the check the host runs at start
before comparing the export with its manifest, so a script that builds also starts. The build then requires a string
`name`, `version` and `license` and a descriptor on each engine, and reads everything else in the manifest from the
script, so the two can't disagree.

### The command line

The package's `bin`, `ibus-web-module`, runs `buildModule` on a script already bundled by whatever tool the module uses:

```sh
ibus-web-module build dist/module.js --out dist/module
```

A map the script's trailing comment names, inlined or in a file beside the script, is written beside the built script,
its relative `sources` rewritten to lead from `--out` to the same files. It prints the output directory and the
manifest's version on success. A refusal is one line on stderr, `<script>: <tag>: <message>`, the tag naming the check
that failed and the message the engine or key and the reason, and the exit code is 1; so is a script that can't be read.
`--help` prints the usage. An unknown option, a missing script or `--out`, or another command prints the usage to stderr
and exits 2.

### The bundler plugin

`@ibus-web/module-kit/unplugin` exports the plugin as an [unplugin](https://unplugin.unjs.io/) instance (`unplugin`,
also the default export) and its factory (`unpluginFactory`), and `@ibus-web/module-kit/<bundler>` exports it ready for
Vite, Rollup, Rolldown, esbuild, webpack and Rspack. It goes in a build whose one input is the module's entry, which in
Vite is the plugin's `entry` option. It sets the bundler's output to one ES module file, with every dependency inlined,
no chunk split out, no runtime chunk and the entry's exports kept, and runs `buildModuleFiles` on that script. The
module's files take the entry script's place in the bundler's output, under `ibus-module/<module name>/`. A setting of
the build's own that the plugin replaces, as a `format` other than ES modules or a split of chunks, is replaced with a
warning (`ibus-web-module replaces <setting>: …`), not refused, since a framework may set it for every build.

It takes these options:

- `entry`, in Vite only: the module's entry, relative to Vite's `root`. Given, `vite build` is the module's own build
  and the dev server serves the module; unset, the plugin only builds the modules `?ibus-module` imports name, and an
  application's build stays the application's whatever its input.
- `outDir`: the directory, relative to the bundler's output directory, that the files go to. A path outside it, or the
  output directory itself, fails the build with `OutDirRefused`.
- `minify`: whether the bundler's own minifier runs on the script. Unset, Rolldown and esbuild minify, and Vite, webpack
  and Rspack do what they do without the plugin: minify a production build. Rolldown keeps a minifier setting of the
  build's own, such as `output.minify: "dce-only"`, unless `minify` is false. Rollup has no minifier, so a Rollup build
  adds one, such as `@rollup/plugin-terser`, which runs before the plugin reads the script, and the Rollup plugin takes
  no `minify`: given `true` anyway, it fails the build. A module is mostly Effect, and a fixture of two engines is about
  115 KB minified against 560 KB not.

A refusal of `buildModuleFiles` fails the bundler's build with `<tag>: <message>`, the message on one line, and so does
a build that gives more than one script, as from two entries (`NotOneFile`). A build that emits a file besides the
script and its map, as for an imported stylesheet or image or an asset another plugin emits, fails with
`ModuleHasAssets`, naming the files: the module is served as one file, and nothing would serve them. The one exception
is the `*.LICENSE.txt` file that webpack's and Rspack's minimizers extract comments to, which the script's own comment
names: it is moved beside the module's files. A source map the bundler writes for the entry goes with it, as
`module.<hash>.js.map`, its relative `sources` rewritten to lead to the same files, and its old name leaves the output.
A hidden map, which a bundler writes without a comment, is written the same way and the script gets no comment. Vite's
builds write a map as `build.sourcemap` says, and its dev server always.

Building imports the script under Node to read its engines and settings, and Node never releases an imported module, so
each of the plugin's builds runs `buildModuleFiles` in a `worker_threads` Worker of its own that ends with it.
Rebuilding on every edit, in Vite's dev server or a bundler's watch mode, then leaves the process's heap where it was.

The bundlers reach the script in different places, since unplugin's shared hooks don't see output files:

| Bundler  | Import                          | Output set                                                                    | Script read                                                             |
| -------- | ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Vite     | `@ibus-web/module-kit/vite`     | `format: "es"`, `codeSplitting: false`, `preserveEntrySignatures: "strict"`   | a nested build's one chunk; emitted as assets ([below](#vites-builds))  |
| Rollup   | `@ibus-web/module-kit/rollup`   | `format: "es"`, `inlineDynamicImports: true`                                  | as Vite                                                                 |
| Rolldown | `@ibus-web/module-kit/rolldown` | `format: "es"`, `codeSplitting: false`                                        | as Vite                                                                 |
| esbuild  | `@ibus-web/module-kit/esbuild`  | `bundle`, `format: "esm"`, no `splitting`, `metafile`                         | the metafile's entry output, at the end of the build; written beside it |
| webpack  | `@ibus-web/module-kit/webpack`  | ES module output and library, no split or runtime chunk, `asyncChunks: false` | `processAssets`, after minifying; emitted as minimized assets           |
| Rspack   | `@ibus-web/module-kit/rspack`   | as webpack                                                                    | as webpack                                                              |

In Vite, the plugin's `entry` names the module, and the plugin makes it the build's input in place of whatever
`build.rolldownOptions.input` (or its alias `build.rollupOptions.input`) names. Without `entry`, an application's build
imports modules instead ([below](#importing-a-module-in-vite)):

```ts
// vite.config.ts
import ibusModule from "@ibus-web/module-kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [ibusModule({ entry: "src/module.ts" })],
});
```

Rollup resolves the kit and `effect` from `node_modules` only with `@rollup/plugin-node-resolve`, and reads TypeScript
only with a plugin for it:

```js
// rollup.config.js
import ibusModule from "@ibus-web/module-kit/rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";

export default {
  input: "src/module.js",
  output: { dir: "dist" },
  plugins: [nodeResolve(), terser(), ibusModule()],
};
```

Rolldown and esbuild need nothing else:

```js
// rolldown.config.js
import ibusModule from "@ibus-web/module-kit/rolldown";

export default { input: "src/module.ts", output: { dir: "dist" }, plugins: [ibusModule()] };
```

```js
import ibusModule from "@ibus-web/module-kit/esbuild";
import { build } from "esbuild";

await build({ entryPoints: ["src/module.ts"], outdir: "dist", plugins: [ibusModule()] });
```

esbuild writes the files itself and removes the entry script once the build ends. With `write: false`, they replace the
entry in the result's `outputFiles` instead. esbuild doesn't drop the parts of Effect's namespaces a module leaves
unused, so its script is about three times the others': the fixture comes to about 360 KB with esbuild, 170 KB with
Rspack, and 105 to 120 KB with Rollup and terser, webpack, Vite or Rolldown.

webpack and Rspack take the plugin in `plugins`, and a TypeScript entry needs a loader, as any of their builds does:

```js
// webpack.config.js
import ibusModule from "@ibus-web/module-kit/webpack";

export default { mode: "production", entry: "./src/module.js", plugins: [ibusModule()] };
```

```js
// rspack.config.js
import ibusModule from "@ibus-web/module-kit/rspack";

export default { mode: "production", entry: "./src/module.js", plugins: [ibusModule()] };
```

The `module-kit-bundlers` check builds a fixture module, and the TypeScript example in
[`examples/pinyin-tones`](../examples/pinyin-tones/README.md), with each of the six and compares the manifest and
`settings.json` with the command line's build of the same source, all but the script's hash and size. With source maps
on, each writes the map beside the script, named for it and leading to the fixture's source. Rollup and webpack read
only JavaScript, so the check gives them a plugin and a loader that strip the types; Rspack uses its
`builtin:swc-loader`, and the other three read TypeScript.

### Vite's builds

The Vite plugin builds a module the same way whichever path asks for it: `vite build` of the module's own entry, an
application's `?ibus-module` import, and the dev server. Every one of them uses the application's `resolve`, `define`
and `worker.plugins`. The module is bundled by Vite's own `build()`, not by the build the plugin is in, which for a
module's own entry bundles nothing itself and gets the module's files in its output. The nested build runs with no
configuration file and these pieces of the application's resolved configuration: `root`, `base`, `mode`, `cacheDir`,
`envDir`, `envPrefix`, `resolve`, `define` and `build.target`, and the plugins `worker.plugins` returns, called afresh
for each build. A module script runs in a Worker, so it gets what the application's Workers get: its aliases and
`define`d constants, and the plugins of its Workers, not its top-level `plugins`. A plugin the module's source needs, as
for a file type Vite doesn't read itself, goes in `worker.plugins`. The nested build's warnings go to the application's
logger, prefixed `[ibus-web-module]`; its errors fail the module's build. Its output is the one ES module file a module
is, minified as `build.minify` and the plugin's `minify` say, except in the dev server, which doesn't minify.

In `vite build --watch`, each file the module bundled is watched, dependencies under `node_modules` aside, and a change
to one rebuilds it with the rest. A build that fails keeps watching what the last good one bundled, and the files the
failing one read.

### Importing a module in Vite

An application imports a module from its own build, as it imports a `?worker`:

```ts
import transliteration from "./transliteration.module.ts?ibus-module";

ModuleRegistry.layer({ hostUrl, runtimeUrl, modules: { transliteration } });
```

In `vite build`, the import builds the entry, emits its files as assets under `<assetsDir>/<module name>/`
(`assets/transliteration/manifest.json` by default), and gives the manifest's URL under `base`, as a `?url` import does:
`/assets/transliteration/manifest.json`, or relative to the importing script for a relative `base`. The plugin's
`outDir` is for a module's own build and doesn't apply. Each module's name sets its directory, so modules of different
names never collide, and two entries building modules of one name fail the build with `DuplicateModuleName`, naming
both. One entry imported from several places is built once.

In the dev server, the import gives the path its middleware serves the module at, the same `<assetsDir>/<module name>/`
under `base`; the module builds when the import is first loaded, and a failure of that build fails the import.

`@ibus-web/module-kit/client` declares `*?ibus-module` imports as a default-exported string, for a `tsconfig`'s `types`
as `vite/client` is:

```json
{ "compilerOptions": { "types": ["vite/client", "@ibus-web/module-kit/client"] } }
```

The same import in the other bundlers would need a nested build in each, and they build a module as its own entry.

### Vite's dev server

In `vite` (the dev server), the Vite plugin serves modules from middleware at the paths `vite build` writes their files
to, under the server's `base`: for the module the plugin's `entry` names, `/ibus-module/<module name>/manifest.json` and
its neighbours, or under `outDir`, built on the first request under that directory; for an import, as above. The
manifest and `settings.json` are the ones `vite build` writes, all but the script's hash and size in the manifest; files
are served as `application/json` and `text/javascript` with `Cache-Control: no-cache`, and any other path under a
module's directory, as a script an older manifest names, answers 404. A path under `outDir` but outside the module's
directory, such as a file of `publicDir`, goes on to Vite's own middleware.

The server watches each file a module's build bundled, dependencies under `node_modules` aside. A change to one rebuilds
the module and, once the build succeeds, reloads the page, which loads the new version afresh, an import's URL with it:
hot replacement can't carry an engine's state in its Worker over. Vite's own update of an import, which would reload the
page before the rebuild, is dropped. Changes during a build are built together once it ends. A build that fails, as a
source that doesn't bundle (`BundleFailed`) or a refusal of `buildModuleFiles`, logs `<tag>: <message>` through Vite's
logger and in the page's error overlay, and leaves the last good build served; with none yet, a request answers 500 with
that line. A failed build can't list what it would have bundled, so until a build succeeds, a file created or changed in
a directory holding a file it read rebuilds the module too, as creating the file a new import names does. A module whose
name another module of the dev server already has fails as `DuplicateModuleName`.

`module-kit-bundlers` starts a dev server on the fixture module and compares what it serves with `vite build`'s output,
edits the source to get a new version and a reload message, breaks it and recovers with the refusal in the overlay,
answers 404 for a stale script, recovers a first build that fails on a missing import once the file is created, and
rebuilds 20 times to check the server's heap doesn't grow with each build. It also builds a fixture application
importing the fixture module and one whose engine only the application's alias reaches: the import's files against the
command line's, the import's value under a `base` of `/app/`, an application whose input is its script built as an
application, the nested build's warnings in the application's log, two entries of one module name refused, a rebuild
under `vite build --watch`, the dev server serving each module at its import's URL, and its rebuild of an imported
module on an edit, with one reload.

### Serving a module

A build's output directory is static files: `manifest.json`, `module.<hash>.js` and, for a module with settings,
`settings.json`. The page passes the manifest's URL to the facade, and the host resolves the script's and the settings'
URLs against it. Three things in how the files are served matter:

- **CORS**, when the module comes from another origin than the page. The script, the manifest and `settings.json` are
  each fetched across origins, so each response carries an `Access-Control-Allow-Origin` that allows the page's origin,
  as a `.wasm` from another origin needs ([worker-host.md](worker-host.md#the-program-and-its-scopes)).
- **`script-src`**, under a Content Security Policy. The script is loaded by `import()` in the module's Worker, so the
  policy's `script-src` must allow the script's origin; a module from the page's own origin needs nothing.
- **An immutable cache for the script.** `module.<hash>.js`, and its map, are named for their bytes, so
  `Cache-Control: public, max-age=31536000, immutable` is safe for them, and a new build is a new URL. `manifest.json`
  and `settings.json` keep their names and name the current script, so they are served to be revalidated
  (`Cache-Control: no-cache`), as the dev server serves every file.

The page itself must be cross-origin isolated for the host's `SharedArrayBuffer`, with COOP `same-origin` and COEP
`require-corp`, as for any module ([ibus-web.md](ibus-web.md)). The plugin sets no headers, since they apply to the
whole server. The application's Vite configuration sets them, for its dev server and `vite preview` alike, as the demo's
does:

```ts
// vite.config.ts
import ibusModule from "@ibus-web/module-kit/vite";
import { defineConfig } from "vite";

const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  plugins: [ibusModule({ entry: "src/module.ts" })],
});
```

### The version's identity

A built manifest's `version` is the module's own `version` with `+js.<hash>` appended (or `.js.<hash>` after build
metadata it already has). `<hash>` is the first 16 hexadecimal digits of SHA-256 over the script's code, without a
`sourceMappingURL` comment, followed by `settings.json`, so the version changes exactly when the code that runs or the
metadata the page builds its form from changes. Both derive from the script, so the same script gives the same version;
a kit that writes different metadata for an unchanged script gives a new one. The script's file name hashes the script's
code and its source map, if it has one, so it stays the same when only the metadata changes.
