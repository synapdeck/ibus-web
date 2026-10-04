// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import { Schema } from "effect";
import { GVariantVariant } from "../gvariant/schema.ts";
import { Bool, Int32, Str, Uint32 } from "../ibus/annotations.ts";
import { IBusText, IBusLookupTable, IBusPropList, IBusProperty, KeyEvent } from "../ibus/types.ts";

export class CommitText extends Schema.TaggedClass<CommitText>()(
  "CommitText",
  { text: IBusText.annotate({ description: "Text to insert into the client at the current selection." }) },
  { kind: 1, description: "Commit the engine's text to the client." },
) {}

export class UpdatePreeditText extends Schema.TaggedClass<UpdatePreeditText>()(
  "UpdatePreeditText",
  {
    text: IBusText.annotate({ description: "Current uncommitted composition text and its attributes." }),
    cursor: Uint32.annotate({ description: "Cursor position in characters within the preedit text." }),
    visible: Bool.annotate({ description: "Whether to display the preedit text." }),
    mode: Uint32.annotate({
      description: "IBusPreeditFocusMode: what the client does with the preedit on focus out and reset.",
    }),
  },
  { kind: 2, description: "Update the client's preedit text, cursor and visibility." },
) {}

export class UpdateAuxiliaryText extends Schema.TaggedClass<UpdateAuxiliaryText>()(
  "UpdateAuxiliaryText",
  {
    text: IBusText.annotate({ description: "Auxiliary text supplied by the engine." }),
    visible: Bool.annotate({ description: "Whether to display the auxiliary text." }),
  },
  { kind: 3, description: "Update the auxiliary text shown with the input method UI." },
) {}

export class UpdateLookupTable extends Schema.TaggedClass<UpdateLookupTable>()(
  "UpdateLookupTable",
  {
    table: IBusLookupTable.annotate({ description: "Candidate list, labels, paging and cursor state." }),
    visible: Bool.annotate({ description: "Whether to display the candidate lookup table." }),
  },
  { kind: 4, description: "Update the candidate lookup table." },
) {}

export class ShowPreeditText extends Schema.TaggedClass<ShowPreeditText>()(
  "ShowPreeditText",
  {},
  { kind: 5, description: "Show the existing preedit text." },
) {}

export class HidePreeditText extends Schema.TaggedClass<HidePreeditText>()(
  "HidePreeditText",
  {},
  { kind: 6, description: "Hide the preedit text." },
) {}

export class ShowAuxiliaryText extends Schema.TaggedClass<ShowAuxiliaryText>()(
  "ShowAuxiliaryText",
  {},
  { kind: 7, description: "Show the existing auxiliary text." },
) {}

export class HideAuxiliaryText extends Schema.TaggedClass<HideAuxiliaryText>()(
  "HideAuxiliaryText",
  {},
  { kind: 8, description: "Hide the auxiliary text." },
) {}

export class ShowLookupTable extends Schema.TaggedClass<ShowLookupTable>()(
  "ShowLookupTable",
  {},
  { kind: 9, description: "Show the existing candidate lookup table." },
) {}

export class HideLookupTable extends Schema.TaggedClass<HideLookupTable>()(
  "HideLookupTable",
  {},
  { kind: 10, description: "Hide the candidate lookup table." },
) {}

export class RegisterProperties extends Schema.TaggedClass<RegisterProperties>()(
  "RegisterProperties",
  { properties: IBusPropList.annotate({ description: "Complete list of input method properties to display." }) },
  { kind: 11, description: "Register the engine's available properties with the client." },
) {}

export class UpdateProperty extends Schema.TaggedClass<UpdateProperty>()(
  "UpdateProperty",
  { property: IBusProperty.annotate({ description: "Replacement state for the property identified by its key." }) },
  { kind: 12, description: "Update one registered input method property." },
) {}

export class ForwardKeyEvent extends Schema.TaggedClass<ForwardKeyEvent>()("ForwardKeyEvent", KeyEvent, {
  kind: 13,
  description: "Forward a key event to the client for normal handling.",
}) {}

export class DeleteSurroundingText extends Schema.TaggedClass<DeleteSurroundingText>()(
  "DeleteSurroundingText",
  {
    offset: Int32.annotate({ description: "Signed character offset from the cursor to the start of the deletion." }),
    count: Uint32.annotate({ description: "Number of surrounding characters to delete." }),
  },
  { kind: 14, description: "Delete a range of the client's surrounding text." },
) {}

export class RequireSurroundingText extends Schema.TaggedClass<RequireSurroundingText>()(
  "RequireSurroundingText",
  {},
  { kind: 15, description: "Ask the client to supply its current surrounding text." },
) {}

export class SettingWritten extends Schema.TaggedClass<SettingWritten>()(
  "SettingWritten",
  {
    schemaId: Str.annotate({ description: "GSettings schema id containing the written key." }),
    key: Str.annotate({ description: "GSettings key written by the engine." }),
    value: GVariantVariant.annotate({ description: "Typed value the host should persist." }),
  },
  { kind: 32, description: "Notify the host of a setting written by the engine." },
) {}

export class Log extends Schema.TaggedClass<Log>()(
  "Log",
  {
    level: Uint32.annotate({ description: "GLogLevelFlags for this log entry." }),
    domain: Str.annotate({ description: "GLib log domain that emitted the entry." }),
    message: Str.annotate({ description: "Log message text." }),
  },
  { kind: 33, description: "Deliver a runtime log entry to the host." },
) {}

export const CrashReason = { trap: 1, fault: 2, relay: 3, load: 4, host: 5 } as const;
export class Crashed extends Schema.TaggedClass<Crashed>()(
  "Crashed",
  { reason: Uint32, message: Str },
  { kind: 34, description: "Host crash report; the shared control state is authoritative. Written by the host only." },
) {}

export const OutputRecord = Schema.Union([
  CommitText,
  UpdatePreeditText,
  UpdateAuxiliaryText,
  UpdateLookupTable,
  ShowPreeditText,
  HidePreeditText,
  ShowAuxiliaryText,
  HideAuxiliaryText,
  ShowLookupTable,
  HideLookupTable,
  RegisterProperties,
  UpdateProperty,
  ForwardKeyEvent,
  DeleteSurroundingText,
  RequireSurroundingText,
  SettingWritten,
  Log,
  Crashed,
]).pipe(Schema.toTaggedUnion("_tag"));
export type OutputRecord = typeof OutputRecord.Type;

export const recordKinds: ReadonlyMap<string, number> = new Map(
  Object.entries(OutputRecord.cases).map(([name, schema]): [string, number] => [name, schema.ast.annotations!.kind!]),
);
