import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ensureMiniDom } from "../test-utils/renderHook";
import { copyText } from "./clipboard";

const restore: Array<() => void> = [];
let textareas: HTMLTextAreaElement[];
let selection: [number, number] | undefined;
let opener: HTMLButtonElement;
let restoredFocusOptions: Array<FocusOptions | undefined>;

function replace(object: object, key: PropertyKey, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  restore.push(() => {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  });
}

beforeEach(() => {
  ensureMiniDom();
  textareas = [];
  selection = undefined;
  restoredFocusOptions = [];
  replace(globalThis, "navigator", {});
  replace(window, "isSecureContext", false);
  replace(document, "execCommand", () => true);
  const previousFocus = document.activeElement;
  restore.push(() => {
    Object.assign(document, { activeElement: previousFocus });
  });

  // Supply only the selection/connection APIs absent from the shared mini DOM.
  // All patched properties are restored per test, without module mocks.
  const createElement = document.createElement;
  replace(document, "createElement", (tag: string) => {
    const element = createElement.call(document, tag);
    if (tag.toLowerCase() === "textarea") {
      const textarea = element as HTMLTextAreaElement;
      textarea.select = () => undefined;
      textarea.setSelectionRange = (start, end) => {
        selection = [start, end];
      };
      textareas.push(textarea);
    }
    return element;
  });
  opener = document.createElement("button");
  document.body.appendChild(opener);
  Object.defineProperty(opener, "isConnected", {
    get: () => document.body.contains(opener),
  });
  opener.focus();
  const focus = opener.focus.bind(opener);
  opener.focus = (options) => {
    restoredFocusOptions.push(options);
    focus(options);
  };
});

afterEach(() => {
  for (const textarea of textareas) {
    textarea.parentNode?.removeChild(textarea);
  }
  opener.parentNode?.removeChild(opener);
  for (const reset of restore.splice(0).reverse()) reset();
});

describe("copyText", () => {
  test("uses a successful secure clipboard write without moving focus or creating a textarea", async () => {
    const written: string[] = [];
    replace(window, "isSecureContext", true);
    replace(navigator, "clipboard", {
      writeText: async (text: string) => written.push(text),
    });
    expect(await copyText("hello clipboard")).toBe(true);
    expect(written).toEqual(["hello clipboard"]);
    expect(textareas).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(restoredFocusOptions).toEqual([]);
  });

  test("falls back after a rejected secure write and restores focus without scrolling", async () => {
    replace(window, "isSecureContext", true);
    replace(navigator, "clipboard", {
      writeText: async () => {
        throw new Error("Permission denied");
      },
    });
    const commands: string[] = [];
    replace(document, "execCommand", (command: string) => {
      commands.push(command);
      expect(document.activeElement).toBe(textareas[0]);
      expect(textareas[0].value).toBe("fallback content");
      return true;
    });
    expect(await copyText("fallback content")).toBe(true);
    expect(commands).toEqual(["copy"]);
    expect(selection).toEqual([0, "fallback content".length]);
    expect(document.body.contains(textareas[0])).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(restoredFocusOptions).toEqual([{ preventScroll: true }]);
  });

  test("an insecure origin uses the fallback without attempting the secure clipboard API", async () => {
    let modernWrites = 0;
    replace(navigator, "clipboard", {
      writeText: async () => {
        modernWrites += 1;
      },
    });
    expect(await copyText("remote mobile content")).toBe(true);
    expect(modernWrites).toBe(0);
    expect(textareas[0].value).toBe("remote mobile content");
    expect(document.activeElement).toBe(opener);
  });

  test("copies the intended text within a modal focus trap and restores its button", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    document.body.removeChild(opener);
    dialog.appendChild(opener);
    restore.push(() => dialog.parentNode?.removeChild(dialog));
    Object.defineProperty(dialog, "isConnected", {
      get: () => document.body.contains(dialog),
    });
    // The shared mini DOM does not support attribute selectors or focusin.
    // Model the browser contracts locally, including the modal's redirection.
    replace(opener, "closest", (selector: string) =>
      selector === '[role="dialog"]' ? dialog : null,
    );
    const createElement = document.createElement;
    replace(document, "createElement", (tag: string) => {
      const element = createElement.call(document, tag);
      if (tag === "textarea") {
        const focus = element.focus.bind(element);
        element.focus = () => {
          focus();
          if (!dialog.contains(element)) opener.focus();
        };
      }
      return element;
    });
    replace(window, "isSecureContext", true);
    replace(navigator, "clipboard", {
      writeText: async () => {
        throw new Error("Permission denied");
      },
    });
    let clipboard = "previous clipboard";
    replace(document, "execCommand", () => {
      // Browsers can report true with no selected text after focus is trapped
      // away. The regression is the clipboard content, not the return value.
      if (document.activeElement === textareas[0]) clipboard = textareas[0].value;
      return true;
    });

    expect(await copyText("/tmp/expected-path.png")).toBe(true);
    expect(clipboard).toBe("/tmp/expected-path.png");
    expect(textareas[0].parentNode).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(restoredFocusOptions).toEqual([{ preventScroll: true }]);
  });

  test.each(["detached dialog", "non-HTML dialog"])(
    "uses the body when the closest dialog is a %s",
    async (kind) => {
      const detached = document.createElement("div");
      Object.defineProperty(detached, "isConnected", { value: false });
      replace(opener, "closest", () =>
        kind === "detached dialog" ? detached : { isConnected: true },
      );
      let copyParent: ParentNode | null = null;
      replace(document, "execCommand", () => {
        copyParent = textareas[0].parentNode;
        return true;
      });
      expect(await copyText("ordinary copy")).toBe(true);
      expect(copyParent).toBe(document.body);
      expect(textareas[0].parentNode).toBeNull();
      expect(document.activeElement).toBe(opener);
    },
  );

  test("reports a denied legacy copy as failure and still removes the temporary field", async () => {
    replace(document, "execCommand", () => false);
    expect(await copyText("denied")).toBe(false);
    expect(document.body.contains(textareas[0])).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(restoredFocusOptions).toEqual([{ preventScroll: true }]);
  });

  test("a thrown legacy copy returns false, cleans up, and restores the original keyboard target", async () => {
    replace(document, "execCommand", () => {
      throw new Error("Unsupported copy command");
    });
    expect(await copyText("unsupported")).toBe(false);
    expect(document.body.contains(textareas[0])).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(restoredFocusOptions).toEqual([{ preventScroll: true }]);
  });

  test("does not refocus an opener removed during the copy operation", async () => {
    replace(document, "execCommand", () => {
      document.body.removeChild(opener);
      return true;
    });
    expect(await copyText("close while copying")).toBe(true);
    expect(document.body.contains(textareas[0])).toBe(false);
    expect(restoredFocusOptions).toEqual([]);
  });
});
