// @ts-nocheck
import { c as _c } from "react/compiler-runtime";
import React from 'react';
export type Props = {
  /**
   * Number of newlines to insert.
   *
   * @default 1
   */
  readonly count?: number;
};

/**
 * Adds one or more newline (\n) characters. Must be used within <Text> components.
 */
export default function Newline(t0) {
  const $ = _c(4);
  const {
    count: t1
  } = t0;
  // Clamp to a non-negative integer — "\n".repeat(n) throws RangeError for
  // negative or non-finite counts (review-2026-05-30). NaN/Infinity fall back
  // to 1 (Math.max(0, NaN) is still NaN, so guard explicitly).
  const _raw = t1 === undefined ? 1 : t1;
  const count = Number.isFinite(_raw) ? Math.max(0, Math.floor(_raw)) : 1;
  let t2;
  if ($[0] !== count) {
    t2 = "\n".repeat(count);
    $[0] = count;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  let t3;
  if ($[2] !== t2) {
    t3 = <ink-text>{t2}</ink-text>;
    $[2] = t2;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  return t3;
}
