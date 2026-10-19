import { describe, expect, it } from "vitest";
import { TERMINAL_URL_REGEX } from "./terminal-web-links";

describe("terminal URL boundaries", () => {
  it.each([
    ["https://example.test/preview.html에서", "https://example.test/preview.html"],
    ["https://example.test/preview.html까지입니다.", "https://example.test/preview.html"],
    ["https://example.test/preview.html”에서", "https://example.test/preview.html"],
    ["https://example.test/preview.html。", "https://example.test/preview.html"],
    ["https://example.test/a?x=1&y=2에서", "https://example.test/a?x=1&y=2"],
    ["https://example.test/wiki/대한민국", "https://example.test/wiki/대한민국"],
    ["https://example.test/wiki/서울에서", "https://example.test/wiki/서울에서"],
    ["https://example.test/wiki/한국·일본", "https://example.test/wiki/한국·일본"],
    ["https://example.test/가", "https://example.test/가"],
    ["https://example.test/2026년", "https://example.test/2026년"],
    ["https://example.test/a/한국?언어=한국어", "https://example.test/a/한국?언어=한국어"],
    ["http://[::1]:8080/path.", "http://[::1]:8080/path"],
    ["https://example.test/a。b", "https://example.test/a。b"],
  ])("finds the URL in %s", (printed, url) => {
    expect(TERMINAL_URL_REGEX.exec(printed)?.[0]).toBe(url);
  });
});
