// SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
// SPDX-License-Identifier: MIT OR Apache-2.0

import { describe, expect, test } from "vitest";
import { convertWithRime, type RimeCommand, type RimeSession, type RimeState } from "./rime.ts";

interface Offer {
  readonly text: string;
  /** How many keys of the input left the candidate covers. */
  readonly keys: number;
}

/**
 * A session that behaves as rime-session does: the preview is the selected
 * text, then the first candidate, then the input left raw, and selecting a
 * candidate that covers the input left commits everything.
 */
class FakeSession implements RimeSession {
  readonly commands: RimeCommand[] = [];
  private readonly offer: (rest: string) => Offer | null;
  private selected = "";
  private rest = "";

  constructor(offer: (rest: string) => Offer | null) {
    this.offer = offer;
  }

  async send(command: RimeCommand): Promise<RimeState> {
    this.commands.push(command);
    let commit: string | null = null;

    if (command.startsWith("type ")) {
      this.selected = "";
      this.rest = command.slice("type ".length);
    } else if (command === "select") {
      const offer = this.offer(this.rest);
      if (offer !== null) {
        this.selected += offer.text;
        this.rest = this.rest.slice(offer.keys);
        if (this.rest === "") {
          commit = this.selected;
          this.selected = "";
        }
      }
    } else {
      this.selected = "";
      this.rest = "";
    }

    if (this.selected === "" && this.rest === "") {
      return { input: "", preview: null, candidate: null, commit };
    }
    const offer = this.offer(this.rest);
    return {
      input: this.rest,
      preview: this.selected + (offer === null ? this.rest : offer.text + this.rest.slice(offer.keys)),
      candidate: offer?.text ?? null,
      commit,
    };
  }
}

const words: Record<string, string> = { nihao: "你好", shijie: "世界", women: "我们" };

// The longest word at the start of the input left, as a partial candidate.
function byWord(rest: string): Offer | null {
  for (let keys = rest.length; keys > 0; keys--) {
    const text = words[rest.slice(0, keys)];
    if (text !== undefined) {
      return { text, keys };
    }
  }
  return null;
}

describe("convertWithRime", () => {
  test("takes a first candidate that covers the input without selecting it", async () => {
    const session = new FakeSession((rest) => ({ text: "你好世界", keys: rest.length }));
    expect(await convertWithRime(session, "nihaoshijie")).toBe("你好世界");
    expect(session.commands).toEqual(["type nihaoshijie", "clear"]);
  });

  test("selects a partial first candidate and continues with the next", async () => {
    const session = new FakeSession(byWord);
    expect(await convertWithRime(session, "womennihaoshijie")).toBe("我们你好世界");
    expect(session.commands).toEqual(["type womennihaoshijie", "select", "select", "clear"]);
  });

  test("leaves input no candidate covers as its letters", async () => {
    const session = new FakeSession(byWord);
    expect(await convertWithRime(session, "nihaoiii")).toBe("你好iii");
    expect(session.commands).toEqual(["type nihaoiii", "select", "clear"]);
  });

  test("takes the commit when the last candidate holds letters of its own", async () => {
    const session = new FakeSession((rest) => (rest === "iphone" ? { text: "iPhone", keys: 6 } : null));
    expect(await convertWithRime(session, "iphone")).toBe("iPhone");
    expect(session.commands).toEqual(["type iphone", "select", "clear"]);
  });

  test("stops a candidate that never uses the input up", async () => {
    const session = new FakeSession(() => ({ text: "你", keys: 0 }));
    await expect(convertWithRime(session, "ni")).rejects.toThrow("more selections than it has keys");
    expect(session.commands.at(-1)).toBe("clear");
  });

  test("rejects input that isn't lowercase letters", async () => {
    await expect(convertWithRime(new FakeSession(byWord), "ni hao")).rejects.toThrow("lowercase letters");
  });
});
