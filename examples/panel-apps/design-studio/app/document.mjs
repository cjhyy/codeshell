/* Repository document codec used by the Design Studio Panel App. */
const SVG_NS = "http://www.w3.org/2000/svg";
export const MAX_DESIGN_NODES = 500;
export const MAX_DESIGN_DOCUMENT_BYTES = 192 * 1024;
export const MAX_SVG_EXPORT_BYTES = 384 * 1024;
const V1_NODE_TYPES = ["frame", "rectangle", "ellipse", "text"];
const V2_NODE_TYPES = [...V1_NODE_TYPES, "group", "component", "instance"];
const CONTAINER_NODE_TYPES = ["frame", "group", "component"];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validHex(value) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function hasUnsafeControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isPortablePathSegment(segment) {
  const windowsBaseName = (segment.split(".", 1)[0] ?? "").trimEnd().toUpperCase();
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    segment.toLowerCase() !== "node_modules" &&
    !/[. ]$/u.test(segment) &&
    !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsBaseName)
  );
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function assertObject(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  const unknown = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key) && value[key] !== undefined,
  );
  if (unknown.length > 0) throw new Error(`${label} 包含未知字段：${unknown.join(", ")}`);
}

function assertFiniteRange(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的有限数字`);
  }
}

export function isSafeDesignPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !value.startsWith("designs/") ||
    !value.endsWith(".codesign.json") ||
    value.includes(":") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every(isPortablePathSegment);
}

export function workspaceVersionChanged(base, current) {
  const diskFound = current?.found === true;
  if (!diskFound) return base.revision !== null || base.modifiedAt !== null;
  if (base.revision !== null) return base.revision !== current.revision;
  if (base.modifiedAt !== null) {
    return (
      !Number.isFinite(current.modifiedAt) || Math.abs(base.modifiedAt - current.modifiedAt) > 0.001
    );
  }
  return true;
}

function isContainerType(type) {
  return CONTAINER_NODE_TYPES.includes(type);
}

function normalizedNode(candidate, version) {
  const node = {
    id: candidate.id,
    type: candidate.type,
    name: candidate.name,
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
    fill: candidate.fill.toLowerCase(),
    stroke: candidate.stroke.toLowerCase(),
    strokeWidth: candidate.strokeWidth,
    opacity: candidate.opacity,
    rotation: candidate.rotation,
    cornerRadius: candidate.cornerRadius,
    visible: candidate.visible,
    locked: candidate.locked,
    ...(!isContainerType(candidate.type) && candidate.parentId !== undefined
      ? { parentId: candidate.parentId }
      : {}),
    ...(candidate.notes !== undefined ? { notes: candidate.notes } : {}),
  };
  if (candidate.type === "text") {
    node.text = candidate.text;
    node.fontSize = candidate.fontSize;
    node.fontWeight = candidate.fontWeight;
    node.lineHeight = candidate.lineHeight;
    node.textAlign = candidate.textAlign;
  } else if (
    ["frame", "component"].includes(candidate.type) &&
    candidate.clipContent !== undefined
  ) {
    node.clipContent = candidate.clipContent;
  }
  if (version === 2 && isContainerType(candidate.type)) {
    node.layout = candidate.layout ?? "none";
    node.gap = candidate.gap ?? 0;
    node.padding = candidate.padding ?? 0;
    node.alignItems = candidate.alignItems ?? "start";
    node.justifyContent = candidate.justifyContent ?? "start";
  }
  if (version === 2 && !isContainerType(candidate.type)) {
    if (candidate.layoutGrow !== undefined) node.layoutGrow = candidate.layoutGrow;
    if (candidate.layoutAlign !== undefined) node.layoutAlign = candidate.layoutAlign;
  }
  if (version === 2 && candidate.type === "instance") {
    node.componentId = candidate.componentId;
  }
  return node;
}

export function normalizeDesignDocument(input) {
  assertObject(input, "设计文档", ["format", "version", "name", "canvas", "tokens", "nodes"]);
  if (
    input.format !== "codeshell.design" ||
    ![1, 2].includes(input.version) ||
    !Array.isArray(input.nodes)
  ) {
    throw new Error("不是有效的 CodeShell Design v1/v2 文件");
  }
  const version = input.version;
  if (
    typeof input.name !== "string" ||
    input.name.length > 120 ||
    hasUnsafeControlCharacters(input.name)
  ) {
    throw new Error("设计名称必须是最多 120 个字符的字符串");
  }
  assertObject(input.canvas, "canvas", ["width", "height", "background"]);
  assertFiniteRange(input.canvas.width, 100, 10000, "canvas.width");
  assertFiniteRange(input.canvas.height, 100, 10000, "canvas.height");
  if (!validHex(input.canvas.background))
    throw new Error("canvas.background 必须是六位十六进制色值");
  assertObject(input.tokens, "tokens", ["colors"]);
  if (!Array.isArray(input.tokens.colors)) throw new Error("颜色变量必须是数组");
  if (input.nodes.length > MAX_DESIGN_NODES) {
    throw new Error(`设计文件最多包含 ${MAX_DESIGN_NODES} 个图层`);
  }
  const rawColors = input.tokens.colors;
  if ((rawColors?.length ?? 0) > 32) throw new Error("颜色变量最多 32 个");
  const colorNames = new Set();
  const colors = (rawColors ?? []).map((token, index) => {
    assertObject(token, `颜色变量 ${index + 1}`, ["name", "value"]);
    if (
      typeof token.name !== "string" ||
      token.name.length === 0 ||
      token.name.length > 80 ||
      hasUnsafeControlCharacters(token.name) ||
      !validHex(token.value)
    ) {
      throw new Error(`颜色变量 ${index + 1} 无效`);
    }
    const name = token.name;
    const normalizedName = name.trim().toLowerCase();
    if (!name.trim()) throw new Error(`颜色变量 ${index + 1} 的名称不能为空`);
    if (colorNames.has(normalizedName)) throw new Error(`颜色变量名称重复：${name}`);
    colorNames.add(normalizedName);
    return { name, value: token.value.toLowerCase() };
  });
  const normalized = {
    format: "codeshell.design",
    version,
    name: input.name,
    canvas: {
      width: input.canvas.width,
      height: input.canvas.height,
      background: input.canvas.background.toLowerCase(),
    },
    tokens: { colors },
    nodes: [],
  };
  const ids = new Set();
  for (const [index, candidate] of input.nodes.entries()) {
    const allowedKeys = [
      "id",
      "type",
      "name",
      "parentId",
      "notes",
      "x",
      "y",
      "width",
      "height",
      "fill",
      "stroke",
      "strokeWidth",
      "opacity",
      "rotation",
      "cornerRadius",
      "visible",
      "locked",
      "clipContent",
      "text",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "textAlign",
      ...(version === 2
        ? [
            "layout",
            "gap",
            "padding",
            "alignItems",
            "justifyContent",
            "layoutGrow",
            "layoutAlign",
            "componentId",
          ]
        : []),
    ];
    assertObject(candidate, `图层 ${index + 1}`, allowedKeys);
    if (
      !(version === 1 ? V1_NODE_TYPES : V2_NODE_TYPES).includes(candidate.type) ||
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      candidate.id.length > 160 ||
      hasUnsafeControlCharacters(candidate.id)
    ) {
      throw new Error(`图层 ${index + 1} 的类型或 ID 无效`);
    }
    if (
      typeof candidate.name !== "string" ||
      candidate.name.length > 120 ||
      hasUnsafeControlCharacters(candidate.name)
    ) {
      throw new Error(`图层 ${candidate.id} 的名称无效`);
    }
    for (const [property, minimum, maximum] of [
      ["x", -20000, 20000],
      ["y", -20000, 20000],
      ["width", 1, 20000],
      ["height", 1, 20000],
      ["strokeWidth", 0, 100],
      ["opacity", 0, 1],
      ["rotation", -360, 360],
      ["cornerRadius", 0, 9999],
    ]) {
      assertFiniteRange(candidate[property], minimum, maximum, `图层 ${candidate.id}.${property}`);
    }
    if (
      !(candidate.fill === "transparent" || validHex(candidate.fill)) ||
      !(candidate.stroke === "transparent" || validHex(candidate.stroke))
    ) {
      throw new Error(`图层 ${candidate.id} 的填充或描边色值无效`);
    }
    if (typeof candidate.visible !== "boolean" || typeof candidate.locked !== "boolean") {
      throw new Error(`图层 ${candidate.id} 的 visible 或 locked 无效`);
    }
    if (
      candidate.notes !== undefined &&
      (typeof candidate.notes !== "string" || candidate.notes.length > 2000)
    ) {
      throw new Error(`图层 ${candidate.id} 的 notes 无效`);
    }
    if (ids.has(candidate.id)) throw new Error(`图层 ID 重复：${candidate.id}`);
    if (isContainerType(candidate.type) && candidate.parentId !== undefined) {
      throw new Error(`容器 ${candidate.id} 必须位于根级`);
    }
    if (
      candidate.type !== "text" &&
      ["text", "fontSize", "fontWeight", "lineHeight", "textAlign"].some((property) =>
        Object.prototype.hasOwnProperty.call(candidate, property),
      )
    ) {
      throw new Error(`非文字图层 ${candidate.id} 包含文字专属字段`);
    }
    if (
      candidate.type === "text" &&
      (typeof candidate.text !== "string" ||
        candidate.text.length > 4000 ||
        typeof candidate.fontSize !== "number" ||
        !Number.isFinite(candidate.fontSize) ||
        candidate.fontSize < 6 ||
        candidate.fontSize > 240 ||
        ![400, 500, 600, 700].includes(candidate.fontWeight) ||
        typeof candidate.lineHeight !== "number" ||
        !Number.isFinite(candidate.lineHeight) ||
        candidate.lineHeight < 0.7 ||
        candidate.lineHeight > 3 ||
        !["left", "center", "right"].includes(candidate.textAlign))
    ) {
      throw new Error(`文字图层 ${candidate.id} 的文字属性无效`);
    }
    if (
      (!["frame", "component"].includes(candidate.type) && candidate.clipContent !== undefined) ||
      (["frame", "component"].includes(candidate.type) &&
        candidate.clipContent !== undefined &&
        typeof candidate.clipContent !== "boolean")
    ) {
      throw new Error(`图层 ${candidate.id} 的 clipContent 无效`);
    }
    if (
      candidate.parentId !== undefined &&
      (typeof candidate.parentId !== "string" ||
        candidate.parentId.length === 0 ||
        candidate.parentId.length > 160 ||
        hasUnsafeControlCharacters(candidate.parentId))
    ) {
      throw new Error(`图层 ${candidate.id} 的 parentId 无效`);
    }
    if (version === 2 && isContainerType(candidate.type)) {
      const missingLayoutField = ["layout", "gap", "padding", "alignItems", "justifyContent"].find(
        (property) => !Object.prototype.hasOwnProperty.call(candidate, property),
      );
      if (missingLayoutField) {
        throw new Error(`容器 ${candidate.id} 缺少 ${missingLayoutField}`);
      }
      if (
        candidate.layout !== undefined &&
        !["none", "horizontal", "vertical"].includes(candidate.layout)
      ) {
        throw new Error(`容器 ${candidate.id} 的 layout 无效`);
      }
      for (const property of ["gap", "padding"]) {
        if (candidate[property] !== undefined) {
          assertFiniteRange(candidate[property], 0, 2000, `容器 ${candidate.id}.${property}`);
        }
      }
      if (
        candidate.alignItems !== undefined &&
        !["start", "center", "end", "stretch"].includes(candidate.alignItems)
      ) {
        throw new Error(`容器 ${candidate.id} 的 alignItems 无效`);
      }
      if (
        candidate.justifyContent !== undefined &&
        !["start", "center", "end", "space-between"].includes(candidate.justifyContent)
      ) {
        throw new Error(`容器 ${candidate.id} 的 justifyContent 无效`);
      }
    } else if (
      ["layout", "gap", "padding", "alignItems", "justifyContent"].some((property) =>
        Object.prototype.hasOwnProperty.call(candidate, property),
      )
    ) {
      throw new Error(`图层 ${candidate.id} 包含容器专属布局字段`);
    }
    if (version === 2 && !isContainerType(candidate.type)) {
      if (candidate.layoutGrow !== undefined && ![0, 1].includes(candidate.layoutGrow)) {
        throw new Error(`图层 ${candidate.id} 的 layoutGrow 无效`);
      }
      if (
        candidate.layoutAlign !== undefined &&
        !["auto", "start", "center", "end", "stretch"].includes(candidate.layoutAlign)
      ) {
        throw new Error(`图层 ${candidate.id} 的 layoutAlign 无效`);
      }
    }
    if (
      candidate.type === "instance" &&
      (typeof candidate.componentId !== "string" ||
        candidate.componentId.length === 0 ||
        candidate.componentId.length > 160 ||
        hasUnsafeControlCharacters(candidate.componentId))
    ) {
      throw new Error(`实例 ${candidate.id} 的 componentId 无效`);
    }
    if (
      candidate.type !== "instance" &&
      Object.prototype.hasOwnProperty.call(candidate, "componentId")
    ) {
      throw new Error(`非实例图层 ${candidate.id} 包含 componentId`);
    }
    ids.add(candidate.id);
    normalized.nodes.push(normalizedNode(candidate, version));
  }
  const containerIds = new Set(
    normalized.nodes.filter((node) => isContainerType(node.type)).map((node) => node.id),
  );
  for (const node of normalized.nodes) {
    if (node.parentId && !containerIds.has(node.parentId)) {
      throw new Error(
        version === 1
          ? `图层 ${node.id} 引用了不存在的 Frame：${node.parentId}`
          : `图层 ${node.id} 引用了不存在的容器：${node.parentId}`,
      );
    }
    if (node.parentId === node.id) {
      throw new Error(`图层 ${node.id} 不能成为自己的父级`);
    }
    if (
      version === 2 &&
      node.type === "instance" &&
      !normalized.nodes.some(
        (candidate) => candidate.id === node.componentId && candidate.type === "component",
      )
    ) {
      throw new Error(`实例 ${node.id} 引用了不存在的组件：${node.componentId}`);
    }
  }
  const expectedOrder = normalized.nodes.flatMap((node) =>
    node.parentId
      ? []
      : [
          node.id,
          ...normalized.nodes
            .filter((candidate) => candidate.parentId === node.id)
            .map((candidate) => candidate.id),
        ],
  );
  if (
    expectedOrder.length !== normalized.nodes.length ||
    expectedOrder.some((id, index) => id !== normalized.nodes[index].id)
  ) {
    throw new Error(
      version === 1 ? "Frame 必须紧邻并位于其子图层之前" : "容器必须紧邻并位于其子图层之前",
    );
  }
  assertDesignDocumentSize(normalized);
  return normalized;
}

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "\ufffd")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function effectiveDesignNodeOpacity(document, node) {
  const parent = node.parentId
    ? document.nodes.find((candidate) => candidate.id === node.parentId)
    : null;
  return clamp(node.opacity * (parent?.opacity ?? 1), 0, 1);
}

export function isDesignNodeVisible(document, node) {
  if (!node.visible) return false;
  const parent = node.parentId
    ? document.nodes.find((candidate) => candidate.id === node.parentId)
    : null;
  return (!parent || parent.visible) && effectiveDesignNodeOpacity(document, node) > 0;
}

function svgTransform(document, node) {
  const transforms = [];
  const parent = node.parentId
    ? document.nodes.find((candidate) => candidate.id === node.parentId)
    : null;
  if (parent?.rotation) {
    transforms.push(
      `rotate(${parent.rotation} ${round(parent.x + parent.width / 2)} ${round(parent.y + parent.height / 2)})`,
    );
  }
  if (node.rotation) {
    transforms.push(
      `rotate(${node.rotation} ${round(node.x + node.width / 2)} ${round(node.y + node.height / 2)})`,
    );
  }
  return transforms.length > 0 ? ` transform="${transforms.join(" ")}"` : "";
}

function exportNodeSvg(document, node, clipIds) {
  if (!isDesignNodeVisible(document, node)) return "";
  if (node.type === "instance") {
    const component = document.nodes.find(
      (candidate) => candidate.id === node.componentId && candidate.type === "component",
    );
    if (!component || component.width <= 0 || component.height <= 0) return "";
    const sourceNodes = [
      component,
      ...document.nodes.filter(
        (candidate) => candidate.parentId === component.id && candidate.type !== "instance",
      ),
    ];
    const source = sourceNodes
      .map((candidate) => exportNodeSvg(document, candidate, clipIds))
      .filter(Boolean)
      .join("\n");
    const scaleX = round(node.width / component.width, 6);
    const scaleY = round(node.height / component.height, 6);
    const mapping = `translate(${round(node.x)} ${round(node.y)}) scale(${scaleX} ${scaleY}) translate(${-round(component.x)} ${-round(component.y)})`;
    const transform = svgTransform(document, node);
    const effectiveOpacity = round(effectiveDesignNodeOpacity(document, node), 4);
    const opacity = effectiveOpacity === 1 ? "" : ` opacity="${effectiveOpacity}"`;
    const markup = `  <g data-node-id="${escapeXml(node.id)}" data-component-id="${escapeXml(component.id)}"${opacity}${transform}>\n    <g transform="${mapping}">\n${source
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n")}\n    </g>\n  </g>`;
    const clipId = node.parentId ? clipIds.get(node.parentId) : null;
    return clipId
      ? `  <g clip-path="url(#${clipId})">\n${markup
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n  </g>`
      : markup;
  }
  const transform = svgTransform(document, node);
  const effectiveOpacity = round(effectiveDesignNodeOpacity(document, node), 4);
  const opacity = effectiveOpacity === 1 ? "" : ` opacity="${effectiveOpacity}"`;
  const metadata = ` data-node-id="${escapeXml(node.id)}"`;
  const clipId = node.parentId ? clipIds.get(node.parentId) : null;
  const clipped = (markup) =>
    clipId ? `  <g clip-path="url(#${clipId})">\n    ${markup.slice(2)}\n  </g>` : markup;
  if (node.type === "ellipse") {
    return clipped(
      `  <ellipse${metadata} cx="${round(node.x + node.width / 2)}" cy="${round(node.y + node.height / 2)}" rx="${round(node.width / 2)}" ry="${round(node.height / 2)}" fill="${escapeXml(node.fill)}" stroke="${escapeXml(node.stroke)}" stroke-width="${node.strokeWidth}"${opacity}${transform} />`,
    );
  }
  if (node.type === "text") {
    const textX =
      node.textAlign === "center"
        ? node.x + node.width / 2
        : node.textAlign === "right"
          ? node.x + node.width
          : node.x;
    const anchor =
      node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start";
    const lines = String(node.text)
      .split("\n")
      .map(
        (line, index) =>
          `<tspan x="${round(textX)}" dy="${index === 0 ? 0 : round(node.fontSize * node.lineHeight)}">${escapeXml(line || " ")}</tspan>`,
      )
      .join("");
    return clipped(
      `  <text${metadata} x="${round(textX)}" y="${round(node.y)}" fill="${escapeXml(node.fill)}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="${node.fontSize}" font-weight="${node.fontWeight}" text-anchor="${anchor}" dominant-baseline="hanging"${opacity}${transform}>${lines}</text>`,
    );
  }
  if (node.type === "group") return "";
  return clipped(
    `  <rect${metadata} x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(Math.min(node.cornerRadius, node.width / 2, node.height / 2))}" fill="${escapeXml(node.fill)}" stroke="${escapeXml(node.stroke)}" stroke-width="${node.strokeWidth}"${opacity}${transform} />`,
  );
}

export function serializeDesignDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function replaceDesignColor(document, previousValue, nextValue) {
  if (!validHex(previousValue) || !validHex(nextValue)) return 0;
  const previous = previousValue.toLowerCase();
  const next = nextValue.toLowerCase();
  if (previous === next) return 0;
  let replacements = 0;
  if (document.canvas?.background?.toLowerCase() === previous) {
    document.canvas.background = next;
    replacements += 1;
  }
  for (const node of document.nodes ?? []) {
    for (const property of ["fill", "stroke"]) {
      if (node[property]?.toLowerCase() !== previous) continue;
      node[property] = next;
      replacements += 1;
    }
  }
  return replacements;
}

export function assertDesignDocumentSize(value) {
  const bytes = new TextEncoder().encode(serializeDesignDocument(value)).length;
  if (bytes > MAX_DESIGN_DOCUMENT_BYTES) {
    throw new Error(
      `设计文件为 ${(bytes / 1024).toFixed(1)} KiB，超过 ${MAX_DESIGN_DOCUMENT_BYTES / 1024} KiB 上限`,
    );
  }
  return bytes;
}

export function exportDesignSvg(document) {
  const clipIds = new Map();
  const clipPaths = [];
  document.nodes.forEach((node, index) => {
    if (!["frame", "component"].includes(node.type) || node.clipContent !== true) return;
    const id = `frame-clip-${index}`;
    clipIds.set(node.id, id);
    const transform = node.rotation
      ? ` transform="rotate(${node.rotation} ${round(node.x + node.width / 2)} ${round(node.y + node.height / 2)})"`
      : "";
    clipPaths.push(
      `    <clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${round(Math.min(node.cornerRadius, node.width / 2, node.height / 2))}"${transform} /></clipPath>`,
    );
  });
  const body = document.nodes
    .map((node) => exportNodeSvg(document, node, clipIds))
    .filter(Boolean)
    .join("\n");
  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="${SVG_NS}" width="${document.canvas.width}" height="${document.canvas.height}" viewBox="0 0 ${document.canvas.width} ${document.canvas.height}">`,
    ...(clipPaths.length > 0 ? ["  <defs>", ...clipPaths, "  </defs>"] : []),
    `  <rect width="${document.canvas.width}" height="${document.canvas.height}" fill="${escapeXml(document.canvas.background)}" />`,
    body,
    "</svg>",
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(svg).length;
  if (bytes > MAX_SVG_EXPORT_BYTES) {
    throw new Error(
      `SVG 为 ${(bytes / 1024).toFixed(1)} KiB，超过 ${MAX_SVG_EXPORT_BYTES / 1024} KiB 导出上限；请减少长文本或图层数量`,
    );
  }
  return svg;
}
