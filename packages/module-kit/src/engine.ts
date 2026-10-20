// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { EngineDescriptor as ManifestDescriptor } from "@ibus-web/protocol/descriptor";
import type * as Contract from "@ibus-web/protocol/module-script";
import { Effect, Schema, Struct } from "effect";
import { ModuleDefinitionError } from "./errors.ts";
import { run } from "./run.ts";
import {
  gsettingsKey,
  type BoundSetting,
  readSettings,
  settingName,
  type NoSettings,
  type SettingName,
  type SettingsDeclaration,
  type SettingsSchema,
} from "./settings.ts";

// The manifest's descriptor without the name, which is the engine's key in
// its module, or the data, which a JavaScript module has none of. Each part of
// the keyboard defaults on its own.
const Descriptor = ManifestDescriptor.mapFields(Struct.omit(["name", "data"])).mapFields(
  Struct.evolve({
    keyboard: (keyboard) =>
      keyboard
        .mapFields(
          Struct.evolve({
            layout: (layout) => layout.pipe(Schema.withDecodingDefaultKey(Effect.succeed("default" as const))),
            passThrough: (passThrough) => passThrough.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
          }),
        )
        .pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  }),
);

/** An engine's descriptor as an author writes it. `keyboard` defaults to `{ layout: "default", passThrough: [] }`. */
export type EngineDescriptor = typeof Descriptor.Encoded;

/** The settings of the engine whose settings struct is `S`, by its field names, each holding its field's type. */
export interface EngineSettings<S extends SettingsSchema> {
  get<K extends SettingName<S>>(key: K): S["Type"][K];
  /** Stores a value and has the page persist it. The host throws for a value outside the setting's range or choices. */
  set<K extends SettingName<S>>(key: K, value: S["Type"][K]): void;
  /**
   * Calls `fn` with each new value of the setting once the store holds it, whether this session, another or the page
   * changed it. Returns a function that unsubscribes.
   */
  onChange<K extends SettingName<S>>(key: K, fn: (value: S["Type"][K]) => void): () => void;
}

/** A candidate: its text, and the label the panel shows beside it instead of its number. */
export type Candidate = string | { readonly text: Contract.RichText; readonly label?: Contract.RichText };

/** Where the candidate list's cursor is. `cursor` is an index into the list and defaults to 0. */
export interface CandidatesOptions {
  readonly cursor?: number;
  /** Defaults to true. */
  readonly cursorVisible?: boolean;
}

/** Where the cursor of the list `candidates` shows is: its index in the list, and whether the panel shows it. */
export interface CandidateCursor {
  readonly index: number;
  readonly visible: boolean;
}

/** A property as a session declares it. `checked` is a toggle's or radio's state. */
export interface PropertyDefinition {
  readonly key: string;
  readonly kind: Contract.PropertyKind;
  readonly label: Contract.RichText;
  readonly symbol?: Contract.RichText;
  readonly tooltip?: Contract.RichText;
  readonly icon?: string;
  readonly sensitive?: boolean;
  readonly visible?: boolean;
  readonly checked?: boolean;
  /** A menu's items. */
  readonly children?: readonly PropertyDefinition[];
}

/** What `updateProperty` merges into a registered property. */
export type PropertyChanges = Partial<Omit<PropertyDefinition, "key" | "kind">>;

/** What a session of the engine whose settings struct is `S` writes to. */
export interface EngineContext<S extends SettingsSchema = SettingsSchema> extends Omit<
  Contract.EngineContext,
  "settings" | "registerProperties" | "updateProperty"
> {
  readonly settings: EngineSettings<S>;
  /**
   * Shows the table of a whole list of candidates: the page of 10 that holds the cursor, pages starting at multiples
   * of 10. An empty list hides the table. A cursor outside the list is moved to its nearest end. While the list is the
   * table, `pageUp`, `pageDown`, `cursorUp` and `cursorDown` move its cursor unless the session defines them, and
   * `candidateClicked` is given the clicked candidate's index in the list.
   */
  candidates(list: readonly Candidate[], options?: CandidatesOptions): void;
  /** The cursor of the list `candidates` shows, or undefined while the table isn't a list of candidates. */
  candidateCursor(): CandidateCursor | undefined;
  /**
   * Declares the session's properties, replacing those it declared before. The properties of the engine's settings
   * stay registered beside them. Throws for a key used twice, or one a setting's property has.
   */
  registerProperties(properties: readonly PropertyDefinition[]): void;
  /**
   * Merges `changes` into the registered property with `key` and sends all of it. Throws for a key not registered, a
   * change to `undefined`, or a change of `checked` or `children` on a setting's property.
   */
  updateProperty(key: string, changes: PropertyChanges): void;
}

// A handler returning its result, or an Effect that does without waiting.
type Handler<F> = F extends (...args: infer A) => infer R ? (...args: A) => R | Effect.Effect<R, unknown> : never;

/**
 * A session's handlers for one input context's requests; any it leaves out does nothing. Each may return an Effect,
 * which the kit runs with `Effect.runSync`: one that reaches an asynchronous boundary throws, a fault the host reports.
 */
export type EngineSession = {
  [K in Exclude<keyof Contract.EngineSession, "settingChanged" | "propertyActivate">]?: Handler<
    NonNullable<Contract.EngineSession[K]>
  >;
} & {
  /** A property was activated; `checked` is whether the activation asks a toggle or radio to be checked. */
  readonly propertyActivate?: Handler<(key: string, checked: boolean) => void>;
};

export interface EngineDefinition<S extends SettingsSchema> extends EngineDescriptor {
  /** A `Schema.Struct` with a field for each setting. */
  readonly settings?: S;
  /** Makes a session for one input context. A throw fails the engine's creation with the error's message. */
  create(context: EngineContext<S>): EngineSession;
}

/** An engine as the module-script contract has it, its settings declared by GSettings key. */
export interface Engine<S extends SettingsSchema = SettingsSchema> extends Contract.ModuleEngine {
  readonly settings?: SettingsDeclaration<S>;
}

// The settings by name, before they are typed from the engine's struct.
interface NamedSettings {
  get(name: string): Contract.SettingValue;
  set(name: string, value: Contract.SettingValue): void;
  onChange(name: string, fn: (value: Contract.SettingValue) => void): () => void;
}

// A session's settings by declared name over the host's by key, and the
// subscribers its settingChanged calls.
const sessionSettings = (settings: Contract.EngineSettings, declared: ReadonlySet<string>) => {
  const subscribers = new Map<string, Set<(value: Contract.SettingValue) => void>>();

  const key = (name: string): string => {
    if (!declared.has(name)) throw new Error(`the engine declares no setting ${JSON.stringify(name)}`);
    return gsettingsKey(name);
  };

  const named: NamedSettings = {
    get: (name) => settings.get(key(name)),
    set: (name, value) => settings.set(key(name), value),
    onChange(name, fn) {
      key(name);

      // Each subscription is its own entry, so the same function subscribed
      // twice is called twice and unsubscribed once at a time.
      const entry = (value: Contract.SettingValue): void => fn(value);
      const entries = subscribers.get(name) ?? new Set();
      entries.add(entry);
      subscribers.set(name, entries);
      return () => void entries.delete(entry);
    },
  };

  // A copy of the subscribers, so that one unsubscribing or subscribing
  // while they are called changes only the next change's.
  const changed = (key: string, value: Contract.SettingValue): void => {
    for (const entry of Array.from(subscribers.get(settingName(key)) ?? [])) entry(value);
  };

  return { named, changed };
};

const toProperty = (definition: PropertyDefinition): Contract.Property => {
  const { checked, children, ...rest } = definition;

  return {
    ...rest,
    ...(checked === undefined ? {} : { state: checked ? "checked" : "unchecked" }),
    ...(children === undefined ? {} : { children: children.map(toProperty) }),
  } as Contract.Property;
};

const findProperty = (list: readonly Contract.Property[], key: string): Contract.Property | undefined => {
  for (const property of list) {
    const found = property.key === key ? property : findProperty(property.children ?? [], key);
    if (found !== undefined) return found;
  }
  return undefined;
};

const clearing = (field: string): string =>
  field === "sensitive" || field === "visible" ? "true restores it" : '"" clears a text';

const keysOf = (list: readonly Contract.Property[]): string[] =>
  list.flatMap((property) => [property.key, ...keysOf(property.children ?? [])]);

// Where a bound property's key leads: the setting it writes, and for a radio
// the value it selects.
interface Binding {
  readonly name: string;
  readonly value?: string;
}

// A session's properties: those of the engine's settings, which the kit keeps
// in step with them, and those the session registers.
const sessionProperties = (
  context: Contract.EngineContext,
  engine: string,
  bound: readonly BoundSetting[],
  settings: NamedSettings,
) => {
  const bindings = new Map<string, Binding>();

  const boundProperties = bound.map((setting): Contract.Property => {
    const key = `${engine}:${setting.key}`;
    const current = settings.get(setting.name);
    const common = { key, label: setting.label, ...(setting.symbol === undefined ? {} : { symbol: setting.symbol }) };

    bindings.set(key, { name: setting.name });
    if (setting.radios === undefined) return { ...common, kind: "toggle", state: current ? "checked" : "unchecked" };

    return {
      ...common,
      kind: "menu",
      children: setting.radios.map(({ value, label }) => {
        const radioKey = `${key}:${value}`;
        bindings.set(radioKey, { name: setting.name, value });
        return { key: radioKey, kind: "radio", label, state: current === value ? "checked" : "unchecked" };
      }),
    };
  });

  let own: Contract.Property[] = [];
  let registrations = 0;

  // Whether the panel has dropped the registration since the last one sent.
  let dropped = false;

  const all = (): Contract.Property[] => [...boundProperties, ...own];

  const send = (): void => {
    registrations += 1;
    dropped = false;
    context.registerProperties(all());
  };

  const setState = (property: Contract.Property, checked: boolean): void => {
    const state = checked ? "checked" : "unchecked";
    if (property.state === state) return;

    (property as { state: Contract.PropertyState }).state = state;
    context.updateProperty({ ...property });
  };

  for (const setting of bound) {
    settings.onChange(setting.name, (value) => {
      const key = `${engine}:${setting.key}`;

      if (setting.radios === undefined) {
        setState(findProperty(boundProperties, key)!, value === true);
        return;
      }

      for (const { value: choice } of setting.radios)
        setState(findProperty(boundProperties, `${key}:${choice}`)!, value === choice);
    });
  }

  return {
    register(definitions: readonly PropertyDefinition[]): void {
      const next = definitions.map(toProperty);
      const taken = new Set(keysOf(boundProperties));
      const keys = keysOf(next);

      const clash = keys.find((key, index) => taken.has(key) || keys.indexOf(key) !== index);
      if (clash !== undefined) throw new Error(`the property key ${JSON.stringify(clash)} is used twice`);

      own = next;
      send();
    },
    update(key: string, changes: PropertyChanges): void {
      const property = findProperty(all(), key);
      if (property === undefined) throw new Error(`the property ${JSON.stringify(key)} isn't registered`);

      // A bound property is found by its key and activated by its kind.
      if ("key" in changes || "kind" in changes)
        throw new Error(`the property ${JSON.stringify(key)} can't change its key or kind`);

      // The host faults on a field written as undefined.
      const unset = Object.keys(changes).find((name) => changes[name as keyof PropertyChanges] === undefined);
      if (unset !== undefined)
        throw new Error(`the property ${JSON.stringify(key)} can't have ${unset} undefined: ${clearing(unset)}`);

      // A setting's property keeps its state and radios in step with the
      // setting, which a change of either would leave behind.
      if (bindings.has(key) && (changes.checked !== undefined || changes.children !== undefined))
        throw new Error(
          `the property ${JSON.stringify(key)} is a setting's, whose state and radios follow the setting`,
        );

      const { checked, children, ...rest } = changes;
      Object.assign(property, rest);
      if (checked !== undefined)
        (property as { state: Contract.PropertyState }).state = checked ? "checked" : "unchecked";
      if (children !== undefined) Object.assign(property, { children: children.map(toProperty) });

      context.updateProperty({ ...property });
    },
    // Registers the bound properties for a session that has registered none
    // of its own.
    start(): void {
      if (registrations === 0 && boundProperties.length > 0) send();
    },
    // Runs the session's focusIn, then registers the properties again if the
    // panel dropped them with a focus out, unless the focusIn did.
    focusIn(handler: () => void): void {
      const before = registrations;
      handler();
      if (registrations === before && dropped && all().length > 0) send();
    },
    focusOut(): void {
      dropped = true;
    },
    // Handles an activation of a bound property, and tells whether it was one.
    // The state is the one the panel asks for, so an activation repeated, or
    // sent from a stale view, writes nothing new.
    activate(key: string, state: Contract.PropertyState): boolean {
      const binding = bindings.get(key);
      if (binding === undefined) return false;

      const write = (value: Contract.SettingValue): void => {
        if (settings.get(binding.name) !== value) settings.set(binding.name, value);
      };

      if (binding.value !== undefined) {
        if (state === "checked") write(binding.value);
      } else if (findProperty(boundProperties, key)?.kind === "toggle") write(state === "checked");
      return true;
    },
  };
};

type Properties = ReturnType<typeof sessionProperties>;

const pageSize = 10;

// A session's candidate list and its cursor, which the kit pages through.
const sessionCandidates = (context: Contract.EngineContext) => {
  let list: readonly Candidate[] = [];
  let cursor = 0;
  let cursorVisible = false;

  // Whether the table is the kit's list, or a page the session drew itself,
  // whose clicks count from that page. Before either, a click has no
  // candidate to land on.
  let drawn: "list" | "page" | undefined;

  const draw = (): void => {
    if (list.length === 0) {
      context.lookupTable({ candidates: [], cursor: 0, cursorVisible: false }, false);
      return;
    }

    const start = Math.floor(cursor / pageSize) * pageSize;
    const page = list
      .slice(start, start + pageSize)
      .map((candidate) => (typeof candidate === "string" ? { text: candidate } : candidate));

    // Labels are all or none; a candidate without one gets its place on the page.
    const labelled = page.some((candidate) => "label" in candidate && candidate.label !== undefined);

    context.lookupTable(
      {
        candidates: page.map((candidate) => candidate.text),
        ...(labelled
          ? {
              labels: page.map(
                (candidate, index) => ("label" in candidate ? candidate.label : undefined) ?? String(index + 1),
              ),
            }
          : {}),
        cursor: cursor - start,
        cursorVisible,
      },
      true,
    );
  };

  // Moves the cursor to `to` and redraws, unless the list is empty or the
  // cursor is already there. Paging keeps a hidden cursor hidden, so a list
  // can be paged without one candidate standing out.
  const move = (to: number): void => {
    if (list.length === 0 || to === cursor) return;

    cursor = to;
    draw();
  };

  // A hidden cursor is first shown where it is, so that the first press shows
  // the candidate the cursor is on before any moves it.
  const step = (to: () => number): void => {
    if (list.length === 0) return;

    if (cursorVisible) {
      move(to());
      return;
    }

    cursorVisible = true;
    draw();
  };

  const clear = (): void => {
    list = [];
    cursor = 0;
    cursorVisible = false;
  };

  return {
    show(next: readonly Candidate[], options: CandidatesOptions = {}): void {
      list = next;
      cursor = Math.min(Math.max(Math.trunc(options.cursor ?? 0) || 0, 0), Math.max(next.length - 1, 0));
      cursorVisible = (options.cursorVisible ?? true) && next.length > 0;
      drawn = "list";
      draw();
    },
    // The session's own page, which replaces the list.
    page(page: Contract.CandidatePage, visible: boolean): void {
      context.lookupTable(page, visible);
      clear();
      drawn = "page";
    },
    cursor: (): CandidateCursor | undefined =>
      drawn === "list" && list.length > 0 ? { index: cursor, visible: cursorVisible } : undefined,
    cursorUp: () => step(() => Math.max(cursor - 1, 0)),
    cursorDown: () => step(() => Math.min(cursor + 1, list.length - 1)),
    pageUp: () => move(cursor < pageSize ? cursor : cursor - pageSize),
    pageDown() {
      const next = (Math.floor(cursor / pageSize) + 1) * pageSize;
      move(next < list.length ? Math.min(cursor + pageSize, list.length - 1) : cursor);
    },
    // The index the session is given for a click on the visible page: the
    // list's index while the list is the table, or undefined past its last
    // candidate; otherwise the page's.
    indexOf(clicked: number): number | undefined {
      if (drawn === "page") return clicked;

      const index = Math.floor(cursor / pageSize) * pageSize + clicked;
      return Number.isInteger(clicked) && clicked >= 0 && index < list.length ? index : undefined;
    },
    clear,
  };
};

type Candidates = ReturnType<typeof sessionCandidates>;

// The session's handlers, read when each is called, so that `this` is the
// session and a handler it adds later is called too.
const hostSession = (
  session: EngineSession,
  candidates: Candidates,
  properties: Properties,
  settingChanged: (key: string, value: Contract.SettingValue) => void,
): Contract.EngineSession => ({
  processKey: (...args) => run(session.processKey?.(...args) ?? false),
  focusIn: () => properties.focusIn(() => run(session.focusIn?.())),
  focusOut() {
    properties.focusOut();
    run(session.focusOut?.());
  },
  reset: () => run(session.reset?.()),
  enable: () => run(session.enable?.()),
  disable: () => run(session.disable?.()),
  setCursorLocation: (...args) => run(session.setCursorLocation?.(...args)),
  setCapabilities: (...args) => run(session.setCapabilities?.(...args)),
  pageUp: () => (session.pageUp ? run(session.pageUp()) : candidates.pageUp()),
  pageDown: () => (session.pageDown ? run(session.pageDown()) : candidates.pageDown()),
  cursorUp: () => (session.cursorUp ? run(session.cursorUp()) : candidates.cursorUp()),
  cursorDown: () => (session.cursorDown ? run(session.cursorDown()) : candidates.cursorDown()),
  candidateClicked(index, button, state) {
    const listIndex = candidates.indexOf(index);
    if (listIndex !== undefined) run(session.candidateClicked?.(listIndex, button, state));
  },
  propertyActivate(key, state) {
    if (!properties.activate(key, state)) run(session.propertyActivate?.(key, state === "checked"));
  },
  setSurroundingText: (...args) => run(session.setSurroundingText?.(...args)),
  setContentType: (...args) => run(session.setContentType?.(...args)),
  settingChanged,
  destroy() {
    candidates.clear();
    run(session.destroy?.());
  },
});

// The keys of a definition: the descriptor's fields, picked out of its schema,
// and the kit's own.
const knownKeys: ReadonlySet<string> = new Set([...Object.keys(Descriptor.fields), "settings", "create"]);

const decodeDescriptor = (definition: EngineDescriptor): Contract.ModuleEngineDescriptor => {
  // The schema has no data field to decode, so it would drop one unseen.
  if (Object.hasOwn(definition, "data"))
    throw new ModuleDefinitionError({
      reason: "the descriptor has data, which a JavaScript module's engine can't have",
    });

  // The schema ignores a key it has no field for, so a misspelled one would
  // go unseen.
  const unknown = Object.keys(definition).find((key) => !knownKeys.has(key));
  if (unknown !== undefined)
    throw new ModuleDefinitionError({
      reason: `the definition has ${JSON.stringify(unknown)}, which is no engine key`,
    });

  try {
    return Schema.decodeUnknownSync(Descriptor)(definition);
  } catch (error) {
    throw new ModuleDefinitionError({
      reason: `the descriptor is one the manifest would refuse: ${(error as Error).message}`,
    });
  }
};

// What the kit keeps of each engine it made, off the engine so that the host
// sees only the contract: its settings' field schemas, and how to make it
// again under the name a module gives it.
interface Made {
  readonly fields?: Readonly<Record<string, Schema.Top>>;
  readonly named: (name: string) => Contract.ModuleEngine;
}

const made = new WeakMap<Contract.ModuleEngine, Made>();

/** The field schema of each setting, by name, of an engine `defineEngine` made with settings. */
export const settingFields = (engine: Contract.ModuleEngine): Readonly<Record<string, Schema.Top>> | undefined =>
  made.get(engine)?.fields;

/**
 * The engine as a module holds it under `name`, whose settings' property keys begin with the name: a new engine for
 * one `defineEngine` made, and any other unchanged.
 */
export const namedEngine = <E extends Contract.ModuleEngine>(engine: E, name: string): E =>
  (made.get(engine)?.named(name) as E | undefined) ?? engine;

/**
 * Makes an engine from its descriptor, its settings and the function that makes its sessions. Throws a
 * `ModuleDefinitionError` for a descriptor the manifest's schema refuses, one with data or a key no engine has, a setting whose name doesn't
 * map to a GSettings key or whose field has a shape no setting has.
 */
export const defineEngine = <S extends SettingsSchema = NoSettings>(definition: EngineDefinition<S>): Engine<S> => {
  const descriptor = decodeDescriptor(definition);
  const read = definition.settings === undefined ? undefined : readSettings(definition.settings);
  const declared = new Set(Object.keys(read?.declarations ?? {}).map(settingName));

  const make = (name: string | undefined): Engine<S> => {
    const engine: Engine<S> = {
      descriptor,
      ...(read === undefined ? {} : { settings: read.declarations as SettingsDeclaration<S> }),
      create(context) {
        const { named, changed } = sessionSettings(context.settings, declared);
        const candidates = sessionCandidates(context);

        if (name === undefined && read?.bound.length)
          throw new Error("the engine has settings that are properties, but isn't in a module that names it");
        const properties = sessionProperties(context, name ?? "", read?.bound ?? [], named);

        const session = definition.create({
          ...context,
          settings: named as unknown as EngineSettings<S>,
          lookupTable: candidates.page,
          candidates: candidates.show,
          candidateCursor: candidates.cursor,
          registerProperties: properties.register,
          updateProperty: properties.update,
        });

        // The host refuses a create that returns no session, in its own words.
        if (typeof session !== "object" || session === null) return session;
        properties.start();
        return hostSession(session, candidates, properties, changed);
      },
    };

    made.set(engine, { ...(read === undefined ? {} : { fields: read.fields }), named: make });
    return engine;
  };

  return make(undefined);
};
