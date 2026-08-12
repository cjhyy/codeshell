import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { WebviewHost } from "./WebviewHost";

function findElement(node: unknown, tagName: string): any | null {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (current.tagName === tagName) return current;
  for (const child of current.childNodes ?? []) {
    const match = findElement(child, tagName);
    if (match) return match;
  }
  return null;
}

let root: Root | null = null;
let container: HTMLElement;
const guestRegistrations: unknown[] = [];
const bucketRegistrations: unknown[] = [];

beforeEach(() => {
  ensureMiniDom();
  guestRegistrations.length = 0;
  bucketRegistrations.length = 0;
  Object.assign(window, {
    codeshell: {
      registerBrowserSessionBucket: (input: unknown) => bucketRegistrations.push(input),
      registerBrowserGuest: (input: unknown) => guestRegistrations.push(input),
    },
  });
  container = document.createElement("div") as unknown as HTMLElement;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

describe("WebviewHost readiness", () => {
  test("never asks Electron for a guest id before dom-ready", async () => {
    let idReads = 0;
    let readyEvents = 0;
    await act(async () => {
      root?.render(
        <WebviewHost
          initialUrl="https://example.test"
          bucket="project::session"
          engineSessionId="session-1"
          onDomReady={() => {
            readyEvents += 1;
          }}
        />,
      );
      await flushMicrotasks();
    });

    const view = findElement(container, "WEBVIEW");
    expect(view).not.toBeNull();
    view.getWebContentsId = () => {
      idReads += 1;
      return 42;
    };
    expect(idReads).toBe(0);
    expect(guestRegistrations).toHaveLength(0);

    await act(async () => {
      view.dispatchEvent(new Event("dom-ready"));
      await flushMicrotasks();
    });

    expect(readyEvents).toBe(1);
    expect(idReads).toBe(1);
    expect(guestRegistrations).toEqual([
      {
        guestId: 42,
        bucket: "project::session",
        partition: "persist:browser",
        engineSessionId: "session-1",
      },
    ]);
    expect(bucketRegistrations).toHaveLength(1);
  });
});
