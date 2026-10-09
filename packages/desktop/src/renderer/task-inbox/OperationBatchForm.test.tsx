import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  OperationBatchInput,
  OperationBatchOptions,
  OperationBatchResult,
} from "../../shared/operation-batch";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { OperationBatchForm } from "./OperationBatchForm";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function descendants(node: Element): Element[] {
  return [node, ...Array.from(node.children).flatMap(descendants)];
}

// The repository's mini-DOM does not implement browser event propagation or
// constraint validation. Drive the real mounted React handlers and inspect
// their rendered required/disabled attributes; native validation needs E2E.
function props(node: Element): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? (node as any)[key] : {};
}

function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? (node as Text).data ?? node.textContent ?? "";
  return node.childNodes.length
    ? Array.from(node.childNodes).map(textOf).join("")
    : (node.textContent ?? "");
}

const savedConnections: OperationBatchOptions = {
  connections: [
    { id: "saved-connection-a", label: "Saved account A" },
    { id: "saved-connection-b", label: "Saved account B" },
  ],
};

describe("OperationBatchForm", () => {
  let root: Root;
  let container: HTMLElement;
  let bridgeBefore: PropertyDescriptor | undefined;
  let storageBefore: PropertyDescriptor | undefined;
  let optionRequests: Array<{
    sessionId: string;
    request: ReturnType<typeof deferred<OperationBatchOptions>>;
  }>;
  let startRequests: Array<{
    input: OperationBatchInput;
    request: ReturnType<typeof deferred<OperationBatchResult>>;
  }>;
  let unexpectedBridgeReads: string[];

  beforeEach(() => {
    ensureMiniDom();
    bridgeBefore = Object.getOwnPropertyDescriptor(window, "codeshell");
    storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => "en" },
    });
    optionRequests = [];
    startRequests = [];
    unexpectedBridgeReads = [];
    Object.defineProperty(window, "codeshell", {
      configurable: true,
      value: new Proxy(
        {
          operationBatch: {
            options: (sessionId: string) => {
              const request = deferred<OperationBatchOptions>();
              optionRequests.push({ sessionId, request });
              return request.promise;
            },
            start: (input: OperationBatchInput) => {
              const request = deferred<OperationBatchResult>();
              startRequests.push({ input: structuredClone(input), request });
              return request.promise;
            },
          },
        },
        {
          get: (target, key, receiver) => {
            if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
            unexpectedBridgeReads.push(String(key));
            throw new Error(`Unexpected bridge access: ${String(key)}`);
          },
        },
      ),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    document.body.removeChild(container);
    if (bridgeBefore) Object.defineProperty(window, "codeshell", bridgeBefore);
    else Reflect.deleteProperty(window, "codeshell");
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
    expect(unexpectedBridgeReads).toEqual([]);
  });

  const settle = async (action: () => void) => {
    await act(async () => {
      action();
      await flushMicrotasks();
    });
  };
  // TaskInboxPage keys the form by Session, so switching cards cannot reuse a draft.
  const render = (sessionId = "session-a") =>
    settle(() => root.render(<OperationBatchForm key={sessionId} sessionId={sessionId} />));
  const nodes = () => descendants(container);
  const find = (predicate: (node: Element) => boolean) => {
    const node = nodes().find(predicate);
    expect(node).toBeDefined();
    return node!;
  };
  const button = (text: string) =>
    find((node) => node.tagName === "BUTTON" && textOf(node) === text);
  const form = () => find((node) => node.tagName === "FORM");
  const select = () => find((node) => node.tagName === "SELECT");
  const fields = () => nodes().filter((node) => node.tagName === "FIELDSET");
  const field = (index: number, key: string) =>
    find((node) => props(node)["aria-label"] === `${index} ${key}`);
  const change = (node: Element, value: string) =>
    settle(() => props(node).onChange({ target: { value } }));
  const click = (node: Element) => settle(() => props(node).onClick());
  const submit = () => settle(() => props(form()).onSubmit({ preventDefault() {} }));
  const open = async (sessionId = "session-a") => {
    await render(sessionId);
    await click(button("Create Issue batch"));
    await settle(() => optionRequests.at(-1)!.request.resolve(savedConnections));
  };
  const authorItem = async (index: number, suffix: string, body = "") => {
    await change(field(index, "owner"), `owner-${suffix}`);
    await change(field(index, "repo"), `repo-${suffix}`);
    await change(field(index, "title"), `Title ${suffix}`);
    await change(field(index, "body"), body);
  };

  test("loads eligible connections only when opened and requires an explicit connection choice", async () => {
    await render();
    await settle(() => undefined);
    expect(optionRequests).toEqual([]);
    expect(startRequests).toEqual([]);
    expect(nodes().some((node) => node.tagName === "FORM")).toBe(false);

    const openButton = button("Create Issue batch");
    await settle(() => {
      props(openButton).onClick();
      props(openButton).onClick();
    });
    expect(optionRequests.map(({ sessionId }) => sessionId)).toEqual(["session-a"]);
    expect(props(openButton).disabled).toBe(true);
    expect(props(select()).disabled).toBe(true);
    expect(props(button("Review with Native confirmation")).disabled).toBe(true);

    await settle(() => optionRequests[0]!.request.resolve(savedConnections));
    expect(props(select()).value).toBe("");
    expect(props(select()).required).toBe(true);
    expect(
      nodes()
        .filter((node) => node.tagName === "OPTION")
        .map((node) => ({ value: props(node).value, text: textOf(node) })),
    ).toEqual([
      { value: "", text: "Select a connection" },
      { value: "saved-connection-a", text: "Saved account A" },
      { value: "saved-connection-b", text: "Saved account B" },
    ]);
    expect(props(button("Review with Native confirmation")).disabled).toBe(true);
    expect(startRequests).toEqual([]);
  });

  test("requires manually authored owner, repo and title and preserves the entered body in the preload request", async () => {
    await open();
    for (const key of ["owner", "repo", "title"]) {
      expect(props(field(1, key)).value).toBe("");
      expect(props(field(1, key)).required).toBe(true);
    }
    expect(props(field(1, "body")).value).toBe("");
    expect(props(field(1, "body")).required).not.toBe(true);
    expect(startRequests).toEqual([]);

    const body = "  User-authored context\n\n- Keep these lines\n末行  ";
    await authorItem(1, "first", body);
    expect(props(button("Review with Native confirmation")).disabled).toBe(true);
    await change(select(), "saved-connection-b");
    expect(props(button("Review with Native confirmation")).disabled).toBe(false);
    await submit();
    expect(startRequests.map(({ input }) => input)).toEqual([
      {
        sessionId: "session-a",
        connectionId: "saved-connection-b",
        items: [{ owner: "owner-first", repo: "repo-first", title: "Title first", body }],
      },
    ]);
    await settle(() => startRequests[0]!.request.resolve({ status: "cancelled" }));
  });

  test("exposes one to eight items and preserves the remaining authored values when an item is removed", async () => {
    await open();
    expect(fields()).toHaveLength(1);
    expect(
      nodes().some((node) => node.tagName === "BUTTON" && textOf(node) === "Remove item"),
    ).toBe(false);
    await authorItem(1, "first");
    for (let count = 1; count < 8; count += 1) await click(button("Add item"));
    expect(fields()).toHaveLength(8);
    expect(props(button("Add item")).disabled).toBe(true);
    await authorItem(2, "second");
    await authorItem(3, "third", "third body");
    const secondRemove = descendants(fields()[1]!).find(
      (node) => node.tagName === "BUTTON" && textOf(node) === "Remove item",
    );
    expect(secondRemove).toBeDefined();
    await click(secondRemove!);
    expect(fields()).toHaveLength(7);
    expect(props(button("Add item")).disabled).toBe(false);
    expect(props(field(1, "title")).value).toBe("Title first");
    expect(props(field(2, "title")).value).toBe("Title third");
    expect(props(field(2, "body")).value).toBe("third body");

    while (fields().length > 1) {
      const lastRemove = descendants(fields().at(-1)!).find(
        (node) => node.tagName === "BUTTON" && textOf(node) === "Remove item",
      );
      await click(lastRemove!);
    }
    expect(fields()).toHaveLength(1);
    expect(props(field(1, "title")).value).toBe("Title first");
    expect(
      nodes().some((node) => node.tagName === "BUTTON" && textOf(node) === "Remove item"),
    ).toBe(false);
    expect(startRequests).toEqual([]);
  });

  test("sends one pending start, disables editing and reports cancelled and started Native results", async () => {
    await open();
    await change(select(), "saved-connection-a");
    await authorItem(1, "first", "body");
    const formNode = form();
    await settle(() => {
      props(formNode).onSubmit({ preventDefault() {} });
      props(formNode).onSubmit({ preventDefault() {} });
    });
    await submit();
    expect(startRequests).toHaveLength(1);
    expect(props(select()).disabled).toBe(true);
    expect(fields().every((node) => props(node).disabled === true)).toBe(true);
    for (const label of ["Create Issue batch", "Add item", "Review with Native confirmation"]) {
      expect(props(button(label)).disabled).toBe(true);
    }
    await settle(() => startRequests[0]!.request.resolve({ status: "cancelled" }));
    expect(textOf(find((node) => props(node).role === "status"))).toBe(
      "Cancelled. No batch started.",
    );
    expect(props(button("Review with Native confirmation")).disabled).toBe(false);
    expect(props(field(1, "title")).value).toBe("Title first");
    expect(startRequests).toHaveLength(1);

    await submit();
    expect(startRequests).toHaveLength(2);
    await settle(() => startRequests[1]!.request.resolve({ status: "started", count: 1 }));
    expect(textOf(find((node) => props(node).role === "status"))).toBe(
      "1 fixed items submitted. Each still requires write approval; follow the Session and activity records.",
    );
    expect(startRequests).toHaveLength(2);
    expect(optionRequests).toHaveLength(1);
  });

  test("a Session key change drops the prior draft, connection and late start notice", async () => {
    await open("session-a");
    await change(select(), "saved-connection-b");
    await authorItem(1, "old", "old Session body");
    await click(button("Add item"));
    await authorItem(2, "old-second", "second old body");
    await render("session-a");
    expect(fields()).toHaveLength(2);
    expect(props(field(1, "body")).value).toBe("old Session body");
    await submit();
    expect(startRequests[0]!.input.sessionId).toBe("session-a");

    await render("session-b");
    expect(nodes().some((node) => node.tagName === "FORM")).toBe(false);
    expect(optionRequests.map(({ sessionId }) => sessionId)).toEqual(["session-a"]);
    await settle(() => startRequests[0]!.request.resolve({ status: "started", count: 2 }));
    expect(nodes().some((node) => props(node).role === "status")).toBe(false);
    await click(button("Create Issue batch"));
    expect(optionRequests.map(({ sessionId }) => sessionId)).toEqual(["session-a", "session-b"]);
    await settle(() => optionRequests[1]!.request.resolve(savedConnections));
    expect(fields()).toHaveLength(1);
    expect(props(select()).value).toBe("");
    for (const key of ["owner", "repo", "title", "body"]) {
      expect(props(field(1, key)).value).toBe("");
    }
    expect(props(button("Review with Native confirmation")).disabled).toBe(true);
    expect(textOf(container)).not.toContain("old Session body");
    expect(startRequests).toHaveLength(1);

    await change(select(), "saved-connection-a");
    await authorItem(1, "new", "new Session body");
    await submit();
    expect(startRequests[1]!.input).toEqual({
      sessionId: "session-b",
      connectionId: "saved-connection-a",
      items: [
        {
          owner: "owner-new",
          repo: "repo-new",
          title: "Title new",
          body: "new Session body",
        },
      ],
    });
    await settle(() => startRequests[1]!.request.resolve({ status: "cancelled" }));
  });
});
