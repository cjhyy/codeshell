import { afterEach, describe, expect, test } from "bun:test";
import {
  assertCliLinkAccount,
  connectCliLink,
  executeCliLinkAction,
  getCliLinkStatus,
  runCliLinkCommand,
  type CliLinkCommandRunner,
} from "./cli.js";

afterEach(() => {
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe("CLI Link sessions", () => {
  test("reports the authenticated CLI account without reading a token", async () => {
    const calls: string[][] = [];
    const run: CliLinkCommandRunner = async (_provider, command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "auth") return { stdout: "signed in", stderr: "" };
      return { stdout: JSON.stringify({ id: 42, login: "octocat" }), stderr: "" };
    };

    expect(await getCliLinkStatus("github", {}, run)).toEqual({
      providerId: "github",
      command: "gh",
      installed: true,
      authenticated: true,
      account: "octocat",
    });
    expect(calls.some((call) => call.includes("token"))).toBe(false);
  });

  test("uses GitLab browser login and returns only safe validation metadata", async () => {
    let authenticated = false;
    const calls: string[][] = [];
    const run: CliLinkCommandRunner = async (_provider, command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "auth" && args[1] === "status") {
        if (!authenticated) throw Object.assign(new Error("signed out"), { stderr: "signed out" });
        return { stdout: "signed in", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "login") {
        authenticated = true;
        return { stdout: "", stderr: "" };
      }
      if (args[1] === "user") {
        return {
          stdout: JSON.stringify({ id: 7, username: "alice", name: "Alice" }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([{ id: 1, path_with_namespace: "acme/widget" }]),
        stderr: "",
      };
    };

    const validation = await connectCliLink("gitlab", { loginIfNeeded: true }, run);
    expect(validation.identity).toMatchObject({
      externalAccountId: "7",
      label: "alice",
      resourceLabels: ["acme/widget"],
    });
    expect(validation.capabilityIds).toEqual(["gitlab.list_projects", "gitlab.list_issues"]);
    expect(calls.some((call) => call.includes("--web") && call.includes("--use-keyring"))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes("token"))).toBe(false);
  });

  test("runs GitHub writes with fixed argv and a JSON stdin body", async () => {
    let captured:
      | { command: string; args: string[]; input?: string; signal?: AbortSignal }
      | undefined;
    const signal = new AbortController().signal;
    const run: CliLinkCommandRunner = async (_provider, command, args, options) => {
      captured = { command, args, input: options.input, signal: options.signal };
      return {
        stdout: JSON.stringify({
          number: 9,
          title: "Shell-safe title",
          state: "open",
          html_url: "https://github.com/acme/repo/issues/9",
        }),
        stderr: "",
      };
    };

    const result = await executeCliLinkAction(
      "github",
      "create_issue",
      { owner: "acme", repo: "repo", title: "$(touch /tmp/nope)", body: "`whoami`" },
      { signal },
      run,
    );
    expect(result).toMatchObject({ number: 9, state: "open" });
    expect(captured?.command).toBe("gh");
    expect(captured?.args).toEqual([
      "api",
      "repos/acme/repo/issues",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    expect(JSON.parse(captured?.input ?? "{}")).toEqual({
      title: "$(touch /tmp/nope)",
      body: "`whoami`",
    });
    expect(captured?.signal).toBe(signal);
  });

  test("normalizes GitLab project results", async () => {
    const run: CliLinkCommandRunner = async () => ({
      stdout: JSON.stringify([
        {
          id: 1,
          name: "Widget",
          path_with_namespace: "acme/widget",
          visibility: "private",
          secret_field: "must not escape",
        },
      ]),
      stderr: "",
    });
    const result = await executeCliLinkAction("gitlab", "list_projects", { limit: 5 }, {}, run);
    expect(result).toEqual({
      projects: [
        {
          id: 1,
          name: "Widget",
          path_with_namespace: "acme/widget",
          visibility: "private",
        },
      ],
    });
  });

  test("uses Notion keychain auth and sends search JSON over stdin", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: CliLinkCommandRunner = async (_provider, _command, args, options) => {
      calls.push({ args, input: options.input });
      if (args[0] === "--version") return { stdout: "1.0.0", stderr: "" };
      if (args[1] === "v1/users/me") {
        return { stdout: JSON.stringify({ id: "user-1", name: "Workspace member" }), stderr: "" };
      }
      return {
        stdout: JSON.stringify({
          results: [{ object: "page", id: "page-1", url: "https://notion.so/page-1" }],
          has_more: false,
        }),
        stderr: "",
      };
    };
    expect(await getCliLinkStatus("notion", {}, run)).toMatchObject({
      command: "ntn",
      authenticated: true,
      account: "Workspace member",
    });
    const result = await executeCliLinkAction(
      "notion",
      "search",
      { query: "roadmap", limit: 8 },
      {},
      run,
    );
    expect(result).toMatchObject({ results: [{ id: "page-1" }], has_more: false });
    expect(calls.at(-1)).toEqual({
      args: ["api", "v1/search", "-X", "POST"],
      input: JSON.stringify({ page_size: 8, query: "roadmap" }),
    });
  });

  test("connects Todoist with read-only OAuth and keeps machine output normalized", async () => {
    let authenticated = false;
    const calls: string[][] = [];
    const run: CliLinkCommandRunner = async (_provider, _command, args) => {
      calls.push(args);
      if (args[0] === "auth" && args[1] === "status") {
        if (!authenticated) throw Object.assign(new Error("signed out"), { stderr: "signed out" });
        return { stdout: JSON.stringify({ id: "u1", email: "alice@example.com" }), stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "login") {
        authenticated = true;
        return { stdout: JSON.stringify({ id: "u1", email: "alice@example.com" }), stderr: "" };
      }
      return {
        stdout: JSON.stringify({ results: [{ id: "p1", name: "Inbox" }], nextCursor: null }),
        stderr: "",
      };
    };
    const validation = await connectCliLink("todoist", { loginIfNeeded: true }, run);
    expect(validation.identity).toMatchObject({
      externalAccountId: "u1",
      label: "alice@example.com",
      resourceLabels: ["Inbox"],
    });
    expect(
      calls.some(
        (args) => args[0] === "auth" && args.includes("--read-only") && args.includes("--json"),
      ),
    ).toBe(true);
  });

  test("runs Vercel Actions through the official api command", async () => {
    let captured: string[] = [];
    const run: CliLinkCommandRunner = async (_provider, command, args) => {
      expect(command).toBe("vercel");
      captured = args;
      return {
        stdout: JSON.stringify({ projects: [{ id: "p1", name: "site", framework: "nextjs" }] }),
        stderr: "",
      };
    };
    const result = await executeCliLinkAction(
      "vercel",
      "list_projects",
      { limit: 4, team_id: "team_123" },
      {},
      run,
    );
    expect(result).toEqual({
      projects: [{ id: "p1", name: "site", framework: "nextjs" }],
      pagination: undefined,
    });
    expect(captured).toEqual(["api", "/v10/projects?limit=4&teamId=team_123", "--no-color"]);
  });

  test("ignores environment tokens that would override the stored CLI session", async () => {
    process.env.GH_TOKEN = "gho_should_not_be_used";
    process.env.GITHUB_TOKEN = "github_pat_should_not_be_used";
    const result = await runCliLinkCommand(
      "github",
      process.execPath,
      [
        "-e",
        "process.stdout.write(String(Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)))",
      ],
      { timeoutMs: 5_000 },
    );
    expect(result.stdout).toBe("false");
  });

  test("rejects an Action when the CLI switched to another account", async () => {
    const run: CliLinkCommandRunner = async () => ({
      stdout: JSON.stringify({ id: 99, login: "another-user" }),
      stderr: "",
    });
    await expect(assertCliLinkAccount("github", "42", {}, run)).rejects.toThrow(
      "different account",
    );
    await expect(assertCliLinkAccount("github", "99", {}, run)).resolves.toBeUndefined();
  });
});
