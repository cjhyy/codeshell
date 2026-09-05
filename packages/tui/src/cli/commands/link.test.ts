import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { LinkStatusResult } from "@cjhyy/code-shell-core";
import { createLinkCommand, formatLinkStatus, isLinkStatusCommand } from "./link.js";

function githubStatus(): LinkStatusResult {
  return {
    kind: "link_status",
    checkedAt: "2026-09-06T00:00:00.000Z",
    credentialStore: { state: "checked" },
    providers: [
      {
        id: "github",
        name: "GitHub",
        connections: [
          {
            id: "github-old",
            backend: "cli",
            runtime: "local",
            account: "previous-account",
            verifiedAt: "2026-09-01T00:00:00.000Z",
            state: "unavailable",
            reason: "The saved credential cannot be read in this process.",
          },
        ],
        cli: {
          state: "checked",
          providerId: "github",
          command: "gh",
          installed: true,
          authenticated: true,
          account: "current-account",
        },
      },
    ],
    guidance: "Saved Link availability and local CLI authentication are separate checks.",
  };
}

describe("link status command", () => {
  test("returns full structured diagnostics for a provider without model setup", async () => {
    const result = githubStatus();
    const queries: unknown[] = [];
    let output = "";
    const command = createLinkCommand({
      cwd: () => "/work/project",
      getStatus: async (options) => {
        queries.push(options);
        return result;
      },
      write: (text) => {
        output += text;
      },
    });

    await command.parseAsync(["status", "github", "--json"], { from: "user" });

    expect(queries).toEqual([{ provider: "github", cwd: "/work/project", settingsScope: "full" }]);
    expect(JSON.parse(output)).toEqual(result);
    expect(output.endsWith("\n")).toBe(true);
  });

  test("checks all providers by default and keeps unreadable Link and CLI login separate", async () => {
    let requestedProvider: string | undefined = "unqueried";
    let output = "";
    const command = createLinkCommand({
      cwd: () => "/work/project",
      getStatus: async ({ provider }) => {
        requestedProvider = provider;
        return githubStatus();
      },
      write: (text) => {
        output += text;
      },
    });

    await command.parseAsync(["status"], { from: "user" });

    expect(requestedProvider).toBeUndefined();
    expect(output).toContain("Link github-old: unavailable");
    expect(output).toContain("saved credential cannot be read");
    expect(output).toContain("CLI (gh): authenticated as current-account");
    expect(output).toContain("Last verified: 2026-09-01T00:00:00.000Z");
  });

  test("propagates an invalid provider error instead of reporting an empty successful query", async () => {
    const command = createLinkCommand({
      getStatus: async () => {
        throw new Error("Unknown Link provider: typo");
      },
      write: () => {
        throw new Error("No success output expected");
      },
    });

    await expect(command.parseAsync(["status", "typo"], { from: "user" })).rejects.toThrow(
      "Unknown Link provider: typo",
    );
  });

  test("exempts only Link status from the shared setup hook", async () => {
    const program = new Command("code-shell");
    let setupCount = 0;
    program.addCommand(
      createLinkCommand({ getStatus: async () => githubStatus(), write: () => {} }),
    );
    program.command("status").action(() => {});
    program.hook("preAction", (_thisCommand, actionCommand) => {
      if (isLinkStatusCommand(actionCommand)) return;
      setupCount++;
    });

    await program.parseAsync(["link", "status", "github"], { from: "user" });
    expect(setupCount).toBe(0);
    await program.parseAsync(["status"], { from: "user" });
    expect(setupCount).toBe(1);
  });
});

describe("Link status text", () => {
  test("does not turn an inconclusive CLI probe into a signed-out assertion", () => {
    const result = githubStatus();
    result.providers[0].cli = {
      state: "checked",
      providerId: "github",
      command: "gh",
      installed: true,
      authenticated: false,
      message: "Authentication check failed; the network may be unavailable.",
    };

    const output = formatLinkStatus(result);

    expect(output).toContain("CLI (gh): installed; authentication not confirmed");
    expect(output).toContain("network may be unavailable");
    expect(output).not.toContain("logged out");
    expect(output).not.toContain("signed out");
  });

  test("distinguishes an unreadable credential store from an empty one", () => {
    const result = githubStatus();
    result.credentialStore = { state: "error", reason: "Credential metadata could not be read." };
    result.providers[0].connections = [];

    const output = formatLinkStatus(result);

    expect(output).toContain("Saved connections: Credential metadata could not be read.");
    expect(output).toContain("Link: saved connection status unknown");
    expect(output).not.toContain("no saved connection");
    expect(output).toContain("CLI (gh): authenticated as current-account");
  });

  test("shows missing and skipped CLIs without implying a login failure", () => {
    const result = githubStatus();
    result.providers[0].connections = [];
    result.providers[0].cli = {
      state: "checked",
      providerId: "github",
      command: "gh",
      installed: false,
      authenticated: false,
    };
    expect(formatLinkStatus(result)).toContain("CLI (gh): not installed");

    result.providers[0].cli = {
      state: "skipped",
      reasonCode: "unsupported",
      reason: "This provider does not support a CLI status check.",
    };
    expect(formatLinkStatus(result)).toContain(
      "CLI: skipped — This provider does not support a CLI status check.",
    );
  });

  test("keeps stored account names from adding terminal control sequences or extra lines", () => {
    const result = githubStatus();
    result.providers[0].connections[0].account = "account\nforged status\u001b[2J";
    const output = formatLinkStatus(result);

    expect(output).toContain("account account forged status [2J");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\nforged status");
  });
});
