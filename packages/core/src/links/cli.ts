import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asArray, asRecord, firstString, intParam, pick, stringParam } from "./http.js";
import { getLocalLinkProvider } from "./providers.js";
import type { LocalLinkIdentity, LocalLinkValidationResult } from "./types.js";

export type CliLinkProviderId = "github" | "gitlab" | "notion" | "todoist" | "vercel";

export interface CliLinkStatus {
  providerId: CliLinkProviderId;
  command: string;
  installed: boolean;
  authenticated: boolean;
  account?: string;
  message?: string;
}

export interface CliLinkCommandResult {
  stdout: string;
  stderr: string;
}

export interface CliLinkRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  input?: string;
}

export type CliLinkCommandRunner = (
  providerId: CliLinkProviderId,
  command: string,
  args: string[],
  options: CliLinkRunOptions,
) => Promise<CliLinkCommandResult>;

const CONFIG = {
  github: {
    command: "gh" as const,
    hostname: "github.com",
    statusArgs: ["auth", "status", "--active", "--hostname", "github.com"],
    loginArgs: [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--web",
      "--clipboard",
      "--git-protocol",
      "https",
      "--skip-ssh-key",
    ],
    tokenEnv: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
  },
  gitlab: {
    command: "glab" as const,
    hostname: "gitlab.com",
    statusArgs: ["auth", "status", "--hostname", "gitlab.com"],
    loginArgs: [
      "auth",
      "login",
      "--hostname",
      "gitlab.com",
      "--web",
      "--git-protocol",
      "https",
      "--use-keyring",
    ],
    tokenEnv: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "CI_JOB_TOKEN"],
  },
  notion: {
    command: "ntn" as const,
    statusArgs: ["--version"],
    loginArgs: ["login"],
    tokenEnv: ["NOTION_API_TOKEN"],
  },
  todoist: {
    command: "td" as const,
    statusArgs: ["auth", "status", "--json"],
    loginArgs: ["auth", "login", "--read-only", "--json"],
    tokenEnv: ["TODOIST_API_TOKEN", "TODOIST_TOKEN"],
  },
  vercel: {
    command: "vercel" as const,
    statusArgs: ["whoami", "--no-color"],
    loginArgs: ["login", "--no-color"],
    tokenEnv: ["VERCEL_TOKEN"],
  },
} satisfies Record<
  CliLinkProviderId,
  {
    command: string;
    hostname?: string;
    statusArgs: string[];
    loginArgs: string[];
    tokenEnv: string[];
  }
>;

const TOKEN_PATTERN =
  /\b(?:github_pat_|gh[pousr]_|glpat-|glcbt-|gldt-|ntn_|secret_)[A-Za-z0-9_.-]{6,}\b/gi;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** App-private CLI location. It never mutates the user's system PATH. */
export function managedLinkCliPath(providerId: CliLinkProviderId): string {
  const base =
    process.env.CODESHELL_LINK_CLI_DIR ??
    join(process.env.HOME ?? homedir(), ".code-shell", "tools", "link-cli");
  const executable = `${CONFIG[providerId].command}${process.platform === "win32" ? ".exe" : ""}`;
  return join(base, providerId, executable);
}

export function resolveLinkCliExecutable(
  providerId: CliLinkProviderId,
  fallbackCommand: string = CONFIG[providerId].command,
): string {
  const managed = managedLinkCliPath(providerId);
  return existsSync(managed) ? managed : fallbackCommand;
}

function safeMessage(value: unknown): string {
  const stderr =
    value && typeof value === "object" && "stderr" in value
      ? String((value as { stderr?: unknown }).stderr ?? "").trim()
      : "";
  const raw = stderr || (value instanceof Error ? value.message : String(value ?? ""));
  return raw.replace(TOKEN_PATTERN, "[redacted]").trim().slice(0, 500);
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

export const runCliLinkCommand: CliLinkCommandRunner = (providerId, command, args, options) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of CONFIG[providerId].tokenEnv) delete env[name];
    const child = execFile(
      resolveLinkCliExecutable(providerId, command),
      args,
      {
        cwd: options.cwd,
        env,
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    // All supported flows are deliberately non-interactive (browser/device
    // authorization or machine-readable API calls). Always close stdin so a
    // CLI cannot mistake the Electron pipe for pending JSON or a hidden prompt.
    child.stdin?.end(options.input ?? "");
  });

function parseJson(result: CliLinkCommandResult, providerId: CliLinkProviderId): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${providerId} CLI returned an invalid response`);
  }
}

async function api(
  providerId: CliLinkProviderId,
  endpoint: string,
  options: {
    cwd?: string;
    signal?: AbortSignal;
    method?: "GET" | "POST";
    input?: unknown;
  } = {},
  run: CliLinkCommandRunner = runCliLinkCommand,
): Promise<unknown> {
  const config = CONFIG[providerId];
  if (providerId === "todoist") throw new Error("Todoist CLI does not expose a raw API command");
  let args: string[];
  if (providerId === "github") {
    args = ["api", endpoint, "--hostname", CONFIG.github.hostname];
    if (options.method && options.method !== "GET") args.push("--method", options.method);
    if (options.input !== undefined) args.push("--input", "-");
  } else if (providerId === "gitlab") {
    args = ["api", endpoint, "--hostname", CONFIG.gitlab.hostname, "--output", "json"];
    if (options.method && options.method !== "GET") args.push("--method", options.method);
    if (options.input !== undefined) args.push("--input", "-");
  } else if (providerId === "notion") {
    args = ["api", endpoint];
    if (options.method && options.method !== "GET") args.push("-X", options.method);
  } else {
    args = ["api", endpoint, "--no-color"];
    if (options.method && options.method !== "GET") args.push("-X", options.method);
  }
  try {
    const result = await run(providerId, config.command, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: 30_000,
      input: options.input === undefined ? undefined : JSON.stringify(options.input),
    });
    return parseJson(result, providerId);
  } catch (error) {
    const message = safeMessage(error);
    throw new Error(message || `${providerId} CLI request failed`, { cause: error });
  }
}

function identityFromUser(providerId: CliLinkProviderId, data: unknown): LocalLinkIdentity {
  const root = asRecord(data) ?? {};
  const user = providerId === "vercel" ? (asRecord(root.user) ?? root) : root;
  const externalAccountId = String(user.id ?? "account");
  const label = (() => {
    if (providerId === "github") return firstString(user.login, user.name) ?? externalAccountId;
    if (providerId === "gitlab") return firstString(user.username, user.name) ?? externalAccountId;
    if (providerId === "todoist") {
      return firstString(user.email, user.fullName, user.name) ?? externalAccountId;
    }
    return firstString(user.name, user.username, user.email) ?? externalAccountId;
  })();
  const detail = firstString(user.name, user.email);
  return { externalAccountId, label, ...(detail && detail !== label ? { detail } : {}) };
}

async function liveIdentity(
  providerId: CliLinkProviderId,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<LocalLinkIdentity> {
  if (providerId === "todoist") {
    const status = parseJson(
      await run(providerId, CONFIG.todoist.command, CONFIG.todoist.statusArgs, {
        ...options,
        timeoutMs: 15_000,
      }),
      providerId,
    );
    const identity = identityFromUser(providerId, status);
    const projectRoot = asRecord(
      parseJson(
        await run(
          providerId,
          CONFIG.todoist.command,
          ["project", "list", "--json", "--limit", "12"],
          { ...options, timeoutMs: 30_000 },
        ),
        providerId,
      ),
    );
    const resourceLabels = asArray(projectRoot?.results)
      .map((value) => firstString(asRecord(value)?.name))
      .filter((value): value is string => Boolean(value))
      .slice(0, 12);
    return { ...identity, resourceLabels };
  }
  const userEndpoint =
    providerId === "notion" ? "v1/users/me" : providerId === "vercel" ? "/v2/user" : "user";
  const user = await api(providerId, userEndpoint, options, run);
  const identity = identityFromUser(providerId, user);
  if (providerId === "notion") return identity;
  const resources =
    providerId === "github"
      ? await api(providerId, "user/repos?per_page=12&sort=updated", options, run)
      : providerId === "gitlab"
        ? await api(providerId, "projects?membership=true&simple=true&per_page=12", options, run)
        : await api(providerId, "/v10/projects?limit=12", options, run);
  const resourceValues =
    providerId === "vercel" ? asArray(asRecord(resources)?.projects) : asArray(resources);
  const resourceLabels = resourceValues
    .map((value) => {
      const record = asRecord(value);
      return providerId === "github"
        ? firstString(record?.full_name)
        : providerId === "gitlab"
          ? firstString(record?.path_with_namespace)
          : firstString(record?.name);
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 12);
  return { ...identity, resourceLabels };
}

async function currentIdentity(
  providerId: CliLinkProviderId,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<LocalLinkIdentity> {
  if (providerId === "todoist") {
    return identityFromUser(
      providerId,
      parseJson(
        await run(providerId, CONFIG.todoist.command, CONFIG.todoist.statusArgs, {
          ...options,
          timeoutMs: 15_000,
        }),
        providerId,
      ),
    );
  }
  return identityFromUser(
    providerId,
    await api(
      providerId,
      providerId === "notion" ? "v1/users/me" : providerId === "vercel" ? "/v2/user" : "user",
      options,
      run,
    ),
  );
}

/**
 * A CLI may switch accounts after Link was connected. Pin every Action to the
 * originally approved account so a local CLI change cannot silently widen or
 * redirect the Link connection.
 */
export async function assertCliLinkAccount(
  providerId: CliLinkProviderId,
  expectedExternalAccountId: string,
  options: { cwd?: string; signal?: AbortSignal } = {},
  run: CliLinkCommandRunner = runCliLinkCommand,
): Promise<void> {
  const identity = await currentIdentity(providerId, options, run);
  if (identity.externalAccountId !== expectedExternalAccountId) {
    throw new Error(
      `${CONFIG[providerId].command} is signed in to a different account; reconnect this Link`,
    );
  }
}

export function isCliLinkProvider(providerId: string): providerId is CliLinkProviderId {
  return (
    providerId === "github" ||
    providerId === "gitlab" ||
    providerId === "notion" ||
    providerId === "todoist" ||
    providerId === "vercel"
  );
}

export async function getCliLinkStatus(
  providerId: CliLinkProviderId,
  options: { cwd?: string; signal?: AbortSignal } = {},
  run: CliLinkCommandRunner = runCliLinkCommand,
): Promise<CliLinkStatus> {
  const config = CONFIG[providerId];
  try {
    const statusResult = await run(providerId, config.command, config.statusArgs, {
      ...options,
      timeoutMs: 15_000,
    });
    const user =
      providerId === "todoist"
        ? identityFromUser(providerId, parseJson(statusResult, providerId))
        : await currentIdentity(providerId, options, run);
    return {
      providerId,
      command: config.command,
      installed: true,
      authenticated: true,
      account: user.label,
    };
  } catch (error) {
    if (isMissingExecutable(error)) {
      return {
        providerId,
        command: config.command,
        installed: false,
        authenticated: false,
        message: `${config.command} is not installed`,
      };
    }
    return {
      providerId,
      command: config.command,
      installed: true,
      authenticated: false,
      message: safeMessage(error) || `${config.command} is not signed in`,
    };
  }
}

export async function connectCliLink(
  providerId: CliLinkProviderId,
  options: { cwd?: string; signal?: AbortSignal; loginIfNeeded: boolean },
  run: CliLinkCommandRunner = runCliLinkCommand,
): Promise<LocalLinkValidationResult> {
  let status = await getCliLinkStatus(providerId, options, run);
  if (!status.installed) throw new Error(`${status.command} is not installed`);
  if (!status.authenticated && options.loginIfNeeded) {
    const config = CONFIG[providerId];
    try {
      await run(providerId, config.command, config.loginArgs, {
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: 15 * 60_000,
      });
    } catch (error) {
      throw new Error(safeMessage(error) || `${config.command} browser authorization failed`, {
        cause: error,
      });
    }
    status = await getCliLinkStatus(providerId, options, run);
  }
  if (!status.authenticated) throw new Error(`${status.command} is not signed in`);

  const provider = getLocalLinkProvider(providerId);
  if (!provider) throw new Error(`Unknown local Link provider: ${providerId}`);
  return {
    providerId,
    identity: await liveIdentity(providerId, options, run),
    capabilityIds: provider.actions.map((action) => `${providerId}.${action.id}`),
    verifiedAt: new Date().toISOString(),
  };
}

function compactList(data: unknown, keys: readonly string[], limit = 100) {
  return asArray(data)
    .slice(0, limit)
    .map((value) => pick(value, keys));
}

function githubFile(data: unknown, owner: string, repo: string, ref?: string) {
  const record = asRecord(data) ?? {};
  if (record.type !== "file") throw new Error("GitHub path is not a file");
  const encoded = typeof record.content === "string" ? record.content.replace(/\s/g, "") : "";
  const content = encoded ? Buffer.from(encoded, "base64").toString("utf8").slice(0, 262_144) : "";
  return {
    owner,
    repo,
    path: record.path,
    ...(ref ? { ref } : {}),
    sha: record.sha,
    size: record.size,
    content,
    truncated:
      typeof record.size === "number"
        ? record.size > Buffer.byteLength(content)
        : content.length >= 262_144,
    html_url: record.html_url,
  };
}

async function executeGithubCliAction(
  actionId: string,
  params: Record<string, unknown>,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<unknown> {
  if (actionId === "list_repositories") {
    const limit = intParam(params, "limit", 30, 100);
    const data = await api("github", `user/repos?per_page=${limit}&sort=updated`, options, run);
    return {
      repositories: compactList(data, [
        "id",
        "full_name",
        "description",
        "private",
        "archived",
        "default_branch",
        "html_url",
        "updated_at",
      ]),
    };
  }
  const owner = stringParam(params, "owner", { required: true, maxLength: 100 })!;
  const repo = stringParam(params, "repo", { required: true, maxLength: 100 })!;
  const base = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  if (actionId === "get_readme") {
    const result = githubFile(await api("github", `${base}/readme`, options, run), owner, repo);
    return { ...result, size: undefined };
  }
  if (actionId === "get_file") {
    const path = stringParam(params, "path", { required: true, maxLength: 2_000 })!;
    const ref = stringParam(params, "ref", { maxLength: 300 });
    const endpoint = `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}${
      ref ? `?ref=${encodeURIComponent(ref)}` : ""
    }`;
    return githubFile(await api("github", endpoint, options, run), owner, repo, ref);
  }
  if (actionId === "list_issues") {
    const limit = intParam(params, "limit", 30, 100);
    const data = asArray(await api("github", `${base}/issues?per_page=${limit}`, options, run));
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
  }
  if (actionId === "list_pull_requests") {
    const limit = intParam(params, "limit", 30, 100);
    const data = await api("github", `${base}/pulls?per_page=${limit}`, options, run);
    return {
      pull_requests: compactList(data, [
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
      ]),
    };
  }
  if (actionId === "get_issue") {
    const number = intParam(params, "issue_number", 0, Number.MAX_SAFE_INTEGER);
    return pick(await api("github", `${base}/issues/${number}`, options, run), [
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
    ]);
  }
  if (actionId === "get_pull_request") {
    const number = intParam(params, "pull_number", 0, Number.MAX_SAFE_INTEGER);
    return pick(await api("github", `${base}/pulls/${number}`, options, run), [
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
    ]);
  }
  if (actionId === "create_issue") {
    const title = stringParam(params, "title", { required: true, maxLength: 256 })!;
    const body = stringParam(params, "body", { maxLength: 20_000 });
    const data = await api(
      "github",
      `${base}/issues`,
      { ...options, method: "POST", input: { title, ...(body ? { body } : {}) } },
      run,
    );
    return pick(data, ["number", "title", "state", "html_url", "created_at"]);
  }
  throw new Error(`Unknown GitHub CLI Link Action: ${actionId}`);
}

async function executeGitlabCliAction(
  actionId: string,
  params: Record<string, unknown>,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<unknown> {
  const limit = intParam(params, "limit", 30, 100);
  if (actionId === "list_projects") {
    const data = await api(
      "gitlab",
      `projects?membership=true&simple=true&per_page=${limit}`,
      options,
      run,
    );
    return {
      projects: compactList(data, [
        "id",
        "name",
        "path_with_namespace",
        "description",
        "visibility",
        "default_branch",
        "web_url",
        "last_activity_at",
      ]),
    };
  }
  if (actionId === "list_issues") {
    const data = await api("gitlab", `issues?scope=assigned_to_me&per_page=${limit}`, options, run);
    return {
      issues: compactList(data, [
        "id",
        "iid",
        "project_id",
        "title",
        "state",
        "web_url",
        "created_at",
        "updated_at",
        "labels",
      ]),
    };
  }
  throw new Error(`Unknown GitLab CLI Link Action: ${actionId}`);
}

async function runJsonCommand(
  providerId: CliLinkProviderId,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<unknown> {
  try {
    return parseJson(
      await run(providerId, CONFIG[providerId].command, args, {
        ...options,
        timeoutMs: 30_000,
      }),
      providerId,
    );
  } catch (error) {
    const message = safeMessage(error);
    throw new Error(message || `${providerId} CLI request failed`, { cause: error });
  }
}

async function executeNotionCliAction(
  actionId: string,
  params: Record<string, unknown>,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<unknown> {
  if (actionId === "search") {
    const query = stringParam(params, "query", { maxLength: 200 });
    const data =
      asRecord(
        await api(
          "notion",
          "v1/search",
          {
            ...options,
            method: "POST",
            input: {
              page_size: intParam(params, "limit", 30, 100),
              ...(query ? { query } : {}),
            },
          },
          run,
        ),
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
  }
  if (actionId === "get_page") {
    const pageId = stringParam(params, "page_id", { required: true, maxLength: 100 })!;
    return pick(await api("notion", `v1/pages/${encodeURIComponent(pageId)}`, options, run), [
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
  throw new Error(`Unknown Notion CLI Link Action: ${actionId}`);
}

function todoistProject(value: unknown): Record<string, unknown> {
  const project = asRecord(value) ?? {};
  return {
    ...pick(project, ["id", "name", "description", "color", "url"]),
    ...(typeof project.isFavorite === "boolean" ? { is_favorite: project.isFavorite } : {}),
    ...(typeof project.parentId === "string" ? { parent_id: project.parentId } : {}),
    ...(typeof project.workspaceId === "string" ? { workspace_id: project.workspaceId } : {}),
  };
}

function todoistTask(value: unknown): Record<string, unknown> {
  const task = asRecord(value) ?? {};
  return {
    ...pick(task, ["id", "content", "description", "priority", "due", "labels", "url"]),
    ...(typeof task.projectId === "string" ? { project_id: task.projectId } : {}),
    ...(typeof task.sectionId === "string" ? { section_id: task.sectionId } : {}),
    ...(typeof task.parentId === "string" ? { parent_id: task.parentId } : {}),
  };
}

async function executeTodoistCliAction(
  actionId: string,
  params: Record<string, unknown>,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<unknown> {
  const limit = intParam(params, "limit", actionId === "list_tasks" ? 50 : 30, 100);
  if (actionId === "list_projects") {
    const root =
      asRecord(
        await runJsonCommand(
          "todoist",
          ["project", "list", "--json", "--limit", String(limit)],
          options,
          run,
        ),
      ) ?? {};
    return { projects: asArray(root.results).slice(0, 100).map(todoistProject) };
  }
  if (actionId === "list_tasks") {
    const root =
      asRecord(
        await runJsonCommand(
          "todoist",
          ["task", "list", "--json", "--limit", String(limit)],
          options,
          run,
        ),
      ) ?? {};
    return {
      tasks: asArray(root.results).slice(0, 100).map(todoistTask),
      next_cursor: root.nextCursor,
    };
  }
  throw new Error(`Unknown Todoist CLI Link Action: ${actionId}`);
}

async function executeVercelCliAction(
  actionId: string,
  params: Record<string, unknown>,
  options: { cwd?: string; signal?: AbortSignal },
  run: CliLinkCommandRunner,
): Promise<unknown> {
  const limit = intParam(params, "limit", 50, 100);
  const teamId = stringParam(params, "team_id", { maxLength: 100 });
  const query = new URLSearchParams({ limit: String(limit) });
  if (teamId) query.set("teamId", teamId);
  if (actionId === "list_projects") {
    const root = asRecord(await api("vercel", `/v10/projects?${query}`, options, run)) ?? {};
    return {
      projects: compactList(
        root.projects,
        ["id", "name", "framework", "updatedAt", "createdAt", "latestDeployments"],
        100,
      ),
      pagination: root.pagination,
    };
  }
  if (actionId === "list_deployments") {
    const root = asRecord(await api("vercel", `/v7/deployments?${query}`, options, run)) ?? {};
    return {
      deployments: compactList(
        root.deployments,
        ["uid", "name", "url", "state", "target", "created", "ready", "meta"],
        100,
      ),
      pagination: root.pagination,
    };
  }
  throw new Error(`Unknown Vercel CLI Link Action: ${actionId}`);
}

export async function executeCliLinkAction(
  providerId: CliLinkProviderId,
  actionId: string,
  params: Record<string, unknown>,
  options: { cwd?: string; signal?: AbortSignal } = {},
  run: CliLinkCommandRunner = runCliLinkCommand,
): Promise<unknown> {
  if (providerId === "github") return executeGithubCliAction(actionId, params, options, run);
  if (providerId === "gitlab") return executeGitlabCliAction(actionId, params, options, run);
  if (providerId === "notion") return executeNotionCliAction(actionId, params, options, run);
  if (providerId === "todoist") return executeTodoistCliAction(actionId, params, options, run);
  return executeVercelCliAction(actionId, params, options, run);
}
