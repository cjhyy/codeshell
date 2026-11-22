import assert from "node:assert/strict";
import test from "node:test";
import { markerPage, readMarker } from "./screen-capture-marker.mjs";

test("pixel readback distinguishes both fixture windows in a scaled, padded frame", () => {
  const width = 320,
    height = 180;
  const frame = new Uint8ClampedArray(width * height * 4);
  for (const label of ["PANEL", "CLOUD"]) {
    frame.fill(0);
    const svg = markerPage(label, "capture-test");
    for (const cell of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"/g)) {
      const left = 19 + Number(cell[1]) * 8,
        top = 27 + Number(cell[2]) * 6;
      for (let y = top; y < top + 6; y++)
        for (let x = left; x < left + 8; x++) frame.set([37, 215, 206, 255], (width * y + x) * 4);
    }
    assert.equal(readMarker(frame, width, height), label);
  }
  frame.fill(0);
  assert.equal(readMarker(frame, width, height), "");
});
