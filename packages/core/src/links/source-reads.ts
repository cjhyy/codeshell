import { asRecord, intParam, pathSegmentParam, pick, stringParam } from "./http.js";

export const GITHUB_SOURCE_ACTIONS = [
  "list_pull_request_files",
  "list_pull_request_commits",
  "get_commit",
] as const;

function assertKeys(params: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(params).some((key) => !keys.includes(key)))
    throw new Error("Unknown source read parameter");
}

/** One explicit page per call; no implicit crawling or caller-provided API endpoints. */
export function githubSourceParams(action: string, params: Record<string, unknown>) {
  if (!(GITHUB_SOURCE_ACTIONS as readonly string[]).includes(action))
    throw new Error("Unknown GitHub source read");
  assertKeys(params, [
    "owner",
    "repo",
    action === "get_commit" ? "sha" : "pull_number",
    "page",
    "limit",
  ]);
  const owner = pathSegmentParam(params, "owner", { required: true, maxLength: 100 })!;
  const repo = pathSegmentParam(params, "repo", { required: true, maxLength: 100 })!;
  const page = intParam(params, "page", 1, 100);
  const limit = intParam(params, "limit", 30, 100);
  if (action === "get_commit") {
    const sha = stringParam(params, "sha", { required: true, maxLength: 40 })!;
    if (!/^[a-f\d]{40}$/i.test(sha))
      throw new Error("GitHub sha must be a full 40-character commit SHA");
    return { owner, repo, page, limit, sha: sha.toLowerCase() };
  }
  return {
    owner,
    repo,
    page,
    limit,
    pull_number: intParam(params, "pull_number", 0, Number.MAX_SAFE_INTEGER),
  };
}

export function githubSourceEndpoint(action: string, params: Record<string, unknown>): string {
  const p = githubSourceParams(action, params);
  const base = `repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  const suffix =
    action === "get_commit"
      ? `commits/${p.sha}`
      : `pulls/${p.pull_number}/${action === "list_pull_request_files" ? "files" : "commits"}`;
  return `${base}/${suffix}?per_page=${p.limit}&page=${p.page}`;
}

function commitIdentity(raw: unknown) {
  const item = asRecord(raw);
  const sha = item?.sha;
  if (typeof sha !== "string" || !/^[a-f\d]{40}$/i.test(sha))
    throw new Error("Invalid GitHub commit identity");
  const commit = asRecord(item?.commit);
  if (!commit || !asRecord(commit.author)) throw new Error("Missing Git commit author");
  return {
    sha: sha.toLowerCase(),
    html_url: item?.html_url,
    author: item?.author === null ? null : pick(item?.author, ["id", "login", "html_url"]),
    committer: item?.committer === null ? null : pick(item?.committer, ["id", "login", "html_url"]),
    commit: {
      author: pick(commit.author, ["name", "email", "date"]),
      committer: pick(commit.committer, ["name", "email", "date"]),
      message: typeof commit.message === "string" ? commit.message.slice(0, 16_384) : "",
      message_truncated: typeof commit.message === "string" && commit.message.length > 16_384,
      verification: pick(commit.verification, ["verified", "reason"]),
    },
    parents: Array.isArray(item?.parents)
      ? item.parents.slice(0, 20).map((parent) => pick(parent, ["sha", "html_url"]))
      : [],
  };
}

export function normalizeGithubSourceResult(
  action: string,
  params: Record<string, unknown>,
  raw: unknown,
) {
  const p = githubSourceParams(action, params);
  const isCommit = action === "get_commit";
  const record = asRecord(raw);
  const values = isCommit ? record?.files : raw;
  if (!Array.isArray(values)) throw new Error("Invalid GitHub source page");
  let remainingPatch = 131_072;
  const items = values.slice(0, p.limit).map((item) => {
    if (action === "list_pull_request_commits") return commitIdentity(item);
    const file = asRecord(item);
    if (typeof file?.filename !== "string") throw new Error("Invalid GitHub source file");
    const patch = typeof file.patch === "string" ? file.patch : undefined;
    const kept = patch?.slice(0, Math.min(16_384, remainingPatch));
    remainingPatch -= kept?.length ?? 0;
    return {
      ...pick(file, [
        "sha",
        "filename",
        "previous_filename",
        "status",
        "additions",
        "deletions",
        "changes",
        "blob_url",
      ]),
      ...(kept === undefined ? {} : { patch: kept }),
      patch_available: patch !== undefined,
      patch_truncated: patch !== undefined && kept!.length < patch.length,
    };
  });
  const sourceUrl = `https://github.com/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/${isCommit ? `commit/${p.sha}` : `pull/${p.pull_number}`}`;
  const hasMore = values.length >= p.limit;
  const upstreamLimit = action === "list_pull_request_commits" ? 250 : 3_000;
  const reachedUpstreamLimit = (p.page - 1) * p.limit + values.length >= upstreamLimit;
  const identity = isCommit ? commitIdentity(raw) : undefined;
  if (isCommit && identity?.sha !== p.sha) throw new Error("GitHub returned a different commit");
  return {
    ...identity,
    owner: p.owner,
    repo: p.repo,
    ...(isCommit
      ? { stats: pick(record?.stats, ["additions", "deletions", "total"]) }
      : { pull_number: p.pull_number }),
    [action === "list_pull_request_commits" ? "commits" : "files"]: items,
    page: p.page,
    limit: p.limit,
    upstream_limit: upstreamLimit,
    // The REST body has no Link header. A full page is conservatively incomplete.
    has_more: hasMore,
    next_page: hasMore && p.page < 100 ? p.page + 1 : null,
    truncated:
      hasMore ||
      reachedUpstreamLimit ||
      p.page > 1 ||
      items.some((item) => "patch_truncated" in item && item.patch_truncated),
    provenance: {
      provider: "github",
      action,
      source_url: sourceUrl,
      fetched_at: new Date().toISOString(),
      page: p.page,
    },
  };
}

function slackTs(value: unknown): string {
  if (typeof value !== "string" || !/^\d{10,16}\.\d{6}$/.test(value))
    throw new Error("Invalid Slack message timestamp");
  return value;
}

export function parseSlackPermalink(value: unknown) {
  if (typeof value !== "string" || value.length > 2_000 || /[\s\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid Slack permalink");
  const url = new URL(value);
  const match = url.pathname.match(/^\/archives\/([CGD][A-Z0-9]{1,99})\/p(\d{10,16})(\d{6})\/?$/);
  if (
    url.protocol !== "https:" ||
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\.slack\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !match
  )
    throw new Error("Invalid Slack permalink");
  const ts = slackTs(`${match[2]}.${match[3]}`);
  const thread = url.searchParams.get("thread_ts");
  return {
    channel: match[1]!,
    ts,
    thread_ts: thread ? slackTs(thread) : undefined,
    origin: url.origin,
    permalink: `${url.origin}${url.pathname.replace(/\/$/, "")}`,
  };
}

export function slackSourceParams(action: string, params: Record<string, unknown>) {
  if (action === "get_message") {
    assertKeys(params, ["permalink"]);
    const link = parseSlackPermalink(params.permalink);
    return { ...link, limit: 1, cursor: undefined };
  }
  if (action !== "get_thread") throw new Error("Unknown Slack source read");
  assertKeys(params, ["channel", "ts", "permalink", "cursor", "limit"]);
  const channel = stringParam(params, "channel", { required: true, maxLength: 100 })!;
  if (!/^[CGD][A-Z0-9]{1,99}$/.test(channel)) throw new Error("Invalid Slack channel");
  const ts = slackTs(params.ts);
  const link = params.permalink === undefined ? undefined : parseSlackPermalink(params.permalink);
  if (link && (link.channel !== channel || (link.thread_ts ?? link.ts) !== ts))
    throw new Error("Slack permalink does not match requested thread");
  const cursor = stringParam(params, "cursor", { maxLength: 1_024 });
  if (cursor && /[\x00-\x20\x7f]/.test(cursor)) throw new Error("Invalid Slack cursor");
  return {
    channel,
    ts,
    thread_ts: ts,
    origin: link?.origin,
    permalink: link?.permalink,
    limit: intParam(params, "limit", 15, 15),
    cursor,
  };
}

/** Raw remote envelope includes a chat.getPermalink result for this exact message/thread. */
export function normalizeSlackSourceResult(
  action: string,
  params: Record<string, unknown>,
  raw: unknown,
) {
  const p = slackSourceParams(action, params);
  const record = asRecord(raw);
  if (!record || (record.ok !== undefined && record.ok !== true) || !Array.isArray(record.messages))
    throw new Error("Invalid Slack source result");
  if (action === "get_thread" && typeof record.has_more !== "boolean")
    throw new Error("Slack thread result is missing pagination state");
  const link = parseSlackPermalink(record.permalink);
  if (link.channel !== p.channel || link.ts !== p.ts || (p.origin && link.origin !== p.origin))
    throw new Error("Slack returned a different permalink");
  const values = record.messages;
  const selected =
    action === "get_message" ? values.filter((item) => asRecord(item)?.ts === p.ts) : values;
  if (action === "get_message" && selected.length !== 1)
    throw new Error("Exact Slack message was not found");
  const messages = selected.slice(0, p.limit).map((item) => {
    const message = asRecord(item)!;
    const ts = slackTs(message?.ts);
    const parent = message.thread_ts === undefined ? undefined : slackTs(message.thread_ts);
    if (
      action === "get_thread" &&
      (ts === p.ts ? parent !== undefined && parent !== p.ts : parent !== p.ts)
    )
      throw new Error("Slack returned a message outside requested thread");
    if (action === "get_message" && p.thread_ts && p.thread_ts !== p.ts && parent !== p.thread_ts)
      throw new Error("Slack returned a message outside requested thread");
    const text = typeof message.text === "string" ? message.text : "";
    return {
      ...pick(message, [
        "type",
        "subtype",
        "user",
        "bot_id",
        "ts",
        "thread_ts",
        "reply_count",
        "edited",
      ]),
      text: text.slice(0, 16_384),
      text_truncated: text.length > 16_384,
      permalink: `${link.origin}/archives/${p.channel}/p${ts.replace(".", "")}${parent && parent !== ts ? `?thread_ts=${parent}&cid=${p.channel}` : ""}`,
    };
  });
  const sourceUrl = action === "get_message" ? messages[0]!.permalink : link.permalink;
  const next = asRecord(record.response_metadata)?.next_cursor ?? record.next_cursor;
  if (
    next !== undefined &&
    (typeof next !== "string" || next.length > 1_024 || /[\x00-\x20\x7f]/.test(next))
  )
    throw new Error("Invalid Slack next cursor");
  const hasMore =
    action === "get_thread" && (record.has_more === true || !!next || values.length > p.limit);
  return {
    channel: p.channel,
    ts: p.ts,
    messages,
    permalink: sourceUrl,
    has_more: hasMore,
    next_cursor: hasMore && next ? next : null,
    truncated: hasMore || !!p.cursor || messages.some((message) => message.text_truncated),
    provenance: {
      provider: "slack",
      action,
      source_url: sourceUrl,
      channel: p.channel,
      ts: p.ts,
      fetched_at: new Date().toISOString(),
    },
  };
}
