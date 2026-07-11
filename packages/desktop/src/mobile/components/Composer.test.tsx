import { afterEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "@/test-utils/renderHook";
import { Composer } from "./Composer";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

let mountedRoot: Root | null = null;

afterEach(async () => {
  await act(async () => {
    mountedRoot?.unmount();
    await flushMicrotasks();
  });
  mountedRoot = null;
});

test("Composer exposes gallery/camera inputs and image-only capable controls", () => {
  const html = renderToStaticMarkup(
    <Composer disabled={false} running={false} onSend={async () => true} onStop={() => {}} />,
  );
  expect(html.match(/type="file"/g)).toHaveLength(2);
  expect(html).toContain('accept="image/*"');
  expect(html).toContain('capture="environment"');
  expect(html).toContain('aria-label="从相册选择图片"');
  expect(html).toContain('aria-label="拍照"');
});

test("Composer synchronously suppresses a repeated send while the first upload is in flight", async () => {
  ensureMiniDom();
  Object.assign(window, {
    matchMedia: () => ({ matches: false }),
  });
  const container = document.createElement("div") as unknown as HTMLElement;
  mountedRoot = createRoot(container);
  let resolveSend!: (sent: boolean) => void;
  const pendingSend = new Promise<boolean>((resolve) => {
    resolveSend = resolve;
  });
  let sends = 0;
  await act(async () => {
    mountedRoot?.render(
      <Composer
        disabled={false}
        running={false}
        onSend={() => {
          sends += 1;
          return pendingSend;
        }}
        onStop={() => undefined}
      />,
    );
    await flushMicrotasks();
  });

  const textarea = findElements(container, "TEXTAREA")[0];
  textarea.value = "send once";
  const sendButton = findElements(container, "BUTTON").at(-1);
  await act(async () => {
    reactPropsOf(sendButton).onClick();
    reactPropsOf(sendButton).onClick();
    await flushMicrotasks();
  });
  expect(sends).toBe(1);

  await act(async () => {
    resolveSend(true);
    await pendingSend;
    await flushMicrotasks();
  });
});
