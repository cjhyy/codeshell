import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "../Markdown";
import { InlineMedia } from "./InlineMedia";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { MediaPreviewRequest, MediaPreviewResult } from "../../shared/media-preview";

function descendants(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(descendants)];
}

function propsOf(node: any): Record<string, any> {
  const key = Object.keys(node).find((key) => key.startsWith("__reactProps$"));
  return key ? node[key] : {};
}

function preview(kind: "audio" | "video" = "audio", token = "one"): MediaPreviewResult {
  return {
    url: `csmedia://preview/${token}`,
    kind,
    name: kind === "audio" ? "voice.wav" : "clip.mp4",
    mimeType: kind === "audio" ? "audio/wav" : "video/mp4",
  };
}

let root: Root;
let container: HTMLElement;
let requests: MediaPreviewRequest[];
let released: string[];
let resolvePreview: (request: MediaPreviewRequest) => Promise<MediaPreviewResult | null>;
const originalObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  ensureMiniDom();
  container = document.createElement("div");
  root = createRoot(container);
  requests = [];
  released = [];
  resolvePreview = async () => preview();
  Object.assign(globalThis, { IntersectionObserver: undefined });
  Object.assign(window, {
    codeshell: {
      getMediaPreview: async (request: MediaPreviewRequest) => {
        requests.push(request);
        return resolvePreview(request);
      },
      releaseMediaPreview: async (url: string) => {
        released.push(url);
      },
    },
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await flushMicrotasks();
  });
  Object.assign(globalThis, { IntersectionObserver: originalObserver });
});

async function render(element: React.ReactNode) {
  await act(async () => {
    root.render(element);
    await flushMicrotasks();
  });
}

function players() {
  return descendants(container).filter((node) => ["AUDIO", "VIDEO"].includes(node.tagName));
}

describe("inline media lifecycle", () => {
  test.each([
    ["![听音频](</repo/中文目录/我的 录音.wav>)", "/repo/中文目录/我的 录音.wav", "audio"],
    ["[video](./clips/demo.MP4)", "./clips/demo.MP4", "video"],
    ["[audio](voice.wav)", "voice.wav", "audio"],
    ["![video](<my clips/a b.mp4>)", "my clips/a b.mp4", "video"],
    ["`voice.wav`", "voice.wav", "audio"],
    ["生成完成：.code-shell/output/demo.mp4", ".code-shell/output/demo.mp4", "video"],
    ["![audio](C:/repo/voice.wav)", "C:/repo/voice.wav", "audio"],
    ["[video](D:/clips/demo.MP4)", "D:/clips/demo.MP4", "video"],
    ["![audio](<C:/my clips/录音 demo.wav>)", "C:/my clips/录音 demo.wav", "audio"],
    [String.raw`![video](D:\clips\demo.mp4)`, String.raw`D:\clips\demo.mp4`, "video"],
    ["`C:/repo/voice.wav`", "C:/repo/voice.wav", "audio"],
    ["生成完成：D:\\clips\\demo.mp4", String.raw`D:\clips\demo.mp4`, "video"],
    ["![audio][clip]\n\n[clip]: C:/repo/voice.wav", "C:/repo/voice.wav", "audio"],
  ] as const)("renders authorized Markdown media: %s", async (text, path, kind) => {
    resolvePreview = async () => preview(kind);
    await render(
      <Markdown
        text={text}
        cwd="/repo"
        sessionId="session"
        sessionMainRootId="main"
        rootStatus="ok"
      />,
    );
    expect(requests).toEqual([{ sessionId: "session", path, rootId: "main" }]);
    expect(players()).toHaveLength(1);
    const player = propsOf(players()[0]);
    expect(player.src).toBe(preview(kind).url);
    expect(player.controls).toBe(true);
    expect(player.preload).toBe("none");
    expect(player.autoPlay).toBeUndefined();
    expect(descendants(container).some((node) => node.tagName === "IMG")).toBe(false);
  });

  test("does not acquire a URL before approaching the viewport", async () => {
    let observe!: (entries: Array<{ isIntersecting: boolean }>) => void;
    Object.assign(globalThis, {
      IntersectionObserver: class {
        constructor(callback: typeof observe) {
          observe = callback;
        }
        observe() {}
        disconnect() {}
      },
    });
    await render(<InlineMedia path="voice.wav" kind="audio" sessionId="session" />);
    expect(requests).toEqual([]);
    await act(async () => {
      observe([{ isIntersecting: true }]);
      await flushMicrotasks();
    });
    expect(requests).toHaveLength(1);
  });

  test.each(["dir_missing", "root_removed", "root_replaced", "loading"] as const)(
    "fails closed when Session authority is %s",
    async (rootStatus) => {
      await render(
        <InlineMedia
          path="/repo/voice.wav"
          kind="audio"
          sessionId="session"
          rootStatus={rootStatus}
        />,
      );
      expect(requests).toEqual([]);
      expect(players()).toHaveLength(0);
      expect(descendants(container).some((node) => node.tagName === "BUTTON")).toBe(false);
    },
  );

  test("does not borrow a parent/default session when none was provided", async () => {
    await render(<InlineMedia path="voice.wav" kind="audio" cwd="/repo" />);
    expect(requests).toEqual([]);
  });

  test("releases a pending URL that resolves after the player was removed", async () => {
    let complete!: (result: MediaPreviewResult) => void;
    resolvePreview = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    await render(<InlineMedia path="voice.wav" kind="audio" sessionId="session" />);
    await render(null);
    await act(async () => {
      complete(preview());
      await flushMicrotasks();
    });
    expect(released).toEqual([preview().url]);
    expect(players()).toHaveLength(0);
  });

  test("stops and releases the old file before a changed root finishes resolving", async () => {
    await render(
      <InlineMedia path="voice.wav" kind="audio" sessionId="session" sessionMainRootId="old" />,
    );
    const oldPlayer = players()[0];
    let paused = 0;
    oldPlayer.pause = () => {
      paused++;
    };
    resolvePreview = async () => null;
    await render(
      <InlineMedia path="voice.wav" kind="audio" sessionId="session" sessionMainRootId="new" />,
    );
    expect(paused).toBe(1);
    expect(released).toEqual([preview().url]);
    expect(requests.at(-1)?.rootId).toBe("new");
    expect(players()).toHaveLength(0);
  });

  test("recovers from missing files and playback errors without stale URLs", async () => {
    resolvePreview = async () => null;
    await render(<InlineMedia path="voice.wav" kind="audio" sessionId="session" />);
    expect(players()).toHaveLength(0);
    resolvePreview = async () => preview();
    const retry = () =>
      descendants(container).find(
        (node) => node.tagName === "BUTTON" && propsOf(node).children?.[1] === "重试",
      );
    await act(async () => {
      propsOf(retry()).onClick();
      await flushMicrotasks();
    });
    expect(players()).toHaveLength(1);
    await act(async () => {
      propsOf(players()[0]).onError();
      await flushMicrotasks();
    });
    expect(players()).toHaveLength(0);
    resolvePreview = async () => preview("audio", "fresh");
    await act(async () => {
      propsOf(retry()).onClick();
      await flushMicrotasks();
    });
    expect(released).toEqual([preview().url]);
    expect(propsOf(players()[0]).src).toBe(preview("audio", "fresh").url);
  });

  test("playing another card pauses the previous player", async () => {
    await render(
      <>
        <InlineMedia path="first.wav" kind="audio" sessionId="session" />
        <InlineMedia path="second.wav" kind="audio" sessionId="session" />
      </>,
    );
    const [first, second] = players();
    let paused = 0;
    first.pause = () => {
      paused++;
    };
    second.pause = () => undefined;
    propsOf(first).onPlay({ currentTarget: first });
    propsOf(second).onPlay({ currentTarget: second });
    expect(paused).toBe(1);
  });

  test("keeps external media links ordinary and scrubs raw HTML media", async () => {
    await render(
      <Markdown
        sessionId="session"
        text={
          '[remote](https://example.com/a.mp4)\n\n<video src="file:///private/a.mp4" autoplay onplay="alert(1)"></video>'
        }
      />,
    );
    expect(requests).toEqual([]);
    expect(players()).toHaveLength(0);
    expect(
      descendants(container).some((node) => propsOf(node).href === "https://example.com/a.mp4"),
    ).toBe(true);
  });

  test("degrades remote image-style media embeds to links without fetching them as images", async () => {
    await render(
      <Markdown text="![Remote audio](https://example.com/a.mp3?download=1)" sessionId="session" />,
    );
    expect(requests).toEqual([]);
    expect(players()).toHaveLength(0);
    expect(descendants(container).some((node) => node.tagName === "IMG")).toBe(false);
    expect(
      descendants(container).some(
        (node) => propsOf(node).href === "https://example.com/a.mp3?download=1",
      ),
    ).toBe(true);
  });
});
