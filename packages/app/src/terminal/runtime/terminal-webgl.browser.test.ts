import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import "@xterm/xterm/css/xterm.css";

const disposables: Array<() => void> = [];
const columns = 60;
const rows = 24;
const batches = 64;

interface RendererFixture {
  terminal: Terminal;
  host: HTMLDivElement;
  removedPages: number;
}

afterEach(() => {
  for (const dispose of disposables.splice(0)) dispose();
});

function mount(left: number): RendererFixture {
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:${left}px;top:0;width:600px;height:500px`;
  document.body.append(host);
  const terminal = new Terminal({
    cols: columns,
    rows,
    fontSize: 14,
    allowProposedApi: true,
    theme: { background: "#111111", foreground: "#eeeeee" },
  });
  terminal.open(host);
  // Read the actual framebuffer after paint rather than mocking WebGL calls.
  const addon = new WebglAddon({ preserveDrawingBuffer: true });
  terminal.loadAddon(addon);
  const fixture = { terminal, host, removedPages: 0 };
  addon.onRemoveTextureAtlasCanvas(() => fixture.removedPages++);
  disposables.push(() => {
    terminal.dispose();
    host.remove();
  });
  return fixture;
}

function write(terminal: Terminal, text: string): Promise<void> {
  return new Promise((resolve) => terminal.write(text, resolve));
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function glyphRow(seed: number, row: number): string {
  const color = seed * (rows - 1) + row;
  let text = `\x1b[38;2;${(color * 37) % 256};${(color * 91) % 256};${128 + ((color * 13) % 128)}m`;
  for (let column = 0; column < columns / 2; column++) {
    text += String.fromCharCode(0xac00 + ((color * 41 + column * 7) % 11172));
  }
  return `${text}\x1b[0m\r\n`;
}

function stressScreen(seed: number): string {
  let text = "\x1b[?25l\x1b[H";
  for (let row = 0; row < rows - 1; row++) text += glyphRow(seed, row);
  return text;
}

async function framebuffer(host: HTMLElement) {
  const canvases = Array.from(host.querySelectorAll<HTMLCanvasElement>(".xterm-screen > canvas"));
  const canvas = canvases.find(
    (element) =>
      element.style.display !== "none" && !element.classList.contains("xterm-link-layer"),
  );
  if (!canvas) throw new Error("Missing WebGL canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("This regression test requires WebGL2");
  const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(
    0,
    0,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  expect(gl.getError()).toBe(gl.NO_ERROR);
  let brightPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] > 64) brightPixels++;
  }
  expect(brightPixels).toBeGreaterThan(100);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pixels));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bufferText(terminal: Terminal): string[] {
  return Array.from(
    { length: rows },
    (_, row) => terminal.buffer.active.getLine(row)?.translateToString() ?? "",
  );
}

test("split terminals keep glyph pixels stable after shared atlas compaction", async () => {
  await page.viewport(1400, 800);
  const left = mount(0);
  const right = mount(610);
  for (let batch = 0; batch < batches; batch++) {
    await write(left.terminal, stressScreen(batch * 2));
    await frame();
    await write(right.terminal, stressScreen(batch * 2 + 1));
    await frame();
  }
  expect(left.removedPages).toBeGreaterThan(0);
  expect(right.removedPages).toBeGreaterThan(0);

  // Reuse glyphs spread across older pages; fresh glyphs can conceal stale GPU slots.
  let replay = "\x1b[0m\x1b[2J\x1b[H\x1b[?25l";
  for (let row = 0; row < rows - 1; row++) {
    const seed = Math.floor((row * (batches * 2 - 1)) / (rows - 1));
    replay += glyphRow(seed, 0);
  }
  await write(left.terminal, replay);
  await write(right.terminal, replay);
  await frame();
  await frame();
  const textBefore = bufferText(left.terminal);
  const before = [await framebuffer(left.host), await framebuffer(right.host)];

  // Resizing resets the texture bindings but must not change the same rendered text.
  left.terminal.resize(columns - 1, rows);
  right.terminal.resize(columns - 1, rows);
  await frame();
  left.terminal.resize(columns, rows);
  right.terminal.resize(columns, rows);
  await frame();
  await write(left.terminal, replay);
  await write(right.terminal, replay);
  await frame();
  await frame();
  expect(bufferText(left.terminal)).toEqual(textBefore);
  expect(bufferText(right.terminal)).toEqual(textBefore);
  expect([await framebuffer(left.host), await framebuffer(right.host)]).toEqual(before);
}, 60_000);
