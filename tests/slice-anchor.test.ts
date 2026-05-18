/**
 * SliceAnchor tests — flow-mode chat slice cap with UUID-style anchoring.
 *
 * Critical invariant: when the rendered window is stable, the anchored id
 * MUST appear at the same screen row across appends. Naive slice(-CAP)
 * fails this — every append shifts the head by 1, triggering log-update's
 * fullResetSequence per turn. computeSliceStart hides the shift by only
 * advancing in STEP-sized chunks.
 */
import { describe, expect, test } from "bun:test";
import {
  computeSliceStart,
  DEFAULT_CAP,
  DEFAULT_STEP,
  type AnchorRef,
} from "../src/ui/slice-anchor.js";

function mkEntries(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}` }));
}

describe("computeSliceStart — basic", () => {
  test("under cap: start at 0, anchor at first entry", () => {
    const entries = mkEntries(10);
    const anchorRef: AnchorRef = { current: null };
    const start = computeSliceStart(entries, anchorRef, 50, 10);
    expect(start).toBe(0);
    expect(anchorRef.current).toEqual({ id: "e1", idx: 0 });
  });

  test("empty entries: start 0, anchor stays null", () => {
    const anchorRef: AnchorRef = { current: null };
    const start = computeSliceStart([], anchorRef);
    expect(start).toBe(0);
    expect(anchorRef.current).toBeNull();
  });

  test("exactly at cap: start at 0, no advance", () => {
    const entries = mkEntries(50);
    const anchorRef: AnchorRef = { current: null };
    const start = computeSliceStart(entries, anchorRef, 50, 10);
    expect(start).toBe(0);
  });

  test("between cap and cap+step: still anchored at 0", () => {
    // cap=50, step=10 → advance only when length > 60
    const entries = mkEntries(55);
    const anchorRef: AnchorRef = { current: { id: "e1", idx: 0 } };
    const start = computeSliceStart(entries, anchorRef, 50, 10);
    expect(start).toBe(0);
    expect(anchorRef.current).toEqual({ id: "e1", idx: 0 });
  });
});

describe("computeSliceStart — hysteresis (STEP quantization)", () => {
  test("step boundary: window advances once at cap+step+1", () => {
    // cap=50, step=10. At 61, advance to start = 61 - 50 = 11.
    const entries = mkEntries(61);
    const anchorRef: AnchorRef = { current: { id: "e1", idx: 0 } };
    const start = computeSliceStart(entries, anchorRef, 50, 10);
    expect(start).toBe(11);
    expect(anchorRef.current).toEqual({ id: "e12", idx: 11 });
  });

  test("steady appends inside the [start, start+cap+step] band do not shift", () => {
    // After advancing to start=11 (anchor at e12), appending up to length
    // 61+10=71 (cap+step beyond start=11 is 11+60=71) must keep start at 11.
    const anchorRef: AnchorRef = { current: { id: "e12", idx: 11 } };
    for (let len = 62; len <= 71; len++) {
      const start = computeSliceStart(mkEntries(len), anchorRef, 50, 10);
      expect(start).toBe(11);
      // Critical: anchored id stays e12, so e12 lives at the same screen row.
      expect(anchorRef.current).toEqual({ id: "e12", idx: 11 });
    }
  });

  test("second advance: another STEP appends triggers another shift", () => {
    // Start anchored at e12 / idx=11. Push length to 72 (11+60+1=72): advance again.
    const anchorRef: AnchorRef = { current: { id: "e12", idx: 11 } };
    const start = computeSliceStart(mkEntries(72), anchorRef, 50, 10);
    expect(start).toBe(22); // 72 - 50 = 22
    expect(anchorRef.current).toEqual({ id: "e23", idx: 22 });
  });
});

describe("computeSliceStart — anchor recovery", () => {
  test("anchored id removed: fall back to clamped stored idx, not 0", () => {
    // Anchor pointed at id "gone" / idx=11. With 100 entries (cap=50),
    // clamped idx should be min(11, max(0, 100-50)) = min(11, 50) = 11.
    // After the advance check (100 - 11 = 89 > 60), we then advance to
    // 100 - 50 = 50.
    const entries = mkEntries(100);
    const anchorRef: AnchorRef = { current: { id: "gone", idx: 11 } };
    const start = computeSliceStart(entries, anchorRef, 50, 10);
    // Advance to 100 - 50 = 50
    expect(start).toBe(50);
    expect(anchorRef.current).toEqual({ id: "e51", idx: 50 });
  });

  test("anchored id removed, stored idx out of range: clamp to tail-cap", () => {
    // anchor idx=999 is beyond entries.length=30. Clamped to max(0, 30-50)=0
    // since length < cap. So start = 0.
    const entries = mkEntries(30);
    const anchorRef: AnchorRef = { current: { id: "gone", idx: 999 } };
    const start = computeSliceStart(entries, anchorRef, 50, 10);
    expect(start).toBe(0);
    expect(anchorRef.current).toEqual({ id: "e1", idx: 0 });
  });
});

describe("computeSliceStart — defaults", () => {
  test("DEFAULT_CAP=200, DEFAULT_STEP=50", () => {
    expect(DEFAULT_CAP).toBe(200);
    expect(DEFAULT_STEP).toBe(50);

    // 250 still anchored at 0 (length == cap+step, not >).
    const anchorRef: AnchorRef = { current: { id: "e1", idx: 0 } };
    expect(computeSliceStart(mkEntries(250), anchorRef)).toBe(0);

    // 251 triggers advance.
    expect(computeSliceStart(mkEntries(251), anchorRef)).toBe(51);
  });
});

describe("computeSliceStart — no-flicker invariant", () => {
  /**
   * The reason this whole module exists: across N consecutive single-entry
   * appends inside one window, the entry at screen row K must remain the
   * same entry. Verified by collecting (start, anchor.id) tuples and
   * asserting they only change in discrete steps, not continuously.
   */
  test("anchor id sequence is step-quantized, not append-quantized", () => {
    const anchorRef: AnchorRef = { current: null };
    const cap = 50;
    const step = 10;

    const observations: Array<{ len: number; start: number; anchorId: string | null }> = [];
    for (let len = 1; len <= 200; len++) {
      const start = computeSliceStart(mkEntries(len), anchorRef, cap, step);
      observations.push({
        len,
        start,
        anchorId: anchorRef.current?.id ?? null,
      });
    }

    // Count distinct anchor.id values across the whole run.
    // Naive slice(-CAP) would produce ~150 distinct values (one per length
    // past cap). Quantized algorithm should produce ⌈(200-cap)/step⌉ + 1 ≈ 16.
    const distinctAnchors = new Set(observations.map((o) => o.anchorId));
    expect(distinctAnchors.size).toBeLessThanOrEqual(20);

    // Once `start` advances past 0, it must only advance forward — never
    // jitter backward, which would mean a row is being uncovered.
    let prevStart = 0;
    for (const obs of observations) {
      expect(obs.start).toBeGreaterThanOrEqual(prevStart);
      prevStart = obs.start;
    }
  });
});
