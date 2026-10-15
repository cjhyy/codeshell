import { asRecord, pick, LinkProviderResponseTooLargeError } from "./http.js";

export const FIGMA_RESPONSE_BYTES = 8 * 1024 * 1024;
export const FIGMA_RESPONSE_TOO_LARGE =
  "Figma response exceeded the 8 MiB limit. Retry get_file with a smaller depth or ids, " +
  "then use get_nodes for selected node IDs (at most 50 per request). No partial design data was returned.";

export const FIGMA_ACTIONS = [
  "get_file",
  "get_comments",
  "get_nodes",
  "get_images",
  "get_image_fills",
] as const;
export const FIGMA_NEW_ACTIONS = ["get_nodes", "get_images", "get_image_fills"] as const;

export class UnsupportedFigmaFileTypeError extends Error {
  readonly code = "unsupported_file_type";
  constructor() {
    super(
      "Figma Make (/make/) links are not supported by these Figma file REST actions. Use a Figma Design, FigJam, or file link.",
    );
    this.name = "UnsupportedFigmaFileTypeError";
  }
}

export class FigmaContentUnavailableError extends Error {
  readonly code = "content_unavailable";
  constructor() {
    super(
      "Figma get_file returned no document content. The Link service must implement Figma document reads; a pages-only summary cannot satisfy this request.",
    );
    this.name = "FigmaContentUnavailableError";
  }
}

/** URLs supply identifiers only. Provider requests always use fixed api.figma.com endpoints. */
export function parseFigmaFileInput(value: unknown): { fileKey: string; nodeId?: string } {
  if (typeof value !== "string" || !value || value.length > 1_000 || /[\x00-\x20\x7f]/.test(value))
    throw new Error("Invalid Figma file_url_or_key");
  let fileKey = value;
  let nodeId: string | undefined;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["figma.com", "www.figma.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Invalid Figma file_url_or_key URL");
    if (/^\/make(?:\/|$)/.test(url.pathname)) throw new UnsupportedFigmaFileTypeError();
    fileKey =
      /^\/(?:file|design|board)\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(url.pathname)?.[1] ?? "";
    if (url.searchParams.getAll("node-id").length > 1)
      throw new Error("Figma URL must contain only one node-id");
    const rawNodeId = url.searchParams.get("node-id");
    if (rawNodeId !== null) nodeId = normalizeNodeId(rawNodeId);
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileKey)) throw new Error("Invalid Figma file_url_or_key");
  return { fileKey, ...(nodeId ? { nodeId } : {}) };
}

function normalizeNodeId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Figma ids must contain node ID strings");
  const id = value.trim().replace(/(\d)-(\d)/g, "$1:$2");
  if (!id || id.length > 200 || !/^(?:I)?[0-9]+:[0-9]+(?:;[0-9]+:[0-9]+)*$/.test(id))
    throw new Error("Invalid Figma node ID");
  return id;
}

function list(value: unknown, key: string, normalize: (value: unknown) => string): string {
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values) || !values.length || values.length > 50)
    throw new Error(`Figma ${key} must contain 1 to 50 values`);
  return [...new Set(values.map(normalize))].join(",");
}

function number(value: unknown, key: string, min: number, max: number, integer = false): number {
  const parsed =
    typeof value === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  )
    throw new Error(
      `Figma ${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`,
    );
  return parsed;
}

const IMAGE_FLAGS = [
  "svg_outline_text",
  "svg_include_id",
  "svg_include_node_id",
  "svg_simplify_stroke",
  "contents_only",
  "use_absolute_bounds",
] as const;

/** One canonical contract is used by local execution and the remote exact-file grant gate. */
export function figmaActionParameters(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!(FIGMA_ACTIONS as readonly string[]).includes(action))
    throw new Error("Unknown Figma action");
  const content = action === "get_file" || action === "get_nodes";
  const images = action === "get_images";
  const allowed = [
    "file_url_or_key",
    "file_key",
    ...(content || images ? ["ids", "node_ids", "version"] : []),
    ...(content ? ["depth", "geometry", "plugin_data"] : []),
    ...(action === "get_file" ? ["branch_data", "full"] : []),
    ...(images ? ["scale", "format", ...IMAGE_FLAGS] : []),
  ];
  if (Object.keys(params).some((key) => !allowed.includes(key)))
    throw new Error("Unknown Figma Link Action parameter");
  const has = (key: string) => Object.prototype.hasOwnProperty.call(params, key);
  if (has("file_url_or_key") && has("file_key"))
    throw new Error("Supply only one Figma file_url_or_key or file_key");
  const file = parseFigmaFileInput(
    has("file_url_or_key") ? params.file_url_or_key : params.file_key,
  );
  const result: Record<string, unknown> = { file_url_or_key: file.fileKey };
  if (action === "get_file" && has("full")) {
    if (typeof params.full !== "boolean") throw new Error("Figma full must be a boolean");
    if (has("depth")) throw new Error("Supply only one Figma full or depth");
    if (params.full) result.full = true;
  }
  if (content || images) {
    if (has("ids") && has("node_ids")) throw new Error("Supply only one Figma ids or node_ids");
    const ids = has("ids") ? params.ids : has("node_ids") ? params.node_ids : file.nodeId;
    if (has("ids") || has("node_ids") || ids !== undefined)
      result.ids = list(ids, "ids", normalizeNodeId);
    else if (action === "get_nodes" || images)
      throw new Error(`Figma ${action} requires ids or a URL with node-id`);
    if (params.version !== undefined) {
      if (typeof params.version !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(params.version))
        throw new Error("Invalid Figma version");
      result.version = params.version;
    }
  }
  if (content) {
    if (params.depth !== undefined) result.depth = number(params.depth, "depth", 1, 100, true);
    else if (action === "get_file" && result.full !== true) result.depth = 2;
    if (params.geometry !== undefined) {
      if (params.geometry !== "paths") throw new Error("Figma geometry must be paths");
      result.geometry = "paths";
    }
    if (params.plugin_data !== undefined)
      result.plugin_data = list(params.plugin_data, "plugin_data", (value) => {
        if (typeof value !== "string" || !/^(?:shared|\d{1,200})$/.test(value.trim()))
          throw new Error("Figma plugin_data must contain plugin IDs or shared");
        return value.trim();
      });
  }
  if (images) {
    if (params.scale !== undefined) result.scale = number(params.scale, "scale", 0.01, 4);
    if (params.format !== undefined) {
      if (!["png", "jpg", "svg", "pdf"].includes(params.format as string))
        throw new Error("Figma format must be png, jpg, svg, or pdf");
      result.format = params.format;
    }
  }
  for (const key of [
    ...(images ? IMAGE_FLAGS : []),
    ...(action === "get_file" ? ["branch_data"] : []),
  ]) {
    if (params[key] !== undefined) {
      if (typeof params[key] !== "boolean") throw new Error(`Figma ${key} must be a boolean`);
      result[key] = params[key];
    }
  }
  return result;
}

export function figmaActionEndpoint(action: string, params: Record<string, unknown>): URL {
  const key = encodeURIComponent(params.file_url_or_key as string);
  const path =
    action === "get_images"
      ? `/v1/images/${key}`
      : `/v1/files/${key}${action === "get_nodes" ? "/nodes" : action === "get_image_fills" ? "/images" : action === "get_comments" ? "/comments" : ""}`;
  const url = new URL(path, "https://api.figma.com");
  for (const [key, value] of Object.entries(params))
    if (key !== "file_url_or_key" && key !== "full") url.searchParams.set(key, String(value));
  return url;
}

const FILE_FIELDS = [
  "name",
  "lastModified",
  "version",
  "role",
  "editorType",
  "linkAccess",
  "thumbnailUrl",
  "document",
  "components",
  "componentSets",
  "styles",
  "schemaVersion",
  "mainFileKey",
  "branches",
  "pages",
  "truncated",
  "err",
  "status",
] as const;

function boundedResult(result: Record<string, unknown>): Record<string, unknown> {
  if (typeof result.truncated !== "boolean") delete result.truncated;
  if (Buffer.byteLength(JSON.stringify({ result }), "utf8") > FIGMA_RESPONSE_BYTES)
    throw new LinkProviderResponseTooLargeError(FIGMA_RESPONSE_TOO_LARGE);
  return result;
}

/** Preserve every design field inside documents/nodes, but never relay arbitrary top-level secrets. */
export function normalizeFigmaActionResult(
  action: string,
  raw: unknown,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record) throw new Error("Invalid Figma result");
  if (action === "get_file" || action === "get_nodes") {
    const result = pick(record, [...FILE_FIELDS, ...(action === "get_nodes" ? ["nodes"] : [])]);
    if (action === "get_file") {
      const document = asRecord(record.document);
      if (document) {
        result.pages = Array.isArray(document.children)
          ? document.children.map((page) => pick(page, ["id", "name", "type"]))
          : [];
      } else throw new FigmaContentUnavailableError();
    } else if (!asRecord(record.nodes) && !record.err)
      throw new Error("Figma nodes result is missing nodes");
    if (params.depth !== undefined) result.requestedDepth = params.depth;
    if (params.full === true) result.requestedFull = true;
    if (typeof params.ids === "string") result.requestedNodeIds = params.ids.split(",");
    return boundedResult(result);
  }
  if (action === "get_images") {
    if (!asRecord(record.images) && !record.err)
      throw new Error("Figma image result is missing images");
    return boundedResult({
      ...pick(record, ["images", "err", "status", "truncated"]),
      ...(typeof params.ids === "string" ? { requestedNodeIds: params.ids.split(",") } : {}),
    });
  }
  if (action === "get_image_fills") {
    const meta = asRecord(record.meta);
    if (!asRecord(meta?.images) && !asRecord(record.images) && !record.err)
      throw new Error("Figma image fills result is missing images");
    return boundedResult({
      ...pick(record, ["err", "status", "truncated"]),
      ...(meta?.images || record.images ? { meta: { images: meta?.images ?? record.images } } : {}),
    });
  }
  if (!Array.isArray(record.comments)) throw new Error("Invalid Figma comments result");
  return boundedResult({
    ...pick(record, ["truncated"]),
    comments: record.comments.map((comment) =>
      pick(comment, [
        "id",
        "message",
        "parent_id",
        "order_id",
        "file_key",
        "created_at",
        "resolved_at",
        "user",
        "client_meta",
      ]),
    ),
  });
}
