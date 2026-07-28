/* Design Studio Panel App runtime. */
/* global document, localStorage, requestAnimationFrame, window */

import {
  alignNodeTrees,
  detachNodeFromParent,
  descendantIds,
  distributeNodeTrees,
  moveSelectedNodes,
  normalizeNodeTreeOrder,
  pointInRotatedBounds,
  pointToParentSpace,
  releaseFrame,
  reparentNode,
  rotateVector,
  snapBoundsToNodes,
  setNodeTreePosition,
  snapValue,
  transformedNodeBounds,
  visualSelectionBounds,
  wrapNodesInFrame,
} from "./geometry.mjs";
import {
  assertDesignDocumentSize,
  effectiveDesignNodeOpacity,
  exportDesignSvg,
  isSafeDesignPath,
  isDesignNodeVisible,
  MAX_DESIGN_NODES,
  normalizeDesignDocument,
  replaceDesignColor,
  serializeDesignDocument,
  workspaceVersionChanged,
} from "./document.mjs";
import { auditDesign, auditMarkdown } from "./audit.mjs";
import {
  applyAllAutoLayouts,
  applyAutoLayout,
  createComponentInstance,
  isContainerNode,
} from "./layout.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const TOOL_SHORTCUTS = {
  v: "select",
  f: "frame",
  r: "rectangle",
  o: "ellipse",
  t: "text",
  h: "hand",
};
const DEFAULT_PATH = "designs/design.codesign.json";
const DEFAULT_COLOR_TOKENS = Object.freeze([
  { name: "Ink", value: "#171717" },
  { name: "Paper", value: "#f7f7f3" },
  { name: "Accent", value: "#b7ff52" },
  { name: "Blue", value: "#315fda" },
]);

const elements = {
  stage: document.querySelector("#stage"),
  scene: document.querySelector("#scene"),
  grid: document.querySelector("#grid"),
  stageWrap: document.querySelector("#stage-wrap"),
  workspace: document.querySelector(".workspace"),
  path: document.querySelector("#document-path"),
  repoLinkState: document.querySelector("#repo-link-state"),
  saveState: document.querySelector("#save-state"),
  save: document.querySelector("#save"),
  runAudit: document.querySelector("#run-audit"),
  exportSvg: document.querySelector("#export-svg"),
  openFiles: document.querySelector("#open-files"),
  openShortcuts: document.querySelector("#open-shortcuts"),
  openAi: document.querySelector("#open-ai"),
  toggleInspector: document.querySelector("#toggle-inspector"),
  filesDialog: document.querySelector("#files-dialog"),
  shortcutsDialog: document.querySelector("#shortcuts-dialog"),
  filesList: document.querySelector("#files-list"),
  workspaceSummary: document.querySelector("#workspace-summary"),
  newDocument: document.querySelector("#new-document"),
  aiDialog: document.querySelector("#ai-dialog"),
  auditDialog: document.querySelector("#audit-dialog"),
  auditSummary: document.querySelector("#audit-summary"),
  auditResults: document.querySelector("#audit-results"),
  saveAuditReport: document.querySelector("#save-audit-report"),
  aiRequest: document.querySelector("#ai-request"),
  aiContextState: document.querySelector("#ai-context-state"),
  submitAi: document.querySelector("#submit-ai"),
  zoomOut: document.querySelector("#zoom-out"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomValue: document.querySelector("#zoom-value"),
  toggleGrid: document.querySelector("#toggle-grid"),
  toggleSnap: document.querySelector("#toggle-snap"),
  selectionSize: document.querySelector("#selection-size"),
  noSelection: document.querySelector("#no-selection"),
  multiSelection: document.querySelector("#multi-selection"),
  multiSelectionCount: document.querySelector("#multi-selection-count"),
  canvasProperties: document.querySelector("#canvas-properties"),
  selectionProperties: document.querySelector("#selection-properties"),
  parentField: document.querySelector("#prop-parent-field"),
  frameSection: document.querySelector("#frame-section"),
  containerSectionLabel: document.querySelector("#container-section-label"),
  clipContentField: document.querySelector("#clip-content-field"),
  releaseContainerLabel: document.querySelector("#release-container-label"),
  layoutSection: document.querySelector("#layout-section"),
  containerLayoutControls: document.querySelector("#container-layout-controls"),
  childLayoutControls: document.querySelector("#child-layout-controls"),
  componentSection: document.querySelector("#component-section"),
  componentStatus: document.querySelector("#component-status"),
  textSection: document.querySelector("#text-section"),
  colorTokens: document.querySelector("#color-tokens"),
  addColorToken: document.querySelector("#add-color-token"),
  layersList: document.querySelector("#layers-list"),
  layerFilter: document.querySelector("#layer-filter"),
  duplicateLayer: document.querySelector("#duplicate-layer"),
  makeComponent: document.querySelector("#make-component"),
  createInstance: document.querySelector("#create-instance"),
  frameSelection: document.querySelector("#frame-selection"),
  groupSelection: document.querySelector("#group-selection"),
  releaseFrame: document.querySelector("#release-frame"),
  toggleLock: document.querySelector("#toggle-lock"),
  toggleVisible: document.querySelector("#toggle-visible"),
  toast: document.querySelector("#toast"),
};

const propertyInputs = {
  name: document.querySelector("#prop-name"),
  x: document.querySelector("#prop-x"),
  y: document.querySelector("#prop-y"),
  width: document.querySelector("#prop-width"),
  height: document.querySelector("#prop-height"),
  text: document.querySelector("#prop-text"),
  fontSize: document.querySelector("#prop-font-size"),
  fontWeight: document.querySelector("#prop-font-weight"),
  lineHeight: document.querySelector("#prop-line-height"),
  textAlign: document.querySelector("#prop-text-align"),
  fill: document.querySelector("#prop-fill"),
  fillColor: document.querySelector("#prop-fill-color"),
  stroke: document.querySelector("#prop-stroke"),
  strokeColor: document.querySelector("#prop-stroke-color"),
  strokeWidth: document.querySelector("#prop-stroke-width"),
  cornerRadius: document.querySelector("#prop-radius"),
  opacity: document.querySelector("#prop-opacity"),
  rotation: document.querySelector("#prop-rotation"),
  parent: document.querySelector("#prop-parent"),
  notes: document.querySelector("#prop-notes"),
  clipContent: document.querySelector("#prop-clip-content"),
  layout: document.querySelector("#prop-layout"),
  gap: document.querySelector("#prop-layout-gap"),
  padding: document.querySelector("#prop-layout-padding"),
  alignItems: document.querySelector("#prop-align-items"),
  justifyContent: document.querySelector("#prop-justify-content"),
  layoutGrow: document.querySelector("#prop-layout-grow"),
  layoutAlign: document.querySelector("#prop-layout-align"),
};

const canvasInputs = {
  name: document.querySelector("#prop-document-name"),
  width: document.querySelector("#prop-canvas-width"),
  height: document.querySelector("#prop-canvas-height"),
  background: document.querySelector("#prop-canvas-background"),
  backgroundColor: document.querySelector("#prop-canvas-background-color"),
};

let design = createBlankDocument();
let selectedId = null;
let selectedIds = new Set();
let activeTool = "select";
let zoom = 0.7;
const pan = { x: 60, y: 50 };
let interaction = null;
let spacePressed = false;
let showGrid = true;
let snapEnabled = true;
let dirty = true;
let currentModifiedAt = null;
let currentRevision = null;
let currentSourcePath = null;
let currentSourceModifiedAt = null;
let currentSourceRevision = null;
let savedSnapshot = "";
let history = [];
let historyIndex = -1;
let context = { busy: false, trusted: false };
let toastTimer;
let recoveryTimer;
let copiedNodes = [];
let copiedSelectionIds = new Set();
let copiedDocumentEpoch = null;
let copiedParentFrames = new Map();
let documentEpoch = 0;
let layerFilter = "";
let checkingExternalChange = false;
let lastExternalCheckAt = 0;
let warnedExternalVersion = null;
let fileDiscoveryCache = null;
let fileDiscoveryCachedAt = 0;
let workspaceEpoch = 0;
let contextInitialized = false;
let saveInFlight = null;
let recoveryFailureWarned = false;
let externalSyncTimer = null;
let workspaceInfo = null;
const collapsedLayerIds = new Set();

function scopedStorageKey(base, workspaceRoot = context.cwd ?? "preview") {
  let primary = 2_166_136_261;
  let secondary = 2_654_435_769;
  for (let index = 0; index < workspaceRoot.length; index += 1) {
    const code = workspaceRoot.charCodeAt(index);
    primary = Math.imul(primary ^ code, 16_777_619);
    secondary = Math.imul(secondary ^ code, 2_246_822_519);
    secondary ^= secondary >>> 13;
  }
  const scope = [primary, secondary]
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `${base}.${scope}`;
}

function applyContextTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function baseNode(type, overrides = {}) {
  const defaults = {
    id: `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    name:
      type === "frame"
        ? "画板"
        : type === "group"
          ? "图层组"
          : type === "component"
            ? "组件"
            : type === "instance"
              ? "组件实例"
              : type === "rectangle"
                ? "矩形"
                : type === "ellipse"
                  ? "椭圆"
                  : "文字",
    x: 0,
    y: 0,
    width: type === "text" ? 240 : 160,
    height: type === "text" ? 54 : 120,
    fill:
      type === "text"
        ? "#171717"
        : type === "group" || type === "instance"
          ? "transparent"
          : type === "frame" || type === "component"
            ? "#ffffff"
            : "#d7ff9d",
    stroke: "transparent",
    strokeWidth: 0,
    opacity: 1,
    rotation: 0,
    cornerRadius: type === "ellipse" ? 999 : 12,
    visible: true,
    locked: false,
  };
  if (type === "text") {
    Object.assign(defaults, {
      text: "输入文字",
      fontSize: 32,
      fontWeight: 600,
      lineHeight: 1.15,
      textAlign: "left",
    });
  } else if (["frame", "component"].includes(type)) {
    defaults.clipContent = true;
  }
  if (isContainerNode({ type })) {
    Object.assign(defaults, {
      layout: "none",
      gap: 16,
      padding: 24,
      alignItems: "start",
      justifyContent: "start",
    });
  }
  return { ...defaults, ...overrides };
}

function createBlankDocument(name = "Repo design") {
  return {
    format: "codeshell.design",
    version: 2,
    name,
    canvas: {
      width: 1280,
      height: 820,
      background: "#e9e9e5",
    },
    tokens: {
      colors: clone(DEFAULT_COLOR_TOKENS),
    },
    nodes: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDesignV2() {
  if (design.version === 2) return;
  design.version = 2;
  for (const node of design.nodes) {
    if (!isContainerNode(node)) continue;
    node.layout = "none";
    node.gap = 16;
    node.padding = 24;
    node.alignItems = "start";
    node.justifyContent = "start";
  }
}

function reflowLayouts() {
  if (design.version !== 2) return false;
  return applyAllAutoLayouts(design.nodes);
}

function reflowParent(node) {
  if (design.version !== 2 || !node?.parentId) return false;
  return applyAutoLayout(design.nodes, node.parentId);
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function snapPoint(point, bypass = false) {
  if (!snapEnabled || bypass) return point;
  return { x: snapValue(point.x), y: snapValue(point.y) };
}

function selectedNode() {
  return design.nodes.find((node) => node.id === selectedId) ?? null;
}

function selectedNodes() {
  return design.nodes.filter((node) => selectedIds.has(node.id));
}

function nodeById(id) {
  return design.nodes.find((node) => node.id === id) ?? null;
}

function isEffectivelyVisible(node) {
  return isDesignNodeVisible(design, node);
}

function isEffectivelyLocked(node) {
  if (node.locked) return true;
  const parent = node.parentId ? nodeById(node.parentId) : null;
  return Boolean(parent?.locked);
}

function nodeTransform(node) {
  const transforms = [];
  const parent = node.parentId ? nodeById(node.parentId) : null;
  if (parent?.rotation) {
    transforms.push(
      `rotate(${parent.rotation} ${parent.x + parent.width / 2} ${parent.y + parent.height / 2})`,
    );
  }
  if (node.rotation) {
    transforms.push(
      `rotate(${node.rotation} ${node.x + node.width / 2} ${node.y + node.height / 2})`,
    );
  }
  return transforms.join(" ");
}

function selectedTransformNodes() {
  const selected = selectedNodes();
  const transformIds = new Set(
    selected.filter((node) => !isEffectivelyLocked(node)).map((node) => node.id),
  );
  const selectedContainerIds = new Set(
    selected.filter((node) => isContainerNode(node) && !node.locked).map((node) => node.id),
  );
  for (const id of descendantIds(design.nodes, selectedContainerIds)) transformIds.add(id);
  return design.nodes.filter((node) => transformIds.has(node.id));
}

function visualDeltaForNode(node, delta, movingIds) {
  const parent = node.parentId && !movingIds.has(node.parentId) ? nodeById(node.parentId) : null;
  return parent?.rotation ? rotateVector(delta, -parent.rotation) : delta;
}

function containingFrame(point) {
  return (
    [...design.nodes]
      .reverse()
      .find(
        (node) =>
          isContainerNode(node) &&
          isEffectivelyVisible(node) &&
          !isEffectivelyLocked(node) &&
          pointInRotatedBounds(node, point),
      ) ?? null
  );
}

function layerEntries() {
  const entries = [];
  const visit = (node, depth) => {
    entries.push({ node, depth });
    if (collapsedLayerIds.has(node.id) && !layerFilter.trim()) return;
    for (const child of [...design.nodes].reverse()) {
      if (child.parentId === node.id) visit(child, depth + 1);
    }
  };
  for (const node of [...design.nodes].reverse()) {
    if (!node.parentId) visit(node, 0);
  }
  return entries;
}

function clearSelection() {
  selectedId = null;
  selectedIds = new Set();
}

function selectOnly(id) {
  selectedId = id;
  selectedIds = new Set(id ? [id] : []);
}

function toggleSelection(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    if (selectedId === id) selectedId = [...selectedIds].at(-1) ?? null;
    return;
  }
  selectedIds.add(id);
  selectedId = id;
}

function serializeDocument(value) {
  return serializeDesignDocument(value);
}

function serializeDesign() {
  return serializeDocument(design);
}

function updateDirtyState() {
  dirty = serializeDesign() !== savedSnapshot;
  if (warnedExternalVersion) {
    setSaveState(dirty ? "外部变更 · 本地有修改" : "源文件已在外部变更", "error");
  } else if (dirty) setSaveState("有修改", "dirty");
  else setSaveState("已保存", "saved");
}

function setSaveState(message, kind = "idle") {
  elements.saveState.textContent = message;
  elements.saveState.dataset.kind = kind;
}

function setRepoLinkState(message, kind = "idle") {
  if (!elements.repoLinkState) return;
  elements.repoLinkState.textContent = message;
  elements.repoLinkState.dataset.kind = kind;
  const root = context.cwd ?? workspaceInfo?.root;
  elements.repoLinkState.title = root ? `当前 Repo：${root}` : "尚未连接 Repo";
}

function updateRepoLinkState() {
  if (context.trusted !== true) {
    setRepoLinkState("Repo 未连接", "error");
    return;
  }
  const name = workspaceInfo?.name ?? context.cwd?.split("/").filter(Boolean).at(-1) ?? "Repo";
  const branch = workspaceInfo?.gitBranch;
  setRepoLinkState(branch ? `${name} · ${branch}` : name, "linked");
}

function notify(message, kind = "idle") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  toastTimer = setTimeout(
    () => {
      elements.toast.hidden = true;
    },
    kind === "error" ? 5200 : 2600,
  );
}

function canAddNodes(count) {
  if (!Number.isSafeInteger(count) || count < 0 || design.nodes.length + count > MAX_DESIGN_NODES) {
    notify(`设计文件最多包含 ${MAX_DESIGN_NODES} 个图层`, "error");
    return false;
  }
  return true;
}

function recoverySnapshot(workspaceRoot) {
  const requestedPath = elements.path.value.trim();
  const recoveryPath = safeDesignPath(requestedPath)
    ? requestedPath
    : safeDesignPath(currentSourcePath ?? "")
      ? currentSourcePath
      : DEFAULT_PATH;
  const tracksCurrentSource = recoveryPath === currentSourcePath;
  return {
    workspaceRoot,
    path: recoveryPath,
    design: clone(design),
    baseModifiedAt: tracksCurrentSource ? currentModifiedAt : null,
    baseRevision: tracksCurrentSource ? currentRevision : null,
  };
}

function storeRecovery(workspaceRoot, recoveryValue = recoverySnapshot(workspaceRoot)) {
  return hostCall("storage.set", {
    key: scopedStorageKey("recovery", workspaceRoot ?? "preview"),
    value: recoveryValue,
  });
}

async function persistRecovery(workspaceRoot, recoveryValue = recoverySnapshot(workspaceRoot)) {
  try {
    await storeRecovery(workspaceRoot, recoveryValue);
    if ((context.cwd ?? null) === workspaceRoot) recoveryFailureWarned = false;
    return true;
  } catch {
    if ((context.cwd ?? null) === workspaceRoot && !recoveryFailureWarned) {
      recoveryFailureWarned = true;
      notify("本地恢复快照写入失败（可能空间不足）；请尽快保存设计到仓库", "error");
    }
    return false;
  }
}

function queueRecovery() {
  clearTimeout(recoveryTimer);
  const workspaceRoot = context.cwd ?? null;
  const recoveryValue = recoverySnapshot(workspaceRoot);
  recoveryTimer = setTimeout(() => {
    void persistRecovery(workspaceRoot, recoveryValue);
  }, 500);
}

function markChanged(render = true) {
  updateDirtyState();
  queueRecovery();
  if (render) renderAll();
}

function saveUiPreferences() {
  void hostCall("storage.set", {
    key: "uiPreferences",
    value: { showGrid, snapEnabled },
  }).catch(() => undefined);
}

function resetHistory() {
  history = [serializeDesign()];
  historyIndex = 0;
}

function commitHistory() {
  const snapshot = serializeDesign();
  if (history[historyIndex] === snapshot) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  if (history.length > 60) history.shift();
  historyIndex = history.length - 1;
}

function restoreHistory(nextIndex) {
  if (nextIndex < 0 || nextIndex >= history.length) return;
  historyIndex = nextIndex;
  design = normalizeDocument(JSON.parse(history[historyIndex]));
  selectedIds = new Set(
    [...selectedIds].filter((id) => design.nodes.some((node) => node.id === id)),
  );
  if (!selectedIds.has(selectedId)) selectedId = [...selectedIds].at(-1) ?? null;
  markChanged();
}

function undo() {
  restoreHistory(historyIndex - 1);
}

function redo() {
  restoreHistory(historyIndex + 1);
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function renderScene() {
  elements.scene.replaceChildren();
  elements.scene.setAttribute("transform", `translate(${pan.x} ${pan.y}) scale(${zoom})`);

  const artboard = svgElement("rect", {
    x: 0,
    y: 0,
    width: design.canvas.width,
    height: design.canvas.height,
    rx: 2,
    fill: design.canvas.background,
    filter: "url(#artboard-shadow)",
  });
  artboard.dataset.canvas = "true";
  elements.scene.append(artboard);

  const clipIds = new Map();
  const clipDefs = svgElement("defs");
  design.nodes.forEach((node, index) => {
    if (!["frame", "component"].includes(node.type) || node.clipContent !== true) return;
    const id = `frame-clip-${index}`;
    clipIds.set(node.id, id);
    const clipPath = svgElement("clipPath", {
      id,
      clipPathUnits: "userSpaceOnUse",
    });
    const clipRect = svgElement("rect", {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rx: Math.min(node.cornerRadius, node.width / 2, node.height / 2),
    });
    if (node.rotation) {
      clipRect.setAttribute(
        "transform",
        `rotate(${node.rotation} ${node.x + node.width / 2} ${node.y + node.height / 2})`,
      );
    }
    clipPath.append(clipRect);
    clipDefs.append(clipPath);
  });
  if (clipIds.size > 0) elements.scene.append(clipDefs);
  for (const node of design.nodes) {
    if (!isEffectivelyVisible(node)) continue;
    elements.scene.append(renderNode(node, clipIds));
  }
  const nodes = selectedNodes().filter((node) => isEffectivelyVisible(node));
  if (nodes.length === 1) {
    elements.scene.append(renderSelection(nodes[0], true));
  } else if (nodes.length > 1) {
    for (const node of nodes) elements.scene.append(renderSelection(node, false));
    elements.scene.append(renderMultiSelection(nodes));
  }
  if (interaction?.kind === "marquee") elements.scene.append(renderMarquee(interaction));
  if (interaction?.kind === "move" && interaction.guides?.length) {
    elements.scene.append(renderSmartGuides(interaction.guides));
  }
  renderSelectionSize(nodes);
}

function renderInstanceNode(node, clipIds) {
  const component = design.nodes.find(
    (candidate) => candidate.id === node.componentId && candidate.type === "component",
  );
  const group = svgElement("g");
  group.dataset.nodeId = node.id;
  group.dataset.componentId = node.componentId;
  let content = group;
  if (node.parentId && clipIds.has(node.parentId)) {
    group.setAttribute("clip-path", `url(#${clipIds.get(node.parentId)})`);
    content = svgElement("g");
    group.append(content);
  }
  const transform = nodeTransform(node);
  if (transform) content.setAttribute("transform", transform);
  content.setAttribute("opacity", effectiveDesignNodeOpacity(design, node));
  if (!component || component.width <= 0 || component.height <= 0) {
    const missing = svgElement("rect", {
      x: node.x,
      y: node.y,
      width: Math.max(1, node.width),
      height: Math.max(1, node.height),
      fill: "none",
      stroke: "#ff5c78",
      "stroke-width": 1.5 / zoom,
      "stroke-dasharray": `${6 / zoom} ${4 / zoom}`,
    });
    missing.dataset.nodeId = node.id;
    content.append(missing);
    return group;
  }

  const mapped = svgElement("g", {
    transform: `translate(${node.x} ${node.y}) scale(${node.width / component.width} ${
      node.height / component.height
    }) translate(${-component.x} ${-component.y})`,
  });
  const sourceNodes = [
    component,
    ...design.nodes.filter(
      (candidate) => candidate.parentId === component.id && candidate.type !== "instance",
    ),
  ];
  for (const sourceNode of sourceNodes) {
    const source = renderNode(sourceNode, clipIds, { suppressLabel: true });
    source.dataset.nodeId = node.id;
    for (const target of source.querySelectorAll("[data-node-id]")) {
      target.dataset.componentNodeId = target.dataset.nodeId;
      target.dataset.nodeId = node.id;
    }
    mapped.append(source);
  }
  content.append(mapped);
  if (zoom >= 0.35) {
    const label = svgElement("text", {
      x: node.x,
      y: node.y - 18 / zoom,
      fill: "#a78bfa",
      "font-size": 11 / zoom,
      "font-weight": 650,
      "font-family": "Inter, ui-sans-serif, system-ui, sans-serif",
    });
    label.textContent = `◆ ${node.name}`;
    label.dataset.nodeId = node.id;
    content.append(label);
  }
  return group;
}

function renderNode(node, clipIds, options = {}) {
  if (node.type === "instance") return renderInstanceNode(node, clipIds);
  const group = svgElement("g");
  group.dataset.nodeId = node.id;
  let content = group;
  if (node.parentId && clipIds.has(node.parentId)) {
    group.setAttribute("clip-path", `url(#${clipIds.get(node.parentId)})`);
    content = svgElement("g");
    group.append(content);
  }
  const transform = nodeTransform(node);
  if (transform) content.setAttribute("transform", transform);
  content.setAttribute("opacity", effectiveDesignNodeOpacity(design, node));

  let visual;
  if (node.type === "ellipse") {
    visual = svgElement("ellipse", {
      cx: node.x + node.width / 2,
      cy: node.y + node.height / 2,
      rx: Math.max(0.5, node.width / 2),
      ry: Math.max(0.5, node.height / 2),
      fill: node.fill,
      stroke: node.stroke,
      "stroke-width": node.strokeWidth,
    });
  } else if (node.type === "text") {
    const textX =
      node.textAlign === "center"
        ? node.x + node.width / 2
        : node.textAlign === "right"
          ? node.x + node.width
          : node.x;
    visual = svgElement("text", {
      x: textX,
      y: node.y,
      fill: node.fill,
      "font-size": node.fontSize,
      "font-weight": node.fontWeight,
      "font-family": "Inter, ui-sans-serif, system-ui, sans-serif",
      "dominant-baseline": "hanging",
      "text-anchor":
        node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start",
    });
    const lines = String(node.text).split("\n");
    lines.forEach((line, index) => {
      const span = svgElement("tspan", {
        x: textX,
        dy: index === 0 ? 0 : node.fontSize * node.lineHeight,
      });
      span.textContent = line || " ";
      visual.append(span);
    });
  } else if (node.type === "group") {
    visual = svgElement("rect", {
      x: node.x,
      y: node.y,
      width: Math.max(1, node.width),
      height: Math.max(1, node.height),
      fill: "transparent",
      stroke: "transparent",
      "pointer-events": "all",
    });
  } else {
    visual = svgElement("rect", {
      x: node.x,
      y: node.y,
      width: Math.max(1, node.width),
      height: Math.max(1, node.height),
      rx: Math.min(node.cornerRadius, node.width / 2, node.height / 2),
      fill: node.fill,
      stroke: node.stroke,
      "stroke-width": node.strokeWidth,
    });
  }
  visual.dataset.nodeId = node.id;
  visual.style.pointerEvents = isEffectivelyLocked(node) ? "visiblePainted" : "all";
  content.append(visual);

  if (isContainerNode(node) && zoom >= 0.35 && options.suppressLabel !== true) {
    const label = svgElement("text", {
      x: node.x,
      y: node.y - 18 / zoom,
      fill: "#8a8a85",
      "font-size": 11 / zoom,
      "font-weight": 600,
      "font-family": "Inter, ui-sans-serif, system-ui, sans-serif",
    });
    label.textContent = `${node.type === "component" ? "◇ " : node.type === "group" ? "▣ " : ""}${node.name}`;
    label.dataset.nodeId = node.id;
    content.append(label);
  }
  return group;
}

function renderSelection(node, showHandles) {
  const locked = isEffectivelyLocked(node);
  const overlay = svgElement("g", {
    transform: nodeTransform(node),
  });
  const border = svgElement("rect", {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    fill: "none",
    stroke: locked ? "#ffae52" : "#4f7cff",
    "stroke-width": 1.5 / zoom,
    "stroke-dasharray": locked ? `${5 / zoom} ${3 / zoom}` : "",
    "pointer-events": "none",
  });
  overlay.append(border);
  if (!showHandles || locked || nodeTransform(node) || activeTool !== "select") return overlay;

  const size = 8 / zoom;
  const handles = [
    ["nw", node.x, node.y, "nwse-resize"],
    ["ne", node.x + node.width, node.y, "nesw-resize"],
    ["se", node.x + node.width, node.y + node.height, "nwse-resize"],
    ["sw", node.x, node.y + node.height, "nesw-resize"],
  ];
  for (const [handle, x, y, cursor] of handles) {
    const point = svgElement("rect", {
      x: x - size / 2,
      y: y - size / 2,
      width: size,
      height: size,
      rx: 1.5 / zoom,
      fill: "#ffffff",
      stroke: "#315fda",
      "stroke-width": 1.5 / zoom,
    });
    point.dataset.handle = handle;
    point.style.cursor = cursor;
    overlay.append(point);
  }
  return overlay;
}

function renderMultiSelection(nodes) {
  const bounds = visualSelectionBounds(nodes, design.nodes);
  return svgElement("rect", {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fill: "none",
    stroke: "#4f7cff",
    "stroke-width": 1.5 / zoom,
    "stroke-dasharray": `${4 / zoom} ${3 / zoom}`,
    "pointer-events": "none",
  });
}

function renderMarquee(state) {
  const x = Math.min(state.start.x, state.current.x);
  const y = Math.min(state.start.y, state.current.y);
  return svgElement("rect", {
    x,
    y,
    width: Math.abs(state.current.x - state.start.x),
    height: Math.abs(state.current.y - state.start.y),
    fill: "#4f7cff",
    "fill-opacity": 0.08,
    stroke: "#6d9cff",
    "stroke-width": 1 / zoom,
    "stroke-dasharray": `${3 / zoom} ${2 / zoom}`,
    "pointer-events": "none",
  });
}

function renderSmartGuides(guides) {
  const group = svgElement("g", { "pointer-events": "none" });
  for (const guide of guides) {
    group.append(
      svgElement("line", {
        x1: guide.axis === "x" ? guide.value : 0,
        x2: guide.axis === "x" ? guide.value : design.canvas.width,
        y1: guide.axis === "y" ? guide.value : 0,
        y2: guide.axis === "y" ? guide.value : design.canvas.height,
        stroke: "#ff4fa3",
        "stroke-width": 1 / zoom,
        "stroke-dasharray": `${4 / zoom} ${3 / zoom}`,
      }),
    );
  }
  return group;
}

function renderSelectionSize(nodes) {
  const bounds = visualSelectionBounds(nodes, design.nodes);
  if (!bounds) {
    elements.selectionSize.hidden = true;
    return;
  }
  const x = pan.x + (bounds.x + bounds.width / 2) * zoom;
  const y = pan.y + (bounds.y + bounds.height) * zoom + 9;
  elements.selectionSize.textContent =
    nodes.length > 1
      ? `${nodes.length} 层 · ${Math.round(bounds.width)} × ${Math.round(bounds.height)}`
      : `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
  elements.selectionSize.style.left = `${x}px`;
  elements.selectionSize.style.top = `${y}px`;
  elements.selectionSize.style.transform = "translateX(-50%)";
  elements.selectionSize.hidden = false;
}

function renderProperties() {
  const nodes = selectedNodes();
  const node = selectedNode();
  const single = nodes.length === 1 ? node : null;
  elements.noSelection.hidden = nodes.length !== 0;
  elements.multiSelection.hidden = nodes.length < 2;
  elements.canvasProperties.hidden = nodes.length !== 0;
  elements.selectionProperties.hidden = !single;
  if (nodes.length > 1) {
    elements.multiSelectionCount.textContent = `已选择 ${nodes.length} 个图层`;
    return;
  }
  if (!single) {
    canvasInputs.name.value = design.name;
    canvasInputs.width.value = String(round(design.canvas.width));
    canvasInputs.height.value = String(round(design.canvas.height));
    canvasInputs.background.value = design.canvas.background;
    canvasInputs.backgroundColor.value = design.canvas.background;
    return;
  }

  propertyInputs.name.value = single.name;
  propertyInputs.x.value = String(round(single.x));
  propertyInputs.y.value = String(round(single.y));
  propertyInputs.width.value = String(round(single.width));
  propertyInputs.height.value = String(round(single.height));
  propertyInputs.fill.value = single.fill;
  propertyInputs.stroke.value = single.stroke;
  propertyInputs.strokeWidth.value = String(round(single.strokeWidth));
  propertyInputs.cornerRadius.value = String(round(single.cornerRadius));
  propertyInputs.opacity.value = String(Math.round(single.opacity * 100));
  propertyInputs.rotation.value = String(round(single.rotation));
  propertyInputs.fillColor.value = validHex(single.fill) ? single.fill : "#ffffff";
  propertyInputs.strokeColor.value = validHex(single.stroke) ? single.stroke : "#000000";
  elements.toggleLock.classList.toggle("active", single.locked);
  elements.toggleVisible.classList.toggle("active", single.visible);
  elements.toggleLock.setAttribute("aria-pressed", String(single.locked));
  elements.toggleVisible.setAttribute("aria-pressed", String(single.visible));
  elements.toggleLock.textContent = single.locked ? "解" : "锁";
  elements.toggleVisible.textContent = single.visible ? "眼" : "隐";
  const container = isContainerNode(single);
  const parent = single.parentId ? nodeById(single.parentId) : null;
  const autoLayoutChild = Boolean(parent) && ["horizontal", "vertical"].includes(parent.layout);
  elements.parentField.hidden = container;
  elements.frameSection.hidden = !["frame", "group", "component"].includes(single.type);
  elements.containerSectionLabel.textContent =
    single.type === "component" ? "主组件" : single.type === "group" ? "编组" : "画板";
  elements.clipContentField.hidden = single.type === "group";
  elements.releaseFrame.hidden = single.type === "component";
  elements.releaseContainerLabel.textContent =
    single.type === "group" ? "解除编组，保留内容" : "解除画板，保留内容";
  propertyInputs.clipContent.checked = single.clipContent === true;
  elements.layoutSection.hidden = !container && !autoLayoutChild;
  elements.containerLayoutControls.hidden = !container;
  elements.childLayoutControls.hidden = !autoLayoutChild;
  if (container) {
    propertyInputs.layout.value = single.layout ?? "none";
    propertyInputs.gap.value = String(round(single.gap ?? 0));
    propertyInputs.padding.value = String(round(single.padding ?? 0));
    propertyInputs.alignItems.value = single.alignItems ?? "start";
    propertyInputs.justifyContent.value = single.justifyContent ?? "start";
  }
  if (autoLayoutChild) {
    propertyInputs.layoutGrow.checked = single.layoutGrow === 1;
    propertyInputs.layoutAlign.value = single.layoutAlign ?? "auto";
  }
  elements.componentSection.hidden = !["frame", "component", "instance"].includes(single.type);
  elements.makeComponent.hidden = single.type !== "frame";
  elements.createInstance.hidden = single.type !== "component";
  if (single.type === "component") {
    const instanceCount = design.nodes.filter(
      (candidate) => candidate.type === "instance" && candidate.componentId === single.id,
    ).length;
    elements.componentStatus.textContent = `主组件 · ${instanceCount} 个实例`;
  } else if (single.type === "instance") {
    const source = nodeById(single.componentId);
    elements.componentStatus.textContent = source
      ? `实例来自 ${source.name}`
      : "实例的主组件不存在";
  } else {
    elements.componentStatus.textContent = "将画板转换为可复用组件";
  }
  propertyInputs.parent.replaceChildren();
  const canvasOption = document.createElement("option");
  canvasOption.value = "";
  canvasOption.textContent = "画布（根级）";
  propertyInputs.parent.append(canvasOption);
  for (const frame of design.nodes.filter(
    (candidate) => isContainerNode(candidate) && candidate.id !== single.id,
  )) {
    const option = document.createElement("option");
    option.value = frame.id;
    option.textContent = frame.name;
    propertyInputs.parent.append(option);
  }
  propertyInputs.parent.value = single.parentId ?? "";
  propertyInputs.notes.value = single.notes ?? "";

  const isText = single.type === "text";
  elements.textSection.hidden = !isText;
  if (isText) {
    propertyInputs.text.value = single.text;
    propertyInputs.fontSize.value = String(single.fontSize);
    propertyInputs.fontWeight.value = String(single.fontWeight);
    propertyInputs.lineHeight.value = String(single.lineHeight);
    propertyInputs.textAlign.value = single.textAlign;
  }
}

function focusLayerRow(id) {
  requestAnimationFrame(() => {
    const row = [...elements.layersList.querySelectorAll(".layer-row")].find(
      (candidate) => candidate.dataset.id === id,
    );
    row?.focus();
  });
}

function renderLayers() {
  elements.layersList.replaceChildren();
  const normalizedFilter = layerFilter.trim().toLowerCase();
  const entries = layerEntries().filter(({ node }) => {
    if (!normalizedFilter) return true;
    return [node.name, node.id, node.type, node.notes]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedFilter));
  });
  const rovingId = entries.some(({ node }) => node.id === selectedId)
    ? selectedId
    : entries[0]?.node.id;
  for (const { node, depth } of entries) {
    const row = document.createElement("div");
    row.className = `layer-row${selectedIds.has(node.id) ? " active" : ""}`;
    row.dataset.id = node.id;
    row.dataset.hidden = String(!isEffectivelyVisible(node));
    row.role = "option";
    row.ariaSelected = String(selectedIds.has(node.id));
    row.ariaLabel = `${node.name}，${node.type}，${node.visible ? "可见" : "隐藏"}；按 V 切换显示`;
    row.style.setProperty("--layer-depth", String(depth));
    row.tabIndex = node.id === rovingId ? 0 : -1;

    const hasChildren = design.nodes.some((candidate) => candidate.parentId === node.id);
    const disclosure = document.createElement("button");
    disclosure.className = "layer-disclosure";
    disclosure.type = "button";
    disclosure.tabIndex = -1;
    disclosure.disabled = !hasChildren;
    disclosure.style.visibility = hasChildren ? "visible" : "hidden";
    disclosure.textContent = collapsedLayerIds.has(node.id) ? "›" : "⌄";
    disclosure.title = collapsedLayerIds.has(node.id) ? "展开图层" : "折叠图层";
    disclosure.setAttribute("aria-label", `${disclosure.title}：${node.name}`);
    disclosure.setAttribute("aria-expanded", String(!collapsedLayerIds.has(node.id)));
    disclosure.addEventListener("click", (event) => {
      event.stopPropagation();
      if (collapsedLayerIds.has(node.id)) collapsedLayerIds.delete(node.id);
      else collapsedLayerIds.add(node.id);
      renderLayers();
      focusLayerRow(node.id);
    });
    const kind = document.createElement("span");
    kind.className = "layer-kind";
    kind.textContent =
      node.type === "rectangle"
        ? "▭"
        : node.type === "ellipse"
          ? "○"
          : node.type === "text"
            ? "T"
            : node.type === "group"
              ? "▣"
              : node.type === "component"
                ? "◇"
                : node.type === "instance"
                  ? "◆"
                  : "F";
    const title = document.createElement("span");
    title.className = "layer-title";
    title.textContent = node.name;
    if (node.notes) title.title = node.notes;
    const visibility = document.createElement("button");
    visibility.className = "layer-visibility";
    visibility.type = "button";
    visibility.title = node.visible ? "隐藏图层" : "显示图层";
    visibility.setAttribute("aria-label", `${visibility.title}：${node.name}`);
    visibility.setAttribute("aria-pressed", String(node.visible));
    visibility.tabIndex = -1;
    visibility.textContent = node.visible ? "◉" : "○";
    visibility.addEventListener("click", (event) => {
      event.stopPropagation();
      node.visible = !node.visible;
      commitHistory();
      markChanged();
    });
    row.append(disclosure, kind, title, visibility);
    row.addEventListener("click", (event) => {
      if (event.shiftKey) toggleSelection(node.id);
      else selectOnly(node.id);
      setActiveTool("select");
      renderAll();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        node.visible = !node.visible;
        commitHistory();
        markChanged();
        focusLayerRow(node.id);
        return;
      }
      if (hasChildren && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        if (event.key === "ArrowLeft") collapsedLayerIds.add(node.id);
        else collapsedLayerIds.delete(node.id);
        renderLayers();
        focusLayerRow(node.id);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (event.shiftKey) toggleSelection(node.id);
        else selectOnly(node.id);
        renderAll();
        focusLayerRow(node.id);
        return;
      }
      const rows = [...elements.layersList.querySelectorAll(".layer-row")];
      const index = rows.indexOf(row);
      const targetIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : event.key === "ArrowUp"
              ? Math.max(0, index - 1)
              : event.key === "ArrowDown"
                ? Math.min(rows.length - 1, index + 1)
                : -1;
      if (targetIndex < 0 || targetIndex === index) return;
      event.preventDefault();
      const targetId = rows[targetIndex].dataset.id;
      selectOnly(targetId);
      setActiveTool("select");
      renderAll();
      focusLayerRow(targetId);
    });
    elements.layersList.append(row);
  }
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "layers-empty";
    empty.textContent = "没有匹配的图层";
    elements.layersList.append(empty);
  }
}

function renderTokens() {
  elements.colorTokens.replaceChildren();
  for (const [index, token] of (design.tokens?.colors ?? []).entries()) {
    const originalName = token.name;
    const row = document.createElement("div");
    row.className = "color-token-row";

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "color-token-apply";
    apply.style.background = token.value;
    apply.title = `应用 ${token.name} · ${token.value}`;
    apply.setAttribute("aria-label", apply.title);
    apply.addEventListener("click", () => {
      const nodes = selectedNodes().filter((node) => !isEffectivelyLocked(node));
      if (nodes.length === 0) return notify("先选择一个未锁定图层");
      for (const node of nodes) node.fill = token.value;
      commitHistory();
      markChanged();
    });

    const name = document.createElement("input");
    name.value = token.name;
    name.maxLength = 80;
    name.setAttribute("aria-label", `颜色变量 ${index + 1} 名称`);
    const validTokenName = (candidate) => {
      const normalized = candidate.trim().toLowerCase();
      return (
        normalized.length > 0 &&
        !/[\u0000-\u001f\u007f]/u.test(candidate) &&
        !design.tokens.colors.some(
          (other, candidateIndex) =>
            candidateIndex !== index && other.name.trim().toLowerCase() === normalized,
        )
      );
    };
    name.addEventListener("input", () => {
      const candidate = name.value.slice(0, 80);
      const valid = validTokenName(candidate);
      name.dataset.invalid = String(!valid);
      if (!valid) return;
      token.name = candidate;
      updateDirtyState();
      queueRecovery();
    });
    name.addEventListener("change", () => {
      const candidate = name.value.slice(0, 80).trim();
      if (!validTokenName(candidate)) {
        token.name = originalName;
        name.value = originalName;
        notify("颜色变量名称不能为空、包含控制字符或与现有名称重复", "error");
      } else {
        token.name = candidate;
      }
      name.dataset.invalid = "false";
      commitHistory();
      markChanged();
    });

    const value = document.createElement("input");
    value.value = token.value;
    value.maxLength = 7;
    value.spellcheck = false;
    value.setAttribute("aria-label", `${token.name} 色值`);
    value.addEventListener("input", () => {
      const valid = validHex(value.value);
      value.dataset.invalid = String(!valid);
      if (!valid) return;
      const nextValue = value.value.toLowerCase();
      replaceDesignColor(design, token.value, nextValue);
      token.value = nextValue;
      apply.style.background = token.value;
      updateDirtyState();
      queueRecovery();
      renderScene();
      renderProperties();
    });
    value.addEventListener("change", () => {
      value.value = token.value;
      value.dataset.invalid = "false";
      commitHistory();
      renderTokens();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "color-token-delete";
    remove.textContent = "×";
    remove.title = `删除 ${token.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => {
      design.tokens.colors.splice(index, 1);
      commitHistory();
      markChanged();
    });
    row.append(apply, name, value, remove);
    elements.colorTokens.append(row);
  }
}

function renderAll() {
  renderScene();
  renderProperties();
  renderLayers();
  renderTokens();
  elements.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  elements.grid.style.display = showGrid ? "" : "none";
  elements.toggleGrid.classList.toggle("active", showGrid);
  elements.toggleGrid.setAttribute("aria-pressed", String(showGrid));
  elements.toggleSnap.classList.toggle("active", snapEnabled);
  elements.toggleSnap.setAttribute("aria-pressed", String(snapEnabled));
  updateCursor();
}

function validHex(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function setActiveTool(tool) {
  activeTool = tool;
  for (const button of document.querySelectorAll("[data-tool]")) {
    const active = button.dataset.tool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  updateCursor();
}

function updateCursor() {
  const panning = interaction?.kind === "pan";
  elements.stage.dataset.cursor = panning
    ? "grabbing"
    : activeTool === "hand" || spacePressed
      ? "grab"
      : activeTool === "select"
        ? "select"
        : "crosshair";
}

function documentPoint(event) {
  const rect = elements.stage.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - pan.x) / zoom,
    y: (event.clientY - rect.top - pan.y) / zoom,
  };
}

function pointerDown(event) {
  if (event.button !== 0 && event.button !== 1) return;
  const point = documentPoint(event);
  const handle = event.target.closest?.("[data-handle]")?.dataset.handle;
  const targetId = event.target.closest?.("[data-node-id]")?.dataset.nodeId;
  const shouldPan = activeTool === "hand" || spacePressed || event.button === 1;

  if (shouldPan) {
    interaction = {
      kind: "pan",
      startClient: { x: event.clientX, y: event.clientY },
      startPan: { ...pan },
    };
  } else if (handle && selectedNodes().length === 1 && selectedNode()) {
    const node = selectedNode();
    interaction = {
      kind: "resize",
      handle,
      start: point,
      bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
    };
  } else if (activeTool === "select") {
    if (!targetId) {
      const additive = event.shiftKey;
      const baselineIds = additive ? new Set(selectedIds) : new Set();
      if (!additive) clearSelection();
      interaction = {
        kind: "marquee",
        start: point,
        current: point,
        baselineIds,
      };
      renderAll();
    } else if (event.shiftKey) {
      toggleSelection(targetId);
      renderAll();
      return;
    } else {
      if (!selectedIds.has(targetId)) selectOnly(targetId);
      const node = design.nodes.find((candidate) => candidate.id === targetId);
      const movableNodes = selectedTransformNodes();
      if (node && !isEffectivelyLocked(node) && movableNodes.length > 0) {
        const movingIds = new Set(movableNodes.map((candidate) => candidate.id));
        interaction = {
          kind: "move",
          start: point,
          bounds: visualSelectionBounds(movableNodes, design.nodes),
          origins: new Map(
            movableNodes.map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]),
          ),
          movingIds,
          inheritsRotation: movableNodes.some((candidate) => {
            const parent =
              candidate.parentId && !movingIds.has(candidate.parentId)
                ? nodeById(candidate.parentId)
                : null;
            return Boolean(parent?.rotation);
          }),
          moved: false,
          guides: [],
        };
      }
      renderAll();
    }
  } else {
    if (!canAddNodes(1)) return;
    const parent = activeTool === "frame" ? null : containingFrame(point);
    const localPoint = pointToParentSpace(point, parent) ?? point;
    const origin = snapPoint(localPoint, event.altKey);
    const node = baseNode(activeTool, {
      x: round(origin.x),
      y: round(origin.y),
      width: activeTool === "text" ? 240 : 1,
      height: activeTool === "text" ? 54 : 1,
      ...(parent ? { parentId: parent.id } : {}),
    });
    design.nodes.push(node);
    if (parent) normalizeNodeTreeOrder(design.nodes);
    if (activeTool === "text") {
      node.text = "输入文字";
      reflowParent(node);
      selectOnly(node.id);
      setActiveTool("select");
      commitHistory();
      markChanged();
      requestAnimationFrame(() => {
        propertyInputs.text.focus();
        propertyInputs.text.select();
      });
      return;
    }
    selectOnly(node.id);
    interaction = {
      kind: "create",
      start: origin,
      nodeId: node.id,
      tool: activeTool,
    };
    renderAll();
  }
  elements.stage.setPointerCapture(event.pointerId);
  updateCursor();
}

function pointerMove(event) {
  if (!interaction) return;
  const point = documentPoint(event);
  if (interaction.kind === "pan") {
    pan.x = interaction.startPan.x + event.clientX - interaction.startClient.x;
    pan.y = interaction.startPan.y + event.clientY - interaction.startClient.y;
    renderScene();
    return;
  }
  if (interaction.kind === "marquee") {
    interaction.current = point;
    const left = Math.min(interaction.start.x, point.x);
    const top = Math.min(interaction.start.y, point.y);
    const right = Math.max(interaction.start.x, point.x);
    const bottom = Math.max(interaction.start.y, point.y);
    const enclosed = design.nodes
      .filter((node) => {
        if (!isEffectivelyVisible(node)) return false;
        const bounds = transformedNodeBounds(node, node.parentId ? nodeById(node.parentId) : null);
        return (
          bounds &&
          bounds.x >= left &&
          bounds.x + bounds.width <= right &&
          bounds.y >= top &&
          bounds.y + bounds.height <= bottom
        );
      })
      .map((node) => node.id);
    selectedIds = new Set([...interaction.baselineIds, ...enclosed]);
    selectedId = enclosed.at(-1) ?? [...selectedIds].at(-1) ?? null;
    renderAll();
    return;
  }
  if (interaction.kind === "move") {
    const anchorOrigin =
      interaction.origins.get(selectedId) ?? interaction.origins.values().next().value;
    let deltaX = point.x - interaction.start.x;
    let deltaY = point.y - interaction.start.y;
    if (snapEnabled && !event.altKey && anchorOrigin && !interaction.inheritsRotation) {
      deltaX = snapValue(anchorOrigin.x + deltaX) - anchorOrigin.x;
      deltaY = snapValue(anchorOrigin.y + deltaY) - anchorOrigin.y;
    }
    if (snapEnabled && !event.altKey && interaction.bounds && !interaction.inheritsRotation) {
      const stationaryNodes = design.nodes.filter(
        (node) => !interaction.origins.has(node.id) && isEffectivelyVisible(node),
      );
      const stationaryBounds = stationaryNodes.map((node) => ({
        ...transformedNodeBounds(node, node.parentId ? nodeById(node.parentId) : null),
        id: node.id,
      }));
      const snapped = snapBoundsToNodes(
        interaction.bounds,
        stationaryBounds,
        { x: deltaX, y: deltaY },
        6 / zoom,
      );
      deltaX = snapped.x;
      deltaY = snapped.y;
      interaction.guides = snapped.guides;
    } else {
      interaction.guides = [];
    }
    for (const [nodeId, origin] of interaction.origins) {
      const node = nodeById(nodeId);
      if (!node) continue;
      const nodeDelta = visualDeltaForNode(node, { x: deltaX, y: deltaY }, interaction.movingIds);
      node.x = round(origin.x + nodeDelta.x);
      node.y = round(origin.y + nodeDelta.y);
    }
    interaction.moved =
      interaction.moved ||
      Math.abs(point.x - interaction.start.x) > 0.2 ||
      Math.abs(point.y - interaction.start.y) > 0.2;
  } else if (interaction.kind === "create") {
    const node = selectedNode();
    if (!node) return;
    const parent = node.parentId ? nodeById(node.parentId) : null;
    const localPoint = pointToParentSpace(point, parent) ?? point;
    const snapped = snapPoint(localPoint, event.altKey);
    let endX = snapped.x;
    let endY = snapped.y;
    if (event.shiftKey) {
      const size = Math.max(
        Math.abs(endX - interaction.start.x),
        Math.abs(endY - interaction.start.y),
      );
      endX = interaction.start.x + (endX < interaction.start.x ? -size : size);
      endY = interaction.start.y + (endY < interaction.start.y ? -size : size);
    }
    node.x = round(Math.min(endX, interaction.start.x));
    node.y = round(Math.min(endY, interaction.start.y));
    node.width = round(Math.max(1, Math.abs(endX - interaction.start.x)));
    node.height = round(Math.max(1, Math.abs(endY - interaction.start.y)));
  } else if (interaction.kind === "resize") {
    const node = selectedNode();
    if (!node) return;
    resizeNode(node, snapPoint(point, event.altKey), interaction, event.shiftKey);
  }
  updateDirtyState();
  renderScene();
  renderProperties();
}

function resizeNode(node, point, state, preserveAspect) {
  const minimum = 4;
  const right = state.bounds.x + state.bounds.width;
  const bottom = state.bounds.y + state.bounds.height;
  if (preserveAspect) {
    const anchorX = state.handle.includes("w") ? right : state.bounds.x;
    const anchorY = state.handle.includes("n") ? bottom : state.bounds.y;
    const directionX = state.handle.includes("w") ? -1 : 1;
    const directionY = state.handle.includes("n") ? -1 : 1;
    const aspect = state.bounds.width / state.bounds.height;
    let width = Math.max(minimum, Math.abs(point.x - anchorX));
    let height = Math.max(minimum, Math.abs(point.y - anchorY));
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    node.width = round(width);
    node.height = round(height);
    node.x = round(directionX < 0 ? anchorX - width : anchorX);
    node.y = round(directionY < 0 ? anchorY - height : anchorY);
    return;
  }
  if (state.handle.includes("w")) {
    node.x = round(Math.min(point.x, right - minimum));
    node.width = round(Math.max(minimum, right - point.x));
  }
  if (state.handle.includes("e")) {
    node.width = round(Math.max(minimum, point.x - state.bounds.x));
  }
  if (state.handle.includes("n")) {
    node.y = round(Math.min(point.y, bottom - minimum));
    node.height = round(Math.max(minimum, bottom - point.y));
  }
  if (state.handle.includes("s")) {
    node.height = round(Math.max(minimum, point.y - state.bounds.y));
  }
}

function finishInteraction(pointerId = null) {
  if (!interaction) return;
  const finished = interaction;
  interaction = null;
  if (Number.isInteger(pointerId) && elements.stage.hasPointerCapture(pointerId)) {
    elements.stage.releasePointerCapture(pointerId);
  }
  const node = selectedNode();
  if (finished.kind === "create" && node && (node.width < 4 || node.height < 4)) {
    node.width = finished.tool === "frame" ? 390 : 160;
    node.height = finished.tool === "frame" ? 260 : 120;
  }
  const changed =
    finished.kind === "create" ||
    finished.kind === "resize" ||
    (finished.kind === "move" && finished.moved);
  if (changed) {
    if (node) {
      reflowParent(node);
      if (isContainerNode(node)) applyAutoLayout(design.nodes, node.id);
    }
    commitHistory();
    markChanged(false);
  }
  if (finished.kind === "create") setActiveTool("select");
  renderAll();
}

function pointerUp(event) {
  finishInteraction(event.pointerId);
}

function duplicateSelected() {
  if (selectedIds.size === 0) return;
  const sourceIds = new Set([
    ...selectedIds,
    ...descendantIds(
      design.nodes,
      new Set(
        selectedNodes()
          .filter((node) => isContainerNode(node))
          .map((node) => node.id),
      ),
    ),
  ]);
  const sources = design.nodes.filter((node) => sourceIds.has(node.id));
  if (!canAddNodes(sources.length)) return;
  const { copies, idMap } = cloneNodeSet(sources, selectedIds);
  design.nodes.push(...copies);
  normalizeNodeTreeOrder(design.nodes);
  reflowLayouts();
  selectedIds = new Set([...selectedIds].map((id) => idMap.get(id)));
  selectedId = [...selectedIds].at(-1) ?? null;
  commitHistory();
  markChanged();
}

function cloneNodeSet(sources, sourceSelectionIds) {
  const idMap = new Map(
    sources.map((node, index) => [
      node.id,
      `${node.type}-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    ]),
  );
  const copies = sources.map((source) => {
    const copy = clone(source);
    copy.id = idMap.get(source.id);
    if (sourceSelectionIds.has(source.id)) copy.name = `${copy.name} 副本`;
    copy.x += 18;
    copy.y += 18;
    if (copy.parentId && idMap.has(copy.parentId)) copy.parentId = idMap.get(copy.parentId);
    if (copy.componentId && idMap.has(copy.componentId)) {
      copy.componentId = idMap.get(copy.componentId);
    }
    return copy;
  });
  return { copies, idMap };
}

function copySelected() {
  if (selectedIds.size === 0) return;
  const sourceIds = new Set([
    ...selectedIds,
    ...descendantIds(
      design.nodes,
      new Set(
        selectedNodes()
          .filter((node) => isContainerNode(node))
          .map((node) => node.id),
      ),
    ),
  ]);
  copiedNodes = clone(design.nodes.filter((node) => sourceIds.has(node.id)));
  copiedSelectionIds = new Set(selectedIds);
  copiedDocumentEpoch = documentEpoch;
  rememberClipboardParents(copiedNodes);
  notify(
    selectedIds.size === 1 ? `已复制 ${selectedNode().name}` : `已复制 ${selectedIds.size} 个图层`,
  );
}

function rememberClipboardParents(nodes) {
  const copiedIds = new Set(nodes.map((node) => node.id));
  copiedParentFrames = new Map();
  for (const node of nodes) {
    if (!node.parentId || copiedIds.has(node.parentId) || copiedParentFrames.has(node.parentId)) {
      continue;
    }
    const parent = nodeById(node.parentId);
    if (isContainerNode(parent)) copiedParentFrames.set(parent.id, clone(parent));
  }
}

function pasteCopied() {
  if (copiedNodes.length === 0) return;
  if (!canAddNodes(copiedNodes.length)) return;
  const { copies, idMap } = cloneNodeSet(copiedNodes, copiedSelectionIds);
  const pastedFrameIds = new Set(
    copies.filter((node) => isContainerNode(node)).map((node) => node.id),
  );
  const availableFrameIds = new Set([
    ...design.nodes.filter((node) => isContainerNode(node)).map((node) => node.id),
    ...pastedFrameIds,
  ]);
  const crossDocument = copiedDocumentEpoch !== documentEpoch;
  let detached = 0;
  for (const copy of copies) {
    if (
      copy.parentId &&
      (!availableFrameIds.has(copy.parentId) ||
        (crossDocument && !pastedFrameIds.has(copy.parentId)))
    ) {
      const previousParent = copiedParentFrames.get(copy.parentId) ?? null;
      if (previousParent) detachNodeFromParent(copy, previousParent);
      else delete copy.parentId;
      detached += 1;
    }
  }
  design.nodes.push(...copies);
  normalizeNodeTreeOrder(design.nodes);
  reflowLayouts();
  selectedIds = new Set([...copiedSelectionIds].map((id) => idMap.get(id)));
  selectedId = [...selectedIds].at(-1) ?? null;
  copiedNodes = clone(copies);
  copiedSelectionIds = new Set(selectedIds);
  copiedDocumentEpoch = documentEpoch;
  rememberClipboardParents(copiedNodes);
  commitHistory();
  markChanged();
  if (detached > 0) notify(`${detached} 个图层已脱离原文件中的画板`);
}

function deleteSelected() {
  const deletableRootIds = new Set(
    selectedNodes()
      .filter((node) => !isEffectivelyLocked(node))
      .map((node) => node.id),
  );
  const deletableIds = new Set([
    ...deletableRootIds,
    ...descendantIds(design.nodes, deletableRootIds),
  ]);
  const deletedComponentIds = new Set(
    design.nodes
      .filter((node) => deletableIds.has(node.id) && node.type === "component")
      .map((node) => node.id),
  );
  for (const node of design.nodes) {
    if (node.type === "instance" && deletedComponentIds.has(node.componentId)) {
      deletableIds.add(node.id);
    }
  }
  if (deletableIds.size === 0) return;
  const affectedParents = new Set(
    design.nodes
      .filter((candidate) => deletableIds.has(candidate.id) && candidate.parentId)
      .map((candidate) => candidate.parentId),
  );
  design.nodes = design.nodes.filter((candidate) => !deletableIds.has(candidate.id));
  for (const parentId of affectedParents) applyAutoLayout(design.nodes, parentId);
  selectedIds = new Set([...selectedIds].filter((id) => !deletableIds.has(id)));
  selectedId = [...selectedIds].at(-1) ?? null;
  commitHistory();
  markChanged();
}

function frameSelectedNodes() {
  const nodes = selectedNodes();
  if (nodes.length === 0) return;
  if (nodes.some((node) => isContainerNode(node))) {
    notify("容器不能嵌套；请只选择普通图层", "error");
    return;
  }
  if (nodes.some((node) => node.parentId)) {
    notify("新画板必须位于根级；请先释放原容器或把图层移到画布", "error");
    return;
  }
  if (nodes.some((node) => isEffectivelyLocked(node))) {
    notify("请先解锁所选图层", "error");
    return;
  }
  if (!canAddNodes(1)) return;
  ensureDesignV2();
  const frame = baseNode("frame", {
    name: "Selection frame",
    cornerRadius: 16,
    fill: "#ffffff",
    stroke: "#d7d7d1",
    strokeWidth: 1,
  });
  if (!wrapNodesInFrame(design.nodes, selectedIds, frame)) return;
  selectOnly(frame.id);
  commitHistory();
  markChanged();
}

function groupSelectedNodes() {
  const nodes = selectedNodes();
  if (nodes.length === 0) return;
  if (nodes.some((node) => isContainerNode(node) || node.parentId)) {
    notify("编组目前只支持画布上的普通图层", "error");
    return;
  }
  if (nodes.some((node) => isEffectivelyLocked(node))) {
    notify("请先解锁所选图层", "error");
    return;
  }
  if (!canAddNodes(1)) return;
  ensureDesignV2();
  const group = baseNode("group", {
    name: "图层组",
    cornerRadius: 0,
    fill: "transparent",
    padding: 0,
  });
  if (!wrapNodesInFrame(design.nodes, selectedIds, group, 0)) return;
  selectOnly(group.id);
  commitHistory();
  markChanged();
}

function makeSelectedComponent() {
  const frame = selectedNode();
  if (!frame || selectedIds.size !== 1 || frame.type !== "frame") {
    return notify("请先选择一个画板");
  }
  if (frame.locked) return notify("请先解锁画板", "error");
  ensureDesignV2();
  frame.type = "component";
  frame.name = frame.name.endsWith(" · 组件") ? frame.name : `${frame.name} · 组件`;
  commitHistory();
  markChanged();
  notify("已创建主组件；修改它会同步到所有实例");
}

function createSelectedComponentInstance() {
  const component = selectedNode();
  if (!component || selectedIds.size !== 1 || component.type !== "component") {
    return notify("请先选择一个主组件");
  }
  if (!canAddNodes(1)) return;
  ensureDesignV2();
  const id = `instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const instance = createComponentInstance(component, id, 32, design.canvas);
  if (!instance) return;
  design.nodes.push(instance);
  normalizeNodeTreeOrder(design.nodes);
  selectOnly(instance.id);
  commitHistory();
  markChanged();
  notify(`已创建 ${component.name} 的实例`);
  requestAnimationFrame(fitSelection);
}

function releaseSelectedFrame() {
  const frame = selectedNode();
  if (!frame || selectedIds.size !== 1 || !["frame", "group"].includes(frame.type)) return;
  if (frame.locked) return notify("请先解锁容器", "error");
  const childIds = design.nodes.filter((node) => node.parentId === frame.id).map((node) => node.id);
  if (!releaseFrame(design.nodes, frame.id)) return;
  selectedIds = new Set(childIds);
  selectedId = childIds.at(-1) ?? null;
  commitHistory();
  markChanged();
}

function setOrder(direction) {
  if (!moveSelectedNodes(design.nodes, selectedIds, direction)) return;
  reflowLayouts();
  commitHistory();
  markChanged();
}

function alignSelected(alignment) {
  const ids = new Set(
    selectedNodes()
      .filter((node) => !isEffectivelyLocked(node))
      .map((node) => node.id),
  );
  if (!alignNodeTrees(design.nodes, ids, alignment, design.canvas)) return;
  commitHistory();
  markChanged();
}

function distributeSelected(axis) {
  const ids = new Set(
    selectedNodes()
      .filter((node) => !isEffectivelyLocked(node))
      .map((node) => node.id),
  );
  const rootCount = [...ids].filter((id) => {
    const node = nodeById(id);
    return node && (!node.parentId || !ids.has(node.parentId));
  }).length;
  if (rootCount < 3) return notify("等距分布至少需要 3 个独立的未锁定图层");
  if (!distributeNodeTrees(design.nodes, ids, axis)) return;
  commitHistory();
  markChanged();
}

function setZoom(next, focalClient) {
  const nextZoom = clamp(next, 0.1, 4);
  const rect = elements.stage.getBoundingClientRect();
  const focal = focalClient ?? {
    x: rect.left + elements.stage.clientWidth / 2,
    y: rect.top + elements.stage.clientHeight / 2,
  };
  const documentX = (focal.x - rect.left - pan.x) / zoom;
  const documentY = (focal.y - rect.top - pan.y) / zoom;
  pan.x = focal.x - rect.left - documentX * nextZoom;
  pan.y = focal.y - rect.top - documentY * nextZoom;
  zoom = nextZoom;
  renderAll();
}

function fitCanvas() {
  const padding = 62;
  const width = Math.max(100, elements.stage.clientWidth - padding * 2);
  const height = Math.max(100, elements.stage.clientHeight - padding * 2);
  zoom = clamp(Math.min(width / design.canvas.width, height / design.canvas.height), 0.1, 2);
  pan.x = (elements.stage.clientWidth - design.canvas.width * zoom) / 2;
  pan.y = (elements.stage.clientHeight - design.canvas.height * zoom) / 2;
  renderAll();
}

function fitSelection() {
  const bounds = visualSelectionBounds(selectedNodes(), design.nodes);
  if (!bounds) {
    fitCanvas();
    return;
  }
  const padding = 96;
  const width = Math.max(100, elements.stage.clientWidth - padding * 2);
  const height = Math.max(100, elements.stage.clientHeight - padding * 2);
  zoom = clamp(
    Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height)),
    0.1,
    4,
  );
  pan.x = elements.stage.clientWidth / 2 - (bounds.x + bounds.width / 2) * zoom;
  pan.y = elements.stage.clientHeight / 2 - (bounds.y + bounds.height / 2) * zoom;
  renderAll();
}

function normalizeDocument(input) {
  return normalizeDesignDocument(input);
}

function safeDesignPath(value) {
  return isSafeDesignPath(value);
}

function mockHostCall(method, params = {}) {
  const prefix = "codeshell-design-studio:";
  if (method === "storage.get") {
    return Promise.resolve(
      JSON.parse(localStorage.getItem(`${prefix}storage:${params.key}`) || "null"),
    );
  }
  if (method === "storage.set") {
    localStorage.setItem(`${prefix}storage:${params.key}`, JSON.stringify(params.value));
    return Promise.resolve(true);
  }
  if (method === "storage.delete") {
    localStorage.removeItem(`${prefix}storage:${params.key}`);
    return Promise.resolve(true);
  }
  if (method === "workspace.info") {
    return Promise.resolve({
      name: "codeshell",
      root: "/preview/codeshell",
      trusted: true,
      gitBranch: "preview",
    });
  }
  if (method === "workspace.list") {
    const entriesByPath = new Map();
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${prefix}file:`)) continue;
      const path = key.slice(`${prefix}file:`.length);
      if (!path.startsWith(`${params.path}/`)) continue;
      const remainder = path.slice(`${params.path}/`.length);
      if (remainder.includes("/")) {
        const directoryName = remainder.split("/")[0];
        const directoryPath = `${params.path}/${directoryName}`;
        entriesByPath.set(directoryPath, {
          name: directoryName,
          path: directoryPath,
          kind: "directory",
        });
        continue;
      }
      const content = localStorage.getItem(key) || "";
      entriesByPath.set(path, {
        name: path.split("/").pop(),
        path,
        kind: "file",
        size: content.length,
        modifiedAt: Date.now(),
      });
    }
    return Promise.resolve({
      path: params.path,
      entries: [...entriesByPath.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      truncated: false,
    });
  }
  if (method === "workspace.readText") {
    const content = localStorage.getItem(`${prefix}file:${params.path}`);
    if (content == null) return Promise.reject(new Error("file not found"));
    const modifiedAt = Number(localStorage.getItem(`${prefix}mtime:${params.path}`)) || Date.now();
    return Promise.resolve({
      path: params.path,
      content,
      size: content.length,
      modifiedAt,
      revision: `preview:${modifiedAt}`,
    });
  }
  if (method === "workspace.writeText") {
    const modifiedAt = Date.now();
    localStorage.setItem(`${prefix}file:${params.path}`, params.content);
    localStorage.setItem(`${prefix}mtime:${params.path}`, String(modifiedAt));
    return Promise.resolve({
      path: params.path,
      size: params.content.length,
      modifiedAt,
      revision: `preview:${modifiedAt}`,
    });
  }
  if (method === "agent.submitPrompt") {
    return Promise.resolve({ accepted: true });
  }
  return Promise.resolve(null);
}

function hostCall(method, params) {
  if (window.codeshellPanel?.call) return window.codeshellPanel.call(method, params);
  return mockHostCall(method, params);
}

function assertWorkspaceEpoch(expectedEpoch) {
  if (workspaceEpoch !== expectedEpoch) {
    throw new Error("工作区已在操作期间切换；旧操作已取消，请在当前仓库重试");
  }
}

async function writeRepoText(path, content, expectedWorkspaceEpoch = workspaceEpoch) {
  let expectedModifiedAt = null;
  let expectedRevision = null;
  try {
    const existing = await hostCall("workspace.readText", { path });
    expectedModifiedAt = existing.modifiedAt;
    expectedRevision = existing.revision;
  } catch {
    // A missing output is created; an unreadable existing output fails the host create-only guard.
  }
  assertWorkspaceEpoch(expectedWorkspaceEpoch);
  const result = await hostCall("workspace.writeText", {
    path,
    content,
    expectedModifiedAt,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  assertWorkspaceEpoch(expectedWorkspaceEpoch);
  return result;
}

async function performSaveDocument({ quiet = false } = {}) {
  const operationWorkspaceEpoch = workspaceEpoch;
  const operationWorkspaceIdentity = context.cwd ?? null;
  const operationWorkspaceRoot = operationWorkspaceIdentity ?? "preview";
  const path = elements.path.value.trim();
  if (!safeDesignPath(path)) {
    const message = "路径需位于 designs/，并以 .codesign.json 结尾";
    setSaveState("路径无效", "error");
    notify(message, "error");
    throw new Error(message);
  }
  let content;
  let savedDesign;
  try {
    design = normalizeDocument(design);
    assertDesignDocumentSize(design);
    savedDesign = clone(design);
    content = serializeDesign();
  } catch (error) {
    const message = error instanceof Error ? error.message : "设计文件无效";
    setSaveState(message.includes("KiB") ? "文件过大" : "设计无效", "error");
    notify(message, "error");
    throw error;
  }
  clearTimeout(recoveryTimer);
  elements.save.disabled = true;
  elements.path.disabled = true;
  setSaveState("保存中…", "idle");
  try {
    const replacesCurrentSource = path === currentSourcePath;
    const result = await hostCall("workspace.writeText", {
      path,
      content,
      expectedModifiedAt: replacesCurrentSource ? currentModifiedAt : null,
      ...(replacesCurrentSource && currentRevision ? { expectedRevision: currentRevision } : {}),
    });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    currentModifiedAt = result.modifiedAt;
    currentRevision = result.revision;
    warnedExternalVersion = null;
    currentSourcePath = path;
    currentSourceModifiedAt = result.modifiedAt;
    currentSourceRevision = result.revision;
    fileDiscoveryCache = null;
    savedSnapshot = content;
    recoveryFailureWarned = false;
    updateDirtyState();
    setRepoLinkState("Repo · 已保存", "linked");
    await hostCall("storage.set", {
      key: scopedStorageKey("lastPath", operationWorkspaceRoot),
      value: { workspaceRoot: operationWorkspaceIdentity, path },
    }).catch(() => undefined);
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    if (dirty) queueRecovery();
    else
      await hostCall("storage.delete", {
        key: scopedStorageKey("recovery", operationWorkspaceRoot),
      }).catch(() => undefined);
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    if (!quiet) notify(`已保存到 ${path}`);
    return { ...result, design: savedDesign };
  } catch (error) {
    if (workspaceEpoch !== operationWorkspaceEpoch) throw error;
    const message = error instanceof Error ? error.message : "保存失败";
    queueRecovery();
    setSaveState("保存失败", "error");
    notify(
      message.includes("changed since")
        ? "文件已在面板外变化。请重新打开，或改一个文件名保存副本。"
        : message,
      "error",
    );
    throw error;
  } finally {
    if (workspaceEpoch === operationWorkspaceEpoch) {
      elements.save.disabled = context.trusted !== true;
      elements.path.disabled = false;
    }
  }
}

function saveDocument(options = {}) {
  if (saveInFlight?.workspaceEpoch === workspaceEpoch) return saveInFlight.operation;
  const operation = performSaveDocument(options);
  const entry = { workspaceEpoch, operation };
  saveInFlight = entry;
  const clearInFlight = () => {
    if (saveInFlight === entry) saveInFlight = null;
  };
  void operation.then(clearInFlight, clearInFlight);
  return operation;
}

async function openDocument(path, { discardChanges = false } = {}) {
  const operationWorkspaceEpoch = workspaceEpoch;
  const operationWorkspaceIdentity = context.cwd ?? null;
  const operationWorkspaceRoot = operationWorkspaceIdentity ?? "preview";
  if (
    !discardChanges &&
    dirty &&
    !window.confirm("当前设计有未保存修改。确定要放弃这些修改并打开另一个文件吗？")
  ) {
    return false;
  }
  clearTimeout(recoveryTimer);
  setSaveState("打开中…", "idle");
  try {
    const result = await hostCall("workspace.readText", { path });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    design = normalizeDocument(JSON.parse(result.content));
    documentEpoch += 1;
    clearSelection();
    currentModifiedAt = result.modifiedAt;
    currentRevision = result.revision;
    warnedExternalVersion = null;
    currentSourcePath = path;
    currentSourceModifiedAt = result.modifiedAt;
    currentSourceRevision = result.revision;
    elements.path.value = path;
    savedSnapshot = serializeDesign();
    resetHistory();
    updateDirtyState();
    setRepoLinkState("Repo · 已打开", "linked");
    renderAll();
    requestAnimationFrame(fitCanvas);
    await hostCall("storage.set", {
      key: scopedStorageKey("lastPath", operationWorkspaceRoot),
      value: { workspaceRoot: operationWorkspaceIdentity, path },
    }).catch(() => undefined);
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    await hostCall("storage.delete", {
      key: scopedStorageKey("recovery", operationWorkspaceRoot),
    }).catch(() => undefined);
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    notify(`已打开 ${path}`);
    return true;
  } catch (error) {
    if (workspaceEpoch !== operationWorkspaceEpoch) throw error;
    const message = error instanceof Error ? error.message : "打开失败";
    if (dirty && !discardChanges) queueRecovery();
    setSaveState("打开失败", "error");
    notify(message, "error");
    throw error;
  }
}

async function checkExternalChange({ force = false } = {}) {
  if (
    !currentSourcePath ||
    elements.path.value.trim() !== currentSourcePath ||
    checkingExternalChange
  ) {
    return false;
  }
  const operationWorkspaceEpoch = workspaceEpoch;
  const operationDocumentEpoch = documentEpoch;
  const sourcePath = currentSourcePath;
  const sourceRevision = currentSourceRevision;
  const sourceModifiedAt = currentSourceModifiedAt;
  const now = Date.now();
  if (!force && now - lastExternalCheckAt < 1_500) return false;
  checkingExternalChange = true;
  lastExternalCheckAt = now;
  try {
    const disk = await hostCall("workspace.readText", { path: sourcePath });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    if (operationDocumentEpoch !== documentEpoch || currentSourcePath !== sourcePath) return false;
    const changed =
      sourceRevision && disk.revision
        ? sourceRevision !== disk.revision
        : sourceModifiedAt != null && Math.abs(sourceModifiedAt - disk.modifiedAt) > 0.001;
    if (!changed) {
      const hadExternalWarning = Boolean(warnedExternalVersion);
      warnedExternalVersion = null;
      if (hadExternalWarning) updateDirtyState();
      return false;
    }
    const externalVersion = disk.revision ?? `mtime:${disk.modifiedAt}`;
    if (!dirty) {
      try {
        const nextDesign = normalizeDocument(JSON.parse(disk.content));
        assertWorkspaceEpoch(operationWorkspaceEpoch);
        if (operationDocumentEpoch !== documentEpoch || currentSourcePath !== sourcePath) {
          return false;
        }
        design = nextDesign;
        documentEpoch += 1;
        clearSelection();
        currentModifiedAt = disk.modifiedAt;
        currentRevision = disk.revision;
        currentSourceModifiedAt = disk.modifiedAt;
        currentSourceRevision = disk.revision;
        warnedExternalVersion = null;
        savedSnapshot = serializeDesign();
        resetHistory();
        updateDirtyState();
        renderAll();
        setRepoLinkState("Repo 已同步", "linked");
        notify(`已同步 Agent 对 ${sourcePath} 的修改`);
        return true;
      } catch (error) {
        warnedExternalVersion = externalVersion;
        setSaveState("Repo 文件无效", "error");
        notify(error instanceof Error ? error.message : "Repo 中的设计文件无效", "error");
        return true;
      }
    }
    if (warnedExternalVersion === externalVersion) return true;
    warnedExternalVersion = externalVersion;
    setSaveState(dirty ? "外部变更 · 本地有修改" : "源文件已在外部变更", "error");
    notify("源文件和本地画布都已变化。请从文件列表重新打开，或改名保存副本。", "error");
    return true;
  } catch {
    // A later explicit open or save surfaces missing/unreadable source details.
    return false;
  } finally {
    checkingExternalChange = false;
  }
}

async function discoverDesignFiles() {
  const operationWorkspaceEpoch = workspaceEpoch;
  const now = Date.now();
  if (fileDiscoveryCache && now - fileDiscoveryCachedAt < 3_000) {
    return fileDiscoveryCache;
  }
  const queue = ["designs"];
  const files = [];
  const maxDirectories = 16;
  const maxFiles = 200;
  let truncated = false;
  let processedDirectories = 0;
  for (
    let index = 0;
    index < queue.length && index < maxDirectories && files.length < maxFiles;
    index += 1
  ) {
    let listing;
    try {
      listing = await hostCall("workspace.list", { path: queue[index] });
    } catch {
      if (queue[index] === "designs") {
        fileDiscoveryCache = { files: [], truncated: false };
        fileDiscoveryCachedAt = Date.now();
        return fileDiscoveryCache;
      }
      truncated = true;
      continue;
    }
    processedDirectories += 1;
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    if (listing?.truncated) truncated = true;
    for (const entry of listing?.entries ?? []) {
      if (entry.kind === "file" && entry.path.endsWith(".codesign.json")) {
        if (files.length < maxFiles) files.push(entry);
        else truncated = true;
      } else if (entry.kind === "directory" && !queue.includes(entry.path)) {
        queue.push(entry.path);
      }
    }
  }
  if (queue.length > maxDirectories || queue.length > processedDirectories) truncated = true;
  assertWorkspaceEpoch(operationWorkspaceEpoch);
  fileDiscoveryCache = {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    truncated,
  };
  fileDiscoveryCachedAt = Date.now();
  return fileDiscoveryCache;
}

async function showFiles() {
  const operationWorkspaceEpoch = workspaceEpoch;
  elements.filesList.replaceChildren();
  elements.workspaceSummary.textContent = "正在读取工作区…";
  elements.filesDialog.showModal();
  try {
    const [workspace, discovery] = await Promise.all([
      hostCall("workspace.info", {}),
      discoverDesignFiles(),
    ]);
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    elements.workspaceSummary.textContent = workspace?.name
      ? `${workspace.name} · ${workspace.gitBranch ?? "无 Git 分支"} · ${workspace.trusted ? "已信任" : "只读"}${discovery.truncated ? " · 仅显示部分文件" : ""}`
      : "当前工作区";
    const files = discovery.files;
    if (!files.length) {
      const empty = document.createElement("div");
      empty.className = "files-empty";
      empty.textContent = "还没有设计文件。保存当前画布即可创建第一个。";
      elements.filesList.append(empty);
      return;
    }
    for (const file of files) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-row";
      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = "D";
      const copy = document.createElement("span");
      copy.className = "file-copy";
      const name = document.createElement("strong");
      name.textContent = file.name.replace(/\.codesign\.json$/, "");
      const path = document.createElement("span");
      path.textContent = file.path;
      copy.append(name, path);
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = formatBytes(file.size);
      button.append(icon, copy, size);
      button.addEventListener("click", () => {
        elements.filesDialog.close();
        void openDocument(file.path).catch(() => undefined);
      });
      elements.filesList.append(button);
    }
  } catch (error) {
    if (workspaceEpoch !== operationWorkspaceEpoch) {
      if (elements.filesDialog.open) elements.filesDialog.close();
      return;
    }
    elements.workspaceSummary.textContent = "无法读取工作区";
    const empty = document.createElement("div");
    empty.className = "files-empty";
    empty.textContent = error instanceof Error ? error.message : "读取失败";
    elements.filesList.append(empty);
  }
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function showAudit() {
  const issues = auditDesign(design);
  const errors = issues.filter((issue) => issue.severity === "error").length;
  elements.auditSummary.textContent =
    issues.length === 0
      ? `未发现问题 · ${design.nodes.length} 个图层`
      : `${issues.length} 个问题 · ${errors} 个错误 · ${issues.length - errors} 个建议`;
  elements.auditResults.replaceChildren();
  if (issues.length === 0) {
    const clean = document.createElement("div");
    clean.className = "audit-clean";
    clean.textContent = "✓ 结构与基础可访问性检查通过";
    elements.auditResults.append(clean);
  } else {
    for (const issue of issues) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "audit-issue";
      item.dataset.severity = issue.severity;
      const dot = document.createElement("span");
      dot.className = "audit-issue-dot";
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = nodeById(issue.nodeId)?.name ?? issue.nodeId;
      const message = document.createElement("span");
      message.textContent = issue.message;
      copy.append(name, message);
      item.append(dot, copy);
      item.addEventListener("click", () => {
        selectOnly(issue.nodeId);
        elements.auditDialog.close();
        renderAll();
      });
      elements.auditResults.append(item);
    }
  }
  elements.auditDialog.showModal();
}

async function saveAuditReport() {
  const operationWorkspaceEpoch = workspaceEpoch;
  const sourcePath = elements.path.value.trim();
  if (!safeDesignPath(sourcePath)) return notify("先设置有效的设计文件路径", "error");
  elements.saveAuditReport.disabled = true;
  try {
    const saved = await saveDocument({ quiet: true });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    const issues = auditDesign(saved.design);
    const path = sourcePath.replace(/\.codesign\.json$/, ".audit.md");
    await writeRepoText(
      path,
      auditMarkdown(saved.design, issues, sourcePath),
      operationWorkspaceEpoch,
    );
    elements.auditDialog.close();
    notify(`检查报告已保存到 ${path}`);
  } catch (error) {
    if (workspaceEpoch !== operationWorkspaceEpoch) return;
    notify(error instanceof Error ? error.message : "检查报告保存失败", "error");
  } finally {
    if (workspaceEpoch === operationWorkspaceEpoch) {
      elements.saveAuditReport.disabled = context.trusted !== true;
    }
  }
}

function newDocument() {
  if (dirty && !window.confirm("当前设计有未保存修改。确定要新建设计吗？")) return;
  design = createBlankDocument("Untitled");
  documentEpoch += 1;
  clearSelection();
  collapsedLayerIds.clear();
  currentModifiedAt = null;
  currentRevision = null;
  warnedExternalVersion = null;
  currentSourcePath = null;
  currentSourceModifiedAt = null;
  currentSourceRevision = null;
  elements.path.value = "designs/untitled.codesign.json";
  savedSnapshot = "";
  resetHistory();
  markChanged();
  elements.filesDialog.close();
  requestAnimationFrame(fitCanvas);
}

async function exportSvg() {
  const operationWorkspaceEpoch = workspaceEpoch;
  const sourcePath = elements.path.value.trim();
  if (!safeDesignPath(sourcePath)) {
    notify("先设置有效的 .codesign.json 路径", "error");
    return;
  }
  const path = sourcePath.replace(/\.codesign\.json$/, ".svg");
  elements.exportSvg.disabled = true;
  try {
    const saved = await saveDocument({ quiet: true });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    await writeRepoText(path, exportDesignSvg(saved.design), operationWorkspaceEpoch);
    notify(`SVG 已导出到 ${path}`);
  } catch (error) {
    if (workspaceEpoch !== operationWorkspaceEpoch) return;
    const message = error instanceof Error ? error.message : "SVG 导出失败";
    notify(
      message.includes("changed since")
        ? "SVG 已在面板外变化；请检查后重试，避免覆盖他人的版本。"
        : message,
      "error",
    );
  } finally {
    if (workspaceEpoch === operationWorkspaceEpoch) {
      elements.exportSvg.disabled = context.trusted !== true;
    }
  }
}

async function submitToAgent() {
  const operationWorkspaceEpoch = workspaceEpoch;
  const request = elements.aiRequest.value.trim();
  if (!request) return notify("先写下你希望 Agent 做什么", "error");
  if (context.busy) return notify("当前会话正在运行，请稍后再提交", "error");
  elements.submitAi.disabled = true;
  try {
    await saveDocument({ quiet: true });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    const path = elements.path.value.trim();
    const prompt = [
      "请使用 design-studio skill 处理当前仓库里的设计文件。",
      `设计源文件：${path}`,
      `先读取并校验 codeshell.design v${design.version} 结构；保持稳定 node id、组件引用、自动布局和确定性 JSON 格式。`,
      "不要把 SVG 当作源文件。修改后总结变更的图层、设计理由和实现影响。",
      "",
      `我的要求：${request}`,
    ].join("\n");
    await hostCall("agent.submitPrompt", { prompt });
    assertWorkspaceEpoch(operationWorkspaceEpoch);
    elements.aiDialog.close();
    notify("已交给当前 Agent；文件写入 Repo 后画布会自动同步");
  } catch (error) {
    if (workspaceEpoch !== operationWorkspaceEpoch) return;
    notify(error instanceof Error ? error.message : "提交失败", "error");
  } finally {
    if (workspaceEpoch === operationWorkspaceEpoch) {
      elements.submitAi.disabled = Boolean(context.busy) || context.trusted !== true;
    }
  }
}

function bindPropertyInput(input, update, eventName = "input") {
  input.addEventListener(eventName, () => {
    const node = selectedNode();
    if (!node || isEffectivelyLocked(node)) return;
    update(node, input.value);
    if (isContainerNode(node)) applyAutoLayout(design.nodes, node.id);
    else reflowParent(node);
    markChanged();
  });
  input.addEventListener("change", commitHistory);
}

function bindCanvasInput(input, update, eventName = "input") {
  input.addEventListener(eventName, () => {
    update(input.value);
    markChanged();
  });
  input.addEventListener("change", commitHistory);
}

function bindColorTextInput(input, currentValue, update, allowTransparent = false) {
  const isValid = (value) => validHex(value) || (allowTransparent && value === "transparent");
  input.addEventListener("input", () => {
    input.dataset.invalid = String(!isValid(input.value.trim().toLowerCase()));
  });
  input.addEventListener("change", () => {
    const value = input.value.trim().toLowerCase();
    if (!isValid(value)) {
      input.value = currentValue();
      input.dataset.invalid = "false";
      notify(
        allowTransparent ? "请输入六位十六进制色值或 transparent" : "请输入六位十六进制色值",
        "error",
      );
      return;
    }
    update(value);
    input.dataset.invalid = "false";
    commitHistory();
    markChanged();
  });
}

bindPropertyInput(propertyInputs.name, (node, value) => {
  node.name = value.slice(0, 120) || node.type;
});
bindPropertyInput(propertyInputs.x, (node, value) => {
  setNodeTreePosition(design.nodes, node.id, "x", round(Number(value) || 0));
});
bindPropertyInput(propertyInputs.y, (node, value) => {
  setNodeTreePosition(design.nodes, node.id, "y", round(Number(value) || 0));
});
bindPropertyInput(propertyInputs.width, (node, value) => {
  node.width = clamp(Number(value) || 1, 1, 20000);
});
bindPropertyInput(propertyInputs.height, (node, value) => {
  node.height = clamp(Number(value) || 1, 1, 20000);
});
bindPropertyInput(
  propertyInputs.parent,
  (node, value) => {
    const previousParentId = node.parentId ?? null;
    reparentNode(design.nodes, node.id, value || null);
    if (previousParentId) applyAutoLayout(design.nodes, previousParentId);
    reflowParent(node);
  },
  "change",
);
bindPropertyInput(propertyInputs.notes, (node, value) => {
  const notes = value.slice(0, 2000);
  if (notes) node.notes = notes;
  else delete node.notes;
});
bindPropertyInput(propertyInputs.text, (node, value) => {
  if (node.type === "text") node.text = value.slice(0, 4000);
});
bindPropertyInput(propertyInputs.fontSize, (node, value) => {
  if (node.type === "text") node.fontSize = clamp(Number(value) || 6, 6, 240);
});
bindPropertyInput(
  propertyInputs.fontWeight,
  (node, value) => {
    if (node.type === "text") node.fontWeight = Number(value);
  },
  "change",
);
bindPropertyInput(propertyInputs.lineHeight, (node, value) => {
  if (node.type === "text") node.lineHeight = clamp(finiteOr(value, 1.2), 0.7, 3);
});
bindPropertyInput(
  propertyInputs.textAlign,
  (node, value) => {
    if (node.type === "text" && ["left", "center", "right"].includes(value)) {
      node.textAlign = value;
    }
  },
  "change",
);
bindColorTextInput(
  propertyInputs.fill,
  () => selectedNode()?.fill ?? "#ffffff",
  (value) => {
    const node = selectedNode();
    if (node && !isEffectivelyLocked(node)) node.fill = value;
  },
  true,
);
bindColorTextInput(
  propertyInputs.stroke,
  () => selectedNode()?.stroke ?? "transparent",
  (value) => {
    const node = selectedNode();
    if (node && !isEffectivelyLocked(node)) node.stroke = value;
  },
  true,
);
bindPropertyInput(propertyInputs.cornerRadius, (node, value) => {
  node.cornerRadius = clamp(Number(value) || 0, 0, 9999);
});
bindPropertyInput(propertyInputs.strokeWidth, (node, value) => {
  node.strokeWidth = clamp(finiteOr(value, 0), 0, 100);
});
bindPropertyInput(propertyInputs.opacity, (node, value) => {
  node.opacity = clamp((Number(value) || 0) / 100, 0, 1);
});
bindPropertyInput(propertyInputs.rotation, (node, value) => {
  node.rotation = clamp(finiteOr(value, 0), -360, 360);
});
propertyInputs.clipContent.addEventListener("change", () => {
  const node = selectedNode();
  if (!node || !["frame", "component"].includes(node.type) || isEffectivelyLocked(node)) return;
  if (propertyInputs.clipContent.checked) node.clipContent = true;
  else delete node.clipContent;
  commitHistory();
  markChanged();
});
bindPropertyInput(
  propertyInputs.layout,
  (node, value) => {
    if (!isContainerNode(node) || !["none", "horizontal", "vertical"].includes(value)) return;
    ensureDesignV2();
    node.layout = value;
    applyAutoLayout(design.nodes, node.id);
  },
  "change",
);
bindPropertyInput(propertyInputs.gap, (node, value) => {
  if (!isContainerNode(node)) return;
  ensureDesignV2();
  node.gap = clamp(finiteOr(value, 0), 0, 2000);
  applyAutoLayout(design.nodes, node.id);
});
bindPropertyInput(propertyInputs.padding, (node, value) => {
  if (!isContainerNode(node)) return;
  ensureDesignV2();
  node.padding = clamp(finiteOr(value, 0), 0, 2000);
  applyAutoLayout(design.nodes, node.id);
});
bindPropertyInput(
  propertyInputs.alignItems,
  (node, value) => {
    if (!isContainerNode(node)) return;
    ensureDesignV2();
    node.alignItems = value;
    applyAutoLayout(design.nodes, node.id);
  },
  "change",
);
bindPropertyInput(
  propertyInputs.justifyContent,
  (node, value) => {
    if (!isContainerNode(node)) return;
    ensureDesignV2();
    node.justifyContent = value;
    applyAutoLayout(design.nodes, node.id);
  },
  "change",
);
propertyInputs.layoutGrow.addEventListener("change", () => {
  const node = selectedNode();
  if (!node || isContainerNode(node) || isEffectivelyLocked(node)) return;
  ensureDesignV2();
  node.layoutGrow = propertyInputs.layoutGrow.checked ? 1 : 0;
  reflowParent(node);
  commitHistory();
  markChanged();
});
bindPropertyInput(
  propertyInputs.layoutAlign,
  (node, value) => {
    if (isContainerNode(node)) return;
    ensureDesignV2();
    node.layoutAlign = value;
    reflowParent(node);
  },
  "change",
);
bindPropertyInput(
  propertyInputs.fillColor,
  (node, value) => {
    node.fill = value;
  },
  "input",
);
bindPropertyInput(
  propertyInputs.strokeColor,
  (node, value) => {
    node.stroke = value;
    if (node.strokeWidth === 0) node.strokeWidth = 1;
  },
  "input",
);

bindCanvasInput(canvasInputs.name, (value) => {
  design.name = value.slice(0, 120);
});
bindCanvasInput(canvasInputs.width, (value) => {
  design.canvas.width = clamp(finiteOr(value, 1280), 100, 10000);
});
bindCanvasInput(canvasInputs.height, (value) => {
  design.canvas.height = clamp(finiteOr(value, 820), 100, 10000);
});
bindColorTextInput(
  canvasInputs.background,
  () => design.canvas.background,
  (value) => {
    design.canvas.background = value;
  },
);
bindCanvasInput(
  canvasInputs.backgroundColor,
  (value) => {
    design.canvas.background = value;
  },
  "input",
);

for (const button of document.querySelectorAll("[data-tool]")) {
  button.addEventListener("click", () => setActiveTool(button.dataset.tool));
}
for (const button of document.querySelectorAll("[data-align]")) {
  button.addEventListener("click", () => alignSelected(button.dataset.align));
}
for (const button of document.querySelectorAll("[data-order]")) {
  button.addEventListener("click", () => setOrder(button.dataset.order));
}
for (const button of document.querySelectorAll("[data-distribute]")) {
  button.addEventListener("click", () => distributeSelected(button.dataset.distribute));
}
const inspectorTabs = [...document.querySelectorAll(".inspector-tab")];
function activateInspectorTab(button, { focus = false } = {}) {
  for (const tab of inspectorTabs) {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  document.querySelector("#design-tab").hidden = button.dataset.tab !== "design";
  document.querySelector("#layers-tab").hidden = button.dataset.tab !== "layers";
  if (focus) button.focus();
}
for (const [index, button] of inspectorTabs.entries()) {
  button.addEventListener("click", () => activateInspectorTab(button));
  button.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const targetIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? inspectorTabs.length - 1
          : delta
            ? (index + delta + inspectorTabs.length) % inspectorTabs.length
            : -1;
    if (targetIndex < 0) return;
    event.preventDefault();
    activateInspectorTab(inspectorTabs[targetIndex], { focus: true });
  });
}

elements.toggleLock.addEventListener("click", () => {
  const node = selectedNode();
  if (!node) return;
  node.locked = !node.locked;
  commitHistory();
  markChanged();
});
elements.toggleVisible.addEventListener("click", () => {
  const node = selectedNode();
  if (!node) return;
  node.visible = !node.visible;
  commitHistory();
  markChanged();
});
elements.addColorToken.addEventListener("click", () => {
  if (design.tokens.colors.length >= 32) {
    notify("颜色变量最多 32 个", "error");
    return;
  }
  const usedNames = new Set(design.tokens.colors.map((token) => token.name.toLowerCase()));
  let suffix = design.tokens.colors.length + 1;
  while (usedNames.has(`color ${suffix}`)) suffix += 1;
  const palette = ["#ff6b6b", "#ffca6d", "#6d9cff", "#a8ff3e", "#c99cff"];
  design.tokens.colors.push({
    name: `Color ${suffix}`,
    value: palette[design.tokens.colors.length % palette.length],
  });
  commitHistory();
  markChanged();
});
elements.duplicateLayer.addEventListener("click", duplicateSelected);
elements.frameSelection.addEventListener("click", frameSelectedNodes);
elements.groupSelection.addEventListener("click", groupSelectedNodes);
elements.releaseFrame.addEventListener("click", releaseSelectedFrame);
elements.makeComponent.addEventListener("click", makeSelectedComponent);
elements.createInstance.addEventListener("click", createSelectedComponentInstance);
elements.layerFilter.addEventListener("input", () => {
  layerFilter = elements.layerFilter.value;
  renderLayers();
});
elements.stage.addEventListener("pointerdown", pointerDown);
elements.stage.addEventListener("pointermove", pointerMove);
elements.stage.addEventListener("pointerup", pointerUp);
elements.stage.addEventListener("pointercancel", pointerUp);
elements.stage.addEventListener("dblclick", (event) => {
  const targetId = event.target.closest?.("[data-node-id]")?.dataset.nodeId;
  const node = design.nodes.find((candidate) => candidate.id === targetId);
  if (node?.type !== "text") return;
  selectOnly(node.id);
  document.querySelector('[data-tab="design"]').click();
  renderAll();
  requestAnimationFrame(() => {
    propertyInputs.text.focus();
    propertyInputs.text.select();
  });
});
elements.stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      setZoom(zoom * Math.exp(-event.deltaY * 0.006), { x: event.clientX, y: event.clientY });
    } else {
      pan.x -= event.deltaX;
      pan.y -= event.deltaY;
      renderAll();
    }
  },
  { passive: false },
);
elements.zoomOut.addEventListener("click", () => setZoom(zoom / 1.2));
elements.zoomIn.addEventListener("click", () => setZoom(zoom * 1.2));
elements.zoomValue.addEventListener("click", fitCanvas);
elements.toggleGrid.addEventListener("click", () => {
  showGrid = !showGrid;
  saveUiPreferences();
  renderAll();
});
elements.toggleSnap.addEventListener("click", () => {
  snapEnabled = !snapEnabled;
  saveUiPreferences();
  renderAll();
});
elements.save.addEventListener("click", () => void saveDocument().catch(() => undefined));
elements.runAudit.addEventListener("click", showAudit);
elements.saveAuditReport.addEventListener("click", () => void saveAuditReport());
elements.exportSvg.addEventListener("click", () => void exportSvg());
elements.openFiles.addEventListener("click", () => void showFiles());
elements.openShortcuts.addEventListener("click", () => elements.shortcutsDialog.showModal());
elements.newDocument.addEventListener("click", newDocument);
elements.openAi.addEventListener("click", () => elements.aiDialog.showModal());
elements.toggleInspector.addEventListener("click", () => {
  const open = elements.workspace.classList.toggle("inspector-open");
  elements.toggleInspector.setAttribute("aria-expanded", String(open));
  elements.toggleInspector.title = open ? "关闭属性面板" : "打开属性面板";
  elements.toggleInspector.setAttribute("aria-label", elements.toggleInspector.title);
});
elements.submitAi.addEventListener("click", () => void submitToAgent());
elements.path.addEventListener("change", () => {
  const path = elements.path.value.trim();
  if (path !== currentSourcePath) warnedExternalVersion = null;
  currentModifiedAt = path === currentSourcePath ? currentSourceModifiedAt : null;
  currentRevision = path === currentSourcePath ? currentSourceRevision : null;
  if (dirty) queueRecovery();
  setSaveState(dirty ? "有修改" : "另存为", dirty ? "dirty" : "idle");
});

window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  const activeTag = document.activeElement?.tagName;
  const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(activeTag);
  const interactive = editing || activeTag === "BUTTON" || activeTag === "A";
  const command = event.metaKey || event.ctrlKey;
  const dialogOpen = Boolean(document.querySelector("dialog[open]"));
  if (dialogOpen) return;
  if (event.code === "Space" && !interactive) {
    spacePressed = true;
    updateCursor();
    event.preventDefault();
  }
  if (command && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveDocument().catch(() => undefined);
    return;
  }
  if (command && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void showFiles();
    return;
  }
  if (command && event.key.toLowerCase() === "z" && !editing) {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if (command && event.key.toLowerCase() === "a" && !editing) {
    event.preventDefault();
    selectedIds = new Set(
      design.nodes.filter((node) => isEffectivelyVisible(node)).map((node) => node.id),
    );
    selectedId = [...selectedIds].at(-1) ?? null;
    setActiveTool("select");
    renderAll();
    return;
  }
  if (command && event.key.toLowerCase() === "d" && !editing) {
    event.preventDefault();
    duplicateSelected();
    return;
  }
  if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "g" && !editing) {
    event.preventDefault();
    groupSelectedNodes();
    return;
  }
  if (command && event.altKey && event.key.toLowerCase() === "g" && !editing) {
    event.preventDefault();
    frameSelectedNodes();
    return;
  }
  if (command && event.shiftKey && event.key.toLowerCase() === "g" && !editing) {
    event.preventDefault();
    releaseSelectedFrame();
    return;
  }
  if (command && event.key.toLowerCase() === "c" && !editing && selectedIds.size > 0) {
    event.preventDefault();
    copySelected();
    return;
  }
  if (command && event.key.toLowerCase() === "v" && !editing && copiedNodes.length > 0) {
    event.preventDefault();
    pasteCopied();
    return;
  }
  if (interactive) return;
  if (event.key === "?") {
    elements.shortcutsDialog.showModal();
    return;
  }
  if (event.shiftKey && event.code === "Digit1") {
    event.preventDefault();
    fitCanvas();
    return;
  }
  if (event.shiftKey && event.code === "Digit2") {
    event.preventDefault();
    fitSelection();
    return;
  }
  if (event.key === "Escape") {
    clearSelection();
    setActiveTool("select");
    renderAll();
    return;
  }
  const tool = TOOL_SHORTCUTS[event.key.toLowerCase()];
  if (tool) {
    setActiveTool(tool);
    return;
  }
  const nodes = selectedNodes();
  if ((event.key === "Delete" || event.key === "Backspace") && nodes.length > 0) {
    event.preventDefault();
    deleteSelected();
    return;
  }
  const transformNodes = selectedTransformNodes();
  if (
    transformNodes.length > 0 &&
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  ) {
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const movingIds = new Set(transformNodes.map((node) => node.id));
    for (const node of transformNodes) {
      const delta = visualDeltaForNode(
        node,
        {
          x: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0,
          y: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0,
        },
        movingIds,
      );
      node.x = round(node.x + delta.x);
      node.y = round(node.y + delta.y);
    }
    commitHistory();
    markChanged();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
    spacePressed = false;
    updateCursor();
  }
});

window.addEventListener("blur", () => {
  spacePressed = false;
  finishInteraction();
  updateCursor();
});
window.addEventListener("resize", () => renderScene());
window.addEventListener("focus", () => void checkExternalChange());
window.addEventListener("beforeunload", (event) => {
  if (externalSyncTimer) window.clearInterval(externalSyncTimer);
  if (!dirty) return;
  clearTimeout(recoveryTimer);
  const workspaceRoot = context.cwd ?? null;
  void persistRecovery(workspaceRoot, recoverySnapshot(workspaceRoot));
  event.preventDefault();
  event.returnValue = "";
});

function updateContext(next) {
  const wasVisible = context.visible === true;
  const previousWorkspaceRoot = typeof context.cwd === "string" ? context.cwd : null;
  const nextContext = { ...context, ...(next ?? {}) };
  const nextWorkspaceRoot = typeof nextContext.cwd === "string" ? nextContext.cwd : null;
  const workspaceChanged = contextInitialized && previousWorkspaceRoot !== nextWorkspaceRoot;
  if (workspaceChanged) {
    clearTimeout(recoveryTimer);
    const previousRecovery = dirty ? recoverySnapshot(previousWorkspaceRoot) : null;
    if (previousRecovery) {
      void storeRecovery(previousWorkspaceRoot, previousRecovery).catch(() => undefined);
    }
    currentModifiedAt = null;
    currentRevision = null;
    currentSourcePath = null;
    currentSourceModifiedAt = null;
    currentSourceRevision = null;
    warnedExternalVersion = null;
    fileDiscoveryCache = null;
    fileDiscoveryCachedAt = 0;
    savedSnapshot = "";
    workspaceEpoch += 1;
    recoveryFailureWarned = false;
    elements.path.disabled = false;
  }
  context = nextContext;
  contextInitialized = true;
  applyContextTheme(context.theme);
  updateRepoLinkState();
  const workspaceUnavailable = context.trusted !== true;
  elements.save.disabled = workspaceUnavailable;
  elements.exportSvg.disabled = workspaceUnavailable;
  elements.openFiles.disabled = workspaceUnavailable;
  elements.saveAuditReport.disabled = workspaceUnavailable;
  elements.openAi.disabled = Boolean(context.busy) || workspaceUnavailable;
  elements.submitAi.disabled = Boolean(context.busy) || workspaceUnavailable;
  elements.aiContextState.textContent = context.busy
    ? "当前会话忙碌中"
    : context.trusted === false
      ? "工作区尚未信任"
      : "会话可用";
  if (workspaceChanged) {
    notify(
      dirty
        ? "工作区已切换；当前画布已保留为未保存副本，正在连接新 Repo"
        : "工作区已切换，正在连接新 Repo 的设计文件",
    );
    const expectedWorkspaceEpoch = workspaceEpoch;
    void initializeWorkspaceDocument(expectedWorkspaceEpoch).catch((error) => {
      if (expectedWorkspaceEpoch !== workspaceEpoch) return;
      resetToRepoBlankDocument();
      setRepoLinkState("Repo 读取失败", "error");
      notify(error instanceof Error ? error.message : "无法读取 Repo 设计文件", "error");
    });
  }
  if (!wasVisible && context.visible === true) void checkExternalChange();
  if (wasVisible && context.visible === false && dirty) {
    clearTimeout(recoveryTimer);
    const workspaceRoot = context.cwd ?? null;
    void persistRecovery(workspaceRoot, recoverySnapshot(workspaceRoot));
  }
}

async function restoreRecovery(
  recovery,
  expectedWorkspaceEpoch = workspaceEpoch,
  workspaceRoot = context.cwd ?? null,
) {
  if (
    !recovery ||
    typeof recovery !== "object" ||
    recovery.workspaceRoot !== workspaceRoot ||
    typeof recovery.path !== "string" ||
    !safeDesignPath(recovery.path)
  ) {
    return false;
  }
  const recoveredDesign = normalizeDocument(recovery.design);
  const hasRecoveryBase = Object.prototype.hasOwnProperty.call(recovery, "baseModifiedAt");
  const hasRecoveryRevision = Object.prototype.hasOwnProperty.call(recovery, "baseRevision");
  if (!hasRecoveryBase || !hasRecoveryRevision) {
    throw new Error("恢复快照缺少文件版本守卫");
  }
  if (
    recovery.baseModifiedAt !== null &&
    (typeof recovery.baseModifiedAt !== "number" || !Number.isFinite(recovery.baseModifiedAt))
  ) {
    throw new Error("恢复快照的文件版本无效");
  }
  if (recovery.baseRevision !== null && typeof recovery.baseRevision !== "string") {
    throw new Error("恢复快照的内容版本无效");
  }
  let diskSnapshot = "";
  let diskModifiedAt = null;
  let diskRevision = null;
  let diskFound = false;
  try {
    const disk = await hostCall("workspace.readText", { path: recovery.path });
    assertWorkspaceEpoch(expectedWorkspaceEpoch);
    diskFound = true;
    diskModifiedAt = disk.modifiedAt;
    diskRevision = disk.revision;
    diskSnapshot = serializeDocument(normalizeDocument(JSON.parse(disk.content)));
  } catch {
    // A new unsaved document has no disk baseline yet.
  }
  assertWorkspaceEpoch(expectedWorkspaceEpoch);
  const recoveryBaseChanged = workspaceVersionChanged(
    { modifiedAt: recovery.baseModifiedAt, revision: recovery.baseRevision },
    { found: diskFound, modifiedAt: diskModifiedAt, revision: diskRevision },
  );
  design = recoveredDesign;
  documentEpoch += 1;
  clearSelection();
  currentModifiedAt = hasRecoveryBase ? recovery.baseModifiedAt : diskModifiedAt;
  currentRevision = hasRecoveryRevision
    ? recovery.baseRevision
    : hasRecoveryBase
      ? null
      : diskRevision;
  warnedExternalVersion = recoveryBaseChanged
    ? (diskRevision ?? (diskFound ? `mtime:${diskModifiedAt}` : "missing"))
    : null;
  currentSourcePath = recovery.path;
  currentSourceModifiedAt = currentModifiedAt;
  currentSourceRevision = currentRevision;
  elements.path.value = recovery.path;
  savedSnapshot = diskSnapshot;
  resetHistory();
  updateDirtyState();
  renderAll();
  requestAnimationFrame(fitCanvas);
  if (dirty) {
    notify(
      recoveryBaseChanged
        ? `已恢复 ${recovery.path} 的本地修改，但源文件也已变化；请重新打开或另存副本`
        : `已恢复 ${recovery.path} 的未保存修改`,
      recoveryBaseChanged ? "error" : "idle",
    );
  } else {
    currentModifiedAt = diskModifiedAt;
    currentRevision = diskRevision;
    currentSourceModifiedAt = diskModifiedAt;
    currentSourceRevision = diskRevision;
    warnedExternalVersion = null;
    updateDirtyState();
    await hostCall("storage.delete", {
      key: scopedStorageKey("recovery", workspaceRoot ?? "preview"),
    }).catch(() => undefined);
    assertWorkspaceEpoch(expectedWorkspaceEpoch);
  }
  return true;
}

function chooseRepoDesignFile(files) {
  return [...files].sort(
    (left, right) =>
      (Number(right.modifiedAt) || 0) - (Number(left.modifiedAt) || 0) ||
      left.path.localeCompare(right.path),
  )[0];
}

function resetToRepoBlankDocument() {
  const repoName = workspaceInfo?.name ?? context.cwd?.split("/").filter(Boolean).at(-1) ?? "Repo";
  design = createBlankDocument(`${repoName} design`);
  documentEpoch += 1;
  clearSelection();
  collapsedLayerIds.clear();
  currentModifiedAt = null;
  currentRevision = null;
  currentSourcePath = null;
  currentSourceModifiedAt = null;
  currentSourceRevision = null;
  warnedExternalVersion = null;
  elements.path.value = DEFAULT_PATH;
  savedSnapshot = "";
  resetHistory();
  updateDirtyState();
  renderAll();
  requestAnimationFrame(fitCanvas);
}

async function initializeWorkspaceDocument(expectedWorkspaceEpoch = workspaceEpoch) {
  const initializationWorkspaceIdentity = context.cwd ?? null;
  const workspaceRoot = initializationWorkspaceIdentity ?? "preview";
  if (context.trusted !== true) {
    resetToRepoBlankDocument();
    updateRepoLinkState();
    return;
  }
  const [nextWorkspaceInfo, recovery, lastPath] = await Promise.all([
    hostCall("workspace.info", {}).catch(() => null),
    hostCall("storage.get", {
      key: scopedStorageKey("recovery", workspaceRoot),
    }).catch(() => null),
    hostCall("storage.get", {
      key: scopedStorageKey("lastPath", workspaceRoot),
    }).catch(() => null),
  ]);
  assertWorkspaceEpoch(expectedWorkspaceEpoch);
  workspaceInfo = nextWorkspaceInfo;
  updateRepoLinkState();
  try {
    if (await restoreRecovery(recovery, expectedWorkspaceEpoch, initializationWorkspaceIdentity)) {
      setRepoLinkState("Repo · 已恢复", "linked");
      return;
    }
  } catch {
    assertWorkspaceEpoch(expectedWorkspaceEpoch);
    await hostCall("storage.delete", {
      key: scopedStorageKey("recovery", workspaceRoot),
    }).catch(() => undefined);
  }
  if (
    lastPath &&
    typeof lastPath === "object" &&
    lastPath.workspaceRoot === initializationWorkspaceIdentity &&
    typeof lastPath.path === "string" &&
    safeDesignPath(lastPath.path)
  ) {
    try {
      await openDocument(lastPath.path, { discardChanges: true });
      setRepoLinkState("Repo · 已打开", "linked");
      return;
    } catch {
      if (expectedWorkspaceEpoch !== workspaceEpoch) return;
    }
  }
  const discovery = await discoverDesignFiles();
  assertWorkspaceEpoch(expectedWorkspaceEpoch);
  const initialFile = chooseRepoDesignFile(discovery.files);
  if (initialFile) {
    await openDocument(initialFile.path, { discardChanges: true });
    setRepoLinkState("Repo · 自动打开", "linked");
    return;
  }
  resetToRepoBlankDocument();
  setRepoLinkState("Repo · 新设计", "linked");
  notify("当前 Repo 还没有设计文件；保存后会创建 designs/design.codesign.json");
}

function startExternalSync() {
  if (externalSyncTimer) window.clearInterval(externalSyncTimer);
  externalSyncTimer = window.setInterval(() => {
    if (context.trusted === true && context.visible !== false) {
      void checkExternalChange();
    }
  }, 2_000);
}

async function initialize() {
  resetHistory();
  renderAll();
  requestAnimationFrame(fitCanvas);
  try {
    if (window.codeshellPanel?.getContext) updateContext(await window.codeshellPanel.getContext());
    else updateContext({ trusted: true, busy: false, cwd: "/preview/codeshell" });
    window.codeshellPanel?.on?.("context.changed", updateContext);
  } catch {
    updateContext({ trusted: false, busy: false });
  }

  const initializationWorkspaceEpoch = workspaceEpoch;
  const uiPreferences = await hostCall("storage.get", { key: "uiPreferences" }).catch(() => null);
  if (initializationWorkspaceEpoch !== workspaceEpoch) return;
  if (uiPreferences && typeof uiPreferences === "object") {
    if (typeof uiPreferences.showGrid === "boolean") showGrid = uiPreferences.showGrid;
    if (typeof uiPreferences.snapEnabled === "boolean") snapEnabled = uiPreferences.snapEnabled;
    renderAll();
  }
  try {
    await initializeWorkspaceDocument(initializationWorkspaceEpoch);
  } catch (error) {
    if (initializationWorkspaceEpoch !== workspaceEpoch) return;
    resetToRepoBlankDocument();
    setRepoLinkState("Repo 读取失败", "error");
    notify(error instanceof Error ? error.message : "无法读取 Repo 设计文件", "error");
  }
  startExternalSync();
}

void initialize();
