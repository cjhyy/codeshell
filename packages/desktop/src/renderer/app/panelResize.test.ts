import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ensureMiniDom } from "../test-utils/renderHook";
import { resizedPanelWidth, startPanelResize } from "./panelResize";

function mouseEvent(type: string, clientX: number): MouseEvent {
  const event = new Event(type) as MouseEvent;
  Object.defineProperty(event, "clientX", { value: clientX });
  return event;
}

function keyboardEvent(key: string): KeyboardEvent {
  const event = new Event("keydown") as KeyboardEvent;
  Object.defineProperty(event, "key", { value: key });
  return event;
}

describe("panel resize", () => {
  let target: HTMLElement;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame | undefined;
  let nextFrameId = 0;
  let frames: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    ensureMiniDom();
    target = document.createElement("div");
    target.style.width = "480px";
    document.body.appendChild(target);
    frames = new Map();
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id: number): void => {
      frames.delete(id);
    };
  });

  afterEach(() => {
    if (target.parentNode) target.parentNode.removeChild(target);
    if (originalRequestAnimationFrame) {
      window.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (window as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    }
    if (originalCancelAnimationFrame) {
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      delete (window as unknown as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    }
  });

  test("clamps a right-dock drag to its current bounds", () => {
    expect(resizedPanelWidth(700, 900, 480, 320, 700)).toBe(320);
    expect(resizedPanelWidth(700, 650, 480, 320, 700)).toBe(530);
    expect(resizedPanelWidth(700, 300, 480, 320, 700)).toBe(700);
  });

  test("shields webviews, previews once per frame, and commits only on mouseup", () => {
    const guest = document.createElement("webview");
    guest.style.pointerEvents = "auto";
    target.querySelectorAll = (() => [guest]) as typeof target.querySelectorAll;
    const committed: number[] = [];
    startPanelResize({
      startX: 700,
      startWidth: 480,
      target,
      minWidth: 320,
      maxWidth: () => 700,
      onCommit: (width) => committed.push(width),
    });

    const shield = Array.from(document.body.children).find(
      (element) => element.getAttribute("data-panel-resize-shield") === "true",
    ) as HTMLElement | undefined;
    expect(shield).toBeDefined();
    expect(guest.style.pointerEvents).toBe("none");

    shield!.dispatchEvent(mouseEvent("mousemove", 650));
    shield!.dispatchEvent(mouseEvent("mousemove", 300));
    expect(frames.size).toBe(1);
    expect(target.style.width).toBe("480px");
    expect(committed).toEqual([]);

    const [frameId, frame] = [...frames.entries()][0]!;
    frames.delete(frameId);
    frame(0);
    expect(target.style.width).toBe("700px");
    expect(committed).toEqual([]);

    shield!.dispatchEvent(mouseEvent("mouseup", 300));
    expect(committed).toEqual([700]);
    expect(guest.style.pointerEvents).toBe("auto");
    expect(
      Array.from(document.body.children).some(
        (element) => element.getAttribute("data-panel-resize-shield") === "true",
      ),
    ).toBe(false);
  });

  test("Escape cancels the preview without committing it", () => {
    const committed: number[] = [];
    startPanelResize({
      startX: 700,
      startWidth: 480,
      target,
      minWidth: 320,
      maxWidth: () => 700,
      onCommit: (width) => committed.push(width),
    });
    const shield = Array.from(document.body.children).find(
      (element) => element.getAttribute("data-panel-resize-shield") === "true",
    ) as HTMLElement;
    shield.dispatchEvent(mouseEvent("mousemove", 400));

    window.dispatchEvent(keyboardEvent("Escape"));

    expect(target.style.width).toBe("480px");
    expect(committed).toEqual([]);
    expect(frames.size).toBe(0);
  });
});
