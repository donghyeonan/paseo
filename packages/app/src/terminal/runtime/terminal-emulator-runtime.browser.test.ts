import "@xterm/xterm/css/xterm.css";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { TerminalInputModeState } from "@getpaseo/protocol/terminal-input-mode";
import { encodeTerminalOutput, TerminalEmulatorRuntime } from "./terminal-emulator-runtime";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddon {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): void {}
  },
}));

interface TerminalSize {
  rows: number;
  cols: number;
  shouldClaim: boolean;
  forceClaim?: boolean;
}

interface TerminalKeyRecord {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

type BrowserTerminal = TerminalSize & {
  input: (data: string, wasUserInput?: boolean) => void;
  refresh: (start: number, end: number) => void;
  reset: () => void;
};

interface MountedTerminal {
  host: HTMLDivElement;
  root: HTMLDivElement;
  runtime: TerminalEmulatorRuntime;
  inputs: string[];
  sizes: TerminalSize[];
  terminalKeys: TerminalKeyRecord[];
  inputModeChanges: TerminalInputModeState[];
  openedUrls: string[];
}

const mountedTerminals: MountedTerminal[] = [];

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function terminalOutput(text: string): Uint8Array {
  return encodeTerminalOutput(text);
}

async function waitFor(input: { predicate: () => boolean; timeoutMs?: number }): Promise<void> {
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? 2_000;

  while (!input.predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for terminal browser condition");
    }
    await nextFrame();
  }
}

function settleMountRefits(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2_600));
}

interface CreateTerminalHostInput {
  width: number;
  height: number;
  scrollback?: number;
  isMac?: boolean;
  fontSize?: number;
}

function createTerminalHost(input: CreateTerminalHostInput): MountedTerminal {
  const root = document.createElement("div");
  root.style.width = `${input.width}px`;
  root.style.height = `${input.height}px`;
  root.style.position = "fixed";
  root.style.left = "0";
  root.style.top = "0";
  root.style.overflow = "hidden";

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  root.appendChild(host);
  document.body.appendChild(root);

  const sizes: TerminalSize[] = [];
  const inputs: string[] = [];
  const terminalKeys: TerminalKeyRecord[] = [];
  const inputModeChanges: TerminalInputModeState[] = [];
  const openedUrls: string[] = [];
  const runtime = new TerminalEmulatorRuntime(
    input.isMac === undefined ? undefined : { isMac: input.isMac },
  );
  runtime.setCallbacks({
    callbacks: {
      onInput: (data) => {
        inputs.push(data);
      },
      onResize: (size) => {
        sizes.push(size);
      },
      onTerminalKey: (key) => {
        terminalKeys.push(key);
      },
      onInputModeChange: (state) => {
        inputModeChanges.push(state);
      },
      onOpenExternalUrl: (url) => {
        openedUrls.push(url);
      },
    },
  });
  runtime.mount({
    root,
    host,
    initialSnapshot: null,
    scrollback: input.scrollback ?? 10_000,
    fontSize: input.fontSize,
    theme: {
      background: "#0b0b0b",
      foreground: "#e6e6e6",
      cursor: "#e6e6e6",
    },
  });

  const mounted = {
    host,
    root,
    runtime,
    inputs,
    sizes,
    terminalKeys,
    inputModeChanges,
    openedUrls,
  };
  mountedTerminals.push(mounted);
  return mounted;
}

function terminalScreen(host: HTMLElement): HTMLElement {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error("Expected xterm screen to be mounted");
  return screen;
}

function screenTouch(input: { screen: HTMLElement; x: number; y: number }): Touch {
  const bounds = input.screen.getBoundingClientRect();
  const clientX = bounds.left + input.x;
  const clientY = bounds.top + input.y;
  return new Touch({
    identifier: 1,
    target: input.screen,
    clientX,
    clientY,
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
    screenX: clientX,
    screenY: clientY,
  });
}

function dispatchScreenTouch(input: {
  screen: HTMLElement;
  type: "touchstart" | "touchmove" | "touchend";
  touch: Touch;
}): TouchEvent {
  const activeTouches = input.type === "touchend" ? [] : [input.touch];
  const event = new TouchEvent(input.type, {
    touches: activeTouches,
    targetTouches: activeTouches,
    changedTouches: [input.touch],
    bubbles: true,
    cancelable: true,
  });
  input.screen.dispatchEvent(event);
  return event;
}

function latestSize(sizes: TerminalSize[]): TerminalSize {
  const size = sizes.at(-1);
  if (!size) {
    throw new Error("Terminal did not report a size");
  }
  return size;
}

function expectNoForcedSameSizeClaim(input: {
  sizes: TerminalSize[];
  startIndex: number;
  baseline: TerminalSize;
}): void {
  const forcedSameSizeClaims = input.sizes
    .slice(input.startIndex)
    .filter(
      (size) =>
        size.rows === input.baseline.rows &&
        size.cols === input.baseline.cols &&
        size.shouldClaim &&
        size.forceClaim,
    );
  expect(forcedSameSizeClaims).toEqual([]);
}

function getBrowserTerminal(): BrowserTerminal {
  const terminal = window.__paseoTerminal as BrowserTerminal | undefined;
  if (!terminal) {
    throw new Error("Expected xterm to be exposed for browser test inspection");
  }
  return terminal;
}

interface DispatchTerminalKeyInput {
  host: HTMLElement;
  key: string;
  keyCode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

function dispatchTerminalKey(input: DispatchTerminalKeyInput): boolean {
  const textarea = input.host.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) {
    throw new Error("Expected xterm textarea to be mounted");
  }
  textarea.focus();
  const event = new KeyboardEvent("keydown", {
    key: input.key,
    shiftKey: input.shiftKey ?? false,
    ctrlKey: input.ctrlKey ?? false,
    altKey: input.altKey ?? false,
    metaKey: input.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (input.keyCode !== undefined) {
    // Synthetic KeyboardEvents always report keyCode 0; xterm's fallback encoder
    // switches on keyCode, so hardware-like events need it filled in.
    Object.defineProperty(event, "keyCode", { value: input.keyCode });
  }
  return textarea.dispatchEvent(event);
}

/** An OSC 8 hyperlink, the escape sequence CLIs such as gh and ls --hyperlink print. */
function hyperlink(input: { url: string; text: string }): string {
  return `\x1b]8;;${input.url}\x1b\\${input.text}\x1b]8;;\x1b\\`;
}

function writeTerminalOutput(mounted: MountedTerminal, text: string): Promise<void> {
  return new Promise((resolve) => {
    mounted.runtime.write({ data: terminalOutput(text), onCommitted: resolve });
  });
}

function writeLines(mounted: MountedTerminal, lines: string[]): Promise<void> {
  return writeTerminalOutput(mounted, lines.map((line) => `${line}\r\n`).join(""));
}

async function clickTerminalLink(input: {
  host: HTMLElement;
  row: number;
  col: number;
}): Promise<void> {
  const terminal = getBrowserTerminal();
  const screen = input.host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) {
    throw new Error("Expected xterm screen to be mounted");
  }
  const position = {
    x: (input.col + 0.5) * (screen.clientWidth / terminal.cols),
    y: (input.row + 0.5) * (screen.clientHeight / terminal.rows),
  };
  await userEvent.hover(screen, { position });
  await waitFor({
    predicate: () => input.host.querySelector(".xterm-cursor-pointer") !== null,
  });
  await userEvent.click(screen, { position });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const mounted of mountedTerminals.splice(0)) {
    mounted.runtime.unmount();
    mounted.root.remove();
  }
});

describe("terminal emulator runtime in a real browser", () => {
  it.each([13, 6])(
    "forwards wheel and touch to the fullscreen application after snapshot reset (fontSize=%s)",
    async (fontSize) => {
      const mounted = createTerminalHost({ width: 720, height: 360, fontSize });
      const xtermElement = mounted.host.querySelector<HTMLElement>(".xterm");
      if (!xtermElement) throw new Error("Missing xterm element");
      xtermElement.style.padding = "12px";
      mounted.root.style.left = "23px";
      mounted.root.style.top = "31px";
      mounted.runtime.resize({ forceRefresh: true, shouldClaim: false });
      const size = latestSize(mounted.sizes);
      const snapshot = "\x1b[?1049h\x1b[?7l한글\x1b[4;1H입력> ";
      const documentMoves: Event[] = [];
      const controller = new AbortController();
      document.addEventListener("touchmove", (event) => documentMoves.push(event), {
        signal: controller.signal,
      });
      onTestFinished(() => controller.abort());
      await writeLines(mounted, [snapshot]);
      for (let reconnect = 0; reconnect < 3; reconnect++) {
        documentMoves.length = 0;
        await new Promise<void>((resolve) =>
          mounted.runtime.write({
            data: terminalOutput("\x1b[?1003h\x1b[?1006h"),
            onCommitted: resolve,
          }),
        );
        mounted.inputs.length = 0;
        const screen = terminalScreen(mounted.host);
        const cellWidth = screen.clientWidth / size.cols;
        const cellHeight = screen.clientHeight / size.rows;
        const col = size.cols - 3;
        const x = (col - 0.5) * cellWidth;
        const startY = 5.5 * cellHeight;
        const start = screenTouch({ screen, x, y: startY });
        screen.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: -1,
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            clientX: start.clientX,
            clientY: start.clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(mounted.inputs).toEqual([`\x1b[<64;${col};6M`]);
        mounted.inputs.length = 0;

        dispatchScreenTouch({ screen, type: "touchstart", touch: start });
        const undecided = screenTouch({ screen, x, y: startY + cellHeight / 4 });
        const undecidedMove = dispatchScreenTouch({ screen, type: "touchmove", touch: undecided });
        expect(mounted.inputs).toEqual([]);
        const moved = screenTouch({ screen, x, y: startY + 4 * cellHeight });
        const move = dispatchScreenTouch({ screen, type: "touchmove", touch: moved });
        expect(move.defaultPrevented).toBe(true);
        expect(mounted.inputs.join("")).toBe(`\x1b[<64;${col};10M`.repeat(4));
        mounted.inputs.length = 0;

        const reversed = screenTouch({ screen, x, y: startY - 2 * cellHeight });
        dispatchScreenTouch({ screen, type: "touchmove", touch: reversed });
        expect(mounted.inputs.join("")).toBe(`\x1b[<65;${col};4M`.repeat(6));
        dispatchScreenTouch({ screen, type: "touchend", touch: reversed });
        await nextFrame();
        await nextFrame();
        expect(mounted.inputs.join("")).toBe(`\x1b[<65;${col};4M`.repeat(6));
        expect(documentMoves).toEqual([undecidedMove]);

        const terminal = window.__paseoTerminal;
        expect(terminal?.buffer.active.type).toBe("alternate");
        expect(terminal?.buffer.active.getLine(0)?.translateToString(true)).toBe("한글");
        expect(terminal?.buffer.active.getLine(3)?.translateToString(true)).toBe("입력> ");
        await new Promise<void>((resolve) =>
          mounted.runtime.restoreOutput({
            data: terminalOutput(snapshot),
            rows: size.rows,
            cols: size.cols,
            onCommitted: resolve,
          }),
        );
      }
    },
  );
  it("retains history wheel scrolling, selection, keyboard and unclaimed touch propagation", async () => {
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await writeLines(
      mounted,
      Array.from({ length: 80 }, (_, index) => `history line ${index}`),
    );
    await nextFrame();
    await nextFrame();
    const terminal = window.__paseoTerminal;
    if (!terminal) throw new Error("Missing terminal");
    const screen = terminalScreen(mounted.host);
    const startViewport = terminal.buffer.active.viewportY;
    terminal.select(0, startViewport, 7);
    expect(terminal.getSelection()).toBe("history");

    await userEvent.wheel(screen, { delta: { y: -120 } });
    await waitFor({ predicate: () => terminal.buffer.active.viewportY < startViewport });
    expect(terminal.getSelection()).toBe("history");
    expect(mounted.inputs).toEqual([]);

    const documentMoves: Event[] = [];
    const controller = new AbortController();
    document.addEventListener("touchmove", (event) => documentMoves.push(event), {
      signal: controller.signal,
    });
    onTestFinished(() => controller.abort());
    const start = screenTouch({ screen, x: 40, y: 120 });
    dispatchScreenTouch({ screen, type: "touchstart", touch: start });
    await nextFrame();
    const moved = screenTouch({ screen, x: 40, y: 180 });
    const move = dispatchScreenTouch({ screen, type: "touchmove", touch: moved });
    dispatchScreenTouch({ screen, type: "touchend", touch: moved });
    expect(documentMoves).toEqual([move]);
    expect(terminal.getSelection()).toBe("history");
    expect(mounted.inputs).toEqual([]);

    dispatchTerminalKey({ host: mounted.host, key: "ArrowUp", keyCode: 38 });
    mounted.runtime.paste("typed input");
    expect(mounted.inputs).toEqual(["\x1b[A", "typed input"]);
  });

  it("does not forward UTF-8-corrupted legacy mouse reports from screen touches", async () => {
    const mounted = createTerminalHost({ width: 1200, height: 360 });
    await writeLines(mounted, ["\x1b[?1049h\x1b[?1003h"]);
    const size = latestSize(mounted.sizes);
    const screen = terminalScreen(mounted.host);
    const x = 100.5 * (screen.clientWidth / size.cols);
    const cellHeight = screen.clientHeight / size.rows;
    const start = screenTouch({ screen, x, y: 4.5 * cellHeight });
    const moved = screenTouch({ screen, x, y: 8.5 * cellHeight });
    dispatchScreenTouch({ screen, type: "touchstart", touch: start });
    await nextFrame();
    dispatchScreenTouch({ screen, type: "touchmove", touch: moved });
    dispatchScreenTouch({ screen, type: "touchend", touch: moved });
    await nextFrame();
    expect(mounted.inputs).toEqual([]);
  });

  it("stops reporting app mouse input after a split RIS reset", async () => {
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await writeLines(mounted, ["\x1b[>7u\x1b[?9001;1;2004;1003;1006h"]);
    await writeTerminalOutput(mounted, "\x1b");
    await writeTerminalOutput(mounted, "c");
    expect(mounted.runtime.getInputModeState()).toEqual({
      kittyKeyboardFlags: 0,
      win32InputMode: false,
      applicationCursorKeys: false,
      bracketedPaste: false,
    });
    const screen = terminalScreen(mounted.host);
    const start = screenTouch({ screen, x: 40, y: 80 });
    const moved = screenTouch({ screen, x: 40, y: 140 });
    dispatchScreenTouch({ screen, type: "touchstart", touch: start });
    await nextFrame();
    dispatchScreenTouch({ screen, type: "touchmove", touch: moved });
    dispatchScreenTouch({ screen, type: "touchend", touch: moved });
    await nextFrame();
    expect(mounted.inputs).toEqual([]);

    dispatchTerminalKey({ host: mounted.host, key: "ArrowUp", keyCode: 38 });
    mounted.runtime.paste("plain paste");
    expect(mounted.inputs).toEqual(["\x1b[A", "plain paste"]);
  });

  it("passes configured scrollback to xterm", async () => {
    await page.viewport(900, 600);
    createTerminalHost({ width: 720, height: 360, scrollback: 42_000 });

    await waitFor({
      predicate: () => window.__paseoTerminal !== undefined,
    });

    expect(window.__paseoTerminal?.options.scrollback).toBe(42_000);
  });

  it("updates scrollback on the mounted xterm", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, scrollback: 10_000 });

    await waitFor({
      predicate: () => window.__paseoTerminal !== undefined,
    });
    const terminal = window.__paseoTerminal;

    mounted.runtime.setScrollback({ lines: 42_000 });

    expect(window.__paseoTerminal).toBe(terminal);
    expect(window.__paseoTerminal?.options.scrollback).toBe(42_000);
  });

  it("does not claim PTY ownership from passive mount refits", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();

    expect(mounted.sizes.length).toBeGreaterThan(1);
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);

    const settledSize = latestSize(mounted.sizes);
    mounted.runtime.resize({ forceClaim: true, shouldClaim: true });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([
      { ...settledSize, shouldClaim: true, forceClaim: true },
    ]);
  });

  it("reports a larger PTY size when the terminal container grows", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const initialSize = latestSize(mounted.sizes);

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    await nextFrame();
    mounted.runtime.resize({ forceRefresh: true, shouldClaim: true });

    await waitFor({
      predicate: () => {
        const size = latestSize(mounted.sizes);
        return size.cols > initialSize.cols && size.rows > initialSize.rows;
      },
    });

    const grownSize = latestSize(mounted.sizes);
    expect(grownSize.cols).toBeGreaterThan(initialSize.cols);
    expect(grownSize.rows).toBeGreaterThan(initialSize.rows);
    expect(grownSize.shouldClaim).toBe(true);
  });

  it("keeps passive container measurements local after another client can claim", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    const initialSize = latestSize(mounted.sizes);
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";

    await waitFor({
      predicate: () =>
        mounted.sizes.some((size) => size.cols > initialSize.cols && size.rows > initialSize.rows),
    });

    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps visual viewport keyboard refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    expect(window.visualViewport).not.toBeNull();
    window.visualViewport?.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("keeps browser window refits passive", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 360, height: 180 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    await settleMountRefits();
    mounted.sizes.length = 0;

    mounted.root.style.width = "720px";
    mounted.root.style.height = "360px";
    window.dispatchEvent(new Event("resize"));

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    expect(mounted.sizes.filter((size) => size.shouldClaim)).toEqual([]);
  });

  it("does not force-claim a same-size resize while forwarding ordinary terminal input", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const sizeCount = mounted.sizes.length;
    const sizeBeforeInput = latestSize(mounted.sizes);
    const terminal = getBrowserTerminal();

    terminal.input("a", true);

    await waitFor({ predicate: () => mounted.inputs.length > 0 });

    expect(mounted.inputs.at(-1)).toBe("a");
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeInput,
    });
  });

  it("pastes through xterm's input producer", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.paste("legacy renderer paste");

    await waitFor({ predicate: () => mounted.inputs.length > 0 });
    expect(mounted.inputs).toEqual(["legacy renderer paste"]);
  });

  it("refreshes visible rows on a forced same-size resize", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const refreshCalls: Array<[number, number]> = [];
    const originalRefresh = terminal.refresh.bind(terminal);
    terminal.refresh = (start, end) => {
      refreshCalls.push([start, end]);
      originalRefresh(start, end);
    };

    mounted.runtime.resize({ forceRefresh: true, shouldClaim: false });

    await waitFor({ predicate: () => refreshCalls.length > 0 });
    expect(refreshCalls.at(-1)).toEqual([0, terminal.rows - 1]);
  });

  it("intercepts Shift+Enter only after enhanced terminal input mode is active", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([]);

    mounted.runtime.write({ data: terminalOutput("\x1b[>7u") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 7 && !state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    mounted.terminalKeys.length = 0;
    mounted.runtime.write({ data: terminalOutput("\x1b[=0;0u\x1b[?9001h") });
    await waitFor({
      predicate: () =>
        mounted.inputModeChanges.some(
          (state) => state.kittyKeyboardFlags === 0 && state.win32InputMode,
        ),
    });

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);

    const sizeCount = mounted.sizes.length;
    const sizeBeforeKey = latestSize(mounted.sizes);
    mounted.terminalKeys.length = 0;

    dispatchTerminalKey({
      host: mounted.host,
      key: "Enter",
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.terminalKeys).toEqual([
      {
        key: "Enter",
        ctrl: false,
        shift: true,
        alt: false,
        meta: false,
      },
    ]);
    expectNoForcedSameSizeClaim({
      sizes: mounted.sizes,
      startIndex: sizeCount,
      baseline: sizeBeforeKey,
    });
  });

  it("translates mac editing shortcuts into shell editing sequences", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, isMac: true });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({ host: mounted.host, key: "ArrowRight", keyCode: 39 });
    dispatchTerminalKey({ host: mounted.host, key: "ArrowLeft", keyCode: 37, metaKey: true });
    dispatchTerminalKey({ host: mounted.host, key: "ArrowRight", keyCode: 39, metaKey: true });
    dispatchTerminalKey({ host: mounted.host, key: "ArrowLeft", keyCode: 37, altKey: true });
    dispatchTerminalKey({ host: mounted.host, key: "ArrowRight", keyCode: 39, altKey: true });
    dispatchTerminalKey({ host: mounted.host, key: "Backspace", keyCode: 8, metaKey: true });
    await nextFrame();

    expect(mounted.inputs).toEqual([
      "\x1b[C", // plain arrow keeps xterm's default encoding
      "\x01", // cmd+left -> line start
      "\x05", // cmd+right -> line end
      "\x1bb", // option+left -> word back
      "\x1bf", // option+right -> word forward
      "\x15", // cmd+backspace -> kill line
    ]);
    expect(mounted.terminalKeys).toEqual([]);
  });

  it.each([true, false])("keeps pending modifier chips authoritative (isMac=%s)", async (isMac) => {
    const mounted = createTerminalHost({ width: 720, height: 360, isMac });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    mounted.runtime.setPendingModifiers({
      pendingModifiers: { ctrl: true, alt: false, shift: false },
    });
    dispatchTerminalKey({ host: mounted.host, key: "ArrowLeft", keyCode: 37, altKey: true });
    await nextFrame();
    expect(mounted.inputs).toEqual([]);
    expect(mounted.terminalKeys).toEqual([
      { key: "ArrowLeft", ctrl: true, alt: true, shift: false, meta: false },
    ]);
  });

  it("keeps cmd+shift+arrow free for app-level shortcuts", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, isMac: true });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({
      host: mounted.host,
      key: "ArrowRight",
      keyCode: 39,
      metaKey: true,
      shiftKey: true,
    });
    await nextFrame();

    expect(mounted.inputs).toEqual([]);
    expect(mounted.terminalKeys).toEqual([]);
  });

  it("does not remap modified arrows on non-mac platforms", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360, isMac: false });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    dispatchTerminalKey({ host: mounted.host, key: "ArrowRight", keyCode: 39, metaKey: true });
    dispatchTerminalKey({ host: mounted.host, key: "ArrowRight", keyCode: 39, altKey: true });
    await nextFrame();

    // Meta+arrow is ignored by xterm; alt+arrow takes xterm's generic encoding.
    expect(mounted.inputs).toEqual(["\x1b[1;3C"]);
  });

  it.each([
    { name: "DA1", bytes: "\x1b[c" },
    { name: "DA1-zero", bytes: "\x1b[0c" },
    { name: "DA2", bytes: "\x1b[>c" },
    { name: "DA3", bytes: "\x1b[=c" },
    { name: "DSR-5", bytes: "\x1b[5n" },
    { name: "DSR-6", bytes: "\x1b[6n" },
    { name: "DSR-?6", bytes: "\x1b[?6n" },
    { name: "DECRQM", bytes: "\x1b[1$p" },
    { name: "DECRQM-?", bytes: "\x1b[?1$p" },
    { name: "OSC-10-foreground-color", bytes: "\x1b]10;?\x07" },
    { name: "OSC-11-background-color", bytes: "\x1b]11;?\x07" },
    { name: "OSC-12-cursor-color", bytes: "\x1b]12;?\x07" },
  ])("does not emit a PTY input reply for $name", async ({ bytes }) => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    mounted.runtime.write({ data: terminalOutput(bytes) });
    await nextFrame();
    await nextFrame();

    expect(mounted.inputs).toEqual([]);
  });

  it("replays snapshots without synchronously resetting the visible terminal", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    const terminal = getBrowserTerminal();
    const originalReset = terminal.reset.bind(terminal);
    const reset = vi.fn(originalReset);
    terminal.reset = reset;

    mounted.runtime.renderSnapshot({
      state: {
        rows: terminal.rows,
        cols: terminal.cols,
        scrollback: [],
        grid: [
          [
            { char: "p" },
            { char: "r" },
            { char: "o" },
            { char: "m" },
            { char: "p" },
            { char: "t" },
          ],
        ],
        cursor: {
          row: 0,
          col: 6,
        },
      },
    });
    await nextFrame();

    expect(reset).not.toHaveBeenCalled();
  });

  it("opens a wrapped absolute file path from its continuation rows", async () => {
    const mounted = createTerminalHost({ width: 280, height: 260 });
    await waitFor({ predicate: () => mounted.sizes.length > 0 });
    const opened: string[] = [];
    mounted.runtime.setCallbacks({
      callbacks: {
        onResolveLocalFileLink: (source) => ({ path: source.path }),
        onOpenLocalFileLink: (target) => {
          opened.push(target.path);
        },
      },
    });
    const path =
      "/workspace/project/reports/long-nested-directory/terminal-rendering-regression-20261019.html";
    const columns = latestSize(mounted.sizes).cols;
    expect(path.length + 5).toBeGreaterThan(columns * 2);
    await writeTerminalOutput(mounted, `read ${path}`);
    await clickTerminalLink({ host: mounted.host, row: 1, col: 2 });
    await clickTerminalLink({ host: mounted.host, row: 2, col: 2 });
    expect(opened).toEqual([path, path]);
  });

  it.each([
    { printed: "https://example.test/preview.html에서", url: "https://example.test/preview.html" },
    { printed: "https://example.test/wiki/서울에서", url: "https://example.test/wiki/서울에서" },
    { printed: "https://example.test/wiki/대한민국", url: "https://example.test/wiki/대한민국" },
  ])("opens the intended URL from $printed", async ({ printed, url }) => {
    const mounted = createTerminalHost({ width: 720, height: 360 });
    await writeLines(mounted, [printed]);

    await clickTerminalLink({ host: mounted.host, row: 0, col: 4 });

    expect(mounted.openedUrls).toEqual([url]);
  });

  it("opens OSC 8 hyperlinks the same way as plain-text URLs", async () => {
    await page.viewport(900, 600);
    const mounted = createTerminalHost({ width: 720, height: 360 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await waitFor({ predicate: () => mounted.sizes.length > 0 });

    await writeLines(mounted, [
      hyperlink({ url: "https://example.com/osc8", text: "example" }),
      "https://example.com/plain",
    ]);

    await clickTerminalLink({ host: mounted.host, row: 1, col: 4 });
    await clickTerminalLink({ host: mounted.host, row: 0, col: 2 });

    expect(mounted.openedUrls).toEqual(["https://example.com/plain", "https://example.com/osc8"]);
    expect(confirm).not.toHaveBeenCalled();
  });
});
