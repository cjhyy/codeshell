import { describe, test, expect } from "bun:test";
import {
  addAnchorTo,
  anchorsIn,
  browserAnchorsOf,
  clearAnchorBuckets,
  removeAnchorFrom,
  type AnchorsByBucket,
} from "./anchorBuckets";
import type { Anchor } from "./anchors";

function mk(id: string, kind: Anchor["kind"] = "browser", withEcho = true): Anchor {
  return {
    id,
    kind,
    label: id,
    locator: {},
    comment: "",
    ...(kind === "browser" && withEcho
      ? { browser: { url: "http://localhost:3000/", rect: { x: 0, y: 0, width: 1, height: 1 }, } }
      : {}),
  };
}

describe("anchorBuckets (session-bucketed anchors)", () => {
  test("add/read/remove are bucket-scoped", () => {
    let s: AnchorsByBucket = {};
    s = addAnchorTo(s, "repo::s1", mk("a"));
    s = addAnchorTo(s, "repo::s2", mk("b"));
    expect(anchorsIn(s, "repo::s1").map((a) => a.id)).toEqual(["a"]);
    expect(anchorsIn(s, "repo::s2").map((a) => a.id)).toEqual(["b"]);
    expect(anchorsIn(s, "repo::s3")).toEqual([]);

    s = removeAnchorFrom(s, "repo::s1", "a");
    expect(anchorsIn(s, "repo::s1")).toEqual([]);
    expect(anchorsIn(s, "repo::s2")).toHaveLength(1); // untouched
  });

  test("removeAnchorFrom is a no-op (same reference) when the id is absent", () => {
    const s = addAnchorTo({}, "b1", mk("a"));
    expect(removeAnchorFrom(s, "b1", "nope")).toBe(s);
    expect(removeAnchorFrom(s, "other", "a")).toBe(s);
  });

  test("clearAnchorBuckets clears active + draft slots, leaves others", () => {
    let s: AnchorsByBucket = {};
    s = addAnchorTo(s, "repo::s1", mk("a"));
    s = addAnchorTo(s, "repo::_none_", mk("b")); // draft slot (promoted mid-send)
    s = addAnchorTo(s, "repo::s2", mk("c"));
    const next = clearAnchorBuckets(s, ["repo::s1", "repo::_none_"]);
    expect(anchorsIn(next, "repo::s1")).toEqual([]);
    expect(anchorsIn(next, "repo::_none_")).toEqual([]);
    expect(anchorsIn(next, "repo::s2")).toHaveLength(1);
  });

  test("clearAnchorBuckets is a no-op (same reference) when nothing to clear", () => {
    const s = addAnchorTo({}, "b1", mk("a"));
    expect(clearAnchorBuckets(s, ["empty1", "empty2"])).toBe(s);
  });

  test("browserAnchorsOf keeps only browser anchors WITH echo payload", () => {
    const list = [mk("a"), mk("f", "file"), mk("noEcho", "browser", false)];
    expect(browserAnchorsOf(list).map((a) => a.id)).toEqual(["a"]);
  });
});
