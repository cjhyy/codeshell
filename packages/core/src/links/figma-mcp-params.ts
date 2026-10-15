import { isFigmaMcpAction } from "@cjhyy/code-shell-link";
import { normalizeNodeId } from "./figma.js";

export interface FigmaMcpTarget {
  fileKey: string;
  fileType: "design" | "figjam" | "make" | "slides";
  nodeId?: string;
  resourceUrl?: string;
}

/** A Figma URL supplies identifiers, never a network destination. */
export function figmaMcpTarget(params: Record<string, unknown>): FigmaMcpTarget {
  if (params.file_url_or_key !== undefined && params.file_key !== undefined)
    throw new Error("Use either file_url_or_key or file_key, not both.");
  const input = params.file_url_or_key ?? params.file_key;
  if (typeof input !== "string" || !input || input.length > 4096 || /[\x00-\x20\x7f]/.test(input))
    throw new Error("A Figma file_url_or_key is required.");
  let fileKey = input;
  let fileType: FigmaMcpTarget["fileType"] = "design";
  let nodeId: string | undefined;
  let resourceUrl: string | undefined;
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !["figma.com", "www.figma.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("Use an official HTTPS Figma file URL.");
    const match = /^\/(design|file|board|make|slides)\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(
      url.pathname,
    );
    if (!match) throw new Error("Unsupported Figma file URL.");
    fileKey = match[2]!;
    fileType =
      match[1] === "board"
        ? "figjam"
        : match[1] === "file"
          ? "design"
          : (match[1] as FigmaMcpTarget["fileType"]);
    if (url.searchParams.getAll("node-id").length > 1) throw new Error("Use only one node-id.");
    if (url.searchParams.has("node-id")) nodeId = normalizeNodeId(url.searchParams.get("node-id"));
    resourceUrl = url.href;
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileKey)) throw new Error("Invalid Figma file key.");
  if (params.file_type !== undefined) {
    if (!["design", "figjam", "make", "slides"].includes(String(params.file_type)))
      throw new Error("Invalid Figma file_type.");
    if (resourceUrl && params.file_type !== fileType)
      throw new Error("file_type conflicts with the Figma URL.");
    fileType = params.file_type as FigmaMcpTarget["fileType"];
  }
  if (params.node_id !== undefined) {
    const explicit = normalizeNodeId(params.node_id);
    if (nodeId && nodeId !== explicit) throw new Error("node_id conflicts with the Figma URL.");
    nodeId = explicit;
  }
  return {
    fileKey,
    fileType,
    ...(nodeId ? { nodeId } : {}),
    ...(resourceUrl ? { resourceUrl } : {}),
  };
}

const toolOptions: Record<string, string> = {
  client_languages: "clientLanguages",
  client_frameworks: "clientFrameworks",
  force_code: "forceCode",
  disable_code_connect: "disableCodeConnect",
  recursive: "recursive",
  queries: "queries",
};

export function figmaMcpParameters(action: string, params: Record<string, unknown>) {
  if (!isFigmaMcpAction(action)) throw new Error("Unsupported Figma MCP action.");
  const allowed = new Set([
    "file_url_or_key",
    "file_key",
    "file_type",
    "node_id",
    ...Object.keys(toolOptions),
  ]);
  if (action === "read_resource") allowed.add("uri");
  if (action === "list_resources") allowed.add("cursor");
  for (const key of Object.keys(params))
    if (!allowed.has(key)) throw new Error(`Unsupported Figma MCP parameter: ${key}`);
  const target = figmaMcpTarget(params);
  if (
    target.fileType === "make" &&
    !["get_design_context", "list_resources", "read_resource"].includes(action)
  )
    throw new Error(
      "For Figma Make, use get_design_context to discover files, then read_resource for selected source files.",
    );
  if (["list_resources", "read_resource"].includes(action) && target.fileType !== "make")
    throw new Error("Figma source resources require a Make link or file_type:make.");
  if (action === "get_figjam" && target.fileType !== "figjam")
    throw new Error("get_figjam requires a FigJam link.");
  if (
    !["get_screenshot", "get_figjam", "list_resources", "read_resource"].includes(action) &&
    target.fileType !== "design" &&
    !(target.fileType === "make" && action === "get_design_context")
  )
    throw new Error("This MCP action requires a Figma Design file.");
  const needsNode =
    ![
      "get_metadata",
      "get_libraries",
      "search_design_system",
      "list_resources",
      "read_resource",
    ].includes(action) && target.fileType !== "make";
  if (needsNode && !target.nodeId)
    throw new Error(
      "Select a node_id or use a node URL before reading detailed Figma content. Use the API get_file shallow structure first.",
    );
  const args: Record<string, unknown> = { fileKey: target.fileKey };
  if (target.nodeId || target.fileType === "make") args.nodeId = target.nodeId ?? "0:1";
  for (const [key, name] of Object.entries(toolOptions)) {
    const value = params[key];
    if (value === undefined) continue;
    if (["force_code", "disable_code_connect", "recursive"].includes(key)) {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean.`);
    } else if (key === "queries") {
      if (
        action !== "search_design_system" ||
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > 20 ||
        value.some((item) => typeof item !== "string" || !item || item.length > 1000)
      )
        throw new Error("queries must contain 1 to 20 search strings.");
    } else if (typeof value !== "string" || value.length > 200)
      throw new Error(`${key} must be a short string.`);
    args[name] = value;
  }
  if (action === "read_resource") assertFigmaMakeResourceUri(params.uri, target.fileKey);
  if (
    params.cursor !== undefined &&
    (typeof params.cursor !== "string" || params.cursor.length > 4096)
  )
    throw new Error("Invalid resource cursor.");
  return {
    target,
    args,
    ...(typeof params.uri === "string" ? { uri: params.uri } : {}),
    ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
  };
}

/** Only source/image resources owned by this Make file may be admitted from an upstream manifest. */
export function assertFigmaMakeResourceUri(value: unknown, fileKey: string): string {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value))
    throw new Error("Invalid Figma Make resource URI.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Figma Make resource URI.");
  }
  if (
    url.protocol !== "file:" ||
    url.hostname !== "figma" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw new Error("The resource must belong to the selected Figma Make file.");
  const segments = url.pathname
    .split("/")
    .slice(1)
    .map((part) => decodeURIComponent(part));
  if (
    segments[0] !== "make" ||
    !["source", "image"].includes(segments[1] ?? "") ||
    segments[2] !== fileKey ||
    segments.length < 4 ||
    segments.some(
      (part) => !part || part === "." || part === ".." || /[/\\\x00-\x1f\x7f]/.test(part),
    )
  )
    throw new Error("The resource must belong to the selected Figma Make file.");
  return value;
}
