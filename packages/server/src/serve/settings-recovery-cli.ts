import { parseArgs } from "node:util";
import type { RecoveryScope } from "@cjhyy/code-shell-core/internal";

const HELP = `Usage: code-shell-settings-recovery <inspect|repair|restore> [options]

Offline administrator recovery for a stopped project's settings.
Stop the project and all its workers before repair or restore.
This command does not start a server, authenticate remote users or stop workers.

Options:
  --project <directory>        Actual project directory (default: current directory)
  --scope <project|local>      Configuration layer (default: project)
  --from <file>                Complete reviewed JSON candidate (inspect or repair)
  --expected-revision <sha256> Revision returned by inspect (repair or restore)
  --candidate-sha256 <sha256>  Candidate hash returned by inspect (repair)
  --backup-id <id>             Backup returned by repair/restore (restore)
  -h, --help                   Show this help without reading configuration

Inspection reports metadata and hashes, never configuration values.
Repair preserves original bytes before replacement. Restore also backs up current
bytes; restoring a damaged original restores that fault too. Keep backups private.
`;

type RecoveryArguments =
  | { action: "help" }
  | { action: "inspect"; cwd: string; scope: RecoveryScope; candidatePath?: string }
  | {
      action: "repair";
      cwd: string;
      scope: RecoveryScope;
      candidatePath: string;
      expectedRevision: string;
      candidateSha256: string;
    }
  | {
      action: "restore";
      cwd: string;
      scope: RecoveryScope;
      backupId: string;
      expectedRevision: string;
    };

export function parseSettingsRecoveryArgs(argv: string[], cwd: () => string): RecoveryArguments {
  const invalid = () => new Error("Invalid recovery arguments; use --help for usage.");
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        project: { type: "string" },
        scope: { type: "string" },
        from: { type: "string" },
        "expected-revision": { type: "string" },
        "candidate-sha256": { type: "string" },
        "backup-id": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    // Parser errors can reflect unrecognized argument values. Do not echo them.
    throw invalid();
  }
  const { values, positionals, tokens } = parsed;
  const names = new Set<string>();
  for (const token of tokens ?? []) {
    if (token.kind !== "option") continue;
    if (names.has(token.name)) throw invalid();
    names.add(token.name);
  }
  const action = positionals[0];
  if (positionals.length > 1 || (action && !["inspect", "repair", "restore"].includes(action)))
    throw invalid();
  if (values.help) return { action: "help" };
  if (!action) throw invalid();
  const allowed = new Set(["project", "scope"]);
  if (action === "inspect" || action === "repair") allowed.add("from");
  if (action !== "inspect") allowed.add("expected-revision");
  if (action === "repair") allowed.add("candidate-sha256");
  if (action === "restore") allowed.add("backup-id");
  for (const name of names) if (!allowed.has(name)) throw invalid();
  const value = (name: string, required = false): string | undefined => {
    const result = values[name];
    if (result === undefined && !required) return undefined;
    if (typeof result !== "string" || !result.trim()) throw invalid();
    return result;
  };
  const scope = value("scope") ?? "project";
  if (scope !== "project" && scope !== "local") throw invalid();
  const target = { cwd: value("project") ?? cwd(), scope } as const;
  if (action === "inspect") return { action, ...target, candidatePath: value("from") };
  const expectedRevision = value("expected-revision", true)!;
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw invalid();
  if (action === "repair") {
    const candidateSha256 = value("candidate-sha256", true)!;
    if (!/^[a-f0-9]{64}$/.test(candidateSha256)) throw invalid();
    return {
      action,
      ...target,
      candidatePath: value("from", true)!,
      expectedRevision,
      candidateSha256,
    };
  }
  return { action: "restore", ...target, backupId: value("backup-id", true)!, expectedRevision };
}

export async function runSettingsRecoveryCli(
  argv: string[] = process.argv.slice(2),
  io: {
    cwd?: () => string;
    write?: (text: string) => void;
    error?: (text: string) => void;
  } = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const error = io.error ?? ((text: string) => process.stderr.write(text));
  try {
    const args = parseSettingsRecoveryArgs(argv, io.cwd ?? (() => process.cwd()));
    if (args.action === "help") {
      write(HELP);
      return 0;
    }
    // Load only the reviewed Host recovery operations, after argument validation.
    // In particular, do not start serve/bootstrap or require TUI/model setup.
    const core = await import("@cjhyy/code-shell-core/internal");
    const result =
      args.action === "inspect"
        ? core.inspectProjectSettingsRecovery(args)
        : args.action === "repair"
          ? core.repairProjectSettings(args)
          : core.restoreProjectSettings(args);
    write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (cause) {
    error(`[settings-recovery] ${cause instanceof Error ? cause.message : "Recovery failed"}\n`);
    return 1;
  }
}
