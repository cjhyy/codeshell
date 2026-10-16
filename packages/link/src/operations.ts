import { FIGMA_MCP_ACTION_IDS } from "./figma.js";
import type {
  LinkOperationContract,
  LinkResourcePolicy,
  LinkValueSchema,
} from "./operation-types.js";

const text = (maxLength = 300, minLength = 1): LinkValueSchema => ({
  type: "string",
  minLength,
  maxLength,
});
const flag: LinkValueSchema = { type: "boolean" };
// Existing v1 adapters accept numeric strings and clamp pagination. Keep that behavior.
const integer: LinkValueSchema = { anyOf: [{ type: "integer", minimum: 1 }, text(100)] };
const number: LinkValueSchema = { anyOf: [{ type: "number" }, text(100)] };
const list = (items: LinkValueSchema = { type: "object" }, maxItems = 100): LinkValueSchema => ({
  type: "array",
  items,
  maxItems,
});
const object = (
  properties: Record<string, LinkValueSchema>,
  required: string[] = [],
): LinkValueSchema => ({ type: "object", properties, required, additionalProperties: false });
const output = (
  properties: Record<string, LinkValueSchema>,
  required: string[] = [],
): LinkValueSchema => ({ type: "object", properties, required, additionalProperties: true });
const listOutput = (key: string, max = 100) =>
  output({ [key]: list({ type: "object" }, max) }, [key]);
const groups: Record<string, string> = {
  github: "repositories",
  gitlab: "projects",
  figma: "files",
  notion: "pages",
  linear: "teams",
  slack: "channels",
  sentry: "organizations",
  airtable: "bases",
  todoist: "projects",
  vercel: "projects",
};
const inputResource = (
  group: string,
  fields: string[],
  options: Partial<NonNullable<LinkResourcePolicy["selector"]>> = {},
): LinkResourcePolicy => ({
  source: "input",
  group,
  selector: { kind: "joined", fields, ...options },
});
const filtered = (provider: string): LinkResourcePolicy => ({
  source: "grant-filtered",
  group: groups[provider]!,
});
const repo = { owner: text(100), repo: text(100) };
const file = { file_url_or_key: text(4096), file_key: text(200) };
const fileInput = (
  properties: Record<string, LinkValueSchema> = {},
  required: string[] = [],
): LinkValueSchema => ({
  ...object({ ...file, ...properties }, required),
  oneOf: [{ required: ["file_url_or_key"] }, { required: ["file_key"] }],
});
const fileResource = inputResource("files", ["file_url_or_key", "file_key"], {
  kind: "identifier-or-url",
  urlHosts: ["figma.com", "www.figma.com"],
  urlPathIndex: 1,
});
const nodeList: LinkValueSchema = { anyOf: [text(20_000), list(text(200), 50)] };

type Options = Partial<
  Pick<LinkOperationContract, "effect" | "executors" | "defaults" | "content" | "normalization">
>;
function operation(
  provider: string,
  action: string,
  inputSchema: LinkValueSchema,
  outputSchema: LinkValueSchema,
  resourcePolicy = filtered(provider),
  options: Options = {},
): LinkOperationContract {
  const effect = options.effect ?? "read";
  return {
    operationId: `${provider}.${action}`,
    providerId: provider,
    action,
    effect,
    executors:
      options.executors ??
      (["github", "gitlab", "notion", "todoist", "vercel"].includes(provider)
        ? ["api", "cli"]
        : ["api"]),
    inputSchema,
    outputSchema,
    resourcePolicy,
    defaults: options.defaults ?? {},
    limits: {
      inputBytes: action === "create_issue" ? 256 * 1024 : 65_536,
      responseBytes: provider === "figma" ? 8 * 1024 * 1024 : 1024 * 1024,
    },
    repeatability: effect === "write" ? "verified-write-once" : "read-only",
    normalization: options.normalization ?? [],
    ...(options.content ? { content: options.content } : {}),
  };
}
const gh = (
  action: string,
  properties: Record<string, LinkValueSchema> = {},
  required: string[] = [],
  result: LinkValueSchema = output({}),
  options: Options = {},
) =>
  operation(
    "github",
    action,
    object({ ...repo, ...properties }, ["owner", "repo", ...required]),
    result,
    inputResource("repositories", ["owner", "repo"], { lowercase: true }),
    options,
  );
const pagination = {
  defaults: { limit: 30 },
  normalization: ["limit: positive number or numeric string; clamp to 100"],
};
const sourcePagination = {
  defaults: { page: 1, limit: 30 },
  normalization: [
    "page: positive number or numeric string; clamp to 100",
    "limit: positive integer <= 100",
    "sha: full hexadecimal commit id",
  ],
};
const content = { kind: "application/json", coverage: "selected-resource" as const };

/** Reviewed v1 contracts. Discovery can select these operations, never add executable code. */
export const LINK_OPERATION_CONTRACTS: readonly LinkOperationContract[] = [
  operation(
    "github",
    "list_repositories",
    object({ limit: integer }),
    listOutput("repositories"),
    undefined,
    pagination,
  ),
  gh(
    "get_repository",
    {},
    [],
    output({ id: {}, full_name: text(), private: flag, archived: flag, html_url: text(4096) }),
  ),
  gh("get_starred", {}, [], output({ starred: flag }, ["starred"])),
  gh(
    "set_starred",
    { starred: flag },
    ["starred"],
    output({ acknowledged: flag }, ["acknowledged"]),
    { effect: "write", executors: ["api"] },
  ),
  gh(
    "get_readme",
    {},
    [],
    output({ content: text(262_144, 0), truncated: flag }, ["content", "truncated"]),
    { content: { kind: "text/markdown", coverage: "selected-resource" } },
  ),
  gh(
    "get_file",
    { path: text(2000), ref: text(300) },
    ["path"],
    output({ content: text(262_144, 0), truncated: flag }, ["content", "truncated"]),
    { content: { kind: "text/plain", coverage: "selected-resource" } },
  ),
  gh(
    "list_issues",
    { limit: integer, page: integer, state: { enum: ["open", "closed", "all"] } },
    [],
    listOutput("issues"),
    pagination,
  ),
  gh(
    "list_pull_requests",
    { limit: integer, page: integer },
    [],
    listOutput("pull_requests"),
    pagination,
  ),
  gh("get_issue", { issue_number: integer }, ["issue_number"]),
  gh("get_pull_request", { pull_number: integer }, ["pull_number"]),
  gh(
    "list_pull_request_files",
    { pull_number: integer, page: integer, limit: integer },
    ["pull_number"],
    output({ files: list() }),
    sourcePagination,
  ),
  gh(
    "list_pull_request_commits",
    { pull_number: integer, page: integer, limit: integer },
    ["pull_number"],
    output({ commits: list() }),
    sourcePagination,
  ),
  gh(
    "get_commit",
    { sha: text(40), page: integer, limit: integer },
    ["sha"],
    output({}),
    sourcePagination,
  ),
  gh(
    "create_issue",
    { title: text(256), body: text(20_000, 0) },
    ["title"],
    output({
      number: { type: "integer" },
      title: text(256),
      state: text(100),
      html_url: text(4096),
      created_at: text(100),
    }),
    {
      effect: "write",
      executors: ["api"],
      normalization: [
        "trim title and body; owner/repo identify the authorized parent repository",
        "requires independent list_issues/get_issue verification",
      ],
    },
  ),
  gh(
    "update_issue",
    { issue_number: { type: "integer", minimum: 1 }, state: { enum: ["open", "closed"] } },
    ["issue_number", "state"],
    output({ acknowledged: flag }, ["acknowledged"]),
    {
      effect: "write",
      executors: ["api"],
      normalization: ["non-PR issue only; verify immutable repository and issue IDs independently"],
    },
  ),
  operation(
    "gitlab",
    "list_projects",
    object({ limit: integer }),
    listOutput("projects"),
    undefined,
    pagination,
  ),
  operation(
    "gitlab",
    "list_issues",
    object({ limit: integer }),
    listOutput("issues"),
    undefined,
    pagination,
  ),
  operation(
    "figma",
    "get_file",
    fileInput(),
    output({ pages: list({}, 100), truncated: flag }),
    fileResource,
    {
      defaults: { depth: 1 },
      content: { kind: "application/vnd.figma.summary+json", coverage: "summary" },
      normalization: [
        "summary only; no document; at most 100 pages; reject all depth/full/ids parameters",
      ],
    },
  ),
  operation(
    "figma",
    "read_design_content",
    fileInput({
      ids: nodeList,
      node_ids: nodeList,
      version: text(200),
      depth: integer,
      geometry: { enum: ["paths"] },
      plugin_data: nodeList,
      branch_data: flag,
      full: flag,
    }),
    output({ document: { type: "object" }, pages: list({}, 100), truncated: flag }),
    fileResource,
    {
      defaults: { depth: 2, full: false },
      content: { kind: "application/vnd.figma.document+json", coverage: "requested-subtree" },
      normalization: [
        "reject conflicting file aliases, ids aliases and full/depth",
        "node-id in URL is an input selector; depth 1..100; full:true must be explicit",
        "preserve nested node properties; no implicit complete-file read",
      ],
    },
  ),
  operation(
    "figma",
    "get_nodes",
    fileInput({
      ids: nodeList,
      node_ids: nodeList,
      version: text(200),
      depth: integer,
      geometry: { enum: ["paths"] },
      plugin_data: nodeList,
    }),
    output({ nodes: { type: "object" }, truncated: flag }),
    fileResource,
    {
      content,
      normalization: [
        "require explicit ids or URL node-id; 1..50 node IDs; reject conflicting aliases; depth 1..100",
      ],
    },
  ),
  operation(
    "figma",
    "get_images",
    fileInput({
      ids: nodeList,
      node_ids: nodeList,
      version: text(200),
      scale: number,
      format: { enum: ["png", "jpg", "svg", "pdf"] },
      svg_outline_text: flag,
      svg_include_id: flag,
      svg_include_node_id: flag,
      svg_simplify_stroke: flag,
      contents_only: flag,
      use_absolute_bounds: flag,
    }),
    output({ images: { type: "object" } }),
    fileResource,
    {
      normalization: [
        "require explicit ids or URL node-id; scale 0.01..4; reject conflicting aliases",
      ],
    },
  ),
  operation(
    "figma",
    "get_image_fills",
    fileInput(),
    output({ images: { type: "object" }, meta: { type: "object" } }),
    fileResource,
  ),
  operation(
    "figma",
    "get_comments",
    fileInput(),
    output({ comments: list({}, 100) }),
    fileResource,
  ),
  ...FIGMA_MCP_ACTION_IDS.map((action) =>
    operation(
      "figma",
      action,
      fileInput(
        {
          file_type: { enum: ["design", "figjam", "make", "slides"] },
          node_id: text(200),
          client_languages: text(200, 0),
          client_frameworks: text(200, 0),
          force_code: flag,
          disable_code_connect: flag,
          recursive: flag,
          queries: list(text(1000), 20),
          ...(action === "read_resource" ? { uri: text(4096) } : {}),
          ...(action === "list_resources" ? { cursor: text(4096, 0) } : {}),
        },
        action === "read_resource" ? ["uri"] : [],
      ),
      output({}),
      fileResource,
      {
        executors: ["mcp"],
        content: {
          kind: "application/vnd.figma.mcp+json",
          coverage: action === "list_resources" ? "page" : "requested-subtree",
        },
        normalization: [
          "official MCP origin and issuer/resource binding; exact reviewed tool allowlist",
          "detailed reads require node_id; Make uses discovery then selected file URI",
          "resource URI must belong to selected file and be admitted on this connection",
        ],
      },
    ),
  ),
  operation(
    "notion",
    "search",
    object({ query: text(200, 0), limit: integer }),
    listOutput("results"),
    undefined,
    pagination,
  ),
  operation(
    "notion",
    "get_page",
    object({ page_id: text(100) }, ["page_id"]),
    output({}),
    inputResource("pages", ["page_id"], { lowercase: true, stripHyphens: true }),
  ),
  operation(
    "linear",
    "list_issues",
    object({ limit: integer }),
    listOutput("issues", 50),
    undefined,
    {
      defaults: { limit: 30 },
      normalization: ["limit: positive number or numeric string; clamp to 50"],
    },
  ),
  operation("linear", "list_teams", object({ limit: integer }), listOutput("teams", 50)),
  operation(
    "slack",
    "list_channels",
    object({ limit: integer }),
    listOutput("channels", 200),
    undefined,
    {
      defaults: { limit: 50 },
      normalization: ["limit: positive number or numeric string; clamp to 200"],
    },
  ),
  operation(
    "slack",
    "get_channel_history",
    object({ channel: text(100), limit: integer }, ["channel"]),
    listOutput("messages"),
    inputResource("channels", ["channel"]),
    {
      defaults: { limit: 15 },
      normalization: ["limit: positive number or numeric string; clamp to 15"],
    },
  ),
  operation(
    "slack",
    "get_message",
    object({ permalink: text(4096) }, ["permalink"]),
    output({}),
    inputResource("channels", ["permalink"], { kind: "slack-permalink", urlPathIndex: 1 }),
    {
      normalization: [
        "parse channel and timestamp from HTTPS Slack permalink; reply URL requires thread_ts",
        "URL supplies identifiers only; never controls API origin",
      ],
    },
  ),
  operation(
    "slack",
    "get_thread",
    object(
      {
        channel: text(100),
        ts: text(100),
        permalink: text(4096),
        cursor: text(4096, 0),
        limit: integer,
      },
      ["channel", "ts"],
    ),
    output({}),
    inputResource("channels", ["channel"]),
    {
      defaults: { limit: 15 },
      normalization: ["one thread page; maximum limit 15; reject permalink conflicts"],
    },
  ),
  operation("sentry", "list_organizations", object({}), listOutput("organizations")),
  operation(
    "sentry",
    "list_projects",
    object({ organization: text(100) }, ["organization"]),
    listOutput("projects"),
    inputResource("organizations", ["organization"]),
  ),
  operation("airtable", "list_bases", object({}), listOutput("bases")),
  operation(
    "airtable",
    "list_tables",
    object({ base_id: text(100) }, ["base_id"]),
    listOutput("tables"),
    inputResource("bases", ["base_id"]),
  ),
  operation("todoist", "list_projects", object({ limit: integer }), listOutput("projects")),
  operation("todoist", "list_tasks", object({ limit: integer }), listOutput("tasks"), undefined, {
    defaults: { limit: 50 },
    normalization: ["limit: positive number or numeric string; clamp to 100"],
  }),
  operation(
    "vercel",
    "list_projects",
    object({ team_id: text(100), limit: integer }),
    listOutput("projects"),
    undefined,
    {
      defaults: { limit: 50 },
      normalization: [
        "limit: positive number or numeric string; clamp to 100",
        "broker checks team_id against installation",
      ],
    },
  ),
  operation(
    "vercel",
    "list_deployments",
    object({ team_id: text(100), limit: integer }),
    listOutput("deployments"),
    undefined,
    {
      defaults: { limit: 50 },
      normalization: [
        "limit: positive number or numeric string; clamp to 100",
        "broker checks team_id against installation; filter deployments by granted project",
      ],
    },
  ),
];

function freezeContract(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freezeContract);
  Object.freeze(value);
}
freezeContract(LINK_OPERATION_CONTRACTS);

const contracts = new Map(
  LINK_OPERATION_CONTRACTS.map((contract) => [contract.operationId, contract]),
);
export function getLinkOperationContract(
  provider: string,
  action: string,
): LinkOperationContract | undefined {
  return contracts.get(`${provider}.${action}`);
}
