/* Accessibility and layout audit engine for the Design Studio Panel App. */
import { pointInRotatedBounds, rotateVector, transformedNodeBounds } from "./geometry.mjs";
import { effectiveDesignNodeOpacity, isDesignNodeVisible } from "./document.mjs";

function validHex(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function rgb(value) {
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function channelLuminance(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground, background) {
  if (!validHex(foreground) || !validHex(background)) return null;
  const luminance = (value) => {
    const [red, green, blue] = rgb(value).map(channelLuminance);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function blendHex(foreground, background, opacity) {
  if (!validHex(foreground) || !validHex(background)) return background;
  const alpha = Math.min(1, Math.max(0, opacity));
  const blended = rgb(foreground).map((channel, index) => {
    const backgroundChannel = rgb(background)[index];
    return Math.round((channel * alpha + backgroundChannel * (1 - alpha)) * 255);
  });
  return `#${blended.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function contains(container, node) {
  return (
    node.x >= container.x &&
    node.y >= container.y &&
    node.x + node.width <= container.x + container.width &&
    node.y + node.height <= container.y + container.height
  );
}

function pointInNodeFill(node, point) {
  if (!pointInRotatedBounds(node, point)) return false;
  if (node.type !== "ellipse") return true;
  const radiusX = node.width / 2;
  const radiusY = node.height / 2;
  if (radiusX <= 0 || radiusY <= 0) return false;
  const center = { x: node.x + radiusX, y: node.y + radiusY };
  const local = rotateVector(
    { x: point.x - center.x, y: point.y - center.y },
    -(node.rotation ?? 0),
  );
  return (local.x / radiusX) ** 2 + (local.y / radiusY) ** 2 <= 1;
}

function textBackground(document, node, index) {
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const parent = node.parentId
    ? document.nodes.find((candidate) => candidate.id === node.parentId)
    : null;
  let background = document.canvas.background;
  if (parent && validHex(parent.fill)) {
    background = blendHex(parent.fill, background, parent.opacity);
  }
  for (let cursor = 0; cursor < index; cursor += 1) {
    const candidate = document.nodes[cursor];
    if (
      isDesignNodeVisible(document, candidate) &&
      candidate.parentId === node.parentId &&
      candidate.type !== "text" &&
      validHex(candidate.fill) &&
      pointInNodeFill(candidate, center)
    ) {
      background = blendHex(
        candidate.fill,
        background,
        effectiveDesignNodeOpacity(document, candidate),
      );
    }
  }
  return background;
}

export function auditDesign(document) {
  const issues = [];
  const canvas = { x: 0, y: 0, width: document.canvas.width, height: document.canvas.height };
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const effectivelyVisible = (node) => {
    if (!node.visible || node.opacity <= 0) return false;
    const parent = node.parentId ? byId.get(node.parentId) : null;
    return !parent || (parent.visible && parent.opacity > 0);
  };
  document.nodes.forEach((node, index) => {
    let parent = null;
    if (node.parentId) {
      parent = byId.get(node.parentId);
      if (!parent || parent.type !== "frame") {
        issues.push({
          severity: "error",
          nodeId: node.id,
          message: `父级 Frame 不存在：${node.parentId}`,
        });
      }
    }
    if (!effectivelyVisible(node)) return;
    const visualBounds = transformedNodeBounds(node, parent);
    if (!visualBounds || !contains(canvas, visualBounds)) {
      issues.push({
        severity: "warning",
        nodeId: node.id,
        message: "图层超出文档画布边界",
      });
    }
    if (node.parentId && parent?.type === "frame") {
      const localVisualBounds = transformedNodeBounds(node);
      if (!localVisualBounds || !contains(parent, localVisualBounds)) {
        issues.push({
          severity: "warning",
          nodeId: node.id,
          message: `图层超出所属 Frame「${parent.name}」`,
        });
      }
    }
    if (node.type !== "text") return;
    if (!String(node.text).trim()) {
      issues.push({ severity: "warning", nodeId: node.id, message: "文本内容为空" });
      return;
    }
    const lineCount = String(node.text).split("\n").length;
    const minimumTextHeight =
      node.fontSize + Math.max(0, lineCount - 1) * node.fontSize * node.lineHeight;
    if (node.height + 0.5 < minimumTextHeight) {
      issues.push({
        severity: "warning",
        nodeId: node.id,
        message: `文本高度不足：当前 ${node.height}px，至少需要约 ${Math.ceil(minimumTextHeight)}px`,
      });
    }
    if (node.fill === "transparent") {
      issues.push({ severity: "warning", nodeId: node.id, message: "文字填充透明，内容不可见" });
      return;
    }
    const background = textBackground(document, node, index);
    const renderedFill = blendHex(
      node.fill,
      background,
      effectiveDesignNodeOpacity(document, node),
    );
    const ratio = contrastRatio(renderedFill, background);
    if (ratio == null) return;
    const largeText = node.fontSize >= 24 || (node.fontSize >= 18 && node.fontWeight >= 700);
    const required = largeText ? 3 : 4.5;
    if (ratio < required) {
      issues.push({
        severity: "warning",
        nodeId: node.id,
        message: `文字对比度 ${ratio.toFixed(2)}:1，建议至少 ${required}:1`,
      });
    }
  });
  return issues;
}

export function auditMarkdown(document, issues, sourcePath) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const escapeCell = (value) =>
    String(value)
      .replaceAll("\\", "\\\\")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("|", "\\|")
      .replaceAll("`", "\\`")
      .replace(/([*_[\]{}()#+.!])/gu, "\\$1")
      .replaceAll("\r", " ")
      .replaceAll("\n", " ");
  const inlineCode = (value) => {
    const text = String(value).replaceAll("\n", " ");
    const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestRun + 1);
    const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
  };
  const lines = [
    `# Design audit: ${escapeCell(document.name)}`,
    "",
    `Source: ${inlineCode(sourcePath)}`,
    "",
    `Summary: ${issues.length} issue(s), ${errors} error(s), ${issues.length - errors} warning(s).`,
    "",
  ];
  if (issues.length === 0) {
    lines.push("No issues found.", "");
    return lines.join("\n");
  }
  const names = new Map(document.nodes.map((node) => [node.id, node.name]));
  lines.push("| Severity | Layer | Node ID | Finding |", "| --- | --- | --- | --- |");
  for (const issue of issues) {
    lines.push(
      `| ${issue.severity} | ${escapeCell(names.get(issue.nodeId) ?? issue.nodeId)} | ${inlineCode(issue.nodeId)} | ${escapeCell(issue.message)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
