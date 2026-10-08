import { asRecord, intParam, pathParam, pathSegmentParam, pick, stringParam } from "./http.js";

/** Executable authority is reviewed Host code; a discovery document cannot extend this list. */
export const REMOTE_LINK_PROVIDER_ADAPTERS = [
  {
    id: "github",
    name: "GitHub",
    group: "repositories",
    actions: [
      "list_repositories",
      "get_readme",
      "get_file",
      "list_issues",
      "get_issue",
      "list_pull_requests",
      "get_pull_request",
      "create_issue",
      "get_repository",
      "get_starred",
      "set_starred",
    ],
  },
  { id: "gitlab", name: "GitLab", group: "projects", actions: ["list_projects", "list_issues"] },
  {
    id: "sentry",
    name: "Sentry",
    group: "organizations",
    actions: ["list_organizations", "list_projects"],
  },
  {
    id: "vercel",
    name: "Vercel",
    group: "projects",
    actions: ["list_projects", "list_deployments"],
  },
  {
    id: "slack",
    name: "Slack",
    group: "channels",
    actions: ["list_channels", "get_channel_history"],
  },
  { id: "notion", name: "Notion", group: "pages", actions: ["search", "get_page"] },
  { id: "linear", name: "Linear", group: "teams", actions: ["list_issues", "list_teams"] },
  { id: "todoist", name: "Todoist", group: "projects", actions: ["list_projects", "list_tasks"] },
  { id: "airtable", name: "Airtable", group: "bases", actions: ["list_bases", "list_tables"] },
  { id: "figma", name: "Figma", group: "files", actions: ["get_file", "get_comments"] },
] as const;

export type RemoteLinkProviderId = (typeof REMOTE_LINK_PROVIDER_ADAPTERS)[number]["id"];
export type RemoteLinkProviderAdapter = (typeof REMOTE_LINK_PROVIDER_ADAPTERS)[number];
export interface RemoteLinkResourceGroup {
  id: string;
  items: Array<{ id: string; label: string }>;
}

export const LEGACY_GITHUB_ACTIONS = ["list_repositories", "list_issues", "get_issue"] as const;
export function getRemoteLinkProviderAdapter(id: string): RemoteLinkProviderAdapter | undefined {
  return REMOTE_LINK_PROVIDER_ADAPTERS.find((adapter) => adapter.id === id);
}
export function reviewedRemoteLinkActions(
  providerId: string,
  actions: readonly string[],
): string[] {
  const adapter = getRemoteLinkProviderAdapter(providerId);
  if (
    !adapter ||
    !actions.length ||
    new Set(actions).size !== actions.length ||
    actions.some((action) => !(adapter.actions as readonly string[]).includes(action))
  ) {
    throw new Error("Unreviewed remote Link capabilities");
  }
  return [...actions];
}

export function normalizeRemoteLinkResourceId(providerId: string, value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 300 || /[\x00-\x20\x7f]/.test(value))
    throw new Error("Invalid remote Link resource");
  let normalized = value;
  let valid = false;
  switch (providerId) {
    case "github":
      normalized = value.toLowerCase();
      valid =
        /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(normalized) &&
        ![".", ".."].includes(normalized.split("/")[1]!);
      break;
    case "gitlab":
      valid = /^[1-9]\d{0,19}$/.test(value);
      break;
    case "notion":
      normalized = value.replaceAll("-", "").toLowerCase();
      valid = /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(
        value,
      );
      break;
    case "linear":
      normalized = value.toLowerCase();
      valid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
      break;
    case "sentry":
      valid = /^[a-z0-9][a-z0-9_-]{0,99}$/.test(value);
      break;
    case "slack":
      valid = /^[CGD][A-Z0-9]{1,99}$/.test(value);
      break;
    case "airtable":
      valid = /^app[A-Za-z0-9]{10,30}$/.test(value);
      break;
    case "vercel":
      valid = /^[A-Za-z0-9_-]{1,100}$/.test(value);
      break;
    case "todoist":
      valid = /^[A-Za-z0-9_-]{1,100}$/.test(value);
      break;
    case "figma":
      valid = /^[A-Za-z0-9_-]{1,200}$/.test(value);
      break;
  }
  if (!valid) throw new Error("Invalid remote Link resource");
  return normalized;
}

/** The sole resource group is provider-owned. Never reinterpret another provider's resource ids. */
export function parseRemoteLinkResourceGroups(
  providerId: string,
  authorization: Record<string, unknown>,
): RemoteLinkResourceGroup[] {
  const adapter = getRemoteLinkProviderAdapter(providerId);
  if (!adapter) throw new Error("Unsupported remote Link provider");
  const raw =
    authorization.resourceGroups ??
    authorization.resources ??
    (providerId === "github" && Array.isArray(authorization.repositories)
      ? [{ id: "repositories", items: authorization.repositories.map((id) => ({ id, label: id })) }]
      : undefined);
  if (!Array.isArray(raw) || raw.length !== 1) throw new Error("Invalid remote Link resources");
  const group = asRecord(raw[0]);
  if (
    group?.id !== adapter.group ||
    !Array.isArray(group.items) ||
    !group.items.length ||
    group.items.length > 100
  )
    throw new Error("Invalid remote Link resources");
  const items = group.items.map((rawItem) => {
    const item = asRecord(rawItem);
    const id = normalizeRemoteLinkResourceId(providerId, item?.id);
    if (
      typeof item?.label !== "string" ||
      !item.label ||
      item.label.length > 300 ||
      /[\x00-\x1f\x7f]/.test(item.label)
    )
      throw new Error("Invalid remote Link resource label");
    return { id, label: item.label };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("Ambiguous remote Link resources");
  if (providerId === "github" && authorization.repositories !== undefined) {
    if (
      !Array.isArray(authorization.repositories) ||
      authorization.repositories.length !== items.length ||
      authorization.repositories.some(
        (id) => !items.some((item) => item.id === normalizeRemoteLinkResourceId(providerId, id)),
      )
    )
      throw new Error("Inconsistent remote Link resources");
  }
  for (const field of ["resources", "resourceGroups"] as const) {
    if (authorization[field] !== undefined && authorization[field] !== raw) {
      const other = parseRemoteLinkResourceGroups(providerId, {
        resourceGroups: authorization[field],
      });
      if (JSON.stringify(other) !== JSON.stringify([{ id: adapter.group, items }]))
        throw new Error("Inconsistent remote Link resources");
    }
  }
  return [{ id: adapter.group, items }];
}

function selected(providerId: string, groups: readonly RemoteLinkResourceGroup[]): Set<string> {
  return new Set(
    parseRemoteLinkResourceGroups(providerId, { resourceGroups: groups })[0]!.items.map(
      (item) => item.id,
    ),
  );
}
function assertKeys(params: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(params).some((key) => !allowed.includes(key)))
    throw new Error("Unknown remote Link Action parameter");
}

export function prepareRemoteLinkAction(
  providerId: string,
  action: string,
  params: Record<string, unknown>,
  groups: readonly RemoteLinkResourceGroup[],
): Record<string, unknown> {
  reviewedRemoteLinkActions(providerId, [action]);
  const allowed = selected(providerId, groups);
  const requireResource = (value: unknown) => {
    const id = normalizeRemoteLinkResourceId(providerId, value);
    if (!allowed.has(id)) throw new Error("Remote Link resource is outside this grant");
    return id;
  };
  if (providerId === "github") {
    if (action === "list_repositories") {
      assertKeys(params, ["limit"]);
      return {};
    }
    const owner = pathSegmentParam(params, "owner", { required: true, maxLength: 100 })!;
    const repo = pathSegmentParam(params, "repo", { required: true, maxLength: 100 })!;
    const repository = requireResource(`${owner}/${repo}`);
    if (action === "get_issue") {
      assertKeys(params, ["owner", "repo", "issue_number"]);
      return { repository, number: intParam(params, "issue_number", 0, Number.MAX_SAFE_INTEGER) };
    }
    if (action === "list_issues") {
      assertKeys(params, ["owner", "repo", "limit", "page", "state"]);
      const state = stringParam(params, "state") ?? "open";
      if (!["open", "closed", "all"].includes(state)) throw new Error("Invalid issue state");
      return {
        repository,
        state,
        page: intParam(params, "page", 1, 1_000),
        ...(params.limit === undefined ? {} : { limit: intParam(params, "limit", 30, 100) }),
      };
    }
    const output: Record<string, unknown> = { owner, repo };
    if (action === "get_file") {
      assertKeys(params, ["owner", "repo", "path", "ref"]);
      pathParam(params, "path", { required: true, maxLength: 2_000 });
      output.path = stringParam(params, "path", { required: true, maxLength: 2_000 });
    } else if (["get_readme", "get_repository", "get_starred"].includes(action))
      assertKeys(params, ["owner", "repo"]);
    else if (action === "set_starred") {
      assertKeys(params, ["owner", "repo", "starred"]);
      if (typeof params.starred !== "boolean") throw new Error("GitHub starred must be a boolean");
      output.starred = params.starred;
    } else if (action === "get_pull_request") {
      assertKeys(params, ["owner", "repo", "pull_number"]);
      output.pull_number = intParam(params, "pull_number", 0, Number.MAX_SAFE_INTEGER);
    } else if (action === "list_pull_requests") {
      assertKeys(params, ["owner", "repo", "limit", "page"]);
      output.limit = intParam(params, "limit", 30, 100);
      output.page = intParam(params, "page", 1, 1_000);
    } else if (action === "create_issue") {
      assertKeys(params, ["owner", "repo", "title", "body"]);
      output.title = stringParam(params, "title", { required: true, maxLength: 256 });
      const body = stringParam(params, "body", { maxLength: 20_000 });
      if (body) output.body = body;
    }
    if (action === "get_file") {
      const ref = stringParam(params, "ref", { maxLength: 300 });
      if (ref) output.ref = ref;
    }
    return output;
  }
  const output: Record<string, unknown> = {};
  const resourceParam =
    providerId === "sentry" && action === "list_projects"
      ? "organization"
      : providerId === "slack" && action === "get_channel_history"
        ? "channel"
        : providerId === "notion" && action === "get_page"
          ? "page_id"
          : providerId === "airtable" && action === "list_tables"
            ? "base_id"
            : undefined;
  if (providerId === "figma") {
    assertKeys(params, ["file_url_or_key", "file_key"]);
    const raw =
      stringParam(params, "file_url_or_key", { maxLength: 1_000 }) ??
      stringParam(params, "file_key", { maxLength: 200 });
    let key = raw;
    if (raw?.startsWith("https://")) {
      const url = new URL(raw);
      if (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com"))
        throw new Error("Invalid Figma file URL");
      key = url.pathname.match(/^\/(?:file|design|board)\/([^/]+)/)?.[1];
    }
    return { file_url_or_key: requireResource(key) };
  }
  const limitProviders = ["gitlab", "vercel", "slack", "linear", "todoist"];
  const supportsLimit =
    limitProviders.includes(providerId) || (providerId === "notion" && action === "search");
  assertKeys(params, [
    ...(supportsLimit ? ["limit"] : []),
    ...(resourceParam ? [resourceParam] : []),
    ...(providerId === "notion" && action === "search" ? ["query"] : []),
    ...(providerId === "vercel" ? ["team_id"] : []),
  ]);
  if (resourceParam) output[resourceParam] = requireResource(params[resourceParam]);
  if (supportsLimit && params.limit !== undefined)
    output.limit = intParam(
      params,
      "limit",
      30,
      providerId === "slack"
        ? action === "get_channel_history"
          ? 15
          : 200
        : providerId === "linear"
          ? 50
          : 100,
    );
  if (providerId === "notion" && action === "search") {
    const query = stringParam(params, "query", { maxLength: 200 });
    if (query) output.query = query;
  }
  if (providerId === "vercel") {
    // The server validates this against the installation's own team.
    const team = stringParam(params, "team_id", { maxLength: 100 });
    if (team) output.team_id = team;
  }
  return output;
}

const issueFields = [
  "number",
  "title",
  "body",
  "state",
  "state_reason",
  "html_url",
  "created_at",
  "updated_at",
  "closed_at",
  "user",
  "assignees",
  "labels",
  "milestone",
  "comments",
];
const pullFields = [
  ...issueFields,
  "draft",
  "merged",
  "mergeable",
  "merged_at",
  "requested_reviewers",
  "head",
  "base",
  "commits",
  "additions",
  "deletions",
  "changed_files",
];
/** Keep the existing local result contract and discard results outside the selected resources. */
export function normalizeRemoteLinkActionResult(
  providerId: string,
  action: string,
  raw: unknown,
  params: Record<string, unknown>,
  groups: readonly RemoteLinkResourceGroup[],
): unknown {
  const allowed = selected(providerId, groups);
  const permitted = (id: unknown) => {
    try {
      return allowed.has(
        normalizeRemoteLinkResourceId(providerId, typeof id === "number" ? String(id) : id),
      );
    } catch {
      return false;
    }
  };
  const record = asRecord(raw);
  if (providerId === "github") {
    if (["list_repositories", "list_issues", "list_pull_requests"].includes(action)) {
      if (!Array.isArray(raw)) throw new Error("Invalid remote Link result");
      const values = raw.filter((item) =>
        action === "list_repositories"
          ? permitted(asRecord(item)?.full_name)
          : action !== "list_issues" || !asRecord(item)?.pull_request,
      );
      const key =
        action === "list_repositories"
          ? "repositories"
          : action === "list_issues"
            ? "issues"
            : "pull_requests";
      const fields =
        action === "list_repositories"
          ? [
              "id",
              "full_name",
              "description",
              "private",
              "archived",
              "default_branch",
              "html_url",
              "updated_at",
            ]
          : action === "list_issues"
            ? ["number", "title", "state", "html_url", "created_at", "updated_at", "user", "labels"]
            : pullFields;
      return {
        [key]: values
          .slice(0, intParam(params, "limit", 30, 100))
          .map((item) => pick(item, fields)),
      };
    }
    if (!record) throw new Error("Invalid remote Link result");
    if (action === "get_repository") {
      if (!permitted(record.full_name))
        throw new Error("Remote Link returned an unauthorized repository");
      return pick(record, ["id", "full_name", "private", "archived", "html_url"]);
    }
    if (action === "get_starred") {
      if (typeof record.starred !== "boolean") throw new Error("Invalid remote Star state");
      return { starred: record.starred };
    }
    if (action === "set_starred") {
      if (record.acknowledged !== true) throw new Error("Invalid remote Star acknowledgement");
      return { acknowledged: true };
    }
    if (["get_readme", "get_file"].includes(action)) {
      if (action === "get_file" && record.type !== "file")
        throw new Error("GitHub path is not a file");
      if (record.encoding !== undefined && record.encoding !== "base64")
        throw new Error("Unsupported GitHub file encoding");
      if (typeof record.content !== "string") throw new Error("Invalid GitHub file content");
      const decoded = Buffer.from(record.content.replace(/\s/g, ""), "base64").toString("utf8");
      const content = decoded.slice(0, 262_144);
      return {
        owner: params.owner,
        repo: params.repo,
        path: record.path,
        ...(action === "get_file" ? { ref: params.ref, size: record.size } : {}),
        sha: record.sha,
        content,
        truncated:
          decoded.length > content.length ||
          (typeof record.size === "number" && record.size > Buffer.byteLength(content)),
        html_url: record.html_url,
      };
    }
    return pick(
      record,
      action === "get_pull_request"
        ? pullFields
        : action === "create_issue"
          ? ["number", "title", "state", "html_url", "created_at"]
          : issueFields,
    );
  }
  if (!record) throw new Error("Invalid remote Link result");
  if (providerId === "figma") {
    if (action === "get_file")
      return pick(record, ["name", "lastModified", "version", "role", "pages", "truncated"]);
    if (!Array.isArray(record.comments)) throw new Error("Invalid remote Link result");
    return {
      ...(typeof record.truncated === "boolean" ? { truncated: record.truncated } : {}),
      comments: record.comments
        .slice(0, 100)
        .map((value) =>
          pick(value, ["id", "message", "created_at", "resolved_at", "user", "client_meta"]),
        ),
    };
  }
  if (providerId === "notion" && action === "get_page") {
    if (!permitted(record.id)) throw new Error("Remote Link returned an unauthorized page");
    return pick(record, [
      "object",
      "id",
      "url",
      "created_time",
      "last_edited_time",
      "archived",
      "parent",
      "properties",
    ]);
  }
  const key =
    providerId === "slack"
      ? action === "list_channels"
        ? "channels"
        : "messages"
      : providerId === "notion"
        ? "results"
        : action.replace(/^list_/, "");
  if (!Array.isArray(record[key])) throw new Error("Invalid remote Link result");
  let values = record[key] as unknown[];
  const identityField =
    providerId === "gitlab" && action === "list_issues"
      ? "project_id"
      : providerId === "todoist" && action === "list_tasks"
        ? "project_id"
        : providerId === "sentry" && action === "list_organizations"
          ? "slug"
          : providerId === "vercel" && action === "list_deployments"
            ? "projectId"
            : "id";
  if (
    !(providerId === "sentry" && action === "list_projects") &&
    !(providerId === "airtable" && action === "list_tables") &&
    !(providerId === "slack" && action === "get_channel_history")
  ) {
    values = values.filter((value) =>
      providerId === "linear" && action === "list_issues"
        ? permitted(asRecord(asRecord(value)?.team)?.id)
        : permitted(asRecord(value)?.[identityField]),
    );
  }
  const output: Record<string, unknown> = {
    [key]: values.slice(
      0,
      intParam(
        params,
        "limit",
        providerId === "slack"
          ? action === "get_channel_history"
            ? 15
            : 200
          : providerId === "linear"
            ? 50
            : 100,
        200,
      ),
    ),
  };
  for (const name of ["next_cursor", "offset", "has_more", "truncated", "pagination"]) {
    if (record[name] !== undefined) output[name] = record[name];
  }
  return output;
}
