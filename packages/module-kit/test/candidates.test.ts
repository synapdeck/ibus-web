// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0
import type { CandidatePage } from "@ibus-web/protocol/module-script";
import { describe, expect, test } from "vitest";
import {
  defineEngine,
  type Candidate,
  type CandidatesOptions,
  type EngineContext,
  type EngineSession,
} from "../src/index.ts";
import { recordingHost } from "./recording.ts";

const words = (count: number): string[] => Array.from({ length: count }, (_, index) => `w${index}`);

// A session that shows a list on focus-in and records the clicks it is given.
const open = (list: readonly Candidate[], options?: CandidatesOptions, session: EngineSession = {}) => {
  const clicks: [number, number, number][] = [];
  const host = recordingHost(
    defineEngine({
      displayName: "Test",
      languages: [],
      create: (context) => ({
        focusIn: () => context.candidates(list, options),
        candidateClicked: (...args) => void clicks.push(args),
        ...session,
      }),
    }),
  );
  const opened = host.open();

  return { ...opened, clicks, host };
};

const tables = (calls: readonly { method: string; args: readonly unknown[] }[]) =>
  calls.filter((call) => call.method === "lookupTable").map((call) => call.args as [CandidatePage, boolean]);

const last = (calls: readonly { method: string; args: readonly unknown[] }[]) => tables(calls).at(-1)!;

describe("context.candidates", () => {
  test("sends the first page of a list, with the cursor on its first candidate", () => {
    const { session, calls } = open(words(25));
    session.focusIn!();

    expect(tables(calls)).toEqual([[{ candidates: words(10), cursor: 0, cursorVisible: true }, true]]);
  });

  test("sends the page holding the cursor, pages starting at multiples of 10", () => {
    for (const [cursor, start, position] of [
      [9, 0, 9],
      [10, 10, 0],
      [17, 10, 7],
      [20, 20, 0],
      [24, 20, 4],
    ] as const) {
      const { session, calls } = open(words(25), { cursor });
      session.focusIn!();

      expect(last(calls)).toEqual([
        { candidates: words(25).slice(start, start + 10), cursor: position, cursorVisible: true },
        true,
      ]);
    }
  });

  test("keeps a cursor that is hidden hidden", () => {
    const { session, calls } = open(words(3), { cursorVisible: false });
    session.focusIn!();

    expect(last(calls)[0].cursorVisible).toBe(false);
  });

  test("moves a cursor outside the list to its nearest end", () => {
    const high = open(words(25), { cursor: 99 });
    high.session.focusIn!();
    const low = open(words(25), { cursor: -4 });
    low.session.focusIn!();

    expect(last(high.calls)[0]).toMatchObject({ cursor: 4, candidates: words(25).slice(20) });
    expect(last(low.calls)[0]).toMatchObject({ cursor: 0, candidates: words(10) });
  });

  test("takes strings and objects, and labels every candidate on a page when one has a label", () => {
    const { session, calls } = open([{ text: "a", label: "x" }, "b", { text: "c" }]);
    session.focusIn!();

    expect(last(calls)[0]).toEqual({
      candidates: ["a", "b", "c"],
      labels: ["x", "2", "3"],
      cursor: 0,
      cursorVisible: true,
    });
  });

  test("hides the table for an empty list", () => {
    const { session, calls } = open([]);
    session.focusIn!();

    expect(tables(calls)).toEqual([[{ candidates: [], cursor: 0, cursorVisible: false }, false]]);
  });

  test("hides a shown table when the list becomes empty", () => {
    const lists = [words(3), []];
    const host = recordingHost(
      defineEngine({
        displayName: "Test",
        languages: [],
        create: (context) => ({ focusIn: () => context.candidates(lists.shift()!) }),
      }),
    );
    const { session, calls } = host.open();
    session.focusIn!();
    session.focusIn!();

    expect(tables(calls).map(([, visible]) => visible)).toEqual([true, false]);
  });
});

describe("candidateClicked", () => {
  test("never reaches the session before any table is drawn", () => {
    const { session, clicks } = open(words(5));
    session.candidateClicked!(0, 1, 0);

    expect(clicks).toEqual([]);
  });

  test("is given the list index of a click on the visible page", () => {
    const { session, clicks } = open(words(25), { cursor: 12 });
    session.focusIn!();
    session.candidateClicked!(3, 1, 4);

    expect(clicks).toEqual([[13, 1, 4]]);
  });

  test("ignores a click past the page's last candidate", () => {
    const { session, clicks } = open(words(25), { cursor: 22 });
    session.focusIn!();
    session.candidateClicked!(5, 1, 0);
    session.candidateClicked!(4, 1, 0);

    expect(clicks).toEqual([[24, 1, 0]]);
  });

  test("ignores a click when no list is shown, and a negative one", () => {
    const empty = open([]);
    empty.session.focusIn!();
    empty.session.candidateClicked!(0, 1, 0);

    const shown = open(words(5));
    shown.session.focusIn!();
    shown.session.candidateClicked!(-1, 1, 0);

    expect(empty.clicks).toEqual([]);
    expect(shown.clicks).toEqual([]);
  });

  test("follows the cursor's page after it moves", () => {
    const { session, clicks } = open(words(25));
    session.focusIn!();
    session.pageDown!();
    session.candidateClicked!(2, 1, 0);

    expect(clicks).toEqual([[12, 1, 0]]);
  });
});

describe("a page the session draws itself", () => {
  // A session that hands its context out, and records the clicks it is given.
  const raw = (session: EngineSession = {}) => {
    let context!: EngineContext;
    const clicks: number[] = [];
    const host = recordingHost(
      defineEngine({
        displayName: "Test",
        languages: [],
        create: (given) => {
          context = given;
          return { candidateClicked: (index) => void clicks.push(index), ...session };
        },
      }),
    );

    return { ...host.open(), context, clicks };
  };

  const page = { candidates: ["a", "b", "c"], cursor: 0, cursorVisible: true };

  test("gives candidateClicked the index on the page", () => {
    const { session, context, clicks, calls } = raw();
    context.lookupTable(page, true);
    session.candidateClicked!(2, 1, 0);

    expect(clicks).toEqual([2]);
    expect(tables(calls)).toEqual([[page, true]]);
  });

  test("replaces a list shown before it: clicks count from the page, and the kit pages nothing", () => {
    const { session, context, clicks, calls } = raw();
    context.candidates(words(25), { cursor: 12 });
    context.lookupTable(page, true);
    session.candidateClicked!(1, 1, 0);
    for (const handler of [session.pageUp, session.pageDown, session.cursorUp, session.cursorDown]) handler!();

    expect(clicks).toEqual([1]);
    expect(tables(calls)).toHaveLength(2);
    expect(context.candidateCursor()).toBeUndefined();
  });

  test("gives way to a list shown after it", () => {
    const { session, context, clicks } = raw();
    context.lookupTable(page, true);
    context.candidates(words(25), { cursor: 12 });
    session.candidateClicked!(1, 1, 0);

    expect(clicks).toEqual([11]);
  });
});

describe("context.candidateCursor", () => {
  test("is the list's cursor, as the kit moves it", () => {
    let context!: EngineContext;
    const { session } = recordingHost(
      defineEngine({
        displayName: "Test",
        languages: [],
        create: (given) => {
          context = given;
          return {};
        },
      }),
    ).open();

    expect(context.candidateCursor()).toBeUndefined();

    context.candidates(words(25), { cursor: 3, cursorVisible: false });
    expect(context.candidateCursor()).toEqual({ index: 3, visible: false });

    session.pageDown!();
    expect(context.candidateCursor()).toEqual({ index: 13, visible: false });

    session.cursorDown!();
    expect(context.candidateCursor()).toEqual({ index: 13, visible: true });

    context.candidates([]);
    expect(context.candidateCursor()).toBeUndefined();
  });

  test("lets a session commit the highlighted candidate on a key of its own", () => {
    const list = words(25);
    const { session, calls } = recordingHost(
      defineEngine({
        displayName: "Test",
        languages: [],
        create: (context) => ({
          focusIn: () => context.candidates(list),
          processKey(keyval) {
            const cursor = context.candidateCursor();
            if (keyval !== 0x20 || cursor === undefined) return false;

            context.commit(list[cursor.index]!);
            return true;
          },
        }),
      }),
    ).open();

    session.focusIn!();
    session.pageDown!();
    session.cursorDown!();
    session.processKey!(0x20, 0, 0, " ");

    expect(calls.filter((call) => call.method === "commit").map((call) => call.args)).toEqual([["w11"]]);
  });

  test("follows a session's own handler that redraws the list, beside the kit's", () => {
    let context!: EngineContext;
    const list = words(25);
    const { session, calls } = recordingHost(
      defineEngine({
        displayName: "Test",
        languages: [],
        create: (given) => {
          context = given;
          return {
            // Wraps from the last candidate to the first.
            cursorDown() {
              const { index } = context.candidateCursor()!;
              context.candidates(list, { cursor: index + 1 < list.length ? index + 1 : 0 });
            },
          };
        },
      }),
    ).open();

    context.candidates(list, { cursor: 23 });
    session.cursorDown!();
    session.cursorDown!();
    session.pageDown!();

    expect(context.candidateCursor()).toEqual({ index: 10, visible: true });
    expect(last(calls)[0]).toMatchObject({ candidates: list.slice(10, 20), cursor: 0 });
  });
});

describe("paging handlers", () => {
  test("cursorDown and cursorUp move the cursor across page boundaries", () => {
    const { session, calls } = open(words(15), { cursor: 8 });
    session.focusIn!();
    session.cursorDown!();
    session.cursorDown!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(15).slice(10), cursor: 0 });

    session.cursorUp!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(10), cursor: 9 });
    expect(tables(calls)).toHaveLength(4);
  });

  test("cursorDown at the last candidate and cursorUp at the first do nothing", () => {
    const end = open(words(12), { cursor: 11 });
    end.session.focusIn!();
    end.session.cursorDown!();
    const start = open(words(12));
    start.session.focusIn!();
    start.session.cursorUp!();

    expect(tables(end.calls)).toHaveLength(1);
    expect(tables(start.calls)).toHaveLength(1);
  });

  test("pageDown keeps the cursor's position on the next page and stops on the last candidate of a short one", () => {
    const { session, calls } = open(words(25), { cursor: 4 });
    session.focusIn!();
    session.pageDown!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(25).slice(10, 20), cursor: 4 });

    session.pageDown!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(25).slice(20), cursor: 4 });

    session.pageDown!();

    expect(tables(calls)).toHaveLength(3);

    const short = open(words(23), { cursor: 18 });
    short.session.focusIn!();
    short.session.pageDown!();

    expect(last(short.calls)[0]).toMatchObject({ candidates: words(23).slice(20), cursor: 2 });
  });

  test("pageUp moves back a page and does nothing on the first", () => {
    const { session, calls } = open(words(25), { cursor: 23 });
    session.focusIn!();
    session.pageUp!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(25).slice(10, 20), cursor: 3 });

    session.pageUp!();
    session.pageUp!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(10), cursor: 3 });
    expect(tables(calls)).toHaveLength(3);
  });

  test("cursorUp and cursorDown first show a hidden cursor where it is, then move it", () => {
    const { session, calls } = open(words(25), { cursor: 4, cursorVisible: false });
    session.focusIn!();
    session.cursorDown!();

    expect(last(calls)[0]).toMatchObject({ cursor: 4, cursorVisible: true });

    session.cursorDown!();

    expect(last(calls)[0]).toMatchObject({ cursor: 5, cursorVisible: true });

    const up = open(words(25), { cursor: 4, cursorVisible: false });
    up.session.focusIn!();
    up.session.cursorUp!();

    expect(last(up.calls)[0]).toMatchObject({ cursor: 4, cursorVisible: true });
  });

  test("paging keeps a hidden cursor hidden", () => {
    const { session, calls } = open(words(25), { cursorVisible: false });
    session.focusIn!();
    session.pageDown!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(25).slice(10, 20), cursor: 0, cursorVisible: false });

    session.pageUp!();

    expect(last(calls)[0]).toMatchObject({ candidates: words(10), cursor: 0, cursorVisible: false });
  });

  test("a hidden cursor at the last candidate is shown by cursorDown without moving", () => {
    const { session, calls } = open(words(2), { cursor: 1, cursorVisible: false });
    session.focusIn!();
    session.cursorDown!();

    expect(last(calls)[0]).toMatchObject({ cursor: 1, cursorVisible: true });
  });

  test("do nothing before a list is shown, or for an empty one", () => {
    const { session, calls } = open([]);
    for (const handler of [session.pageUp, session.pageDown, session.cursorUp, session.cursorDown]) handler!();
    session.focusIn!();
    for (const handler of [session.pageUp, session.pageDown, session.cursorUp, session.cursorDown]) handler!();

    expect(tables(calls)).toHaveLength(1);
  });

  test("a session's own handler takes precedence, for each one it defines", () => {
    const called: string[] = [];
    const { session, calls } = open(words(25), undefined, {
      pageUp: () => void called.push("pageUp"),
      cursorDown: () => void called.push("cursorDown"),
    });
    session.focusIn!();
    session.pageUp!();
    session.cursorDown!();
    session.pageDown!();

    expect(called).toEqual(["pageUp", "cursorDown"]);
    expect(last(calls)[0]).toMatchObject({ candidates: words(25).slice(10, 20) });
    expect(tables(calls)).toHaveLength(2);
  });

  test("keep each session's state to itself, and drop it on destroy", () => {
    const host = recordingHost(
      defineEngine({
        displayName: "Test",
        languages: [],
        create: (context) => ({ focusIn: () => context.candidates(words(25)) }),
      }),
    );
    const first = host.open();
    const second = host.open();
    first.session.focusIn!();
    first.session.pageDown!();
    second.session.pageDown!();

    expect(tables(second.calls)).toHaveLength(0);

    first.session.destroy!();
    first.session.pageDown!();

    expect(tables(first.calls)).toHaveLength(2);
  });
});
