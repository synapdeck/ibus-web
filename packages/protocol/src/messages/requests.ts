// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { GVariantVariant } from "../gvariant/schema.ts";
import { Int32, Str, Uint32 } from "../ibus/annotations.ts";
import { IBusText, KeyEvent } from "../ibus/types.ts";

export const SettingsInstance = Schema.Struct({
  schemaId: Str.annotate({ description: "GSettings schema id." }),
  path: Str.annotate({ description: "Path the schema is instantiated at, ending in /." }),
  values: Schema.Record(Str, GVariantVariant).annotate({ description: "The instance's stored values, by key." }),
});

export class Init extends Schema.TaggedClass<Init>()(
  "Init",
  {
    version: Uint32.annotate({ description: "Protocol version supported by the host." }),
    settings: Schema.Array(SettingsInstance).annotate({
      description: "Every GSettings schema instance the module declares, with its stored values.",
    }),
  },
  { kind: 1, description: "Initialize the runtime with the host's protocol version and settings." },
) {}

export class CreateEngine extends Schema.TaggedClass<CreateEngine>()(
  "CreateEngine",
  { name: Str.annotate({ description: "IBus engine name to instantiate for the input context." }) },
  { kind: 2, description: "Create an engine for the input context." },
) {}

export class DestroyEngine extends Schema.TaggedClass<DestroyEngine>()(
  "DestroyEngine",
  {},
  { kind: 3, description: "Destroy the input context's engine." },
) {}

export class SettingChanged extends Schema.TaggedClass<SettingChanged>()(
  "SettingChanged",
  {
    path: Str.annotate({ description: "Path of the schema instance holding the changed key." }),
    key: Str.annotate({ description: "GSettings key that changed." }),
    value: GVariantVariant.annotate({ description: "New typed GSettings value." }),
  },
  { kind: 4, description: "Notify the runtime that a host setting changed." },
) {}

export class ProcessKeyEvent extends Schema.TaggedClass<ProcessKeyEvent>()("ProcessKeyEvent", KeyEvent, {
  kind: 16,
  reply: "b",
  description: "Process a key event and reply whether the engine handled it.",
}) {}

export class FocusIn extends Schema.TaggedClass<FocusIn>()(
  "FocusIn",
  {},
  { kind: 17, description: "Give the input context keyboard focus." },
) {}

export class FocusOut extends Schema.TaggedClass<FocusOut>()(
  "FocusOut",
  {},
  { kind: 18, description: "Remove keyboard focus from the input context." },
) {}

export class Reset extends Schema.TaggedClass<Reset>()(
  "Reset",
  {},
  { kind: 19, description: "Reset the engine's composition state." },
) {}

export class Enable extends Schema.TaggedClass<Enable>()(
  "Enable",
  {},
  { kind: 20, description: "Enable the input context's engine." },
) {}

export class Disable extends Schema.TaggedClass<Disable>()(
  "Disable",
  {},
  { kind: 21, description: "Disable the input context's engine." },
) {}

export class SetCursorLocation extends Schema.TaggedClass<SetCursorLocation>()(
  "SetCursorLocation",
  {
    x: Int32.annotate({ description: "Horizontal position of the cursor rectangle in screen coordinates." }),
    y: Int32.annotate({ description: "Vertical position of the cursor rectangle in screen coordinates." }),
    width: Int32.annotate({ description: "Width of the cursor rectangle." }),
    height: Int32.annotate({ description: "Height of the cursor rectangle." }),
  },
  { kind: 22, description: "Update the cursor rectangle used to position input method UI." },
) {}

export class SetCapabilities extends Schema.TaggedClass<SetCapabilities>()(
  "SetCapabilities",
  {
    capabilities: Uint32.annotate({ description: "IBusCapabilite flags describing the client's supported features." }),
  },
  { kind: 23, description: "Tell the engine which input method features the client supports." },
) {}

export class PageUp extends Schema.TaggedClass<PageUp>()(
  "PageUp",
  {},
  { kind: 24, description: "Move to the previous candidate page." },
) {}

export class PageDown extends Schema.TaggedClass<PageDown>()(
  "PageDown",
  {},
  { kind: 25, description: "Move to the next candidate page." },
) {}

export class CursorUp extends Schema.TaggedClass<CursorUp>()(
  "CursorUp",
  {},
  { kind: 26, description: "Move the candidate cursor up." },
) {}

export class CursorDown extends Schema.TaggedClass<CursorDown>()(
  "CursorDown",
  {},
  { kind: 27, description: "Move the candidate cursor down." },
) {}

export class CandidateClicked extends Schema.TaggedClass<CandidateClicked>()(
  "CandidateClicked",
  {
    index: Uint32.annotate({
      description: "Page-relative position of the clicked candidate on the visible lookup table page.",
    }),
    button: Uint32.annotate({ description: "Mouse button used to select the candidate." }),
    state: Uint32.annotate({ description: "Modifier state at the time of the click." }),
  },
  { kind: 28, description: "Notify the engine that the user clicked a candidate." },
) {}

export class PropertyActivate extends Schema.TaggedClass<PropertyActivate>()(
  "PropertyActivate",
  {
    name: Str.annotate({ description: "Key of the IBus property to activate." }),
    state: Uint32.annotate({ description: "IBusPropState requested for the property." }),
  },
  { kind: 29, description: "Activate an input method property." },
) {}

export class SetSurroundingText extends Schema.TaggedClass<SetSurroundingText>()(
  "SetSurroundingText",
  {
    text: IBusText.annotate({ description: "Client text surrounding the insertion point." }),
    cursor: Uint32.annotate({ description: "Insertion point in characters within the surrounding text." }),
    anchor: Uint32.annotate({ description: "Selection anchor in characters within the surrounding text." }),
  },
  { kind: 30, description: "Update the surrounding text and selection known to the engine." },
) {}

export class SetContentType extends Schema.TaggedClass<SetContentType>()(
  "SetContentType",
  {
    purpose: Uint32.annotate({ description: "IBusInputPurpose of the focused input field." }),
    hints: Uint32.annotate({ description: "IBusInputHints flags for the focused input field." }),
  },
  { kind: 31, description: "Describe the focused input field's purpose and input hints." },
) {}

export const Request = Schema.Union([
  Init,
  CreateEngine,
  DestroyEngine,
  SettingChanged,
  ProcessKeyEvent,
  FocusIn,
  FocusOut,
  Reset,
  Enable,
  Disable,
  SetCursorLocation,
  SetCapabilities,
  PageUp,
  PageDown,
  CursorUp,
  CursorDown,
  CandidateClicked,
  PropertyActivate,
  SetSurroundingText,
  SetContentType,
]).pipe(Schema.toTaggedUnion("_tag"));
export type Request = typeof Request.Type;

export const requestKinds: ReadonlyMap<string, number> = new Map(
  Object.entries(Request.cases).map(([name, schema]) => [name, schema.ast.annotations!.kind!]),
);
