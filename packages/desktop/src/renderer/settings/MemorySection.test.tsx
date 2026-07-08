import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RendererMemoryEntryFull } from "../../preload/types";
import {
  MemoryEntryBadges,
  buildEditDraft,
  buildPinSaveInput,
  defaultCleanupSelection,
} from "./MemorySection";

describe("MemorySection badges", () => {
  test("renders manual, auto, and dream origins plus use/update counts", () => {
    const html = renderToStaticMarkup(
      <div>
        <MemoryEntryBadges
          entry={{
            name: "manual-entry",
            description: "",
            type: "feedback",
            fileName: "manual.md",
            scope: "user",
            level: "user",
            useCount: 1,
            updateCount: 2,
          }}
        />
        <MemoryEntryBadges
          entry={{
            name: "auto-entry",
            description: "",
            type: "feedback",
            fileName: "auto.md",
            scope: "user",
            level: "user",
            origin: "auto",
            useCount: 3,
            updateCount: 4,
          }}
        />
        <MemoryEntryBadges
          entry={{
            name: "dream-entry",
            description: "",
            type: "feedback",
            fileName: "dream.md",
            scope: "dream",
            level: "project",
            origin: "dream",
            useCount: 5,
            updateCount: 6,
          }}
        />
      </div>,
    );

    expect(html).toContain("手动");
    expect(html).toContain("自动");
    expect(html).toContain("Dream");
    expect(html).toContain("命中 1 次");
    expect(html).toContain("更新 2 次");
    expect(html).toContain("命中 5 次");
    expect(html).toContain("更新 6 次");
  });
});

describe("MemorySection save payload helpers", () => {
  const selected: RendererMemoryEntryFull = {
    id: "mem_selected",
    name: "selected",
    description: "selected description",
    type: "feedback",
    fileName: "selected.md",
    scope: "user",
    level: "user",
    origin: "dream",
    pinned: true,
    useCount: 8,
    updateCount: 3,
    content: "body",
  };

  test("editing a user entry forces origin:manual even when it was dream-owned", () => {
    expect(buildEditDraft(selected, "user", "user", "/repo").origin).toBe("manual");
  });

  test("editing a dream-scope entry preserves dream provenance", () => {
    expect(
      buildEditDraft({ ...selected, scope: "dream" }, "project", "dream", "/repo").origin,
    ).toBe("dream");
  });

  test("pin/unpin payload preserves id and origin", () => {
    const next = buildPinSaveInput(selected, false, "project", "user", "/repo");
    expect(next.id).toBe("mem_selected");
    expect(next.origin).toBe("dream");
    expect(next.pinned).toBe(false);
  });
});

describe("MemorySection legacy cleanup selection", () => {
  test("defaults only origin:auto and unpinned entries", () => {
    const selected = defaultCleanupSelection([
      {
        name: "auto",
        description: "",
        type: "feedback",
        fileName: "auto.md",
        scope: "user",
        level: "user",
        origin: "auto",
      },
      {
        name: "auto-pinned",
        description: "",
        type: "feedback",
        fileName: "auto-pinned.md",
        scope: "user",
        level: "user",
        origin: "auto",
        pinned: true,
      },
      {
        name: "manual",
        description: "",
        type: "feedback",
        fileName: "manual.md",
        scope: "user",
        level: "user",
        origin: "manual",
      },
      {
        name: "dream",
        description: "",
        type: "feedback",
        fileName: "dream.md",
        scope: "dream",
        level: "project",
        origin: "dream",
      },
    ]);

    expect([...selected]).toEqual(["auto.md"]);
  });
});
