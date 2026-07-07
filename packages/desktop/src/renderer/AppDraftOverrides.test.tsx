import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bucketKey } from "./transcripts";

type SendFn = (
  text: string,
  sendOpts?: { bucket?: string; clientMessageId?: string },
) => Promise<void>;

let chatProps: { onSend: SendFn } | null = null;

mock.module("./ChatView", () => ({
  ChatView(props: { onSend: SendFn }) {
    chatProps = props;
    return React.createElement("div");
  },
}));

mock.module("./assets/codeshell-dog-icon.png", () => ({ default: "dog.png" }));

class MemoryLocalStorage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

const localStorageMock = new MemoryLocalStorage();
const runCalls: Array<{ text: string; opts: Record<string, unknown> }> = [];
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreGlobalProperty(
  key: "localStorage" | "window",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: localStorageMock,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    codeshell: {
      platform: "linux",
      log: () => undefined,
      run: async (text: string, opts: Record<string, unknown>) => {
        runCalls.push({ text, opts });
        return { ok: true };
      },
    },
  },
  configurable: true,
  writable: true,
});

const { App } = await import("./App");

describe("App send draft overrides", () => {
  afterAll(() => {
    mock.restore();
    restoreGlobalProperty("localStorage", originalLocalStorageDescriptor);
    restoreGlobalProperty("window", originalWindowDescriptor);
  });

  beforeEach(() => {
    chatProps = null;
    runCalls.length = 0;
    localStorageMock.clear();
  });

  test("first send from a draft reads goal, permission, and model from the draft bucket", async () => {
    const repoId = "repoA";
    const draftBucket = bucketKey(repoId, null);
    localStorageMock.setItem(
      "codeshell.repos",
      JSON.stringify([{ id: repoId, name: "Repo A", path: "/tmp/repo-a", addedAt: 1 }]),
    );
    localStorageMock.setItem("codeshell.activeRepoId", repoId);
    localStorageMock.setItem(
      "codeshell.view",
      JSON.stringify({ viewMode: "chat", sidebarCollapsed: true, inspectorCollapsed: false }),
    );
    localStorageMock.setItem(
      "codeshell.overrides.permission",
      JSON.stringify({ [draftBucket]: "bypass" }),
    );
    localStorageMock.setItem("codeshell.overrides.goal", JSON.stringify({ [draftBucket]: true }));
    localStorageMock.setItem(
      "codeshell.overrides.model",
      JSON.stringify({ [draftBucket]: "draft-model" }),
    );

    renderToStaticMarkup(React.createElement(App));

    expect(chatProps).not.toBeNull();
    await chatProps!.onSend("draft goal");

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.text).toBe("draft goal");
    expect(runCalls[0]!.opts).toMatchObject({
      cwd: "/tmp/repo-a",
      permissionMode: "bypassPermissions",
      goal: "draft goal",
      model: "draft-model",
    });
    expect(typeof runCalls[0]!.opts.sessionId).toBe("string");
  });
});
