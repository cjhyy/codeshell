import { Command } from "commander";
import type { LinkStatusResult } from "@cjhyy/code-shell-core";

interface LinkStatusQuery {
  provider?: string;
  cwd: string;
  settingsScope: "full";
}

interface LinkCommandDependencies {
  getStatus: (options: LinkStatusQuery) => Promise<LinkStatusResult>;
  cwd: () => string;
  write: (text: string) => void;
}

async function queryLocalStatus(options: LinkStatusQuery): Promise<LinkStatusResult> {
  const { getLinkStatus, localCredentialAccess } = await import("@cjhyy/code-shell-core");
  return getLinkStatus(options, { credentialAccess: localCredentialAccess });
}

/** Status must remain available before model setup and must not run setup writes. */
export function isLinkStatusCommand(command: Command): boolean {
  return command.name() === "status" && command.parent?.name() === "link";
}

export function createLinkCommand(dependencies: Partial<LinkCommandDependencies> = {}): Command {
  const getStatus = dependencies.getStatus ?? queryLocalStatus;
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const link = new Command("link").description("Inspect Link connections and local CLI login");

  link
    .command("status")
    .description("Check saved connections and local CLI login without changing configuration")
    .argument("[provider]", "Provider ID (for example github); omit to check all providers")
    .option("--json", "Print structured status as JSON")
    .action(async (provider: string | undefined, options: { json?: boolean }) => {
      const result = await getStatus({ provider, cwd: cwd(), settingsScope: "full" });
      write(options.json ? JSON.stringify(result, null, 2) + "\n" : formatLinkStatus(result));
    });

  return link;
}

/** Keep account names and stored labels on one terminal line. */
function line(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function formatLinkStatus(result: LinkStatusResult): string {
  const lines: string[] = [`Link status — ${line(result.checkedAt)}`];
  if (result.credentialStore.state === "error") {
    lines.push(`Saved connections: ${line(result.credentialStore.reason ?? "could not be read")}`);
  }

  for (const provider of result.providers) {
    lines.push("", `${line(provider.name)} (${line(provider.id)})`);
    if (provider.connections.length === 0) {
      lines.push(
        result.credentialStore.state === "error"
          ? "  Link: saved connection status unknown"
          : "  Link: no saved connection",
      );
    }
    for (const connection of provider.connections) {
      const details = [connection.backend, connection.runtime].filter(Boolean).join(", ");
      const account = connection.account ? `; account ${line(connection.account)}` : "";
      lines.push(`  Link ${line(connection.id)}: ${connection.state} (${details}${account})`);
      if (connection.reason) lines.push(`    ${line(connection.reason)}`);
      if (connection.verifiedAt) {
        lines.push(`    Last verified: ${line(connection.verifiedAt)}`);
      }
    }

    const cli = provider.cli;
    if (cli.state === "checked") {
      const state = !cli.installed
        ? "not installed"
        : cli.authenticated
          ? `authenticated${cli.account ? ` as ${line(cli.account)}` : ""}`
          : "installed; authentication not confirmed";
      lines.push(`  CLI (${line(cli.command)}): ${state}`);
      if (cli.message) lines.push(`    ${line(cli.message)}`);
    } else {
      lines.push(`  CLI: ${cli.state} — ${line(cli.reason)}`);
    }
  }

  if (result.providers.length === 0) lines.push("", "No Link providers found.");
  lines.push("", line(result.guidance));
  return lines.join("\n") + "\n";
}
