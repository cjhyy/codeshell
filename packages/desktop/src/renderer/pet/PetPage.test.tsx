import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { PetPage } from "./PetPage";

describe("PetPage", () => {
  test("is a standalone work surface without overlay controls", () => {
    const html = renderToStaticMarkup(
      <PetPage>
        <div>world pane</div>
        <div>chat slot</div>
      </PetPage>,
    );

    expect(html).toContain('data-pet-page="standalone"');
    expect(html).toContain('aria-label="Mimi 工作台页面"');
    expect(html).not.toContain('role="separator"');
    expect(html).not.toContain('aria-label="关闭 Mimi 概览"');
    expect(html).toContain("world pane");
    expect(html).toContain("chat slot");
    expect(html).toContain("@container/pet-page");
    expect(html).toContain("<h1");
    expect(html).toContain('data-pet-workspace-layout="split"');
    expect(html).toContain('data-pet-focus-mode="toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("@min-[1100px]/pet-page:overflow-hidden");
  });

  test("collapses narrow-window work into a summary while reserving the chat row", () => {
    const html = renderToStaticMarkup(
      <PetPage runningCount={3} pendingCount={2}>
        <div>work pane</div>
        <div>chat pane</div>
      </PetPage>,
    );

    expect(html).toContain("h-full min-w-0 flex-1 flex-col overflow-hidden");
    expect(html).toContain("grid-rows-[auto_minmax(0,1fr)]");
    expect(html).toContain('data-pet-work-toggle="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("3 项运行中 · 2 项待决定");
    expect(html).toContain("@min-[1100px]/pet-page:grid-rows-1");
    expect(html).toContain("@min-[1100px]/pet-page:overflow-hidden");
  });
});

/** Records the work rail's classes at the moment a child effect would scroll into it. */
function RailProbe({ focus, seen }: { focus: boolean; seen: string[] }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!focus) return;
    let node = ref.current?.parentNode as (Element & { parentNode: unknown }) | null;
    const classes = (element: typeof node) => element?.getAttribute?.("class") ?? "";
    while (node && !classes(node).includes("col-start-2")) {
      node = node.parentNode as typeof node;
    }
    seen.push(node ? classes(node) : "missing");
  }, [focus, seen]);
  return <div ref={ref} />;
}

test("a reveal request unhides the work rail before its children scroll into it", async () => {
  ensureMiniDom();
  const container = document.createElement("div") as unknown as HTMLElement;
  const root = createRoot(container);
  const seen: string[] = [];
  const render = async (reveal: boolean) => {
    await act(async () => {
      root.render(
        <PetPage focusPending={reveal}>
          <RailProbe focus={reveal} seen={seen} />
          <div>chat</div>
        </PetPage>,
      );
      await flushMicrotasks();
    });
  };
  try {
    await render(false);
    const toggle = (function find(node: any): any {
      if (node?.getAttribute?.("data-pet-focus-mode") === "toggle") return node;
      for (const child of Array.from(node?.childNodes ?? [])) {
        const hit = find(child);
        if (hit) return hit;
      }
      return undefined;
    })(container);
    const props = toggle[Object.keys(toggle).find((key) => key.startsWith("__reactProps$"))!];
    await act(async () => {
      props.onClick();
      await flushMicrotasks();
    });
    await render(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("col-start-2");
    expect(seen[0]).not.toContain("@min-[1100px]/pet-page:hidden");
  } finally {
    await act(async () => root.unmount());
  }
});
