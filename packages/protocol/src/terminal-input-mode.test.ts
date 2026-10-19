import { describe, expect, it } from "vitest";
import { TerminalInputModeTracker } from "./terminal-input-mode.js";

describe("TerminalInputModeTracker", () => {
  it.each([
    ["\x1bc"],
    ["\x1b", "c"],
    ["output\x1b", "", "cmore output"],
    ["\x1b[?100", "\x1b", "c"],
  ])("resets every tracked mode and Kitty stack on RIS in chunks %j", (...chunks) => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[>3u\x1b[>7u\x1b[?9001;1;2004;1003;1006h");

    const results = chunks.map((chunk) => tracker.feed(chunk));

    expect(results.at(-1)).toEqual({ changed: true, responses: [] });
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("");
    expect(
      tracker.encodeWheel({ direction: "up", col: 3, row: 4, pixelX: 30, pixelY: 80, count: 1 }),
    ).toBeNull();
    expect(tracker.feed("\x1b[<u\x1b[?u")).toEqual({
      changed: false,
      responses: ["\x1b[?0u"],
    });
  });

  it("applies mode sequences and queries in order around RIS", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[>7u\x1b[?u\x1bc\x1b[?u\x1b[?2004h")).toEqual({
      changed: true,
      responses: ["\x1b[?7u", "\x1b[?0u"],
    });
    expect(tracker.getPreamble()).toBe("\x1b[?2004h");
    expect(tracker.feed("\x1bc")).toEqual({ changed: true, responses: [] });
    expect(tracker.feed("\x1bc")).toEqual({ changed: false, responses: [] });
  });

  it("routes touch wheel reports only when the application requests mouse tracking", () => {
    const tracker = new TerminalInputModeTracker();
    const gesture = { direction: "up" as const, col: 3, row: 4, pixelX: 30, pixelY: 80, count: 2 };
    expect(tracker.encodeWheel(gesture)).toBeNull();
    tracker.feed("\x1b[?1003h\x1b[?1006h");
    expect(tracker.encodeWheel(gesture)).toBe("\x1b[<64;3;4M\x1b[<64;3;4M");
    tracker.feed("\x1b[?1006l");
    expect(tracker.encodeWheel({ ...gesture, direction: "down", count: 1 })).toBeNull();
    tracker.feed("\x1b[?1016h");
    expect(tracker.encodeWheel({ ...gesture, count: 1 })).toBe("\x1b[<64;30;80M");
    tracker.feed("\x1b[?1003l");
    expect(tracker.encodeWheel(gesture)).toBeNull();
  });
  it.each([9, 1000, 1002, 1003])(
    "does not synthesize legacy binary wheel reports over UTF-8 text (mode %s)",
    (mode) => {
      const tracker = new TerminalInputModeTracker();
      tracker.feed(`\x1b[?${mode}h`);
      const gesture = {
        direction: "down" as const,
        col: 96,
        row: 223,
        pixelX: 960,
        pixelY: 2230,
        count: 1,
      };

      // Classic coordinates would contain bytes >= 0x80, which the text transport would re-encode.
      expect(tracker.encodeWheel(gesture)).toBeNull();
      tracker.feed("\x1b[?1006h\x1b[?1006l");
      expect(tracker.encodeWheel(gesture)).toBeNull();
    },
  );

  it("does not send wheel reports for X10 tracking even with SGR encoding", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[?9;1006h");
    expect(
      tracker.encodeWheel({ direction: "up", col: 3, row: 4, pixelX: 30, pixelY: 80, count: 1 }),
    ).toBeNull();
  });

  it("replays mouse reporting without re-entering and clearing the alternate screen", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    expect(tracker.getPreamble()).toBe("\x1b[?1003h\x1b[?1006h");
    tracker.feed("\x1b[?1003l\x1b[?1006l");
    expect(tracker.getPreamble()).toBe("");
    tracker.feed("\x1b[?1002h\x1b[?1006h");
    tracker.reset();
    expect(tracker.getPreamble()).toBe("");
  });
  it("activates from a pushed Kitty keyboard mode and builds a replay preamble", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[>7u").changed).toBe(true);

    expect(tracker.supportsModifiedEnter()).toBe(true);
    expect(tracker.getKittyKeyboardFlags()).toBe(7);
    expect(tracker.getPreamble()).toBe("\x1b[=7;1u");
  });

  it("tracks split terminal output chunks", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[>");
    const result = tracker.feed("1u");

    expect(result.changed).toBe(true);
    expect(tracker.getKittyKeyboardFlags()).toBe(1);
  });

  it("restores pushed Kitty keyboard modes when the foreground program pops them", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[>1u");
    tracker.feed("\x1b[>7u");
    expect(tracker.getKittyKeyboardFlags()).toBe(7);

    expect(tracker.feed("\x1b[<u").changed).toBe(true);
    expect(tracker.getKittyKeyboardFlags()).toBe(1);

    expect(tracker.feed("\x1b[<u").changed).toBe(true);
    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("answers Kitty keyboard mode queries with the current flags", () => {
    const tracker = new TerminalInputModeTracker();
    tracker.feed("\x1b[=3;1u");

    expect(tracker.feed("\x1b[?u").responses).toEqual(["\x1b[?3u"]);
  });

  it("tracks ConPTY Win32 input mode and replays it after snapshots", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[?9001h").changed).toBe(true);

    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: true,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.supportsModifiedEnter()).toBe(true);
    expect(tracker.getPreamble()).toBe("\x1b[?9001h");

    expect(tracker.feed("\x1b[?9001l").changed).toBe(true);
    expect(tracker.supportsModifiedEnter()).toBe(false);
  });

  it("keeps Kitty and Win32 input modes independent", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[>7u\x1b[?9001h");

    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 7,
      win32InputMode: true,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("\x1b[=7;1u\x1b[?9001h");
  });

  it("tracks application cursor keys mode independently", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[?1h").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: true,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("\x1b[?1h");

    expect(tracker.feed("\x1b[?1l").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
  });

  it("tracks bracketed paste mode independently", () => {
    const tracker = new TerminalInputModeTracker();

    expect(tracker.feed("\x1b[?2004h").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: true,
    });
    expect(tracker.getPreamble()).toBe("\x1b[?2004h");

    expect(tracker.feed("\x1b[?2004l").changed).toBe(true);
    expect(tracker.getState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    expect(tracker.getPreamble()).toBe("");
  });

  it("ignores encoded key input sequences", () => {
    const tracker = new TerminalInputModeTracker();

    tracker.feed("\x1b[13;2u");

    expect(tracker.supportsModifiedEnter()).toBe(false);
  });
});
