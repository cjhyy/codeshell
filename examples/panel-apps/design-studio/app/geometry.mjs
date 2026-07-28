/* Geometry engine used only by the Design Studio Panel App. */
const CONTAINER_NODE_TYPES = ["frame", "group", "component"];

function isContainerNode(node) {
  return Boolean(node && CONTAINER_NODE_TYPES.includes(node.type));
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function snapValue(value, grid = 8) {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid <= 0) return value;
  return Math.round(value / grid) * grid;
}

export function pointInRotatedBounds(node, point) {
  if (
    !node ||
    !point ||
    ![node.x, node.y, node.width, node.height, node.rotation ?? 0, point.x, point.y].every(
      Number.isFinite,
    )
  ) {
    return false;
  }
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const radians = (-(node.rotation ?? 0) * Math.PI) / 180;
  const deltaX = point.x - centerX;
  const deltaY = point.y - centerY;
  const localX = centerX + deltaX * Math.cos(radians) - deltaY * Math.sin(radians);
  const localY = centerY + deltaX * Math.sin(radians) + deltaY * Math.cos(radians);
  return (
    localX >= node.x &&
    localX <= node.x + node.width &&
    localY >= node.y &&
    localY <= node.y + node.height
  );
}

export function rotateVector(vector, degrees) {
  if (
    !vector ||
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(degrees)
  ) {
    return { x: vector?.x ?? 0, y: vector?.y ?? 0 };
  }
  const radians = (degrees * Math.PI) / 180;
  return {
    x: vector.x * Math.cos(radians) - vector.y * Math.sin(radians),
    y: vector.x * Math.sin(radians) + vector.y * Math.cos(radians),
  };
}

function rotatePoint(point, center, degrees) {
  if (!degrees) return point;
  const rotated = rotateVector({ x: point.x - center.x, y: point.y - center.y }, degrees);
  return { x: center.x + rotated.x, y: center.y + rotated.y };
}

function validBounds(node) {
  return (
    node && [node.x, node.y, node.width, node.height, node.rotation ?? 0].every(Number.isFinite)
  );
}

function normalizeRotation(degrees) {
  const normalized = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return round(normalized);
}

export function pointToParentSpace(point, parent = null) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!parent) return { x: point.x, y: point.y };
  if (!validBounds(parent)) return null;
  const center = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
  return rotatePoint(point, center, -(parent.rotation ?? 0));
}

export function pointFromParentSpace(point, parent = null) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!parent) return { x: point.x, y: point.y };
  if (!validBounds(parent)) return null;
  const center = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
  return rotatePoint(point, center, parent.rotation ?? 0);
}

export function transformNodeBetweenParents(node, previousParent = null, nextParent = null) {
  if (!validBounds(node)) return false;
  if (
    (previousParent && !validBounds(previousParent)) ||
    (nextParent && !validBounds(nextParent))
  ) {
    return false;
  }
  const localCenter = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const visualCenter = pointFromParentSpace(localCenter, previousParent);
  const nextCenter = pointToParentSpace(visualCenter, nextParent);
  if (!nextCenter) return false;
  node.x = round(nextCenter.x - node.width / 2);
  node.y = round(nextCenter.y - node.height / 2);
  node.rotation = normalizeRotation(
    (node.rotation ?? 0) + (previousParent?.rotation ?? 0) - (nextParent?.rotation ?? 0),
  );
  return true;
}

export function detachNodeFromParent(node, parent) {
  if (!parent || !transformNodeBetweenParents(node, parent, null)) return false;
  if (Number.isFinite(parent.opacity) && Number.isFinite(node.opacity)) {
    node.opacity = round(Math.min(1, Math.max(0, parent.opacity * node.opacity)), 4);
  }
  if (typeof parent.visible === "boolean" && typeof node.visible === "boolean") {
    node.visible = parent.visible && node.visible;
  }
  delete node.parentId;
  return true;
}

export function transformedNodeBounds(node, parent = null) {
  if (!validBounds(node) || (parent && !validBounds(parent))) return null;
  const nodeCenter = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const parentCenter = parent
    ? { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 }
    : null;
  const corners = [
    { x: node.x, y: node.y },
    { x: node.x + node.width, y: node.y },
    { x: node.x + node.width, y: node.y + node.height },
    { x: node.x, y: node.y + node.height },
  ].map((point) => {
    const locallyRotated = rotatePoint(point, nodeCenter, node.rotation ?? 0);
    return parentCenter
      ? rotatePoint(locallyRotated, parentCenter, parent.rotation ?? 0)
      : locallyRotated;
  });
  const left = Math.min(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  const right = Math.max(...corners.map((point) => point.x));
  const bottom = Math.max(...corners.map((point) => point.y));
  return {
    x: round(left),
    y: round(top),
    width: round(right - left),
    height: round(bottom - top),
  };
}

export function visualSelectionBounds(nodes, allNodes = nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const bounds = nodes
    .map((node) => transformedNodeBounds(node, node.parentId ? byId.get(node.parentId) : null))
    .filter(Boolean);
  return selectionBounds(bounds);
}

export function snapBoundsToNodes(bounds, stationaryNodes, delta, threshold = 6) {
  if (
    !bounds ||
    !Array.isArray(stationaryNodes) ||
    !Number.isFinite(delta?.x) ||
    !Number.isFinite(delta?.y) ||
    !Number.isFinite(threshold) ||
    threshold < 0
  ) {
    return { x: delta?.x ?? 0, y: delta?.y ?? 0, guides: [] };
  }
  const bestMatch = (axis) => {
    const horizontal = axis === "x";
    const start = horizontal ? bounds.x + delta.x : bounds.y + delta.y;
    const size = horizontal ? bounds.width : bounds.height;
    const sourceAnchors = [start, start + size / 2, start + size];
    let best = null;
    for (const node of stationaryNodes) {
      const targetStart = horizontal ? node.x : node.y;
      const targetSize = horizontal ? node.width : node.height;
      const targetAnchors = [targetStart, targetStart + targetSize / 2, targetStart + targetSize];
      for (const source of sourceAnchors) {
        for (const target of targetAnchors) {
          const distance = Math.abs(target - source);
          if (distance > threshold || (best && distance >= best.distance)) continue;
          best = { adjustment: target - source, distance, value: target, targetId: node.id };
        }
      }
    }
    return best;
  };
  const xMatch = bestMatch("x");
  const yMatch = bestMatch("y");
  return {
    x: delta.x + (xMatch?.adjustment ?? 0),
    y: delta.y + (yMatch?.adjustment ?? 0),
    guides: [
      ...(xMatch ? [{ axis: "x", value: xMatch.value, targetId: xMatch.targetId }] : []),
      ...(yMatch ? [{ axis: "y", value: yMatch.value, targetId: yMatch.targetId }] : []),
    ],
  };
}

export function descendantIds(nodes, rootIds) {
  const descendants = new Set();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const node of nodes) {
      if (node.parentId !== parentId || descendants.has(node.id) || rootIds.has(node.id)) continue;
      descendants.add(node.id);
      queue.push(node.id);
    }
  }
  return descendants;
}

export function normalizeNodeTreeOrder(nodes) {
  if (!Array.isArray(nodes)) return false;
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const ordered = [];
  const visited = new Set();
  for (const node of nodes) {
    if (node.parentId) continue;
    ordered.push(node);
    visited.add(node.id);
    for (const child of childrenByParent.get(node.id) ?? []) {
      ordered.push(child);
      visited.add(child.id);
    }
  }
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    ordered.push(node);
  }
  const changed = ordered.some((node, index) => node !== nodes[index]);
  if (changed) nodes.splice(0, nodes.length, ...ordered);
  return changed;
}

export function selectionBounds(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function wrapNodesInFrame(nodes, selectedIds, frame, padding = 24) {
  if (
    !Array.isArray(nodes) ||
    !(selectedIds instanceof Set) ||
    selectedIds.size === 0 ||
    !frame ||
    !isContainerNode(frame) ||
    typeof frame.id !== "string" ||
    nodes.some((node) => node.id === frame.id) ||
    !Number.isFinite(padding) ||
    padding < 0
  ) {
    return false;
  }
  const selected = nodes.filter((node) => selectedIds.has(node.id));
  if (selected.length === 0 || selected.some((node) => isContainerNode(node) || node.parentId)) {
    return false;
  }
  const bounds = selectionBounds(selected);
  frame.x = round(bounds.x - padding);
  frame.y = round(bounds.y - padding);
  frame.width = round(bounds.width + padding * 2);
  frame.height = round(bounds.height + padding * 2);

  const firstSelectedIndex = nodes.findIndex((node) => selectedIds.has(node.id));
  const insertionIndex = nodes
    .slice(0, firstSelectedIndex)
    .filter((node) => !selectedIds.has(node.id)).length;
  const remaining = nodes.filter((node) => !selectedIds.has(node.id));
  for (const node of selected) node.parentId = frame.id;
  remaining.splice(insertionIndex, 0, frame, ...selected);
  nodes.splice(0, nodes.length, ...remaining);
  return true;
}

export function releaseFrame(nodes, frameId) {
  if (!Array.isArray(nodes) || typeof frameId !== "string") return false;
  const frame = nodes.find((node) => node.id === frameId);
  if (!frame || !["frame", "group"].includes(frame.type)) return false;
  const children = nodes.filter((node) => node.parentId === frameId);
  const insertionIndex = nodes
    .slice(0, nodes.indexOf(frame))
    .filter((node) => node.id !== frameId && node.parentId !== frameId).length;
  const remaining = nodes.filter((node) => node.id !== frameId && node.parentId !== frameId);
  for (const child of children) {
    detachNodeFromParent(child, frame);
  }
  remaining.splice(insertionIndex, 0, ...children);
  nodes.splice(0, nodes.length, ...remaining);
  return true;
}

export function alignNodes(nodes, alignment, canvas) {
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  const bounds =
    nodes.length === 1
      ? {
          x: Number.isFinite(canvas?.x) ? canvas.x : 0,
          y: Number.isFinite(canvas?.y) ? canvas.y : 0,
          width: canvas.width,
          height: canvas.height,
        }
      : selectionBounds(nodes);
  for (const node of nodes) {
    if (alignment === "left") node.x = bounds.x;
    else if (alignment === "center") node.x = round(bounds.x + (bounds.width - node.width) / 2);
    else if (alignment === "right") node.x = round(bounds.x + bounds.width - node.width);
    else if (alignment === "top") node.y = bounds.y;
    else if (alignment === "middle") node.y = round(bounds.y + (bounds.height - node.height) / 2);
    else if (alignment === "bottom") node.y = round(bounds.y + bounds.height - node.height);
    else return false;
  }
  return true;
}

function selectedTreeRoots(nodes, selectedIds) {
  return nodes.filter(
    (node) => selectedIds.has(node.id) && (!node.parentId || !selectedIds.has(node.parentId)),
  );
}

function visualBoundsForNode(nodes, node) {
  const parent = node.parentId
    ? nodes.find((candidate) => candidate.id === node.parentId && isContainerNode(candidate))
    : null;
  return transformedNodeBounds(node, parent);
}

function moveNodeTreeByVisualDelta(nodes, root, delta) {
  if (!Number.isFinite(delta?.x) || !Number.isFinite(delta?.y)) return false;
  const parent = root.parentId
    ? nodes.find((candidate) => candidate.id === root.parentId && isContainerNode(candidate))
    : null;
  const localDelta = parent?.rotation ? rotateVector(delta, -parent.rotation) : delta;
  root.x = round(root.x + localDelta.x);
  root.y = round(root.y + localDelta.y);
  if (isContainerNode(root)) {
    const descendants = descendantIds(nodes, new Set([root.id]));
    for (const node of nodes) {
      if (!descendants.has(node.id)) continue;
      node.x = round(node.x + localDelta.x);
      node.y = round(node.y + localDelta.y);
    }
  }
  return true;
}

export function alignNodeTrees(nodes, selectedIds, alignment, canvas) {
  if (!Array.isArray(nodes) || !(selectedIds instanceof Set) || selectedIds.size === 0) {
    return false;
  }
  if (!["left", "center", "right", "top", "middle", "bottom"].includes(alignment)) return false;
  const roots = selectedTreeRoots(nodes, selectedIds);
  if (roots.length === 0) return false;
  const entries = roots.map((node) => ({ node, bounds: visualBoundsForNode(nodes, node) }));
  if (entries.some((entry) => !entry.bounds)) return false;
  const singleParent =
    roots.length === 1 && roots[0].parentId
      ? nodes.find((candidate) => candidate.id === roots[0].parentId && isContainerNode(candidate))
      : null;
  const target =
    roots.length === 1
      ? singleParent
        ? transformedNodeBounds(singleParent)
        : {
            x: Number.isFinite(canvas?.x) ? canvas.x : 0,
            y: Number.isFinite(canvas?.y) ? canvas.y : 0,
            width: canvas?.width,
            height: canvas?.height,
          }
      : selectionBounds(entries.map((entry) => entry.bounds));
  if (!target || ![target.x, target.y, target.width, target.height].every(Number.isFinite)) {
    return false;
  }
  for (const entry of entries) {
    const { bounds } = entry;
    const delta = { x: 0, y: 0 };
    if (alignment === "left") delta.x = target.x - bounds.x;
    else if (alignment === "center") {
      delta.x = target.x + target.width / 2 - (bounds.x + bounds.width / 2);
    } else if (alignment === "right") {
      delta.x = target.x + target.width - (bounds.x + bounds.width);
    } else if (alignment === "top") delta.y = target.y - bounds.y;
    else if (alignment === "middle") {
      delta.y = target.y + target.height / 2 - (bounds.y + bounds.height / 2);
    } else if (alignment === "bottom") {
      delta.y = target.y + target.height - (bounds.y + bounds.height);
    }
    moveNodeTreeByVisualDelta(nodes, entry.node, delta);
  }
  return true;
}

export function distributeNodes(nodes, axis) {
  if (!Array.isArray(nodes) || nodes.length < 3) return false;
  const horizontal = axis === "horizontal";
  if (!horizontal && axis !== "vertical") return false;
  const position = horizontal ? "x" : "y";
  const size = horizontal ? "width" : "height";
  const ordered = [...nodes].sort((left, right) => left[position] - right[position]);
  const first = ordered[0][position];
  const last = ordered.at(-1);
  const lastEdge = last[position] + last[size];
  const occupied = ordered.reduce((total, node) => total + node[size], 0);
  const gap = (lastEdge - first - occupied) / (ordered.length - 1);
  let cursor = first;
  for (const node of ordered) {
    node[position] = round(cursor);
    cursor += node[size] + gap;
  }
  return true;
}

export function distributeNodeTrees(nodes, selectedIds, axis) {
  if (!Array.isArray(nodes) || !(selectedIds instanceof Set) || selectedIds.size === 0) {
    return false;
  }
  const roots = selectedTreeRoots(nodes, selectedIds);
  if (roots.length < 3 || !["horizontal", "vertical"].includes(axis)) return false;
  const horizontal = axis === "horizontal";
  const position = horizontal ? "x" : "y";
  const size = horizontal ? "width" : "height";
  const entries = roots
    .map((node) => ({ node, bounds: visualBoundsForNode(nodes, node) }))
    .filter((entry) => entry.bounds)
    .sort((left, right) => left.bounds[position] - right.bounds[position]);
  if (entries.length !== roots.length) return false;
  const first = entries[0].bounds[position];
  const last = entries.at(-1).bounds;
  const lastEdge = last[position] + last[size];
  const occupied = entries.reduce((total, entry) => total + entry.bounds[size], 0);
  const gap = (lastEdge - first - occupied) / (entries.length - 1);
  let cursor = first;
  for (const entry of entries) {
    const delta = cursor - entry.bounds[position];
    moveNodeTreeByVisualDelta(
      nodes,
      entry.node,
      horizontal ? { x: delta, y: 0 } : { x: 0, y: delta },
    );
    cursor += entry.bounds[size] + gap;
  }
  return true;
}

export function setNodeTreePosition(nodes, nodeId, axis, value) {
  if (!Array.isArray(nodes) || !["x", "y"].includes(axis) || !Number.isFinite(value)) return false;
  const root = nodes.find((node) => node.id === nodeId);
  if (!root) return false;
  const delta = value - root[axis];
  if (delta === 0) return false;
  root[axis] = round(value);
  if (isContainerNode(root)) {
    const descendants = descendantIds(nodes, new Set([root.id]));
    for (const node of nodes) {
      if (!descendants.has(node.id)) continue;
      node[axis] = round(node[axis] + delta);
    }
  }
  return true;
}

export function moveSelectedNodes(nodes, selectedIds, direction) {
  if (!Array.isArray(nodes) || selectedIds.size === 0) return false;
  if (direction !== "up" && direction !== "down") return false;
  let changed = false;
  const childrenByParent = new Map();
  for (const node of nodes) {
    const parent = node.parentId ?? null;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(node);
    childrenByParent.set(parent, siblings);
  }

  for (const siblings of childrenByParent.values()) {
    if (direction === "up") {
      for (let index = siblings.length - 2; index >= 0; index -= 1) {
        if (selectedIds.has(siblings[index].id) && !selectedIds.has(siblings[index + 1].id)) {
          [siblings[index], siblings[index + 1]] = [siblings[index + 1], siblings[index]];
          changed = true;
        }
      }
    } else {
      for (let index = 1; index < siblings.length; index += 1) {
        if (selectedIds.has(siblings[index].id) && !selectedIds.has(siblings[index - 1].id)) {
          [siblings[index], siblings[index - 1]] = [siblings[index - 1], siblings[index]];
          changed = true;
        }
      }
    }
  }
  if (!changed) return false;

  const ordered = [];
  const visited = new Set();
  const appendTree = (node) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    for (const child of childrenByParent.get(node.id) ?? []) appendTree(child);
  };
  for (const root of childrenByParent.get(null) ?? []) appendTree(root);
  for (const node of nodes) appendTree(node);
  nodes.splice(0, nodes.length, ...ordered);
  return changed;
}

export function reparentNode(nodes, nodeId, parentId) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node || isContainerNode(node)) return false;
  const previousParent = node.parentId
    ? nodes.find((candidate) => candidate.id === node.parentId && isContainerNode(candidate))
    : null;
  const parent =
    typeof parentId === "string"
      ? nodes.find((candidate) => candidate.id === parentId && isContainerNode(candidate))
      : null;
  if (parentId && !parent) return false;
  if (previousParent && !parent) detachNodeFromParent(node, previousParent);
  else transformNodeBetweenParents(node, previousParent, parent);
  const index = nodes.indexOf(node);
  nodes.splice(index, 1);
  if (!parent) {
    delete node.parentId;
    nodes.push(node);
    return true;
  }
  node.parentId = parent.id;
  let insertionIndex = nodes.findIndex((candidate) => candidate.id === parent.id);
  for (let cursor = insertionIndex + 1; cursor < nodes.length; cursor += 1) {
    if (nodes[cursor].parentId === parent.id) insertionIndex = cursor;
  }
  nodes.splice(insertionIndex + 1, 0, node);
  return true;
}
