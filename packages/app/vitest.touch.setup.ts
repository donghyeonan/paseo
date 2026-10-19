if (navigator.maxTouchPoints < 1 || !("ontouchstart" in window)) {
  throw new Error("Touch regressions require the browser-touch project's hasTouch context");
}
