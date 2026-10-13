import { expect, test } from "bun:test";
import { asGlobalFetch } from "../testing/fetch-stub.js";
import { executeCliLinkAction } from "./cli.js";
import { getLocalLinkProvider } from "./providers.js";
import { normalizeRemoteLinkActionResult, prepareRemoteLinkAction } from "./remote-adapters.js";
import {
  githubSourceParams,
  normalizeGithubSourceResult,
  parseSlackPermalink,
  slackSourceParams,
} from "./source-reads.js";

const sha = "a".repeat(40);
const ts = "1760000000.000001";
const permalink = "https://fixture.slack.com/archives/C12345/p1760000000000001";
const group = (provider: "github" | "slack") => [
  {
    id: provider === "github" ? "repositories" : "channels",
    items: [{ id: provider === "github" ? "owner/repo" : "C12345", label: "Fixture" }],
  },
];
const file = {
  filename: "src/example.ts",
  status: "modified",
  patch: "@@ -1 +1 @@\n-old\n+new",
  additions: 1,
  deletions: 1,
};
const commit = {
  sha,
  author: { id: 42, login: "fixture" },
  committer: null,
  commit: {
    author: { name: "Fixture", email: "fixture@example.test", date: "2026-10-12T00:00:00Z" },
    committer: { name: "Merge Bot", date: "2026-10-12T00:00:00Z" },
    message: "Explain a decision",
    verification: { verified: true, reason: "valid" },
  },
  parents: [{ sha: "b".repeat(40) }],
  files: [file],
  stats: { total: 2, additions: 1, deletions: 1 },
};

function stable(value: any) {
  const cloned = structuredClone(value);
  delete cloned.provenance.fetched_at;
  return cloned;
}

test("all GitHub contribution actions preserve identical direct, CLI and remote evidence", async () => {
  for (const action of ["list_pull_request_files", "list_pull_request_commits", "get_commit"]) {
    const params = {
      owner: "owner",
      repo: "repo",
      ...(action === "get_commit" ? { sha } : { pull_number: 8 }),
      limit: 1,
      page: 1,
    };
    const raw =
      action === "get_commit" ? commit : action === "list_pull_request_files" ? [file] : [commit];
    let requested = "";
    const direct = await getLocalLinkProvider("github")!
      .actions.find((item) => item.id === action)!
      .execute({
        token: "synthetic",
        params,
        fetchImpl: asGlobalFetch(async (input, init) => {
          const url = new URL(String(input));
          expect(url.origin).toBe("https://api.github.com");
          expect(init?.redirect).toBe("error");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic");
          requested = url.pathname + url.search;
          return new Response(JSON.stringify(raw));
        }),
      });
    const cli = await executeCliLinkAction(
      "github",
      action,
      params,
      {},
      async (_provider, command, args) => {
        expect(command).toBe("gh");
        expect(args).toContain(requested.slice(1));
        return { stdout: JSON.stringify(raw), stderr: "" };
      },
    );
    expect(prepareRemoteLinkAction("github", action, params, group("github"))).toEqual(params);
    const remote = normalizeRemoteLinkActionResult("github", action, raw, params, group("github"));
    expect(stable(direct)).toEqual(stable(remote));
    expect(stable(cli)).toEqual(stable(remote));
    expect(direct).toMatchObject({
      has_more: true,
      next_page: 2,
      truncated: true,
      provenance: { action, provider: "github" },
    });
    if (action === "get_commit")
      expect(direct).toMatchObject({
        sha,
        author: { login: "fixture" },
        commit: { author: { email: "fixture@example.test" } },
        files: [file],
      });
  }
});

test("GitHub exact commit rejects mutable refs, path traversal and mismatched returned SHA", async () => {
  const params = { owner: "owner", repo: "repo", sha };
  for (const invalid of ["main", "a".repeat(7), "../HEAD", "a".repeat(40) + "/files"])
    expect(() => githubSourceParams("get_commit", { ...params, sha: invalid })).toThrow();
  expect(() => githubSourceParams("get_commit", { ...params, owner: ".." })).toThrow();
  expect(() =>
    githubSourceParams("get_commit", { ...params, endpoint: "https://evil.test" }),
  ).toThrow();
  expect(() =>
    normalizeGithubSourceResult("get_commit", params, { ...commit, sha: "b".repeat(40) }),
  ).toThrow("different commit");
  expect(() =>
    prepareRemoteLinkAction("github", "get_commit", { ...params, owner: "other" }, group("github")),
  ).toThrow("outside this grant");
});

test("patches explicitly distinguish missing binary diffs and bounded truncation", () => {
  const output = normalizeGithubSourceResult(
    "list_pull_request_files",
    { owner: "owner", repo: "repo", pull_number: 8, limit: 100 },
    [
      { filename: "image.png" },
      ...Array.from({ length: 10 }, (_, i) => ({
        filename: `large-${i}.ts`,
        patch: "x".repeat(20_000),
      })),
    ],
  );
  expect(output).toMatchObject({ truncated: true, has_more: false });
  const files = (output as any).files;
  expect(files[0]).toMatchObject({ patch_available: false, patch_truncated: false });
  expect(files[1]).toMatchObject({ patch_available: true, patch_truncated: true });
  expect(files.reduce((sum, item) => sum + (item.patch?.length ?? 0), 0)).toBe(131_072);
});

test("Slack exact permalink uses fixed API and exact timestamp; source identity survives remote", async () => {
  const calls: Array<{ endpoint: string; body: any }> = [];
  const raw = {
    ok: true,
    messages: [{ user: "U12345", ts, text: "We chose the simpler migration", reply_count: 2 }],
    permalink,
  };
  const output = await getLocalLinkProvider("slack")!
    .actions.find((item) => item.id === "get_message")!
    .execute({
      token: "synthetic",
      params: { permalink },
      fetchImpl: asGlobalFetch(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://slack.com");
        const body = JSON.parse(String(init?.body));
        calls.push({ endpoint: url.pathname, body });
        return new Response(
          JSON.stringify(
            url.pathname.endsWith("chat.getPermalink") ? { ok: true, permalink } : raw,
          ),
        );
      }),
    });
  expect(calls).toEqual([
    {
      endpoint: "/api/conversations.history",
      body: { channel: "C12345", limit: "1", oldest: ts, latest: ts, inclusive: "true" },
    },
    { endpoint: "/api/chat.getPermalink", body: { channel: "C12345", message_ts: ts } },
  ]);
  expect(output).toMatchObject({
    messages: [{ user: "U12345", ts, text: "We chose the simpler migration", permalink }],
    provenance: { source_url: permalink, channel: "C12345", ts },
  });
  expect(stable(output)).toEqual(
    stable(
      normalizeRemoteLinkActionResult("slack", "get_message", raw, { permalink }, group("slack")),
    ),
  );
});

test("Slack thread is one bounded cursor page and preserves authors and parent linkage", async () => {
  const params = { channel: "C12345", ts, cursor: "page-two", limit: 50, permalink };
  const raw = {
    ok: true,
    messages: [
      {
        user: "UOTHER",
        ts: "1760000000.000002",
        thread_ts: ts,
        text: "Because the failure mode is easier to recover",
      },
    ],
    response_metadata: { next_cursor: "page-three" },
    has_more: true,
    permalink,
  };
  let reads = 0;
  const output = await getLocalLinkProvider("slack")!
    .actions.find((item) => item.id === "get_thread")!
    .execute({
      token: "synthetic",
      params,
      fetchImpl: asGlobalFetch(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://slack.com");
        if (url.pathname.endsWith("conversations.replies")) {
          reads++;
          expect(JSON.parse(String(init?.body))).toEqual({
            channel: "C12345",
            ts,
            cursor: "page-two",
            limit: "15",
          });
        }
        return new Response(
          JSON.stringify(
            url.pathname.endsWith("chat.getPermalink") ? { ok: true, permalink } : raw,
          ),
        );
      }),
    });
  expect(reads).toBe(1);
  expect(output).toMatchObject({
    has_more: true,
    next_cursor: "page-three",
    truncated: true,
    messages: [
      {
        user: "UOTHER",
        thread_ts: ts,
        permalink: `https://fixture.slack.com/archives/C12345/p1760000000000002?thread_ts=${ts}&cid=C12345`,
      },
    ],
  });
  expect(stable(output)).toEqual(
    stable(normalizeRemoteLinkActionResult("slack", "get_thread", raw, params, group("slack"))),
  );
});

test("reply permalinks select exact reply within supplied parent thread", async () => {
  const reply = "https://fixture.slack.com/archives/C12345/p1760000000000002";
  const output = await getLocalLinkProvider("slack")!
    .actions.find((item) => item.id === "get_message")!
    .execute({
      token: "synthetic",
      params: { permalink: `${reply}?thread_ts=${ts}&cid=C12345` },
      fetchImpl: asGlobalFetch(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://slack.com");
        if (url.pathname.endsWith("chat.getPermalink"))
          return new Response(JSON.stringify({ ok: true, permalink: reply }));
        expect(url.pathname).toBe("/api/conversations.replies");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          ts,
          oldest: "1760000000.000002",
          latest: "1760000000.000002",
        });
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { ts, user: "U1", text: "Parent" },
              { ts: "1760000000.000002", thread_ts: ts, user: "U2", text: "Reply" },
            ],
          }),
        );
      }),
    });
  expect(output).toMatchObject({ messages: [{ user: "U2", text: "Reply" }] });
  expect(parseSlackPermalink((output as any).permalink)).toMatchObject({
    channel: "C12345",
    ts: "1760000000.000002",
    thread_ts: ts,
  });
});

test("Slack provider permission/rate errors stop the read without pretending the thread is complete", async () => {
  for (const error of [
    "missing_scope",
    "not_allowed_token_type",
    "ratelimited",
    "thread_not_found",
  ]) {
    let requests = 0;
    await expect(
      getLocalLinkProvider("slack")!
        .actions.find((item) => item.id === "get_thread")!
        .execute({
          token: "synthetic",
          params: { channel: "C12345", ts },
          fetchImpl: asGlobalFetch(async (input) => {
            expect(String(input)).toBe("https://slack.com/api/conversations.replies");
            requests++;
            return new Response(JSON.stringify({ ok: false, error }));
          }),
        }),
    ).rejects.toThrow(error);
    expect(requests).toBe(1);
  }
});

test("Slack message truncation and later empty GitHub pages remain explicitly incomplete", () => {
  const slack = normalizeRemoteLinkActionResult(
    "slack",
    "get_message",
    {
      messages: [{ ts, user: "U1", text: "x".repeat(20_000) }],
      permalink,
    },
    { permalink },
    group("slack"),
  ) as any;
  expect(slack.messages[0].text).toHaveLength(16_384);
  expect(slack).toMatchObject({ truncated: true, messages: [{ text_truncated: true }] });
  const github = normalizeGithubSourceResult(
    "list_pull_request_files",
    { owner: "owner", repo: "repo", pull_number: 8, page: 2 },
    [],
  );
  expect(github).toMatchObject({ files: [], truncated: true, has_more: false, next_page: null });
});

test("Slack rejects spoofed URLs, wrong channel/thread/time/account and malformed cursors", () => {
  for (const invalid of [
    permalink.replace("fixture.slack.com", "fixture.slack.com.evil.test"),
    permalink.replace("https:", "http:"),
    permalink.replace("fixture.slack.com", "user:pass@fixture.slack.com"),
    permalink.replace("fixture.slack.com", "fixture.slack.com:8443"),
  ])
    expect(() => parseSlackPermalink(invalid)).toThrow();
  expect(() => slackSourceParams("get_thread", { channel: "COTHER", ts, permalink })).toThrow(
    "does not match",
  );
  expect(() =>
    slackSourceParams("get_thread", { channel: "C12345", ts, cursor: "bad\ncursor" }),
  ).toThrow();
  expect(() =>
    prepareRemoteLinkAction(
      "slack",
      "get_message",
      { permalink: permalink.replace("C12345", "COTHER") },
      group("slack"),
    ),
  ).toThrow("outside this grant");
  for (const raw of [
    { messages: [{ ts: "1760000000.000002", text: "Neighbor" }], permalink },
    { messages: [{ ts }], permalink: permalink.replace("fixture", "another") },
    { messages: [{ ts }], permalink: permalink.replace("C12345", "COTHER") },
  ])
    expect(() =>
      normalizeRemoteLinkActionResult("slack", "get_message", raw, { permalink }, group("slack")),
    ).toThrow();
  expect(() =>
    normalizeRemoteLinkActionResult(
      "slack",
      "get_thread",
      {
        messages: [{ ts: "1760000000.000002", thread_ts: "1760000000.000003" }],
        has_more: false,
        permalink,
      },
      { channel: "C12345", ts },
      group("slack"),
    ),
  ).toThrow("outside requested thread");
});
