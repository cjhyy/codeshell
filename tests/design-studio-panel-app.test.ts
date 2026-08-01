import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANEL_APP_MANIFEST_FILE,
  PanelAppManifest,
  installReviewedLocalPanelApp,
  listInstalledPanelApps,
  previewLocalPanelApp,
} from "../packages/core/src/panel-apps/index.js";
import {
  alignNodeTrees,
  alignNodes,
  detachNodeFromParent,
  descendantIds,
  distributeNodeTrees,
  distributeNodes,
  moveSelectedNodes,
  normalizeNodeTreeOrder,
  pointInRotatedBounds,
  pointFromParentSpace,
  pointToParentSpace,
  releaseFrame,
  reparentNode,
  selectionBounds,
  rotateVector,
  snapBoundsToNodes,
  setNodeTreePosition,
  snapValue,
  transformedNodeBounds,
  transformNodeBetweenParents,
  visualSelectionBounds,
  wrapNodesInFrame,
} from "../examples/panel-apps/design-studio/app/geometry.mjs";
import {
  assertDesignDocumentSize,
  effectiveDesignNodeOpacity,
  exportDesignSvg,
  isSafeDesignPath,
  isDesignNodeVisible,
  MAX_DESIGN_DOCUMENT_BYTES,
  MAX_DESIGN_NODES,
  MAX_SVG_EXPORT_BYTES,
  normalizeDesignDocument,
  replaceDesignColor,
  serializeDesignDocument,
  workspaceVersionChanged,
} from "../examples/panel-apps/design-studio/app/document.mjs";
import {
  auditDesign,
  auditMarkdown,
  contrastRatio,
} from "../examples/panel-apps/design-studio/app/audit.mjs";
import {
  inspectDesignSource,
  isDesignPreviewCurrent,
} from "../examples/panel-apps/design-studio/app/tools/check-design.mjs";
import {
  applyAutoLayout,
  createComponentInstance,
} from "../examples/panel-apps/design-studio/app/layout.mjs";

const ROOT = join(import.meta.dir, "..", "examples", "panel-apps", "design-studio");
const REQUIRED_NODE_FIELDS = {
  stroke: "transparent",
  strokeWidth: 0,
  opacity: 1,
  rotation: 0,
  cornerRadius: 0,
  visible: true,
  locked: false,
};

describe("design-studio geometry", () => {
  test("computes selection bounds and aligns one or many nodes", () => {
    const nodes = [
      { id: "a", x: 20, y: 10, width: 30, height: 20 },
      { id: "b", x: 90, y: 50, width: 10, height: 30 },
    ];
    expect(selectionBounds(nodes)).toEqual({ x: 20, y: 10, width: 80, height: 70 });
    expect(alignNodes(nodes, "left", { width: 200, height: 100 })).toBe(true);
    expect(nodes.map((node) => node.x)).toEqual([20, 20]);
    expect(alignNodes([nodes[0]], "bottom", { width: 200, height: 100 })).toBe(true);
    expect(nodes[0].y).toBe(80);
    expect([snapValue(13), snapValue(-13), snapValue(13, 0)]).toEqual([16, -16, 13]);
    expect(
      descendantIds(
        [
          { id: "frame" },
          { id: "child", parentId: "frame" },
          { id: "grandchild", parentId: "child" },
        ],
        new Set(["frame"]),
      ),
    ).toEqual(new Set(["child", "grandchild"]));
  });

  test("snaps moving bounds to nearby layer edges and centers with deterministic guides", () => {
    const snapped = snapBoundsToNodes(
      { x: 0, y: 0, width: 40, height: 20 },
      [
        { id: "card", x: 100, y: 80, width: 60, height: 40 },
        { id: "footer", x: 20, y: 200, width: 200, height: 40 },
      ],
      { x: 57, y: 61 },
      4,
    );
    expect(snapped).toEqual({
      x: 60,
      y: 60,
      guides: [
        { axis: "x", value: 100, targetId: "card" },
        { axis: "y", value: 80, targetId: "card" },
      ],
    });
    expect(
      snapBoundsToNodes(
        { x: 0, y: 0, width: 10, height: 10 },
        [{ id: "far", x: 100, y: 100, width: 10, height: 10 }],
        { x: 20, y: 20 },
        2,
      ).guides,
    ).toEqual([]);
  });

  test("hit-tests rotated frames in their visual coordinate space", () => {
    const frame = { x: 0, y: 0, width: 100, height: 50, rotation: 90 };
    expect(pointInRotatedBounds(frame, { x: 50, y: -10 })).toBe(true);
    expect(pointInRotatedBounds(frame, { x: 10, y: 10 })).toBe(false);
    expect(pointInRotatedBounds(frame, { x: Number.NaN, y: 10 })).toBe(false);
    expect(rotateVector({ x: 10, y: 0 }, -90).x).toBeCloseTo(0, 8);
    expect(rotateVector({ x: 10, y: 0 }, -90).y).toBeCloseTo(-10, 8);
    const localPoint = pointToParentSpace({ x: 50, y: -10 }, frame);
    expect(localPoint.x).toBeCloseTo(15, 8);
    expect(localPoint.y).toBeCloseTo(25, 8);
    const visualPoint = pointFromParentSpace(localPoint, frame);
    expect(visualPoint.x).toBeCloseTo(50, 8);
    expect(visualPoint.y).toBeCloseTo(-10, 8);
    expect(transformedNodeBounds(frame)).toEqual({
      x: 25,
      y: -25,
      width: 50,
      height: 100,
    });
    const nodes = [
      { id: "frame", x: 0, y: 0, width: 100, height: 50, rotation: 90 },
      {
        id: "child",
        parentId: "frame",
        x: 20,
        y: 10,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ];
    expect(visualSelectionBounds(nodes, nodes)).toEqual({
      x: 25,
      y: -25,
      width: 50,
      height: 100,
    });
  });

  test("distributes gaps and moves selected layers without scrambling their order", () => {
    const nodes = [
      { id: "a", x: 0, y: 0, width: 10, height: 10 },
      { id: "b", x: 30, y: 0, width: 20, height: 10 },
      { id: "c", x: 100, y: 0, width: 10, height: 10 },
    ];
    expect(distributeNodes(nodes, "horizontal")).toBe(true);
    expect(nodes.map((node) => node.x)).toEqual([0, 45, 100]);

    const layers = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(moveSelectedNodes(layers, new Set(["b", "c"]), "up")).toBe(true);
    expect(layers.map((node) => node.id)).toEqual(["a", "d", "b", "c"]);
    expect(moveSelectedNodes(layers, new Set(["b", "c"]), "down")).toBe(true);
    expect(layers.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);

    const nested = [
      { id: "frame" },
      { id: "child-a", parentId: "frame" },
      { id: "child-b", parentId: "frame" },
    ];
    expect(moveSelectedNodes(nested, new Set(["child-a"]), "down")).toBe(false);
    expect(moveSelectedNodes(nested, new Set(["child-a"]), "up")).toBe(true);
    expect(nested.map((node) => node.id)).toEqual(["frame", "child-b", "child-a"]);

    const secondFrame = { id: "frame-2", type: "frame" };
    nested.push(secondFrame);
    expect(reparentNode(nested, "child-a", "frame-2")).toBe(true);
    expect(nested.map((node) => node.id)).toEqual(["frame", "child-b", "frame-2", "child-a"]);
    expect(nested.at(-1).parentId).toBe("frame-2");

    const interleaved = [
      { id: "frame-a", type: "frame" },
      { id: "frame-b", type: "frame" },
      { id: "child-a", parentId: "frame-a" },
    ];
    expect(normalizeNodeTreeOrder(interleaved)).toBe(true);
    expect(interleaved.map((node) => node.id)).toEqual(["frame-a", "child-a", "frame-b"]);
    expect(normalizeNodeTreeOrder(interleaved)).toBe(false);
  });

  test("reparents across rotated frames without moving the visual geometry", () => {
    const nodes = [
      { id: "left", type: "frame", x: 0, y: 0, width: 100, height: 60, rotation: 30 },
      {
        id: "child",
        type: "rectangle",
        parentId: "left",
        x: 20,
        y: 10,
        width: 30,
        height: 20,
        rotation: 15,
      },
      { id: "right", type: "frame", x: 180, y: 40, width: 120, height: 90, rotation: -20 },
    ];
    const before = transformedNodeBounds(nodes[1], nodes[0]);
    expect(reparentNode(nodes, "child", "right")).toBe(true);
    const child = nodes.find((node) => node.id === "child");
    expect(child.parentId).toBe("right");
    expect(child.rotation).toBe(65);
    const after = transformedNodeBounds(child, nodes[1]);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    expect(after.width).toBeCloseTo(before.width, 1);
    expect(after.height).toBeCloseTo(before.height, 1);

    const extreme = {
      id: "extreme",
      type: "rectangle",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      rotation: 350,
    };
    expect(
      transformNodeBetweenParents(
        extreme,
        { x: 0, y: 0, width: 100, height: 100, rotation: 350 },
        { x: 200, y: 0, width: 100, height: 100, rotation: -350 },
      ),
    ).toBe(true);
    expect(extreme.rotation).toBe(-30);
    const detached = {
      id: "detached",
      type: "rectangle",
      parentId: "old",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      rotation: 0,
      opacity: 0.8,
      visible: true,
    };
    expect(
      detachNodeFromParent(detached, {
        id: "old",
        type: "frame",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        rotation: 90,
        opacity: 0.5,
        visible: false,
      }),
    ).toBe(true);
    expect(detached.parentId).toBeUndefined();
    expect(detached).toMatchObject({ rotation: 90, opacity: 0.4, visible: false });
  });

  test("wraps ordinary layers in a stable frame block without changing relative coordinates", () => {
    const nodes = [
      { id: "background", type: "rectangle", x: 0, y: 0, width: 400, height: 300 },
      { id: "title", type: "text", x: 80, y: 60, width: 120, height: 30 },
      { id: "divider", type: "rectangle", x: 20, y: 130, width: 360, height: 1 },
      { id: "body", type: "text", x: 100, y: 100, width: 180, height: 40 },
    ];
    const frame = { id: "frame-selection", type: "frame" };
    expect(wrapNodesInFrame(nodes, new Set(["title", "body"]), frame, 20)).toBe(true);
    expect(frame).toMatchObject({ x: 60, y: 40, width: 240, height: 120 });
    expect(nodes.map((node) => node.id)).toEqual([
      "background",
      "frame-selection",
      "title",
      "body",
      "divider",
    ]);
    expect(nodes.slice(2, 4).map((node) => node.parentId)).toEqual([
      "frame-selection",
      "frame-selection",
    ]);
    expect(
      wrapNodesInFrame(nodes, new Set(["frame-selection"]), {
        id: "nested",
        type: "frame",
      }),
    ).toBe(false);
    expect(
      wrapNodesInFrame(nodes, new Set(["title"]), {
        id: "nested-child",
        type: "frame",
      }),
    ).toBe(false);

    expect(releaseFrame(nodes, "frame-selection")).toBe(true);
    expect(nodes.map((node) => node.id)).toEqual(["background", "title", "body", "divider"]);
    expect(
      nodes
        .filter((node) => node.id === "title" || node.id === "body")
        .map((node) => node.parentId),
    ).toEqual([undefined, undefined]);

    const rotated = [
      {
        id: "rotated-frame",
        type: "frame",
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        rotation: 90,
        opacity: 0.5,
        visible: true,
      },
      {
        id: "rotated-child",
        type: "rectangle",
        parentId: "rotated-frame",
        x: 20,
        y: 10,
        width: 30,
        height: 20,
        rotation: 15,
        opacity: 0.8,
        visible: true,
      },
    ];
    const visualBeforeRelease = transformedNodeBounds(rotated[1], rotated[0]);
    expect(releaseFrame(rotated, "rotated-frame")).toBe(true);
    expect(transformedNodeBounds(rotated[0]).x).toBeCloseTo(visualBeforeRelease.x, 1);
    expect(transformedNodeBounds(rotated[0]).y).toBeCloseTo(visualBeforeRelease.y, 1);
    expect(rotated[0]).toMatchObject({
      id: "rotated-child",
      rotation: 105,
      opacity: 0.4,
      visible: true,
    });
    expect(rotated[0].parentId).toBeUndefined();
  });

  test("reorders a frame and its descendants as one reviewable layer block", () => {
    const nodes = [
      { id: "frame-a", type: "frame" },
      { id: "child-a", type: "rectangle", parentId: "frame-a" },
      { id: "frame-b", type: "frame" },
      { id: "child-b", type: "rectangle", parentId: "frame-b" },
      { id: "root-copy", type: "text" },
    ];
    expect(moveSelectedNodes(nodes, new Set(["frame-a"]), "up")).toBe(true);
    expect(nodes.map((node) => node.id)).toEqual([
      "frame-b",
      "child-b",
      "frame-a",
      "child-a",
      "root-copy",
    ]);
    expect(moveSelectedNodes(nodes, new Set(["frame-a"]), "down")).toBe(true);
    expect(nodes.map((node) => node.id)).toEqual([
      "frame-a",
      "child-a",
      "frame-b",
      "child-b",
      "root-copy",
    ]);
  });

  test("keeps frame descendants attached across inspector, alignment, and distribution moves", () => {
    const nodes = [
      { id: "frame-a", type: "frame", x: 10, y: 20, width: 100, height: 100 },
      {
        id: "child-a",
        type: "rectangle",
        parentId: "frame-a",
        x: 24,
        y: 42,
        width: 10,
        height: 10,
      },
      { id: "frame-b", type: "frame", x: 180, y: 20, width: 100, height: 100 },
      {
        id: "child-b",
        type: "rectangle",
        parentId: "frame-b",
        x: 194,
        y: 42,
        width: 10,
        height: 10,
      },
      { id: "frame-c", type: "frame", x: 420, y: 20, width: 100, height: 100 },
      {
        id: "child-c",
        type: "rectangle",
        parentId: "frame-c",
        x: 434,
        y: 42,
        width: 10,
        height: 10,
      },
    ];

    expect(setNodeTreePosition(nodes, "frame-a", "x", 30)).toBe(true);
    expect([nodes[0].x, nodes[1].x]).toEqual([30, 44]);
    expect(alignNodeTrees(nodes, new Set(["frame-a"]), "bottom", { width: 600, height: 300 })).toBe(
      true,
    );
    expect([nodes[0].y, nodes[1].y]).toEqual([200, 222]);

    expect(
      distributeNodeTrees(
        nodes,
        new Set(["frame-a", "child-a", "frame-b", "frame-c"]),
        "horizontal",
      ),
    ).toBe(true);
    expect(nodes[1].x - nodes[0].x).toBe(14);
    expect(nodes[3].x - nodes[2].x).toBe(14);
    expect(nodes[5].x - nodes[4].x).toBe(14);
  });

  test("aligns one child to its containing frame instead of the global canvas", () => {
    const nodes = [
      { id: "frame", type: "frame", x: 100, y: 80, width: 300, height: 200 },
      {
        id: "child",
        type: "rectangle",
        parentId: "frame",
        x: 150,
        y: 120,
        width: 40,
        height: 30,
      },
    ];
    expect(alignNodeTrees(nodes, new Set(["child"]), "right", { width: 1000, height: 800 })).toBe(
      true,
    );
    expect(nodes[1].x).toBe(360);
    expect(alignNodeTrees(nodes, new Set(["child"]), "bottom", { width: 1000, height: 800 })).toBe(
      true,
    );
    expect(nodes[1].y).toBe(250);
  });

  test("aligns and distributes rotated trees by their visual bounds", () => {
    const nodes = [
      { id: "frame", type: "frame", x: 0, y: 0, width: 100, height: 50, rotation: 90 },
      {
        id: "frame-child",
        type: "rectangle",
        parentId: "frame",
        x: 20,
        y: 10,
        width: 10,
        height: 10,
        rotation: 0,
      },
    ];
    expect(alignNodeTrees(nodes, new Set(["frame"]), "left", { width: 300, height: 200 })).toBe(
      true,
    );
    expect(transformedNodeBounds(nodes[0]).x).toBe(0);
    expect(nodes[1].x - nodes[0].x).toBe(20);

    const childLocalYBefore = nodes[1].y;
    expect(
      alignNodeTrees(nodes, new Set(["frame-child"]), "right", { width: 300, height: 200 }),
    ).toBe(true);
    const childAfter = transformedNodeBounds(nodes[1], nodes[0]);
    const frameBounds = transformedNodeBounds(nodes[0]);
    expect(childAfter.x + childAfter.width).toBeCloseTo(frameBounds.x + frameBounds.width, 2);
    expect(nodes[1].y).not.toBe(childLocalYBefore);

    const distributed = [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 30, height: 10, rotation: 30 },
      { id: "b", type: "rectangle", x: 90, y: 0, width: 20, height: 20, rotation: 45 },
      { id: "c", type: "rectangle", x: 220, y: 0, width: 40, height: 10, rotation: -20 },
    ];
    expect(distributeNodeTrees(distributed, new Set(["a", "b", "c"]), "horizontal")).toBe(true);
    const bounds = distributed.map((node) => transformedNodeBounds(node));
    const firstGap = bounds[1].x - (bounds[0].x + bounds[0].width);
    const secondGap = bounds[2].x - (bounds[1].x + bounds[1].width);
    expect(firstGap).toBeCloseTo(secondGap, 1);
  });
});

describe("design-studio repository output", () => {
  const textNode = {
    id: "text<&",
    type: "text",
    name: "Copy",
    parentId: "frame",
    x: 12,
    y: 16,
    width: 80,
    height: 24,
    fill: "#171717",
    stroke: "transparent",
    strokeWidth: 0,
    opacity: 1,
    rotation: 0,
    cornerRadius: 0,
    visible: true,
    locked: false,
    text: "A&B <safe>",
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 1.2,
    textAlign: "left",
  };
  const document = {
    format: "codeshell.design",
    version: 1,
    name: "Output",
    canvas: { width: 120, height: 100, background: "#ffffff" },
    tokens: { colors: [] },
    nodes: [
      {
        id: "frame",
        type: "frame",
        name: "Frame",
        x: 0,
        y: 0,
        width: 120,
        height: 100,
        fill: "#ffffff",
        stroke: "transparent",
        strokeWidth: 0,
        opacity: 1,
        rotation: 0,
        cornerRadius: 0,
        visible: false,
        locked: false,
        clipContent: true,
      },
      textNode,
    ],
  };

  test("serializes stable reviewable JSON with a trailing newline", () => {
    const normalized = normalizeDesignDocument({
      ...structuredClone(document),
      canvas: { ...document.canvas, background: "#FFFFFF" },
    });
    const serialized = serializeDesignDocument(normalized);
    expect(serialized).toEndWith("\n");
    expect(serializeDesignDocument(JSON.parse(serialized))).toBe(serialized);
    expect(() =>
      normalizeDesignDocument({ ...structuredClone(document), extra: "discarded" }),
    ).toThrow(/未知字段/);
    expect(normalized.canvas.background).toBe("#ffffff");
    expect(isSafeDesignPath("designs/产品/首页 v2.codesign.json")).toBe(true);
    expect(isSafeDesignPath("designs/../secret.codesign.json")).toBe(false);
    expect(isSafeDesignPath("designs/NODE_MODULES/secret.codesign.json")).toBe(false);
    expect(isSafeDesignPath("designs/C:/secret.codesign.json")).toBe(false);
    expect(isSafeDesignPath("designs/CON.codesign.json")).toBe(false);
    expect(isSafeDesignPath("designs/LPT9.preview.codesign.json")).toBe(false);
    expect(isSafeDesignPath("designs/trailing./secret.codesign.json")).toBe(false);
    expect(isSafeDesignPath("designs/trailing /secret.codesign.json")).toBe(false);
    const inspection = inspectDesignSource(serialized, "designs/output.codesign.json");
    expect(inspection.isCanonical).toBe(true);
    expect(inspection.document.nodes).toHaveLength(2);
    const preview = exportDesignSvg(inspection.document);
    expect(isDesignPreviewCurrent(inspection.document, preview)).toBe(true);
    expect(isDesignPreviewCurrent(inspection.document, `${preview}\n`)).toBe(false);
    expect(
      inspectDesignSource(serialized.trimEnd(), "designs/output.codesign.json").isCanonical,
    ).toBe(false);
    expect(
      workspaceVersionChanged(
        { modifiedAt: 10, revision: "sha256:same" },
        { found: true, modifiedAt: 20, revision: "sha256:same" },
      ),
    ).toBe(false);
    expect(
      workspaceVersionChanged(
        { modifiedAt: 10, revision: "sha256:old" },
        { found: true, modifiedAt: 10, revision: "sha256:new" },
      ),
    ).toBe(true);
    expect(
      workspaceVersionChanged(
        { modifiedAt: null, revision: null },
        { found: false, modifiedAt: null, revision: null },
      ),
    ).toBe(false);
    expect(
      workspaceVersionChanged(
        { modifiedAt: null, revision: null },
        { found: true, modifiedAt: 10, revision: "sha256:new" },
      ),
    ).toBe(true);
    expect(
      workspaceVersionChanged(
        { modifiedAt: 10, revision: null },
        { found: false, modifiedAt: null, revision: null },
      ),
    ).toBe(true);
  });

  test("normalizes v2 auto layout and linked components without expanding instances", () => {
    const component = {
      ...REQUIRED_NODE_FIELDS,
      id: "component-button",
      type: "component",
      name: "Button",
      x: 20,
      y: 20,
      width: 180,
      height: 64,
      fill: "#171717",
      clipContent: true,
      layout: "horizontal",
      gap: 8,
      padding: 16,
      alignItems: "center",
      justifyContent: "center",
    };
    const label = {
      ...textNode,
      id: "button-label",
      parentId: component.id,
      name: "Label",
      x: 36,
      y: 38,
      width: 148,
      height: 28,
      fill: "#ffffff",
      text: "Continue",
      layoutGrow: 1,
      layoutAlign: "center",
    };
    const instance = createComponentInstance(component, "instance-button");
    const normalized = normalizeDesignDocument({
      format: "codeshell.design",
      version: 2,
      name: "Components",
      canvas: { width: 600, height: 300, background: "#ffffff" },
      tokens: { colors: [] },
      nodes: [component, label, instance],
    });
    expect(normalized.version).toBe(2);
    expect(normalized.nodes[0]).toMatchObject({
      type: "component",
      layout: "horizontal",
      gap: 8,
      padding: 16,
    });
    expect(normalized.nodes[2]).toMatchObject({
      type: "instance",
      componentId: component.id,
      width: component.width,
      height: component.height,
    });
    expect(
      createComponentInstance(component, "instance-inside-canvas", 32, {
        width: 300,
        height: 200,
      }),
    ).toMatchObject({ x: 20, y: 116 });
    const svg = exportDesignSvg(normalized);
    expect(svg).toContain('data-node-id="instance-button"');
    expect(svg).toContain('data-component-id="component-button"');
    expect(() =>
      normalizeDesignDocument({
        ...structuredClone(normalized),
        nodes: normalized.nodes.filter((node) => node.type === "instance"),
      }),
    ).toThrow(/不存在的组件/);
    const missingLayout = structuredClone(normalized);
    delete missingLayout.nodes[0].layout;
    expect(() => normalizeDesignDocument(missingLayout)).toThrow(/缺少 layout/);
  });

  test("resolves auto layout into deterministic explicit geometry", () => {
    const nodes = [
      {
        id: "frame",
        type: "frame",
        x: 10,
        y: 20,
        width: 300,
        height: 100,
        layout: "horizontal",
        gap: 10,
        padding: 20,
        alignItems: "center",
        justifyContent: "start",
      },
      {
        id: "fixed",
        type: "rectangle",
        parentId: "frame",
        x: 0,
        y: 0,
        width: 50,
        height: 20,
      },
      {
        id: "growing",
        type: "rectangle",
        parentId: "frame",
        x: 0,
        y: 0,
        width: 10,
        height: 30,
        layoutGrow: 1,
        layoutAlign: "stretch",
      },
    ];
    expect(applyAutoLayout(nodes, "frame")).toBe(true);
    expect(nodes[1]).toMatchObject({ x: 30, y: 60, width: 50, height: 20 });
    expect(nodes[2]).toMatchObject({ x: 90, y: 40, width: 200, height: 60 });
    expect(applyAutoLayout(nodes, "frame")).toBe(false);
  });

  test("propagates edited color values while keeping explicit standalone node colors", () => {
    const colored = structuredClone(document);
    colored.canvas.background = "#171717";
    colored.nodes[0].fill = "#171717";
    colored.nodes[1].stroke = "#171717";
    expect(replaceDesignColor(colored, "#171717", "#315FDA")).toBe(4);
    expect(colored.canvas.background).toBe("#315fda");
    expect(colored.nodes[0].fill).toBe("#315fda");
    expect(colored.nodes[1].fill).toBe("#315fda");
    expect(colored.nodes[1].stroke).toBe("#315fda");
    expect(replaceDesignColor(colored, "transparent", "#ffffff")).toBe(0);
  });

  test("checks committed SVG previews from the read-only CI command", () => {
    const directory = mkdtempSync(join(tmpdir(), "design-studio-check-"));
    const sourcePath = join(directory, "home.codesign.json");
    const previewPath = join(directory, "home.svg");
    const normalized = normalizeDesignDocument(structuredClone(document));
    writeFileSync(sourcePath, serializeDesignDocument(normalized));
    writeFileSync(previewPath, exportDesignSvg(normalized));
    try {
      const current = spawnSync(
        process.execPath,
        [join(ROOT, "app", "tools", "check-design.mjs"), "--check-svg", sourcePath],
        { encoding: "utf-8" },
      );
      expect(current.status).toBe(0);
      expect(current.stdout).toContain("SVG current");

      writeFileSync(previewPath, "<svg />\n");
      const stale = spawnSync(
        process.execPath,
        [join(ROOT, "app", "tools", "check-design.mjs"), "--check-svg", sourcePath],
        { encoding: "utf-8" },
      );
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain("sibling SVG preview is stale");

      writeFileSync(sourcePath, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
      const invalidUtf8 = spawnSync(
        process.execPath,
        [join(ROOT, "app", "tools", "check-design.mjs"), sourcePath],
        { encoding: "utf-8" },
      );
      expect(invalidUtf8.status).toBe(1);
      expect(invalidUtf8.stderr).toContain("source is not valid UTF-8");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("exports escaped SVG and propagates frame visibility", () => {
    expect(exportDesignSvg(document)).not.toContain("text&lt;&amp;");
    const visible = structuredClone(document);
    visible.nodes[0].visible = true;
    visible.nodes[0].rotation = 12;
    visible.nodes[1].rotation = 4;
    const svg = exportDesignSvg(visible);
    expect(svg).toContain('<clipPath id="frame-clip-0" clipPathUnits="userSpaceOnUse">');
    expect(svg).toContain('<g clip-path="url(#frame-clip-0)">');
    expect(svg).toContain('data-node-id="text&lt;&amp;"');
    expect(svg).toContain("A&amp;B &lt;safe&gt;");
    expect(svg).toContain('transform="rotate(12 60 50) rotate(4 52 28)"');
    expect(exportDesignSvg(visible)).toBe(svg);

    const translucent = structuredClone(visible);
    translucent.nodes[0].opacity = 0.5;
    translucent.nodes[1].opacity = 0.4;
    expect(effectiveDesignNodeOpacity(translucent, translucent.nodes[1])).toBe(0.2);
    expect(exportDesignSvg(translucent)).toContain('data-node-id="text&lt;&amp;"');
    expect(exportDesignSvg(translucent)).toContain('opacity="0.2"');
    translucent.nodes[0].opacity = 0;
    expect(isDesignNodeVisible(translucent, translucent.nodes[1])).toBe(false);
    expect(exportDesignSvg(translucent)).not.toContain('data-node-id="text&lt;&amp;"');

    const controlled = structuredClone(visible);
    controlled.nodes[1].text = "A\u0000B";
    const controlledSvg = exportDesignSvg(controlled);
    expect(controlledSvg).toContain("A\ufffdB");
    expect(controlledSvg).not.toContain("\u0000");
  });

  test("refuses an SVG whose escaped text would exceed the repository write budget", () => {
    const escapeHeavy = structuredClone(document);
    escapeHeavy.nodes = Array.from({ length: 30 }, (_, index) => ({
      ...textNode,
      id: `text-${index}`,
      parentId: undefined,
      text: "&".repeat(4000),
    }));
    const normalized = normalizeDesignDocument(escapeHeavy);
    expect(assertDesignDocumentSize(normalized)).toBeLessThan(MAX_DESIGN_DOCUMENT_BYTES);
    expect(() => exportDesignSvg(normalized)).toThrow(/SVG.*KiB.*导出上限/);
    expect(MAX_SVG_EXPORT_BYTES).toBe(384 * 1024);
  });

  test("keeps a full 500-layer document within the normal repository workflow", () => {
    const stressDocument = normalizeDesignDocument({
      format: "codeshell.design",
      version: 1,
      name: "500 layer stress",
      canvas: { width: 10000, height: 10000, background: "#ffffff" },
      tokens: { colors: [] },
      nodes: Array.from({ length: MAX_DESIGN_NODES }, (_, index) => ({
        ...REQUIRED_NODE_FIELDS,
        id: `rectangle-${index}`,
        type: "rectangle",
        name: `Layer ${index}`,
        x: (index % 50) * 20,
        y: Math.floor(index / 50) * 20,
        width: 10,
        height: 10,
        fill: "#ffffff",
      })),
    });
    expect(stressDocument.nodes).toHaveLength(MAX_DESIGN_NODES);
    expect(assertDesignDocumentSize(stressDocument)).toBeLessThan(MAX_DESIGN_DOCUMENT_BYTES);
    expect(auditDesign(stressDocument)).toEqual([]);
    expect(new TextEncoder().encode(exportDesignSvg(stressDocument)).length).toBeLessThan(
      MAX_SVG_EXPORT_BYTES,
    );
  });

  test("rejects structural corruption instead of silently dropping repo data", () => {
    const duplicate = structuredClone(document);
    duplicate.nodes[1].id = "frame";
    expect(() => normalizeDesignDocument(duplicate)).toThrow(/ID 重复/);

    const orphan = structuredClone(document);
    orphan.nodes[1].parentId = "missing";
    expect(() => normalizeDesignDocument(orphan)).toThrow(/不存在的 Frame/);

    const interleaved = structuredClone(document);
    interleaved.nodes.reverse();
    expect(() => normalizeDesignDocument(interleaved)).toThrow(/紧邻.*子图层/);

    const controlledId = structuredClone(document);
    controlledId.nodes[1].id = "bad\nid";
    expect(() => normalizeDesignDocument(controlledId)).toThrow(/类型或 ID 无效/);

    const controlledName = structuredClone(document);
    controlledName.nodes[1].name = "bad\rname";
    expect(() => normalizeDesignDocument(controlledName)).toThrow(/名称无效/);

    const invalidNumber = structuredClone(document);
    invalidNumber.nodes[1].x = "12";
    expect(() => normalizeDesignDocument(invalidNumber)).toThrow(/有限数字/);

    const invalidColor = structuredClone(document);
    invalidColor.nodes[1].fill = "red";
    expect(() => normalizeDesignDocument(invalidColor)).toThrow(/色值无效/);

    const missingRequired = structuredClone(document);
    delete missingRequired.nodes[1].locked;
    expect(() => normalizeDesignDocument(missingRequired)).toThrow(/visible 或 locked/);

    const unknownNodeField = structuredClone(document);
    unknownNodeField.nodes[1].href = "https://example.invalid";
    expect(() => normalizeDesignDocument(unknownNodeField)).toThrow(/未知字段/);

    const wrongFields = structuredClone(document);
    wrongFields.nodes[0].text = "not a text layer";
    expect(() => normalizeDesignDocument(wrongFields)).toThrow(/文字专属字段/);
    delete wrongFields.nodes[0].text;
    wrongFields.nodes[1].clipContent = true;
    expect(() => normalizeDesignDocument(wrongFields)).toThrow(/clipContent/);

    const duplicateColors = structuredClone(document);
    duplicateColors.tokens.colors = [
      { name: "Ink", value: "#171717" },
      { name: "ink", value: "#ffffff" },
    ];
    expect(() => normalizeDesignDocument(duplicateColors)).toThrow(/名称重复/);

    const tooMany = structuredClone(document);
    tooMany.nodes = Array.from({ length: 501 }, (_, index) => ({
      ...textNode,
      id: `text-${index}`,
      parentId: undefined,
    }));
    expect(() => normalizeDesignDocument(tooMany)).toThrow(/500/);

    const oversized = structuredClone(document);
    oversized.nodes = Array.from({ length: 60 }, (_, index) => ({
      ...textNode,
      id: `text-${index}`,
      parentId: undefined,
      text: "x".repeat(4000),
    }));
    expect(() => normalizeDesignDocument(oversized)).toThrow(/KiB/);
    expect(MAX_DESIGN_DOCUMENT_BYTES).toBe(192 * 1024);
    expect(MAX_DESIGN_NODES).toBe(500);
    expect(assertDesignDocumentSize(document)).toBeGreaterThan(0);
  });
});

describe("design-studio audit", () => {
  test("checks contrast, frame bounds, and empty text deterministically", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 4);
    const auditText = {
      ...REQUIRED_NODE_FIELDS,
      type: "text",
      name: "Text",
      x: 12,
      y: 16,
      width: 80,
      height: 24,
      fill: "#171717",
      text: "Text",
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.2,
      textAlign: "left",
    };
    const document = normalizeDesignDocument({
      format: "codeshell.design",
      version: 1,
      name: "Audit",
      canvas: { width: 100, height: 100, background: "#ffffff" },
      tokens: { colors: [] },
      nodes: [
        {
          ...REQUIRED_NODE_FIELDS,
          id: "frame",
          type: "frame",
          name: "Frame",
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          fill: "#ffffff",
        },
        {
          ...auditText,
          id: "low-contrast",
          parentId: "frame",
          x: 80,
          y: 80,
          width: 30,
          text: "Readable?",
          fill: "#eeeeee",
        },
        {
          ...auditText,
          id: "empty",
          parentId: "frame",
          width: 40,
          text: " ",
        },
        {
          ...auditText,
          id: "hidden-empty",
          parentId: "frame",
          width: 40,
          text: " ",
          visible: false,
        },
      ],
    });
    const issues = auditDesign(document);
    expect(issues.map((issue) => issue.nodeId)).toEqual([
      "low-contrast",
      "low-contrast",
      "low-contrast",
      "empty",
    ]);
    expect(auditDesign(document)).toEqual(issues);
    const report = auditMarkdown(document, issues, "designs/audit.codesign.json");
    expect(report).toContain("Source: `designs/audit.codesign.json`");
    expect(auditMarkdown(document, issues, "designs/review`draft.codesign.json")).toContain(
      "Source: ``designs/review`draft.codesign.json``",
    );
    expect(
      auditMarkdown({ ...document, name: "<img onerror=alert(1)>" }, [], "designs/a.json"),
    ).toContain("# Design audit: &lt;img onerror=alert\\(1\\)&gt;");
    expect(report).toContain("| warning |");
    expect(auditMarkdown(document, issues, "designs/audit.codesign.json")).toBe(report);

    const transparentText = normalizeDesignDocument({
      format: "codeshell.design",
      version: 1,
      name: "Transparent",
      canvas: { width: 100, height: 100, background: "#ffffff" },
      tokens: { colors: [] },
      nodes: [
        {
          ...auditText,
          id: "transparent",
          text: "Invisible",
          fill: "transparent",
        },
      ],
    });
    expect(auditDesign(transparentText)).toEqual([
      expect.objectContaining({
        nodeId: "transparent",
        message: expect.stringContaining("不可见"),
      }),
    ]);

    const fadedText = structuredClone(transparentText);
    fadedText.nodes[0].fill = "#000000";
    fadedText.nodes[0].opacity = 0.1;
    expect(auditDesign(fadedText)).toContainEqual(
      expect.objectContaining({
        nodeId: "transparent",
        message: expect.stringContaining("文字对比度"),
      }),
    );

    const overflowingText = structuredClone(transparentText);
    overflowingText.nodes[0].fill = "#000000";
    overflowingText.nodes[0].text = "Line one\nLine two";
    overflowingText.nodes[0].height = 20;
    expect(auditDesign(overflowingText)).toContainEqual(
      expect.objectContaining({
        nodeId: "transparent",
        message: expect.stringContaining("文本高度不足"),
      }),
    );
  });

  test("uses rotated visual bounds and rotated background hit testing", () => {
    const rotated = normalizeDesignDocument({
      format: "codeshell.design",
      version: 1,
      name: "Rotated audit",
      canvas: { width: 120, height: 120, background: "#ffffff" },
      tokens: { colors: [] },
      nodes: [
        {
          ...REQUIRED_NODE_FIELDS,
          id: "frame",
          type: "frame",
          name: "Frame",
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          fill: "#ffffff",
        },
        {
          ...REQUIRED_NODE_FIELDS,
          id: "rotated-child",
          type: "rectangle",
          name: "Rotated child",
          parentId: "frame",
          x: 5,
          y: 40,
          width: 20,
          height: 20,
          rotation: 45,
          fill: "#315fda",
        },
        {
          ...REQUIRED_NODE_FIELDS,
          id: "rotated-background",
          type: "rectangle",
          name: "Rotated background",
          x: 40,
          y: 40,
          width: 20,
          height: 60,
          rotation: 45,
          fill: "#000000",
        },
        {
          ...REQUIRED_NODE_FIELDS,
          id: "edge-text",
          type: "text",
          name: "Edge text",
          x: 40,
          y: 40,
          width: 2,
          height: 2,
          fill: "#777777",
          text: "A",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 1.2,
          textAlign: "left",
        },
      ],
    });
    const issues = auditDesign(rotated);
    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: "rotated-child",
        message: expect.stringContaining("所属 Frame"),
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: "edge-text",
        message: expect.stringContaining("文字对比度"),
      }),
    );

    const ellipseCorner = normalizeDesignDocument({
      format: "codeshell.design",
      version: 1,
      name: "Ellipse contrast",
      canvas: { width: 120, height: 120, background: "#ffffff" },
      tokens: { colors: [] },
      nodes: [
        {
          ...REQUIRED_NODE_FIELDS,
          id: "ellipse-background",
          type: "ellipse",
          name: "Ellipse background",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          fill: "#000000",
        },
        {
          ...REQUIRED_NODE_FIELDS,
          id: "corner-text",
          type: "text",
          name: "Corner text",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          fill: "#777777",
          text: "A",
          fontSize: 16,
          fontWeight: 400,
          lineHeight: 1.2,
          textAlign: "left",
        },
      ],
    });
    expect(auditDesign(ellipseCorner)).toContainEqual(
      expect.objectContaining({
        nodeId: "corner-text",
        message: expect.stringContaining("文字对比度"),
      }),
    );
  });
});

describe("design-studio example Panel App", () => {
  test("declares one repo-native app with scoped workspace permissions", () => {
    const manifest = PanelAppManifest.parse(
      JSON.parse(readFileSync(join(ROOT, PANEL_APP_MANIFEST_FILE), "utf-8")),
    );
    expect(manifest).toMatchObject({
      id: "design-studio",
      entry: "app/index.html",
      icon: "palette",
    });
    expect(manifest.permissions).toEqual(
      expect.arrayContaining([
        "context.workspace",
        "workspace.read",
        "workspace.write",
        "agent.submitPrompt",
      ]),
    );
  });

  test("installs through the independent Panel App registry without agent content", async () => {
    const home = mkdtempSync(join(tmpdir(), "design-studio-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const preview = await previewLocalPanelApp({ kind: "dir", path: ROOT });
      const installed = await installReviewedLocalPanelApp(
        { kind: "dir", path: ROOT },
        preview.reviewToken,
        "2026-07-28T00:00:00.000Z",
      );
      expect(await listInstalledPanelApps()).toEqual([
        expect.objectContaining({
          id: "design-studio",
          entry: "app/index.html",
        }),
      ]);
      expect(readFileSync(join(installed.installPath, "app", "app.js"), "utf-8")).toContain(
        'hostCall("workspace.writeText"',
      );
      expect(readFileSync(join(installed.installPath, "app", "audit.mjs"), "utf-8")).toContain(
        "auditDesign",
      );
      expect(
        readFileSync(join(installed.installPath, "app", "tools", "check-design.mjs"), "utf-8"),
      ).toContain("inspectDesignSource");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
    // Real preview + install over the whole example app (hundreds of files) can
    // exceed bun's 5s default on a loaded machine; a timeout reports as a
    // failure, indistinguishable from a genuine regression.
  }, 60_000);

  test("ships a CSP-compatible dependency-free app", () => {
    const html = readFileSync(join(ROOT, "app", "index.html"), "utf-8");
    const app = readFileSync(join(ROOT, "app", "app.js"), "utf-8");
    const schema = JSON.parse(
      readFileSync(join(ROOT, "app", "formats", "codeshell-design-v1.schema.json"), "utf-8"),
    );
    const schemaV2 = JSON.parse(
      readFileSync(join(ROOT, "app", "formats", "codeshell-design-v2.schema.json"), "utf-8"),
    );
    expect(html).toContain('<script type="module" src="./app.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]+src=)/);
    expect(html).toContain('id="prop-canvas-width"');
    expect(html).toContain('id="prop-line-height"');
    expect(html).toContain('id="prop-text-align"');
    expect(html).toContain('id="multi-selection"');
    expect(html).toContain('id="add-color-token"');
    expect(html).toContain('id="toggle-snap"');
    expect(html).toContain('id="prop-parent"');
    expect(html).toContain('id="prop-notes"');
    expect(html).toContain('id="layer-filter"');
    expect(html).toContain('id="audit-dialog"');
    expect(html).toContain('id="save-audit-report"');
    expect(html).toContain('id="repo-link-state"');
    expect(html).toContain('id="prop-layout"');
    expect(html).toContain('id="make-component"');
    expect(html).toContain('id="create-instance"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-distribute="horizontal"');
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        format: { const: "codeshell.design" },
        version: { const: 1 },
      },
    });
    expect(schema.$defs.node.additionalProperties).toBe(false);
    expect(schema.$defs.node.properties.parentId).toMatchObject({
      type: "string",
      maxLength: 160,
    });
    expect(schema.$defs.node.properties.notes.maxLength).toBe(2000);
    expect(schemaV2).toMatchObject({
      properties: {
        format: { const: "codeshell.design" },
        version: { const: 2 },
      },
    });
    expect(schemaV2.$defs.node.properties.type.enum).toContain("component");
    expect(schemaV2.$defs.node.properties.type.enum).toContain("instance");
    const boundIds = [...app.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
    expect([...new Set(boundIds)].filter((id) => !html.includes(`id="${id}"`))).toEqual([]);
    expect(app).toContain('"codeshell.design"');
    expect(app).toContain("expectedModifiedAt");
    expect(app).toContain("expectedRevision");
    expect(app).toContain("toggleSelection");
    expect(app).toContain('"marquee"');
    expect(app).toContain("distributeSelected");
    expect(app).toContain("nodeTransform");
    expect(app).toContain("if (event.defaultPrevented) return");
    expect(app).toContain('event.key.toLowerCase() === "z" && !editing');
    expect(app).toContain("const workspaceUnavailable = context.trusted !== true");
    expect(app).toContain("previousRecovery = dirty ? recoverySnapshot(previousWorkspaceRoot)");
    expect(app).toContain("当前画布已保留为未保存副本");
    expect(app).toContain("assertWorkspaceEpoch(operationWorkspaceEpoch)");
    expect(app).toContain("exportDesignSvg(saved.design)");
    expect(app).toContain("return { ...result, design: savedDesign }");
    expect(app).toContain("if (workspaceEpoch !== operationWorkspaceEpoch) return;");
    expect(app).toContain("const replacesCurrentSource = path === currentSourcePath");
    expect(app).toContain("baseModifiedAt: tracksCurrentSource ? currentModifiedAt : null");
    expect(app).toContain("fileDiscoveryCache");
    expect(app).toContain("chooseRepoDesignFile");
    expect(app).toContain("startExternalSync");
    expect(app).toContain("const maxFiles = 200");
    expect(app).toContain("restoreRecovery");
    expect(app).toContain("恢复快照缺少文件版本守卫");
    expect(app).toContain("const recoveryBaseChanged = workspaceVersionChanged");
    expect(app).toContain('scopedStorageKey("recovery",');
    expect(app).toContain("workspaceRoot,");
    expect(app).toContain("value: { workspaceRoot: operationWorkspaceIdentity, path }");
    expect(app).toContain("lastPath.workspaceRoot === initializationWorkspaceIdentity");
    expect(app).toContain("design.nodes.length + count > MAX_DESIGN_NODES");
    expect(app).toContain("normalizeNodeTreeOrder(design.nodes)");
    expect(app).toContain("saveInFlight?.workspaceEpoch === workspaceEpoch");
    expect(app).toContain("contextInitialized && previousWorkspaceRoot !== nextWorkspaceRoot");
    expect(app).toContain("applyContextTheme(context.theme)");
    expect(app).toContain("document.documentElement.dataset.theme = theme");
    expect(app).toContain("本地恢复快照写入失败");
    expect(app).toContain("recoveryFailureWarned");
    expect(app).toContain("persistRecovery(workspaceRoot");
    expect(app).toContain("context.visible === false && dirty");
    expect(app).toContain('event.returnValue = ""');
    expect(app).toContain("activateInspectorTab");
    expect(app).toContain("focusLayerRow");
    expect(app).toContain("row.tabIndex = node.id === rovingId ? 0 : -1");
    expect(app).toContain("visibility.tabIndex = -1");
    expect(app).toContain('event.key === "ArrowDown"');
    expect(app).toContain('window.addEventListener("blur"');
    expect(app).toContain("finishInteraction()");
    expect(app).toContain('"storage.delete"');
    expect(app).not.toMatch(/\bfetch\s*\(/);
    expect(app).not.toContain("https://");
  });
});
