import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { rememberSearchDialogOpener, resolveSearchOpener } from "./searchFocus";

// App integration suites replace the canonical SearchBar module. Keep their
// stubs intact while testing a separate instance of the real search surface.
const { SearchBar } = await import("./SearchBar?search-focus-handoff");

function inputs(node: Node): HTMLInputElement[] {
  return [
    ...((node as HTMLElement).tagName === "INPUT" ? [node as HTMLInputElement] : []),
    ...Array.from(node.childNodes).flatMap(inputs),
  ];
}

describe("search focus handoff", () => {
  let root: Root;
  let container: HTMLElement;
  let opener: HTMLButtonElement;
  let destination: HTMLButtonElement;
  let activeDescriptor: PropertyDescriptor | undefined;
  let previousFocus: Element | null;
  let dialog: HTMLElement;
  let dialogInput: HTMLInputElement;

  const settle = async () => {
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
  };

  beforeEach(() => {
    ensureMiniDom();
    activeDescriptor = Object.getOwnPropertyDescriptor(document, "activeElement");
    previousFocus = document.activeElement;
    let focused: Element | null = document.body;
    // The mini DOM keeps removed nodes active. Match the browser's fallback to
    // body so these tests exercise the real unmount/return-focus conditions.
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => (focused && document.body.contains(focused) ? focused : document.body),
      set: (element: Element | null) => {
        focused = element;
      },
    });
    opener = document.createElement("button");
    destination = document.createElement("button");
    container = document.createElement("div");
    for (const element of [opener, destination, container]) document.body.appendChild(element);
    Object.defineProperty(opener, "isConnected", {
      get: () => document.body.contains(opener),
    });
    dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialogInput = document.createElement("input");
    dialog.appendChild(dialogInput);
    root = createRoot(container);
    opener.focus();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await settle();
    });
    for (const element of [opener, destination, container, dialog]) {
      element.parentNode?.removeChild(element);
    }
    if (activeDescriptor) Object.defineProperty(document, "activeElement", activeDescriptor);
    else Reflect.deleteProperty(document, "activeElement");
    Object.assign(document, { activeElement: previousFocus });
  });

  const render = async (inlineOpen: boolean) => {
    await act(async () => {
      root.render(
        <SearchBar
          open={inlineOpen}
          value=""
          onChange={() => {}}
          onClose={() => {}}
          matchCount={0}
        />,
      );
      await settle();
    });
    await act(settle);
  };

  const openDialog = () => {
    document.body.appendChild(dialog);
    rememberSearchDialogOpener(dialog, resolveSearchOpener(document.activeElement));
    dialogInput.focus();
  };

  test("direct inline search returns focus to its opener", async () => {
    await render(true);
    const input = inputs(container)[0];
    expect(input).toBeDefined();
    expect(document.activeElement === input).toBe(true);
    await render(false);
    expect(document.activeElement === opener).toBe(true);
  });

  test("dialog to inline search retains the original opener after the dialog unmounts", async () => {
    openDialog();
    await render(true);
    dialog.parentNode?.removeChild(dialog);
    const input = inputs(container)[0];
    expect(input).toBeDefined();
    expect(document.activeElement === input).toBe(true);
    await render(false);
    expect(document.activeElement === opener).toBe(true);
  });

  test("closing inline search does not take focus from a newly selected surface", async () => {
    openDialog();
    await render(true);
    dialog.parentNode?.removeChild(dialog);
    destination.focus();
    await render(false);
    expect(document.activeElement === destination).toBe(true);
  });

  test("an opener removed during the search is not focused on close", async () => {
    openDialog();
    await render(true);
    dialog.parentNode?.removeChild(dialog);
    opener.parentNode?.removeChild(opener);
    await render(false);
    expect(document.activeElement === document.body).toBe(true);
  });

  test("unregistered dialogs retain their own focus target", () => {
    document.body.appendChild(dialog);
    dialogInput.focus();
    expect(resolveSearchOpener(document.activeElement) === dialogInput).toBe(true);
  });

  test("a dialog opened without a return target does not pass on its temporary input", () => {
    document.body.appendChild(dialog);
    rememberSearchDialogOpener(dialog, null);
    dialogInput.focus();
    expect(resolveSearchOpener(document.activeElement)).toBeNull();
  });
});
