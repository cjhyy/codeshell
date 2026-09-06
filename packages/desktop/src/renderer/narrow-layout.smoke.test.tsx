/**
 * Narrow-screen / responsive layout smoke.
 *
 * A genuine pixel-level narrow-screen check needs a real browser (that's a
 * Playwright job a human runs); these are the parts we *can* guard without a
 * DOM: that the layout containers carry the responsive utility classes the
 * narrow layout depends on, that the lightbox keeps image sizing viewport-
 * relative, and that a multi-image user message renders its full thumbnail
 * gallery (the data path that feeds Lightbox prev/next).
 */
import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MessageStream } from "./MessageStream";
import { Lightbox } from "./chat/Lightbox";
import type { Message } from "./types";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";

// A 1x1 transparent PNG data URL — enough for decodeWireForDisplay to keep the
// block (non-empty body) and for the thumbnail <img> to render.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function imageWire(...names: string[]): string {
  return names
    .map((n) => `<codeshell-image name="${n}" mime="image/png">${PNG}</codeshell-image>`)
    .join("\n");
}

describe("narrow layout — responsive utility classes survive", () => {
  test("user bubble caps its width so it doesn't span a narrow viewport", () => {
    const messages: Message[] = [{ kind: "user", id: "u1", text: "hello there" }];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    // The bubble is width-capped (max-w-[80%]) and wraps long words rather than
    // forcing horizontal scroll on a narrow screen.
    expect(html).toContain("max-w-[80%]");
    expect(html).toContain("break-words");
  });
});

describe("narrow layout — multi-image gallery renders fully", () => {
  test("all thumbnails of a multi-image message render", () => {
    const messages: Message[] = [
      { kind: "user", id: "u1", text: imageWire("a.png", "b.png", "c.png") },
    ];
    const html = renderToStaticMarkup(<MessageStream messages={messages} />);
    // Three distinct thumbnails → the gallery the Lightbox cycles through.
    const imgCount = (html.match(/<img/g) ?? []).length;
    expect(imgCount).toBe(3);
    expect(html).toContain('title="a.png"');
    expect(html).toContain('title="c.png"');
    // The flex-wrap container keeps thumbnails from overflowing a narrow width.
    expect(html).toContain("flex-wrap");
  });
});

describe("narrow layout — lightbox", () => {
  test("lightbox image stays viewport-relative so it never exceeds a narrow screen", async () => {
    ensureMiniDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const findImage = (node: Node): HTMLElement | undefined => {
      if ((node as HTMLElement).tagName === "IMG") return node as HTMLElement;
      for (const child of Array.from(node.childNodes)) {
        const found = findImage(child);
        if (found) return found;
      }
      return undefined;
    };
    try {
      await act(async () => {
        root.render(<Lightbox src={PNG} alt="preview.png" onClose={() => {}} />);
        await flushMicrotasks();
      });
      // Dialog content lives in a body portal, outside any transcript size /
      // content-visibility containment. SSR markup cannot inspect that image.
      const image = findImage(document.body);
      expect(image).toBeDefined();
      expect(container.contains(image!)).toBe(false);
      const classes = image!.getAttribute("class");
      expect(classes).toContain("max-h-full");
      expect(classes).toContain("max-w-full");
      expect(classes).toContain("object-contain");
    } finally {
      await act(async () => {
        root.unmount();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      document.body.removeChild(container);
    }
  });

  // The lightbox now has a SINGLE close button (the toolbar one). The old
  // floating `.lightbox-close` (and its <720px declutter media query) were
  // removed — they were the "两个叉" bug. Guard against the dead class coming
  // back.
  test("no dead .lightbox-close rule remains (single close button)", () => {
    const css = readFileSync(join(import.meta.dir, "styles/tailwind.css"), "utf8");
    expect(css).not.toContain("lightbox-close");
  });
});
