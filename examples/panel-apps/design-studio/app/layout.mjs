/* Auto-layout and reusable-component helpers for Design Studio v2 documents. */
export const CONTAINER_NODE_TYPES = Object.freeze(["frame", "group", "component"]);

function round(value, precision = 2) {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function assignNumber(node, property, value) {
  const next = round(value);
  if (node[property] === next) return false;
  node[property] = next;
  return true;
}

export function isContainerNode(node) {
  return Boolean(node && CONTAINER_NODE_TYPES.includes(node.type));
}

export function childNodes(nodes, parentId, { visibleOnly = false } = {}) {
  if (!Array.isArray(nodes) || typeof parentId !== "string") return [];
  return nodes.filter(
    (node) => node.parentId === parentId && (!visibleOnly || node.visible !== false),
  );
}

export function applyAutoLayout(nodes, containerId) {
  if (!Array.isArray(nodes) || typeof containerId !== "string") return false;
  const container = nodes.find((node) => node.id === containerId);
  if (!isContainerNode(container) || !["horizontal", "vertical"].includes(container.layout)) {
    return false;
  }
  const children = childNodes(nodes, container.id, { visibleOnly: true });
  if (children.length === 0) return false;

  const horizontal = container.layout === "horizontal";
  const mainPosition = horizontal ? "x" : "y";
  const crossPosition = horizontal ? "y" : "x";
  const mainSize = horizontal ? "width" : "height";
  const crossSize = horizontal ? "height" : "width";
  const padding = Math.max(0, finite(container.padding));
  const configuredGap = Math.max(0, finite(container.gap));
  const innerMain = Math.max(0, finite(container[mainSize]) - padding * 2);
  const innerCross = Math.max(1, finite(container[crossSize]) - padding * 2);
  const growChildren = children.filter((node) => node.layoutGrow === 1);
  const fixedSize = children
    .filter((node) => node.layoutGrow !== 1)
    .reduce((total, node) => total + Math.max(1, finite(node[mainSize], 1)), 0);
  const baseGapTotal = configuredGap * Math.max(0, children.length - 1);
  const growSpace = Math.max(0, innerMain - fixedSize - baseGapTotal);
  const growSize = growChildren.length > 0 ? growSpace / growChildren.length : 0;

  let changed = false;
  if (growChildren.length > 0) {
    for (const node of growChildren) {
      changed = assignNumber(node, mainSize, Math.max(1, growSize)) || changed;
    }
  }

  const occupied = children.reduce(
    (total, node) => total + Math.max(1, finite(node[mainSize], 1)),
    0,
  );
  const freeMain = Math.max(0, innerMain - occupied);
  let gap = configuredGap;
  let offset = 0;
  if (container.justifyContent === "center") {
    offset = Math.max(0, (freeMain - baseGapTotal) / 2);
  } else if (container.justifyContent === "end") {
    offset = Math.max(0, freeMain - baseGapTotal);
  } else if (container.justifyContent === "space-between" && children.length > 1) {
    gap = freeMain / (children.length - 1);
  }

  let cursor = finite(container[mainPosition]) + padding + offset;
  for (const node of children) {
    const alignment =
      node.layoutAlign && node.layoutAlign !== "auto"
        ? node.layoutAlign
        : (container.alignItems ?? "start");
    if (alignment === "stretch") {
      changed = assignNumber(node, crossSize, innerCross) || changed;
    }
    const childCrossSize = Math.max(1, finite(node[crossSize], 1));
    let crossOffset = 0;
    if (alignment === "center") crossOffset = (innerCross - childCrossSize) / 2;
    else if (alignment === "end") crossOffset = innerCross - childCrossSize;
    changed = assignNumber(node, mainPosition, cursor) || changed;
    changed =
      assignNumber(node, crossPosition, finite(container[crossPosition]) + padding + crossOffset) ||
      changed;
    cursor += Math.max(1, finite(node[mainSize], 1)) + gap;
  }
  return changed;
}

export function applyAllAutoLayouts(nodes) {
  if (!Array.isArray(nodes)) return false;
  let changed = false;
  for (const node of nodes) {
    if (isContainerNode(node)) changed = applyAutoLayout(nodes, node.id) || changed;
  }
  return changed;
}

export function createComponentInstance(component, id, offset = 32, canvas = null) {
  if (!component || component.type !== "component" || typeof id !== "string" || !id) {
    return null;
  }
  const candidates = [
    { x: component.x + component.width + offset, y: component.y },
    { x: component.x, y: component.y + component.height + offset },
    { x: component.x - component.width - offset, y: component.y },
    { x: component.x, y: component.y - component.height - offset },
  ];
  const fitsCanvas = (candidate) =>
    canvas &&
    candidate.x >= 0 &&
    candidate.y >= 0 &&
    candidate.x + component.width <= canvas.width &&
    candidate.y + component.height <= canvas.height;
  const position = canvas
    ? (candidates.find(fitsCanvas) ?? {
        x: Math.min(Math.max(0, component.x + offset), Math.max(0, canvas.width - component.width)),
        y: Math.min(
          Math.max(0, component.y + offset),
          Math.max(0, canvas.height - component.height),
        ),
      })
    : candidates[0];
  return {
    id,
    type: "instance",
    name: `${component.name} · 实例`,
    componentId: component.id,
    x: round(position.x),
    y: round(position.y),
    width: round(component.width),
    height: round(component.height),
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    opacity: 1,
    rotation: 0,
    cornerRadius: round(component.cornerRadius ?? 0),
    visible: true,
    locked: false,
  };
}
