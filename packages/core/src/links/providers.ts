import {
  asArray,
  asRecord,
  firstString,
  intParam,
  linkRequestJson,
  pick,
  stringParam,
} from "./http.js";
import type {
  LocalLinkActionContext,
  LocalLinkActionSpec,
  LocalLinkIdentity,
  LocalLinkProviderSpec,
  LocalLinkProviderSummary,
} from "./types.js";

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const GITHUB_API_VERSION = "2026-03-10";
const NOTION_API_VERSION = "2026-03-11";
const githubHeaders = (token: string): Record<string, string> => ({
  ...bearer(token),
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": GITHUB_API_VERSION,
});

function action(
  id: string,
  title: string,
  description: string,
  execute: LocalLinkActionSpec["execute"],
  risk: LocalLinkActionSpec["risk"] = "read",
): LocalLinkActionSpec {
  return { id, title, description, risk, execute };
}

async function request(
  context: LocalLinkActionContext | Omit<LocalLinkActionContext, "params">,
  url: string | URL,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<unknown> {
  return linkRequestJson({
    url: typeof url === "string" ? new URL(url) : url,
    method: options.method,
    headers: options.headers ?? bearer(context.token),
    body: options.body,
    signal: context.signal,
    fetchImpl: context.fetchImpl,
  });
}

function identity(
  data: unknown,
  idKeys: string[],
  labelKeys: string[],
  detailKeys: string[] = [],
): LocalLinkIdentity {
  const record = asRecord(data) ?? {};
  const externalAccountId =
    firstString(...idKeys.map((key) => record[key])) ?? String(record.id ?? "account");
  const label = firstString(...labelKeys.map((key) => record[key])) ?? externalAccountId;
  const detail = firstString(...detailKeys.map((key) => record[key]));
  return { externalAccountId, label, ...(detail ? { detail } : {}) };
}

function compactList(
  data: unknown,
  keys: readonly string[],
  limit = 50,
): Record<string, unknown>[] {
  return asArray(data)
    .slice(0, limit)
    .map((value) => pick(value, keys));
}

const github: LocalLinkProviderSpec = {
  id: "github",
  displayName: "GitHub",
  tokenLabel: "Fine-grained PAT",
  tokenPlaceholder: "github_pat_…",
  async validate(context) {
    const data = await request(context, "https://api.github.com/user", {
      headers: githubHeaders(context.token),
    });
    const repositoriesUrl = new URL("https://api.github.com/user/repos");
    repositoriesUrl.searchParams.set("per_page", "12");
    repositoriesUrl.searchParams.set("sort", "updated");
    const repositories = await request(context, repositoriesUrl, {
      headers: githubHeaders(context.token),
    });
    return {
      ...identity(data, ["id"], ["login", "name"], ["name", "email"]),
      resourceLabels: asArray(repositories)
        .map((value) => firstString(asRecord(value)?.full_name))
        .filter((value): value is string => Boolean(value))
        .slice(0, 12),
    };
  },
  actions: [
    action(
      "list_repositories",
      "列出仓库",
      "列出当前 Token 可访问的 GitHub 仓库。",
      async (ctx) => {
        const url = new URL("https://api.github.com/user/repos");
        url.searchParams.set("per_page", String(intParam(ctx.params, "limit", 30, 100)));
        url.searchParams.set("sort", "updated");
        const data = await request(ctx, url, {
          headers: githubHeaders(ctx.token),
        });
        return {
          repositories: compactList(
            data,
            [
              "id",
              "full_name",
              "description",
              "private",
              "archived",
              "default_branch",
              "html_url",
              "updated_at",
            ],
            100,
          ),
        };
      },
    ),
    action(
      "get_readme",
      "读取 README",
      "读取 GitHub README；params: owner, repo。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const data =
          asRecord(
            await request(
              ctx,
              `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
              { headers: githubHeaders(ctx.token) },
            ),
          ) ?? {};
        const encoded = typeof data.content === "string" ? data.content.replace(/\s/g, "") : "";
        const content = encoded
          ? Buffer.from(encoded, "base64").toString("utf8").slice(0, 262_144)
          : "";
        return {
          owner,
          repo,
          path: data.path,
          sha: data.sha,
          content,
          truncated: content.length >= 262_144,
          html_url: data.html_url,
        };
      },
    ),
    action(
      "list_issues",
      "列出 Issue",
      "列出 GitHub Issue（排除 Pull Request）；params: owner, repo, 可选 limit。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const url = new URL(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        );
        url.searchParams.set("per_page", String(intParam(ctx.params, "limit", 30, 100)));
        const data = asArray(
          await request(ctx, url, {
            headers: githubHeaders(ctx.token),
          }),
        );
        return {
          issues: data
            .filter((value) => !asRecord(value)?.pull_request)
            .slice(0, 100)
            .map((value) =>
              pick(value, [
                "number",
                "title",
                "state",
                "html_url",
                "created_at",
                "updated_at",
                "user",
                "labels",
              ]),
            ),
        };
      },
    ),
    action(
      "get_file",
      "读取指定文件",
      "读取 GitHub 仓库文件；params: owner, repo, path, 可选 ref。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const path = stringParam(ctx.params, "path", { required: true, maxLength: 2_000 })!;
        const ref = stringParam(ctx.params, "ref", { maxLength: 300 });
        const url = new URL(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`,
        );
        if (ref) url.searchParams.set("ref", ref);
        const data = asRecord(await request(ctx, url, { headers: githubHeaders(ctx.token) })) ?? {};
        if (data.type !== "file") throw new Error("GitHub path is not a file");
        const encoded = typeof data.content === "string" ? data.content.replace(/\s/g, "") : "";
        const content = encoded
          ? Buffer.from(encoded, "base64").toString("utf8").slice(0, 262_144)
          : "";
        return {
          owner,
          repo,
          path: data.path,
          ref,
          sha: data.sha,
          size: data.size,
          content,
          truncated: typeof data.size === "number" ? data.size > Buffer.byteLength(content) : false,
          html_url: data.html_url,
        };
      },
    ),
    action(
      "list_pull_requests",
      "列出 Pull Request",
      "列出 GitHub Pull Request；params: owner, repo, 可选 limit。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const url = new URL(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        );
        url.searchParams.set("per_page", String(intParam(ctx.params, "limit", 30, 100)));
        const data = await request(ctx, url, {
          headers: githubHeaders(ctx.token),
        });
        return {
          pull_requests: compactList(
            data,
            [
              "number",
              "title",
              "state",
              "draft",
              "html_url",
              "created_at",
              "updated_at",
              "user",
              "head",
              "base",
            ],
            100,
          ),
        };
      },
    ),
    action(
      "get_issue",
      "查看 Issue",
      "查看单个 GitHub Issue；params: owner, repo, issue_number。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const number = intParam(ctx.params, "issue_number", 0, Number.MAX_SAFE_INTEGER);
        return pick(
          await request(
            ctx,
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
            { headers: githubHeaders(ctx.token) },
          ),
          [
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
          ],
        );
      },
    ),
    action(
      "get_pull_request",
      "查看 Pull Request",
      "查看单个 GitHub Pull Request；params: owner, repo, pull_number。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const number = intParam(ctx.params, "pull_number", 0, Number.MAX_SAFE_INTEGER);
        return pick(
          await request(
            ctx,
            `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
            { headers: githubHeaders(ctx.token) },
          ),
          [
            "number",
            "title",
            "body",
            "state",
            "draft",
            "merged",
            "mergeable",
            "html_url",
            "created_at",
            "updated_at",
            "closed_at",
            "merged_at",
            "user",
            "assignees",
            "requested_reviewers",
            "labels",
            "head",
            "base",
            "commits",
            "additions",
            "deletions",
            "changed_files",
          ],
        );
      },
    ),
    action(
      "create_issue",
      "创建 Issue",
      "创建 GitHub Issue；params: owner, repo, title, 可选 body；执行前始终审批。",
      async (ctx) => {
        const owner = stringParam(ctx.params, "owner", { required: true, maxLength: 100 })!;
        const repo = stringParam(ctx.params, "repo", { required: true, maxLength: 100 })!;
        const title = stringParam(ctx.params, "title", { required: true, maxLength: 256 })!;
        const body = stringParam(ctx.params, "body", { maxLength: 20_000 });
        const data = await request(
          ctx,
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          {
            method: "POST",
            headers: githubHeaders(ctx.token),
            body: { title, ...(body ? { body } : {}) },
          },
        );
        return pick(data, ["number", "title", "state", "html_url", "created_at"]);
      },
      "write",
    ),
  ],
};

const gitlab: LocalLinkProviderSpec = {
  id: "gitlab",
  displayName: "GitLab",
  tokenLabel: "Personal access token",
  tokenPlaceholder: "glpat-…",
  async validate(context) {
    const data = await request(context, "https://gitlab.com/api/v4/user", {
      headers: { "PRIVATE-TOKEN": context.token },
    });
    return identity(data, ["id"], ["username", "name"], ["name", "email"]);
  },
  actions: [
    action("list_projects", "列出项目", "列出当前 Token 可访问的 GitLab 项目。", async (ctx) => {
      const url = new URL("https://gitlab.com/api/v4/projects");
      url.searchParams.set("membership", "true");
      url.searchParams.set("simple", "true");
      url.searchParams.set("per_page", String(intParam(ctx.params, "limit", 30, 100)));
      const data = await request(ctx, url, { headers: { "PRIVATE-TOKEN": ctx.token } });
      return {
        projects: compactList(
          data,
          [
            "id",
            "name",
            "path_with_namespace",
            "description",
            "visibility",
            "default_branch",
            "web_url",
            "last_activity_at",
          ],
          100,
        ),
      };
    }),
    action("list_issues", "列出 Issue", "列出当前用户可见的 GitLab Issue。", async (ctx) => {
      const url = new URL("https://gitlab.com/api/v4/issues");
      url.searchParams.set("scope", "assigned_to_me");
      url.searchParams.set("per_page", String(intParam(ctx.params, "limit", 30, 100)));
      const data = await request(ctx, url, { headers: { "PRIVATE-TOKEN": ctx.token } });
      return {
        issues: compactList(
          data,
          [
            "id",
            "iid",
            "project_id",
            "title",
            "state",
            "web_url",
            "created_at",
            "updated_at",
            "labels",
          ],
          100,
        ),
      };
    }),
  ],
};

const figma: LocalLinkProviderSpec = {
  id: "figma",
  displayName: "Figma",
  tokenLabel: "Personal access token",
  tokenPlaceholder: "figd_…",
  async validate(context) {
    const data = await request(context, "https://api.figma.com/v1/me", {
      headers: { "X-Figma-Token": context.token },
    });
    return identity(data, ["id"], ["handle", "email"], ["email"]);
  },
  actions: [
    action(
      "get_file",
      "读取文件摘要",
      "用 file_url_or_key 读取 Figma 文件名称、版本和第一页结构摘要。",
      async (ctx) => {
        const fileKey = figmaFileKey(ctx.params);
        const url = new URL(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}`);
        url.searchParams.set("depth", "1");
        const data =
          asRecord(await request(ctx, url, { headers: { "X-Figma-Token": ctx.token } })) ?? {};
        const document = asRecord(data.document);
        return {
          name: data.name,
          lastModified: data.lastModified,
          version: data.version,
          role: data.role,
          pages: compactList(document?.children, ["id", "name", "type"], 100),
        };
      },
    ),
    action("get_comments", "读取评论", "用 file_url_or_key 读取 Figma 文件评论。", async (ctx) => {
      const fileKey = figmaFileKey(ctx.params);
      const data =
        asRecord(
          await request(
            ctx,
            `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/comments`,
            { headers: { "X-Figma-Token": ctx.token } },
          ),
        ) ?? {};
      return {
        comments: compactList(
          data.comments,
          ["id", "message", "created_at", "resolved_at", "user", "client_meta"],
          100,
        ),
      };
    }),
  ],
};

function figmaFileKey(params: Record<string, unknown>): string {
  const value =
    stringParam(params, "file_url_or_key", { maxLength: 1_000 }) ??
    stringParam(params, "file_key", { maxLength: 200 });
  if (!value) throw new Error("Missing required Link Action parameter: file_url_or_key");
  if (!/^https?:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("file_url_or_key must be a Figma URL or file key");
  }
  if (url.hostname !== "figma.com" && !url.hostname.endsWith(".figma.com")) {
    throw new Error("file_url_or_key must use figma.com");
  }
  const match = url.pathname.match(/\/(?:file|design|board)\/([^/]+)/);
  if (!match?.[1]) throw new Error("Could not find a Figma file key in the URL");
  return decodeURIComponent(match[1]);
}

const notionHeaders = (token: string) => ({
  ...bearer(token),
  "Notion-Version": NOTION_API_VERSION,
});
const notion: LocalLinkProviderSpec = {
  id: "notion",
  displayName: "Notion",
  tokenLabel: "Internal integration token",
  tokenPlaceholder: "ntn_… / secret_…",
  async validate(context) {
    const data = await request(context, "https://api.notion.com/v1/users/me", {
      headers: notionHeaders(context.token),
    });
    const record = asRecord(data) ?? {};
    const bot = asRecord(record.bot);
    return {
      externalAccountId: String(record.id ?? "bot"),
      label: firstString(record.name, bot?.owner && "Notion integration") ?? "Notion integration",
      detail: firstString(record.type),
    };
  },
  actions: [
    action(
      "search",
      "搜索页面和数据库",
      "搜索已授权给该 Integration 的 Notion 页面和数据库。",
      async (ctx) => {
        const query = stringParam(ctx.params, "query", { maxLength: 200 });
        const data =
          asRecord(
            await request(ctx, "https://api.notion.com/v1/search", {
              method: "POST",
              headers: notionHeaders(ctx.token),
              body: {
                page_size: intParam(ctx.params, "limit", 30, 100),
                ...(query ? { query } : {}),
              },
            }),
          ) ?? {};
        return {
          results: asArray(data.results)
            .slice(0, 100)
            .map((value) =>
              pick(value, [
                "object",
                "id",
                "url",
                "created_time",
                "last_edited_time",
                "archived",
                "parent",
                "properties",
                "title",
              ]),
            ),
          has_more: data.has_more,
          next_cursor: data.next_cursor,
        };
      },
    ),
    action("get_page", "读取页面属性", "读取 Notion 页面属性；params: page_id。", async (ctx) => {
      const pageId = stringParam(ctx.params, "page_id", { required: true, maxLength: 100 })!;
      return pick(
        await request(ctx, `https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
          headers: notionHeaders(ctx.token),
        }),
        [
          "object",
          "id",
          "url",
          "created_time",
          "last_edited_time",
          "archived",
          "parent",
          "properties",
        ],
      );
    }),
  ],
};

async function linearGraphql(
  context: LocalLinkActionContext | Omit<LocalLinkActionContext, "params">,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response =
    asRecord(
      await request(context, "https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: context.token },
        body: { query, variables },
      }),
    ) ?? {};
  if (asArray(response.errors).length)
    throw new Error(
      `Linear GraphQL request failed: ${JSON.stringify(response.errors).slice(0, 300)}`,
    );
  return asRecord(response.data) ?? {};
}

const linear: LocalLinkProviderSpec = {
  id: "linear",
  displayName: "Linear",
  tokenLabel: "Personal API key",
  tokenPlaceholder: "lin_api_…",
  async validate(context) {
    const data = await linearGraphql(context, "query { viewer { id name displayName email } }");
    const viewer = asRecord(data.viewer) ?? {};
    return identity(viewer, ["id"], ["displayName", "name", "email"], ["email"]);
  },
  actions: [
    action("list_issues", "列出 Issue", "列出分配给当前 Linear 用户的 Issue。", async (ctx) => {
      const first = intParam(ctx.params, "limit", 30, 50);
      const data = await linearGraphql(
        ctx,
        "query Issues($first: Int!) { viewer { assignedIssues(first: $first) { nodes { id identifier title description priority url createdAt updatedAt state { name type } team { key name } } } } }",
        { first },
      );
      const viewer = asRecord(data.viewer);
      const assigned = asRecord(viewer?.assignedIssues);
      return { issues: asArray(assigned?.nodes).slice(0, 50) };
    }),
    action("list_teams", "列出团队", "列出当前 Linear 工作区中的团队。", async (ctx) => {
      const data = await linearGraphql(
        ctx,
        "query { teams(first: 50) { nodes { id key name description } } }",
      );
      return { teams: asArray(asRecord(data.teams)?.nodes).slice(0, 50) };
    }),
  ],
};

async function slackRequest(
  context: LocalLinkActionContext | Omit<LocalLinkActionContext, "params">,
  endpoint: string,
  body?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const data =
    asRecord(
      await request(context, `https://slack.com/api/${endpoint}`, {
        method: "POST",
        body: body ?? {},
      }),
    ) ?? {};
  if (data.ok !== true)
    throw new Error(`Slack API request failed: ${firstString(data.error) ?? "unknown_error"}`);
  return data;
}

const slack: LocalLinkProviderSpec = {
  id: "slack",
  displayName: "Slack",
  tokenLabel: "Bot or user token",
  tokenPlaceholder: "xoxb-… / xoxp-…",
  async validate(context) {
    const data = await slackRequest(context, "auth.test");
    return {
      externalAccountId: firstString(data.user_id, data.bot_id, data.team_id) ?? "slack",
      label: firstString(data.user, data.team) ?? "Slack",
      detail: firstString(data.team, data.url),
    };
  },
  actions: [
    action("list_channels", "列出频道", "列出 Token 可访问的 Slack 频道。", async (ctx) => {
      const data = await slackRequest(ctx, "conversations.list", {
        limit: String(intParam(ctx.params, "limit", 50, 200)),
        exclude_archived: "true",
      });
      return {
        channels: compactList(
          data.channels,
          ["id", "name", "is_private", "is_member", "topic", "purpose", "num_members"],
          200,
        ),
        next_cursor: asRecord(data.response_metadata)?.next_cursor,
      };
    }),
    action(
      "get_channel_history",
      "读取频道消息",
      "读取 Slack 频道最近消息；params: channel, 可选 limit（最多 15）。",
      async (ctx) => {
        const channel = stringParam(ctx.params, "channel", { required: true, maxLength: 100 })!;
        const data = await slackRequest(ctx, "conversations.history", {
          channel,
          limit: String(intParam(ctx.params, "limit", 15, 15)),
        });
        return {
          messages: compactList(
            data.messages,
            ["type", "user", "text", "ts", "thread_ts", "reply_count", "files"],
            100,
          ),
          has_more: data.has_more,
        };
      },
    ),
  ],
};

const sentry: LocalLinkProviderSpec = {
  id: "sentry",
  displayName: "Sentry",
  tokenLabel: "User auth token",
  tokenPlaceholder: "sntrys_…",
  async validate(context) {
    const data = await request(context, "https://sentry.io/api/0/organizations/");
    const organizations = asArray(data);
    const first = asRecord(organizations[0]);
    return {
      externalAccountId: firstString(first?.id, first?.slug) ?? "sentry-token",
      label:
        organizations.length > 0
          ? `${firstString(first?.name, first?.slug) ?? "Sentry"} · ${organizations.length} org`
          : "Sentry token",
    };
  },
  actions: [
    action(
      "list_organizations",
      "列出组织",
      "列出当前 Sentry Token 可访问的组织。",
      async (ctx) => ({
        organizations: compactList(
          await request(ctx, "https://sentry.io/api/0/organizations/"),
          ["id", "slug", "name", "status", "dateCreated", "isEarlyAdopter"],
          100,
        ),
      }),
    ),
    action(
      "list_projects",
      "列出项目",
      "列出 Sentry 组织项目；params: organization。",
      async (ctx) => {
        const org = stringParam(ctx.params, "organization", { required: true, maxLength: 100 })!;
        return {
          projects: compactList(
            await request(
              ctx,
              `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/projects/`,
            ),
            ["id", "slug", "name", "platform", "dateCreated", "isBookmarked"],
            100,
          ),
        };
      },
    ),
  ],
};

const airtable: LocalLinkProviderSpec = {
  id: "airtable",
  displayName: "Airtable",
  tokenLabel: "Personal access token",
  tokenPlaceholder: "pat…",
  async validate(context) {
    const root = asRecord(await request(context, "https://api.airtable.com/v0/meta/bases")) ?? {};
    const bases = asArray(root.bases);
    const first = asRecord(bases[0]);
    return {
      externalAccountId: firstString(first?.id) ?? "airtable-token",
      label:
        bases.length > 0
          ? `Airtable · ${bases.length} base${bases.length === 1 ? "" : "s"}`
          : "Airtable token",
    };
  },
  actions: [
    action("list_bases", "列出 Base", "列出当前 Airtable PAT 可访问的 Base。", async (ctx) => {
      const data = asRecord(await request(ctx, "https://api.airtable.com/v0/meta/bases")) ?? {};
      return {
        bases: compactList(data.bases, ["id", "name", "permissionLevel"], 100),
        offset: data.offset,
      };
    }),
    action(
      "list_tables",
      "列出数据表",
      "列出 Airtable 表与字段；params: base_id。",
      async (ctx) => {
        const baseId = stringParam(ctx.params, "base_id", { required: true, maxLength: 100 })!;
        const data =
          asRecord(
            await request(
              ctx,
              `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(baseId)}/tables`,
            ),
          ) ?? {};
        return {
          tables: asArray(data.tables)
            .slice(0, 100)
            .map((value) => pick(value, ["id", "name", "primaryFieldId", "fields", "views"])),
        };
      },
    ),
  ],
};

const todoist: LocalLinkProviderSpec = {
  id: "todoist",
  displayName: "Todoist",
  tokenLabel: "Developer API token",
  tokenPlaceholder: "Todoist API token",
  async validate(context) {
    const data = await request(context, "https://api.todoist.com/api/v1/user");
    return identity(data, ["id"], ["full_name", "email"], ["email"]);
  },
  actions: [
    action("list_projects", "列出项目", "列出当前 Todoist Token 可访问的项目。", async (ctx) => {
      const root = asRecord(await request(ctx, "https://api.todoist.com/api/v1/projects"));
      const data = root?.results ?? root ?? [];
      return {
        projects: compactList(
          data,
          ["id", "name", "color", "is_shared", "is_favorite", "is_archived", "url"],
          100,
        ),
      };
    }),
    action("list_tasks", "列出任务", "列出当前 Todoist 用户的未完成任务。", async (ctx) => {
      const url = new URL("https://api.todoist.com/api/v1/tasks");
      url.searchParams.set("limit", String(intParam(ctx.params, "limit", 50, 100)));
      const root = asRecord(await request(ctx, url));
      const data = root?.results ?? root ?? [];
      return {
        tasks: compactList(
          data,
          ["id", "content", "description", "project_id", "priority", "due", "labels", "url"],
          100,
        ),
        next_cursor: root?.next_cursor,
      };
    }),
  ],
};

const vercel: LocalLinkProviderSpec = {
  id: "vercel",
  displayName: "Vercel",
  tokenLabel: "Access token",
  tokenPlaceholder: "Vercel access token",
  async validate(context) {
    const root = asRecord(await request(context, "https://api.vercel.com/v2/user")) ?? {};
    return identity(root.user, ["id", "uid"], ["name", "username", "email"], ["email"]);
  },
  actions: [
    action("list_projects", "列出项目", "列出当前 Vercel Token 可访问的项目。", async (ctx) => {
      const url = new URL("https://api.vercel.com/v10/projects");
      url.searchParams.set("limit", String(intParam(ctx.params, "limit", 50, 100)));
      const teamId = stringParam(ctx.params, "team_id", { maxLength: 100 });
      if (teamId) url.searchParams.set("teamId", teamId);
      const root = asRecord(await request(ctx, url)) ?? {};
      return {
        projects: compactList(
          root.projects,
          ["id", "name", "framework", "updatedAt", "createdAt", "latestDeployments"],
          100,
        ),
        pagination: root.pagination,
      };
    }),
    action("list_deployments", "列出部署", "列出当前 Vercel Token 可访问的部署。", async (ctx) => {
      const url = new URL("https://api.vercel.com/v7/deployments");
      url.searchParams.set("limit", String(intParam(ctx.params, "limit", 50, 100)));
      const teamId = stringParam(ctx.params, "team_id", { maxLength: 100 });
      if (teamId) url.searchParams.set("teamId", teamId);
      const root = asRecord(await request(ctx, url)) ?? {};
      return {
        deployments: compactList(
          root.deployments,
          ["uid", "name", "url", "state", "target", "created", "ready", "meta"],
          100,
        ),
        pagination: root.pagination,
      };
    }),
  ],
};

export const LOCAL_LINK_PROVIDERS: readonly LocalLinkProviderSpec[] = [
  github,
  gitlab,
  figma,
  notion,
  linear,
  slack,
  sentry,
  airtable,
  todoist,
  vercel,
];

export function getLocalLinkProvider(providerId: string): LocalLinkProviderSpec | undefined {
  return LOCAL_LINK_PROVIDERS.find((provider) => provider.id === providerId);
}

export function listLocalLinkProviders(): LocalLinkProviderSummary[] {
  return LOCAL_LINK_PROVIDERS.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    tokenLabel: provider.tokenLabel,
    tokenPlaceholder: provider.tokenPlaceholder,
    actions: provider.actions.map(({ id, title, description, risk }) => ({
      id,
      title,
      description,
      risk,
    })),
  }));
}

export async function validateLocalLinkToken(
  providerId: string,
  token: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<import("./types.js").LocalLinkValidationResult> {
  const provider = getLocalLinkProvider(providerId);
  if (!provider) throw new Error(`Unknown local Link provider: ${providerId}`);
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Token is required");
  const identity = await provider.validate({ token: trimmed, ...options });
  return {
    providerId,
    identity,
    capabilityIds: provider.actions.map((actionSpec) => `${providerId}.${actionSpec.id}`),
    verifiedAt: new Date().toISOString(),
  };
}
