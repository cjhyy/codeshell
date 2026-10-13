import { SaxesParser } from "saxes";

/** Composer icons are images, never a general SVG document or executable UI. */
export const PLUGIN_COMPOSER_SVG_LIMITS = {
  bytes: 2 * 1024 * 1024,
  elements: 1024,
  depth: 16,
  attributesPerElement: 16,
  attributes: 16_384,
  pathCharacters: 65_536,
  totalPathCharacters: 262_144,
  numbers: 32_768,
  segments: 16_384,
  numberCharacters: 64,
  coordinate: 1_000_000,
  dimension: 8192,
  pixels: 40_000_000,
} as const;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "ellipse",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
]);
const SHAPE_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  svg: new Set(["xmlns", "viewBox", "width", "height", "preserveAspectRatio"]),
  g: new Set(),
  path: new Set(["d"]),
  ellipse: new Set(["cx", "cy", "rx", "ry"]),
  circle: new Set(["cx", "cy", "r"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
  line: new Set(["x1", "y1", "x2", "y2"]),
  polyline: new Set(["points"]),
  polygon: new Set(["points"]),
};
const PRESENTATION_ATTRIBUTES = new Set([
  "id",
  "fill",
  "stroke",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "stroke-width",
  "fill-rule",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
]);
const COLORS = new Set([
  "none",
  "currentColor",
  "transparent",
  "black",
  "silver",
  "gray",
  "white",
  "maroon",
  "red",
  "purple",
  "fuchsia",
  "green",
  "lime",
  "olive",
  "yellow",
  "navy",
  "blue",
  "teal",
  "aqua",
]);
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7 };
const NUMBER = /[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const SPACE = /[\t\n\r ]/u;

interface GeometryBudget {
  numbers: number;
  segments: number;
  pathCharacters: number;
}

function refuse(reason: string): never {
  throw new Error(`Plugin composer SVG ${reason}`);
}

class Numbers {
  offset = 0;
  previousNumber = false;

  constructor(
    readonly text: string,
    readonly budget: GeometryBudget,
  ) {}

  whitespace(): void {
    while (this.offset < this.text.length && SPACE.test(this.text[this.offset])) this.offset++;
  }

  read(): { value: number; token: string } {
    this.whitespace();
    if (this.text[this.offset] === ",") {
      if (!this.previousNumber) refuse("has an invalid number separator");
      this.offset++;
      this.whitespace();
    }
    NUMBER.lastIndex = this.offset;
    const match = NUMBER.exec(this.text);
    if (!match || match[0].length > PLUGIN_COMPOSER_SVG_LIMITS.numberCharacters) {
      refuse("has an invalid or oversized number");
    }
    this.offset = NUMBER.lastIndex;
    this.previousNumber = true;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || Math.abs(value) > PLUGIN_COMPOSER_SVG_LIMITS.coordinate) {
      refuse("has a number outside its finite coordinate limit");
    }
    if (++this.budget.numbers > PLUGIN_COMPOSER_SVG_LIMITS.numbers)
      refuse("exceeds its number limit");
    return { value, token: match[0] };
  }

  list(): number[] {
    const values: number[] = [];
    this.whitespace();
    while (this.offset < this.text.length) {
      values.push(this.read().value);
      this.whitespace();
    }
    return values;
  }
}

function singleNumber(text: string, budget: GeometryBudget): number {
  const values = new Numbers(text, budget).list();
  if (values.length !== 1) refuse("requires exactly one number");
  return values[0];
}

function boundedLength(value: number, positive = false): void {
  if (
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0) ||
    value > PLUGIN_COMPOSER_SVG_LIMITS.dimension
  ) {
    refuse("has a length outside its dimension limit");
  }
}

function segment(budget: GeometryBudget, count = 1): void {
  budget.segments += count;
  if (budget.segments > PLUGIN_COMPOSER_SVG_LIMITS.segments) refuse("exceeds its geometry limit");
}

function validatePath(text: string, budget: GeometryBudget): void {
  budget.pathCharacters += text.length;
  if (
    text.length > PLUGIN_COMPOSER_SVG_LIMITS.pathCharacters ||
    budget.pathCharacters > PLUGIN_COMPOSER_SVG_LIMITS.totalPathCharacters
  )
    refuse("exceeds its path character limit");
  const input = new Numbers(text, budget);
  let command = "";
  let started = false;
  input.whitespace();
  while (input.offset < text.length) {
    const next = text[input.offset];
    if (/[A-Za-z]/u.test(next)) {
      command = next.toLowerCase();
      input.offset++;
      input.previousNumber = false;
      if (!started && command !== "m") refuse("path must start with moveto");
      if (command === "z") {
        segment(budget);
        command = "";
        input.whitespace();
        continue;
      }
      if (!ARITY[command]) refuse("has an unsupported path command");
    }
    if (!command) refuse("has path coordinates without a command");
    const values = Array.from({ length: ARITY[command] }, () => input.read());
    if (command === "a") {
      boundedLength(values[0].value);
      boundedLength(values[1].value);
      if (!/^[01]$/u.test(values[3].token) || !/^[01]$/u.test(values[4].token)) {
        refuse("has invalid arc flags");
      }
    }
    segment(budget);
    started = true;
    if (command === "m") command = "l";
    input.whitespace();
  }
  if (!started) refuse("has an empty path");
}

function validatePresentation(name: string, value: string, budget: GeometryBudget): void {
  if (name === "id") {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(value)) refuse("has an unsupported id");
  } else if (name === "fill" || name === "stroke") {
    if (!COLORS.has(value) && !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value)) {
      refuse("has an unsupported paint value");
    }
  } else if (["opacity", "fill-opacity", "stroke-opacity"].includes(name)) {
    const opacity = singleNumber(value, budget);
    if (opacity < 0 || opacity > 1) refuse("has an invalid opacity");
  } else if (name === "stroke-width") {
    boundedLength(singleNumber(value, budget));
  } else if (name === "stroke-miterlimit") {
    const limit = singleNumber(value, budget);
    if (limit < 1 || limit > 1000) refuse("has an invalid stroke miter limit");
  } else {
    const allowed: Record<string, string[]> = {
      "fill-rule": ["nonzero", "evenodd"],
      "stroke-linecap": ["butt", "round", "square"],
      "stroke-linejoin": ["miter", "round", "bevel"],
    };
    if (!allowed[name]?.includes(value)) refuse("has an unsupported presentation value");
  }
}

/** Validate original bytes without fetching resources, rewriting XML, or importing a UI runtime. */
export function validatePluginComposerSvg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength === 0 || bytes.byteLength > PLUGIN_COMPOSER_SVG_LIMITS.bytes) {
    refuse("exceeds its byte limit");
  }
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[&\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(xml)) {
    refuse("contains entities or unsupported control characters");
  }
  const parser = new SaxesParser({ xmlns: true, fragment: false });
  const stack: string[] = [];
  const budget: GeometryBudget = { numbers: 0, segments: 0, pathCharacters: 0 };
  let elements = 0;
  let attributes = 0;
  let elementAttributes = 0;
  let width = 0;
  let height = 0;
  parser.on("error", (error) => {
    throw error;
  });
  parser.on("xmldecl", (declaration) => {
    if (
      declaration.version !== "1.0" ||
      (declaration.encoding && !/^utf-8$/iu.test(declaration.encoding))
    ) {
      refuse("requires an XML 1.0 UTF-8 declaration");
    }
  });
  for (const event of ["doctype", "processinginstruction", "cdata", "comment"] as const) {
    parser.on(event, () => refuse(`contains forbidden ${event}`));
  }
  parser.on("text", (text) => {
    if (!/^[\t\n\r ]*$/u.test(text)) refuse("contains text content");
  });
  parser.on("opentagstart", () => {
    elementAttributes = 0;
  });
  parser.on("attribute", () => {
    if (
      ++elementAttributes > PLUGIN_COMPOSER_SVG_LIMITS.attributesPerElement ||
      ++attributes > PLUGIN_COMPOSER_SVG_LIMITS.attributes
    ) {
      refuse("exceeds its attribute limit");
    }
  });
  parser.on("opentag", (tag) => {
    const root = stack.length === 0;
    if (
      ++elements > PLUGIN_COMPOSER_SVG_LIMITS.elements ||
      stack.length + 1 > PLUGIN_COMPOSER_SVG_LIMITS.depth
    ) {
      refuse("exceeds its structure limit");
    }
    if (
      !ELEMENTS.has(tag.local) ||
      tag.prefix ||
      tag.uri !== SVG_NAMESPACE ||
      (root ? tag.local !== "svg" : tag.local === "svg")
    ) {
      refuse("contains an unsupported element or namespace");
    }
    if (!root && !["svg", "g"].includes(stack[stack.length - 1]))
      refuse("nests elements inside a shape");
    const attrs: Record<string, string> = {};
    for (const attr of Object.values(tag.attributes)) {
      if (attr.name === "xmlns" && root && attr.value === SVG_NAMESPACE) {
        attrs.xmlns = attr.value;
        continue;
      }
      if (
        attr.prefix ||
        attr.uri ||
        attr.name === "xmlns" ||
        (!SHAPE_ATTRIBUTES[tag.local].has(attr.name) && !PRESENTATION_ATTRIBUTES.has(attr.name))
      ) {
        refuse("contains an unsupported attribute or namespace");
      }
      attrs[attr.name] = attr.value;
      if (PRESENTATION_ATTRIBUTES.has(attr.name)) {
        validatePresentation(attr.name, attr.value, budget);
      } else if (attr.name === "d") {
        validatePath(attr.value, budget);
      } else if (attr.name === "points") {
        const points = new Numbers(attr.value, budget).list();
        if (points.length % 2 || points.length < (tag.local === "polygon" ? 6 : 4))
          refuse("has invalid points");
        segment(budget, points.length / 2);
      } else if (attr.name === "preserveAspectRatio") {
        if (!/^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/u.test(attr.value))
          refuse("has an unsupported aspect ratio");
      } else if (attr.name !== "viewBox") {
        const value = singleNumber(root ? attr.value.replace(/px$/u, "") : attr.value, budget);
        if (["width", "height", "r", "rx", "ry"].includes(attr.name)) boundedLength(value, root);
      }
    }
    if (root) {
      if (attrs.xmlns !== SVG_NAMESPACE || !attrs.viewBox) refuse("requires SVG xmlns and viewBox");
      const viewBox = new Numbers(attrs.viewBox, budget).list();
      if (viewBox.length !== 4) refuse("requires four viewBox numbers");
      boundedLength(viewBox[2], true);
      boundedLength(viewBox[3], true);
      if (viewBox[2] * viewBox[3] > PLUGIN_COMPOSER_SVG_LIMITS.pixels)
        refuse("exceeds its viewport pixel limit");
      width = attrs.width ? Number(attrs.width.replace(/px$/u, "")) : viewBox[2];
      height = attrs.height ? Number(attrs.height.replace(/px$/u, "")) : viewBox[3];
      if (attrs.width && !attrs.height) height = width * (viewBox[3] / viewBox[2]);
      if (attrs.height && !attrs.width) width = height * (viewBox[2] / viewBox[3]);
      boundedLength(width, true);
      boundedLength(height, true);
      if (width * height > PLUGIN_COMPOSER_SVG_LIMITS.pixels)
        refuse("exceeds its image pixel limit");
    } else {
      if (tag.local === "path" && !attrs.d) refuse("requires path data");
      if (["polygon", "polyline"].includes(tag.local) && !attrs.points) refuse("requires points");
      segment(budget);
    }
    stack.push(tag.local);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  if (!elements || stack.length || width <= 0 || height <= 0) refuse("is incomplete");
  return { width, height };
}
