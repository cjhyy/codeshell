import { describe, expect, test } from "bun:test";
import { CuaActivityTracker } from "./cua-activity.js";

const request = (id: string | number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const response = (id: string | number, structuredContent: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  result: { structuredContent, content: [] },
});

function observe(tracker: CuaActivityTracker, id: string | number = 1, overrides = {}) {
  tracker.begin(request(id, "get_window_state", { pid: 10, window_id: 20 }));
  tracker.finish(
    response(id, {
      pid: 10,
      window_id: 20,
      screenshot_frame_valid: true,
      window_bounds: { x: 100, y: 200, width: 800, height: 600 },
      screenshot_width: 400,
      screenshot_height: 300,
      screenshot_scale: 2,
      capture_id: "capture-1",
      elements: [
        {
          element_token: "s12345678:1",
          frame: { x: 180, y: 280, w: 40, h: 20 },
          label: "secret document",
          value: "private typed text",
        },
      ],
      ...overrides,
    }),
  );
}

describe("CuaActivityTracker", () => {
  test("reserves a code editor's enclosing region without moving its native AX target", () => {
    const tracker = new CuaActivityTracker("proxy");
    observe(tracker, 1, {
      elements: [
        { element_index: 1, role: "AXGroup", frame: { x: 200, y: 210, w: 600, h: 350 } },
        {
          element_index: 2,
          parent_index: 1,
          role: "AXTextArea",
          element_token: "s12345678:2",
          frame: { x: 790, y: 220, w: 2, h: 23 },
        },
      ],
    });
    const event = tracker.begin(
      request(2, "click", { pid: 10, window_id: 20, element_token: "s12345678:2" }),
    );
    expect(event?.target).toEqual({ x: 791, y: 231.5 });
    expect(event?.avoidRect).toEqual({ x: 200, y: 210, width: 600, height: 350 });
    observe(tracker, 3, {
      elements: [
        { element_index: 1, role: "AXWebArea", frame: { x: 100, y: 200, w: 800, h: 600 } },
        {
          element_index: 2,
          parent_index: 1,
          role: "AXTextArea",
          element_token: "s12345678:2",
          frame: { x: 790, y: 220, w: 2, h: 23 },
        },
      ],
    });
    expect(
      tracker.begin(request(4, "click", { pid: 10, window_id: 20, element_token: "s12345678:2" }))
        ?.avoidRect,
    ).toEqual({ x: 790, y: 220, width: 2, height: 23 });
  });

  test("only a pointerless value write marks its AX element as the target", () => {
    const tracker = new CuaActivityTracker("proxy");
    observe(tracker);
    const write = { pid: 10, window_id: 20, element_token: "s12345678:1", value: "整段" };
    expect(tracker.begin(request(2, "set_value", write))).toMatchObject({
      action: "type",
      target: { x: 200, y: 290 },
      targetSource: "element",
    });
    expect(tracker.begin(request(3, "click", write))?.targetSource).toBeUndefined();
    // Without a fresh snapshot of that element there is no position to claim.
    expect(
      tracker.begin(request(4, "set_value", { ...write, element_token: "s12345678:9" })),
    ).not.toHaveProperty("targetSource");
  });

  test("uses returned window geometry including image downscale, not only Retina scale", () => {
    const tracker = new CuaActivityTracker("proxy");
    observe(tracker);
    const event = tracker.begin(
      request(2, "click", {
        pid: 10,
        window_id: 20,
        x: 120,
        y: 50,
        capture_id: "capture-1",
      }),
    );
    expect(event).toEqual({
      id: "proxy:2",
      action: "click",
      phase: "start",
      capture: false,
      lane: "background",
      target: { x: 340, y: 300 },
    });
    expect(tracker.finish(response(2))).toEqual({
      id: "proxy:2",
      action: "click",
      phase: "end",
      capture: false,
    });
    expect(
      tracker.begin(request(3, "click", { pid: 10, window_id: 20, x: 120, y: 50 }))?.target,
    ).toBeUndefined();
  });

  test("AX token frames are already global points and require matching target identity", () => {
    const tracker = new CuaActivityTracker("proxy");
    observe(tracker);
    expect(
      tracker.begin(
        request(2, "type_text", { pid: 10, element_token: "s12345678:1", text: "secret" }),
      )?.target,
    ).toEqual({ x: 200, y: 290 });
    expect(
      tracker.begin(request(3, "click", { pid: 11, element_token: "s12345678:1" }))?.target,
    ).toBeUndefined();
    expect(
      tracker.begin(request(4, "click", { pid: 10, window_id: 21, element_token: "s12345678:1" }))
        ?.target,
    ).toBeUndefined();
  });

  test("AX avoidance rectangles contain only fresh matching snapshot geometry", () => {
    let now = 100;
    const tracker = new CuaActivityTracker("proxy", () => now);
    observe(tracker);
    const args = { pid: 10, window_id: 20, element_token: "s12345678:1", text: "private input" };
    const event = tracker.begin(request(2, "type_text", args));
    expect(event?.target).toEqual({ x: 200, y: 290 });
    expect(event?.avoidRect).toEqual({ x: 180, y: 280, width: 40, height: 20 });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(JSON.stringify(event)).not.toContain("secret");
    for (const [index, extra] of [
      { pid: 11 },
      { window_id: 21 },
      { from_zoom: true },
      { scope: "desktop" },
      { debug_image_out: "private" },
    ].entries())
      expect(
        tracker.begin(request(index + 3, "click", { ...args, ...extra }))?.avoidRect,
      ).toBeUndefined();
    expect(
      tracker.begin(request(9, "click", { pid: 10, window_id: 20, x: 1, y: 2 }))?.avoidRect,
    ).toBeUndefined();
    now += 15_001;
    expect(tracker.begin(request(10, "type_text", args))?.avoidRect).toBeUndefined();
    observe(tracker, 11);
    observe(tracker, 12, { elements: [] });
    expect(tracker.begin(request(13, "type_text", args))?.avoidRect).toBeUndefined();
  });

  test("does not infer targets for zoom, stale captures, invalid pixels or expired geometry", () => {
    let now = 100;
    const tracker = new CuaActivityTracker("proxy", () => now);
    observe(tracker);
    const base = { target: { kind: "window", pid: 10, window_id: 20 }, x: 120, y: 50 };
    for (const [i, extra] of [
      { from_zoom: true },
      { capture_id: "another" },
      { x: -1 },
      { y: 300 },
      { x: Infinity },
    ].entries()) {
      expect(tracker.begin(request(i + 2, "click", { ...base, ...extra }))?.target).toBeUndefined();
    }
    now += 15_001;
    expect(tracker.begin(request(8, "click", base))?.target).toBeUndefined();
  });

  test("unverified screenshot geometry does not become pixel coordinates", () => {
    const tracker = new CuaActivityTracker("proxy");
    observe(tracker, 1, { screenshot_frame_valid: false });
    expect(
      tracker.begin(request(2, "click", { pid: 10, window_id: 20, x: 1, y: 2 }))?.target,
    ).toBeUndefined();
    expect(
      tracker.begin(request(3, "click", { pid: 10, element_token: "s12345678:1" }))?.target,
    ).toEqual({ x: 200, y: 290 });
  });

  test("new snapshots replace tokens and mismatched responses discard prior geometry", () => {
    const tracker = new CuaActivityTracker("proxy");
    observe(tracker);
    observe(tracker, 2, { elements: [] });
    expect(
      tracker.begin(request(3, "click", { pid: 10, element_token: "s12345678:1" }))?.target,
    ).toBeUndefined();
    observe(tracker, 4, { pid: 11 });
    expect(
      tracker.begin(request(5, "click", { pid: 10, window_id: 20, x: 1, y: 2 }))?.target,
    ).toBeUndefined();
  });

  test("uses primary desktop screenshot dimensions without assuming a 2x display", () => {
    const tracker = new CuaActivityTracker("proxy");
    tracker.begin(request(1, "get_desktop_state"));
    tracker.finish(
      response(1, {
        platform: "macos",
        display: "primary",
        screen_width: 1440,
        screen_height: 900,
        screenshot_width: 960,
        screenshot_height: 600,
      }),
    );
    expect(
      tracker.begin(
        request(2, "click", { target: { kind: "desktop", display_id: "primary" }, x: 200, y: 100 }),
      )?.target,
    ).toEqual({ x: 300, y: 150 });
    expect(
      tracker.begin(
        request(3, "click", {
          target: { kind: "desktop", display_id: "secondary" },
          x: 200,
          y: 100,
        }),
      )?.target,
    ).toBeUndefined();
  });

  test("never projects content and conservatively hides for unknown or composite invocations", () => {
    const tracker = new CuaActivityTracker("proxy");
    for (const [i, name] of [
      "page",
      "run_script",
      "run_steps",
      "browser_click",
      "future_tool",
    ].entries()) {
      const event = tracker.begin(
        request(i, name, { code: "secret", text: "private", x: 5, y: 6 }),
      );
      expect(event).toEqual({
        id: `proxy:${i + 1}`,
        action: "working",
        phase: "start",
        capture: true,
        // Opaque or unknown tools are gated as foreground input.
        lane: "foreground",
      });
      expect(JSON.stringify(event)).not.toContain("secret");
    }
    expect(
      tracker.begin(request(9, "get_window_state", { include_screenshot: false }))?.capture,
    ).toBe(false);
    expect(
      tracker.begin(
        request(10, "get_window_state", {
          include_screenshot: false,
          screenshot_out_file: "private",
        }),
      )?.capture,
    ).toBe(true);
    expect(tracker.begin(request(11, "click", { debug_image_out: "private" }))?.capture).toBe(true);
  });

  test("correlates numeric and string RPC ids separately and ignores notifications", () => {
    const tracker = new CuaActivityTracker("proxy");
    const a = tracker.begin(request(1, "click"));
    const b = tracker.begin(request("1", "type_text"));
    expect(a?.id).not.toBe(b?.id);
    expect(tracker.begin({ method: "tools/call", params: { name: "click" } })).toBeUndefined();
    expect(tracker.finish({ id: 1, error: { message: "private" } })).toEqual({
      id: a!.id,
      action: "click",
      phase: "end",
      capture: false,
      failed: true,
    });
    expect(tracker.finish(response("1"))?.id).toBe(b!.id);
    expect(tracker.finish(response("1"))).toBeUndefined();
  });

  test("cleanup returns failed terminal events for every outstanding capture", () => {
    const tracker = new CuaActivityTracker("proxy");
    tracker.begin(request(1, "get_window_state"));
    expect(tracker.clear()).toEqual([
      { id: "proxy:1", action: "observe", phase: "end", capture: true, failed: true },
    ]);
    expect(tracker.clear()).toEqual([]);
  });
});
