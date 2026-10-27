import { afterEach, beforeEach, expect, test } from "bun:test";
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
let matchMediaDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  ensureMiniDom();
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false }),
  });
});

afterEach(async () => {
  await act(async () => {
    mountedRoot?.unmount();
    await flushMicrotasks();
  });
  mountedRoot = null;
  if (matchMediaDescriptor) Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
  else Reflect.deleteProperty(window, "matchMedia");
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

test("Composer keeps text and image drafts after rejection and retries the same File", async () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:composer-preview";
  URL.revokeObjectURL = (url) => revoked.push(url);
  const container = document.createElement("div") as unknown as HTMLElement;
  mountedRoot = createRoot(container);
  let sends = 0;
  const sentAttachments: Array<Array<{ clientId: string; file: File }>> = [];
  try {
    await act(async () => {
      mountedRoot?.render(
        <Composer
          disabled={false}
          running={false}
          onSend={async (input) => {
            sends += 1;
            sentAttachments.push(input.attachments);
            if (sends === 1) throw new Error("socket failed unexpectedly");
            return true;
          }}
          onStop={() => undefined}
        />,
      );
      await flushMicrotasks();
    });

    const file = new File([new Uint8Array([1, 2, 3])], "phone.png", {
      type: "image/png",
    });
    const galleryInput = findElements(container, "INPUT")[0];
    await act(async () => {
      reactPropsOf(galleryInput).onChange({ target: { files: [file], value: "phone.png" } });
      await flushMicrotasks();
    });
    expect(findElements(container, "IMG")).toHaveLength(1);

    const textarea = findElements(container, "TEXTAREA")[0];
    textarea.value = "retry this draft";
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON").at(-1)).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(sends).toBe(1);
    expect(textarea.value).toBe("retry this draft");
    expect(findElements(container, "IMG")).toHaveLength(1);
    expect(revoked).toEqual([]);
    expect(sentAttachments[0]).toHaveLength(1);
    expect(sentAttachments[0]?.[0]?.file).toBe(file);
    expect(reactPropsOf(findElements(container, "BUTTON").at(-1)).disabled).toBe(false);

    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON").at(-1)).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(sends).toBe(2);
    expect(sentAttachments[1]?.[0]?.file).toBe(file);
    expect(revoked).toEqual(["blob:composer-preview"]);
    expect(findElements(container, "IMG")).toHaveLength(0);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test("Composer retains an uncertain message ID across an unsuccessful retry", async () => {
  const container = document.createElement("div") as unknown as HTMLElement;
  mountedRoot = createRoot(container);
  const ids: Array<string | undefined> = [];
  await act(async () => {
    mountedRoot?.render(
      <Composer
        disabled={false}
        running={false}
        conversationKey="session-a"
        onSend={async (input) => {
          ids.push(input.clientMessageId);
          if (ids.length === 1) input.onUncertain?.("uncertain-message");
          return ids.length === 3;
        }}
        onStop={() => undefined}
      />,
    );
    await flushMicrotasks();
  });
  const textarea = findElements(container, "TEXTAREA")[0];
  textarea.value = "retry without duplication";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await act(async () => {
      reactPropsOf(findElements(container, "BUTTON").at(-1)).onClick();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(textarea.value).toBe(attempt < 2 ? "retry without duplication" : "");
  }
  expect(ids).toEqual([undefined, "uncertain-message", "uncertain-message"]);
});

for (const change of ["text", "attachment", "conversation"] as const) {
  test(`Composer starts a new intent after an uncertain submission changes ${change}`, async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:changed-intent";
    URL.revokeObjectURL = () => undefined;
    const container = document.createElement("div") as unknown as HTMLElement;
    mountedRoot = createRoot(container);
    const ids: Array<string | undefined> = [];
    const render = (conversationKey: string) =>
      mountedRoot?.render(
        <Composer
          disabled={false}
          running={false}
          conversationKey={conversationKey}
          onSend={async (input) => {
            ids.push(input.clientMessageId);
            if (ids.length === 1) input.onUncertain?.("previous-intent");
            return false;
          }}
          onStop={() => undefined}
        />,
      );
    try {
      await act(async () => {
        render("session-a");
        await flushMicrotasks();
      });
      const textarea = findElements(container, "TEXTAREA")[0];
      textarea.value = "original intent";
      await act(async () => {
        reactPropsOf(findElements(container, "BUTTON").at(-1)).onClick();
        await flushMicrotasks();
        await flushMicrotasks();
      });
      await act(async () => {
        if (change === "text") textarea.value = "different intent";
        if (change === "conversation") render("session-b");
        if (change === "attachment") {
          reactPropsOf(findElements(container, "INPUT")[0]).onChange({
            target: {
              files: [new File([new Uint8Array([1])], "extra.png", { type: "image/png" })],
              value: "extra.png",
            },
          });
        }
        await flushMicrotasks();
      });
      await act(async () => {
        reactPropsOf(findElements(container, "BUTTON").at(-1)).onClick();
        await flushMicrotasks();
        await flushMicrotasks();
      });
      expect(ids).toEqual([undefined, undefined]);
    } finally {
      await act(async () => {
        mountedRoot?.unmount();
        mountedRoot = null;
      });
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
}
