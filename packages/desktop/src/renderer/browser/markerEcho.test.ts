import { describe, test, expect } from "bun:test";
import {
  browserMarkersFrom,
  visibleMarkersOn,
  groupMarkersByPage,
  pageAttribution,
  urlsMatch,
  buildHighlightScript,
  CLEAR_HIGHLIGHT_SCRIPT,
} from "./markerEcho";
import type { Anchor } from "../chat/anchors";

function mk(id: string, url: string, extra?: Partial<NonNullable<Anchor["browser"]>>): Anchor {
  return {
    id,
    kind: "browser",
    label: id,
    locator: {},
    comment: `c-${id}`,
    browser: { url, rect: { x: 1, y: 2, width: 3, height: 4 }, ...extra },
  };
}

describe("browserMarkersFrom / visibleMarkersOn", () => {
  test("narrows to browser anchors with echo and filters by exact URL", () => {
    const anchors: Anchor[] = [
      mk("a", "http://x/1"),
      mk("b", "http://x/2"),
      { id: "f", kind: "file", label: "f", locator: {}, comment: "" },
      { id: "noEcho", kind: "browser", label: "n", locator: {}, comment: "" },
    ];
    const markers = browserMarkersFrom(anchors);
    expect(markers.map((m) => m.anchor.id)).toEqual(["a", "b"]);
    expect(visibleMarkersOn(markers, "http://x/1").map((m) => m.anchor.id)).toEqual(["a"]);
    expect(visibleMarkersOn(markers, "http://x/3")).toEqual([]);
  });
});

describe("urlsMatch (normalized page identity)", () => {
  test("trailing slash / bare host are the same page", () => {
    expect(urlsMatch("http://localhost:3000", "http://localhost:3000/")).toBe(true);
    expect(urlsMatch("http://x/a/", "http://x/a")).toBe(true);
  });

  test("different paths / hashes / queries stay distinct", () => {
    expect(urlsMatch("http://localhost:3000", "http://localhost:3000/chat")).toBe(false);
    expect(urlsMatch("http://x/a#1", "http://x/a#2")).toBe(false);
    expect(urlsMatch("http://x/a?p=1", "http://x/a?p=2")).toBe(false);
  });

  test("unparsable values fall back to raw equality", () => {
    expect(urlsMatch("not a url", "not a url")).toBe(true);
    expect(urlsMatch("not a url", "other")).toBe(false);
  });

  test("visibleMarkersOn uses the normalized match", () => {
    const markers = browserMarkersFrom([mk("a", "http://localhost:3000")]);
    expect(visibleMarkersOn(markers, "http://localhost:3000/")).toHaveLength(1);
  });
});

describe("groupMarkersByPage", () => {
  test("groups by url, prefers a captured pageTitle as the group title", () => {
    const markers = browserMarkersFrom([
      mk("a", "http://x/1"), // no title yet
      mk("b", "http://x/1", { pageTitle: "首页" }),
      mk("c", "http://x/2"),
    ]);
    const groups = groupMarkersByPage(markers);
    expect(groups).toHaveLength(2);
    expect(groups[0].url).toBe("http://x/1");
    expect(groups[0].title).toBe("首页"); // upgraded from bare-url fallback
    expect(groups[0].markers).toHaveLength(2);
    expect(groups[1].title).toBe("http://x/2"); // no title → url fallback
  });
});

describe("pageAttribution", () => {
  test("host + path; bare host for the root path; raw value when unparsable", () => {
    expect(pageAttribution({ url: "http://localhost:3000/settings", rect: { x: 0, y: 0, width: 0, height: 0 } })).toBe(
      "localhost:3000/settings",
    );
    expect(pageAttribution({ url: "http://localhost:3000/", rect: { x: 0, y: 0, width: 0, height: 0 } })).toBe(
      "localhost:3000",
    );
    expect(pageAttribution({ url: "not a url", rect: { x: 0, y: 0, width: 0, height: 0 } })).toBe("not a url");
  });
});

describe("highlight scripts", () => {
  test("highlight script embeds the JSON-escaped selector and reports match", () => {
    const script = buildHighlightScript(`button.primary[data-x="1"]`);
    expect(script).toContain(JSON.stringify(`button.primary[data-x="1"]`));
    expect(script).toContain("return false"); // miss reporting (the old code silently no-opped)
    expect(script).toContain("return true");
    expect(script).toContain("scrollIntoView");
    // The clear pass runs first so switching markers can't stack outlines.
    expect(script.indexOf(CLEAR_HIGHLIGHT_SCRIPT.slice(5, 40))).toBeGreaterThan(-1);
  });

  test("clear script restores the saved outline and removes the data attr", () => {
    expect(CLEAR_HIGHLIGHT_SCRIPT).toContain("removeAttribute");
    expect(CLEAR_HIGHLIGHT_SCRIPT).toContain("data-__cs_marker_hl__");
  });
});
