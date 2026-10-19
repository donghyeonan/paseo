import { afterEach, expect, test } from "vitest";
import { Terminal } from "@xterm/xterm";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";

const disposables: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposables.splice(0)) dispose();
});

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function graphics(parameters: string, payload?: string): string {
  return `\x1b_G${parameters}${payload === undefined ? "" : `;${payload}`}\x1b\\`;
}

function imageFixture() {
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px;overflow:hidden";
  document.body.append(host);
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  terminal.open(host);
  const images = new ImageAddon();
  terminal.loadAddon(images);
  disposables.push(() => {
    terminal.dispose();
    host.remove();
  });
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 16, 16);
  return { terminal, images, host, payload: canvas.toDataURL("image/png").split(",")[1] };
}

test("Kitty placement-only redraw preserves uploaded image pixels", async () => {
  const { terminal, images, payload } = imageFixture();
  await write(terminal, graphics("a=T,f=100,i=42,c=2,r=2,C=1,q=2", payload));
  expect(images.getImageAtBufferCell(0, 0)?.width).toBeGreaterThan(0);
  // Pi clears placements on repaint, then places the already-uploaded image.
  await write(terminal, graphics("a=d,d=a,q=2"));
  await write(terminal, "\x1b[H" + graphics("a=p,i=42,c=2,r=2,C=1,q=2"));
  expect(images.getImageAtBufferCell(0, 0)?.width).toBeGreaterThan(0);
});

test("explicit Kitty deletion clears tiles instead of painting gray placeholders", async () => {
  const { terminal, host, payload } = imageFixture();
  await write(terminal, graphics("a=T,f=100,i=42,c=2,r=2,C=1,q=2", payload));
  await write(terminal, "\x1b[5;1H" + graphics("a=T,f=100,i=43,c=2,r=2,C=1,q=2", payload));
  function firstPixelAlpha() {
    const layer = host.querySelector<HTMLCanvasElement>(".xterm-image-layer-top");
    const context = layer?.getContext("2d");
    return context?.getImageData(1, 1, 1, 1).data[3];
  }
  terminal.refresh(0, 9);
  await expect.poll(firstPixelAlpha).toBe(255);
  await write(terminal, graphics("a=d,d=I,i=42,q=2"));
  terminal.refresh(0, 9);
  await expect.poll(firstPixelAlpha).toBe(0);
});

test.each(["a", "i"])(
  "Kitty lowercase %s preserves payload while uppercase frees it",
  async (selector) => {
    const { terminal, images, payload } = imageFixture();
    await write(terminal, graphics("a=T,f=100,i=42,c=2,r=2,C=1,q=2", payload));
    await write(terminal, graphics(`a=d,d=${selector},i=42,q=2`));
    expect(images.getImageAtBufferCell(0, 0)).toBeUndefined();
    await write(terminal, "\x1b[H" + graphics("a=p,i=42,c=2,r=2,C=1,q=2"));
    expect(images.getImageAtBufferCell(0, 0)?.width).toBeGreaterThan(0);
    await write(terminal, graphics(`a=d,d=${selector.toUpperCase()},i=42,q=2`));
    await write(terminal, "\x1b[H" + graphics("a=p,i=42,c=2,r=2,C=1,q=2"));
    expect(images.getImageAtBufferCell(0, 0)).toBeUndefined();
  },
);

test("alternate-screen redraw keeps cropped images and clears their former cells", async () => {
  const { terminal, images, payload } = imageFixture();
  await write(terminal, "\x1b[?1049h" + graphics("a=t,f=100,i=42,q=2", payload));
  for (let frame = 0; frame < 20; frame++) {
    const row = frame % 2 === 0 ? 0 : 3;
    const oldRow = row === 0 ? 3 : 0;
    await write(
      terminal,
      graphics("a=d,d=a,q=2") + `\x1b[${row + 1};1H` + graphics("a=p,i=42,c=2,r=2,y=4,h=8,C=1,q=2"),
    );
    expect(images.getImageAtBufferCell(0, row)?.width).toBeGreaterThan(0);
    expect(images.getImageAtBufferCell(0, oldRow)).toBeUndefined();
    expect(terminal.buffer.active.cursorY).toBe(row);
  }
});
