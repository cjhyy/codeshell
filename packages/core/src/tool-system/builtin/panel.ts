import type { ContentBlock, ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { validateToolInputSchemaStrict } from "../validation.js";

export const panelToolDef: ToolDefinition = {
  name: "Panel",
  description:
    "Discover, open, and use panels in the interactive host. Use action='list' to discover " +
    "stable panel ids, action='tools' to inspect a Panel App's structured Agent tools, and " +
    "action='invoke' to call one. Invoking a tool opens its panel automatically.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "open", "tools", "invoke"],
        description: "List panels, open one, list its tools, or invoke one of its tools.",
      },
      panel_id: {
        type: "string",
        description: "Stable id returned by action='list'. Required except for action='list'.",
      },
      tool_name: {
        type: "string",
        description: "Declared tool name returned by action='tools'. Required for action='invoke'.",
      },
      arguments: {
        type: "object",
        description: "JSON object passed to the Panel App tool handler.",
        additionalProperties: true,
      },
    },
    required: ["action"],
  },
};

const NO_PANEL_HOST =
  "Error: panel hosting is not available in this session. This tool requires an interactive Desktop host.";

type PanelToolImageResult = {
  contentBlocks: ContentBlock[];
  result: string;
};

const INVALID_PANEL_IMAGE = "Error: Panel App returned an invalid image result";
const MAX_PANEL_IMAGE_DIMENSION = 16_384;
const MAX_PANEL_IMAGE_PIXELS = 24_000_000;
const MAX_PANEL_JSON_RESULT_BYTES = 512 * 1024;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedPanelJson(value: unknown): string | null {
  try {
    const encoded = JSON.stringify(value, null, 2);
    return Buffer.byteLength(encoded, "utf8") <= MAX_PANEL_JSON_RESULT_BYTES ? encoded : null;
  } catch {
    return null;
  }
}

type SafePanelToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};

function safePanelToolDescriptors(value: unknown): SafePanelToolDescriptor[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const tools: SafePanelToolDescriptor[] = [];
  for (const candidate of value) {
    if (
      !plainObject(candidate) ||
      typeof candidate.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(candidate.name) ||
      typeof candidate.description !== "string" ||
      candidate.description.length < 1 ||
      candidate.description.length > 500 ||
      !plainObject(candidate.inputSchema) ||
      candidate.inputSchema.type !== "object" ||
      validateToolInputSchemaStrict(candidate.inputSchema) !== null ||
      typeof candidate.readOnly !== "boolean"
    ) {
      return null;
    }
    tools.push({
      name: candidate.name,
      description: candidate.description,
      inputSchema: candidate.inputSchema,
      readOnly: candidate.readOnly,
    });
  }
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) return null;
  return tools;
}

function validImageDimensions(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_PANEL_IMAGE_DIMENSION &&
    height <= MAX_PANEL_IMAGE_DIMENSION &&
    width * height <= MAX_PANEL_IMAGE_PIXELS
  );
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const startOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (startOfFrame) {
      if (length < 7) return null;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.length < 20 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    return null;
  }
  const format = bytes.subarray(12, 16).toString("ascii");
  if (format === "VP8X") {
    if (bytes.length < 30) return null;
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (format === "VP8 ") {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  return null;
}

function imageDimensions(
  mediaType: string,
  data: string,
): { width: number; height: number } | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  if (mediaType === "image/png") {
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      return null;
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mediaType === "image/jpeg") {
    return jpegDimensions(bytes);
  }
  if (mediaType === "image/webp") {
    return webpDimensions(bytes);
  }
  if (mediaType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) return null;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  return null;
}

function imageResult(value: unknown): PanelToolImageResult | typeof INVALID_PANEL_IMAGE | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "image") return null;
  const mediaType = candidate.mediaType;
  const data = candidate.data;
  if (
    typeof mediaType !== "string" ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType) ||
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > 350_000 ||
    data.length % 4 !== 0 ||
    !/^[a-z0-9+/]+={0,2}$/iu.test(data)
  ) {
    return INVALID_PANEL_IMAGE;
  }
  const dimensions = imageDimensions(mediaType, data);
  if (
    !dimensions ||
    !validImageDimensions(dimensions.width, dimensions.height) ||
    (candidate.width !== undefined && candidate.width !== dimensions.width) ||
    (candidate.height !== undefined && candidate.height !== dimensions.height)
  ) {
    return INVALID_PANEL_IMAGE;
  }
  const metadata: Record<string, unknown> = { mediaType, ...dimensions };
  for (const key of [
    "nodeId",
    "pageId",
    "pageName",
    "path",
    "revision",
    "stateRevision",
    "summary",
  ]) {
    const value = candidate[key];
    if (typeof value === "string" && value.length <= 2_000) metadata[key] = value;
  }
  return {
    contentBlocks: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType as "image/png" | "image/jpeg" | "image/webp" | "image/gif",
          data,
        },
      },
    ],
    result: JSON.stringify(metadata, null, 2),
  };
}

export async function panelTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string | PanelToolImageResult> {
  const bridge = ctx?.panels;
  if (!bridge) return NO_PANEL_HOST;

  const action = args.action;
  if (action === "list") {
    const panels = await bridge.list();
    if (panels.length === 0) return "(no panels available)";
    return panels.map((panel) => `${panel.id}\t${panel.title}\t${panel.source}`).join("\n");
  }
  if (action === "open") {
    const panelId = typeof args.panel_id === "string" ? args.panel_id.trim() : "";
    if (!panelId) return "Error: panel_id is required for action='open'";
    const result = await bridge.open(panelId);
    return result.ok
      ? `Opened panel ${result.panelId}`
      : `Error: ${result.detail ?? `could not open panel ${panelId}`}`;
  }
  if (action === "tools") {
    const panelId = typeof args.panel_id === "string" ? args.panel_id.trim() : "";
    if (!panelId) return "Error: panel_id is required for action='tools'";
    if (!bridge.tools) return "Error: this panel host does not expose Agent tools";
    const tools = safePanelToolDescriptors(await bridge.tools(panelId));
    if (!tools) return "Error: panel host returned malformed Agent tool descriptors";
    if (tools.length === 0) return `(panel ${panelId} has no Agent tools)`;
    return (
      boundedPanelJson({ panelId, tools }) ??
      "Error: panel host returned oversized Agent tool descriptors"
    );
  }
  if (action === "invoke") {
    const panelId = typeof args.panel_id === "string" ? args.panel_id.trim() : "";
    const toolName = typeof args.tool_name === "string" ? args.tool_name.trim() : "";
    if (!panelId) return "Error: panel_id is required for action='invoke'";
    if (!toolName) return "Error: tool_name is required for action='invoke'";
    if (!bridge.invoke) return "Error: this panel host cannot invoke Agent tools";
    if (
      args.arguments !== undefined &&
      (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments))
    ) {
      return "Error: arguments must be a JSON object for action='invoke'";
    }
    const toolArgs = (args.arguments as Record<string, unknown> | undefined) ?? {};
    const result = await bridge.invoke(panelId, toolName, toolArgs);
    if (!result.ok) {
      return `Error: ${result.detail ?? `could not invoke ${toolName} in ${panelId}`}`;
    }
    const image = imageResult(result.result);
    if (image) return image;
    return (
      boundedPanelJson({
        panelId: result.panelId,
        toolName: result.toolName,
        result: result.result ?? null,
      }) ?? "Error: Panel App returned an oversized or non-JSON result"
    );
  }
  return `Error: unknown panel action '${String(action)}'`;
}
