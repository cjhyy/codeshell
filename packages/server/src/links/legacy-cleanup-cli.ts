import { parseArgs } from "node:util";

const HELP = `Usage: code-shell-link-cleanup <inspect|remove> [options]

Offline cleanup of legacy Link-owned connection records. Stop every CodeShell
Host/worker sharing these credentials before remove. Ordinary OAuth/MCP/model
credentials, sessions, operation evidence and files are preserved. External CLI
logins are retained. Remote grants remain in private retirement custody for retry;
removing a local record does not report successful remote revocation.

  --project <directory>       Project credential layer (default: current directory)
  --scope <full|project>      Full includes user + project (default: full)
  --user-dir <directory>      Explicit user credential directory override
  --operations-root <dir>    Repeat for every custom shared operation/session root
  -h, --help                 Show help without reading credentials
`;

export async function runLegacyLinkCleanupCli(
  argv = process.argv.slice(2),
  io = { write: (value: string) => process.stdout.write(value) },
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        scope: { type: "string" },
        "user-dir": { type: "string" },
        "operations-root": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.write(HELP);
      return 0;
    }
    const action = positionals[0];
    const scope = values.scope ?? "full";
    if (
      positionals.length !== 1 ||
      !["inspect", "remove"].includes(action) ||
      !["full", "project"].includes(scope) ||
      Object.entries(values).some(
        ([key, value]) =>
          key !== "help" &&
          (Array.isArray(value)
            ? value.some((item) => !item.trim())
            : typeof value === "string" && !value.trim()),
      )
    )
      throw new Error("arguments");
    const { CredentialStore, sessionsRoot } = await import("@cjhyy/code-shell-core");
    const { previewLegacyLinkCleanup, cleanupLegacyLinkConnections } =
      await import("@cjhyy/code-shell-core/internal");
    const store = new CredentialStore(
      values.project ?? process.cwd(),
      undefined,
      values["user-dir"],
    );
    const preview = previewLegacyLinkCleanup(store, scope as "full" | "project");
    if (action === "inspect") {
      io.write(`${JSON.stringify({ count: preview.length, connections: preview })}\n`);
      return 0;
    }
    const result = cleanupLegacyLinkConnections({
      store,
      scope: scope as "full" | "project",
      operationRoots: [sessionsRoot(), ...(values["operations-root"] ?? [])],
    });
    io.write(`${JSON.stringify(result)}\n`);
    return result.changed.length ? 1 : 0;
  } catch {
    io.write(
      "Legacy Link cleanup failed; no successful cleanup is implied. Check arguments, stop Hosts and ensure stores are readable.\n",
    );
    return 1;
  }
}
