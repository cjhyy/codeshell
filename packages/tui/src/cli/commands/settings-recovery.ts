import { Command, Option } from "commander";
import type {
  RecoveryScope,
  SettingsRecoveryInspection,
  SettingsRecoveryResult,
} from "@cjhyy/code-shell-core/internal";

type Target = { cwd: string; scope: RecoveryScope };
interface Dependencies {
  inspect(options: Target & { candidatePath?: string }): SettingsRecoveryInspection;
  repair(
    options: Target & { candidatePath: string; expectedRevision: string; candidateSha256: string },
  ): SettingsRecoveryResult;
  restore(options: Target & { backupId: string; expectedRevision: string }): SettingsRecoveryResult;
}
/** Recovery must work before setup can read/migrate a damaged configuration. */
export function isSettingsRecoveryCommand(command: Command): boolean {
  return (
    command.parent?.name() === "settings-recovery" &&
    ["inspect", "repair", "restore"].includes(command.name())
  );
}
export function createSettingsRecoveryCommand(
  options: {
    operations?: Dependencies;
    cwd?: () => string;
    write?: (text: string) => void;
  } = {},
): Command {
  const cwd = options.cwd ?? (() => process.cwd());
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  async function operations(): Promise<Dependencies> {
    if (options.operations) return options.operations;
    const core = await import("@cjhyy/code-shell-core/internal");
    return {
      inspect: core.inspectProjectSettingsRecovery,
      repair: core.repairProjectSettings,
      restore: core.restoreProjectSettings,
    };
  }
  const command = new Command("settings-recovery").description(
    "Local/server-admin configuration inspection, repair and rollback (stop the project first)",
  );
  const target = (child: Command) =>
    child
      .option("--project <directory>", "Project directory (defaults to current directory)")
      .addOption(
        new Option("--scope <scope>", "Configuration layer")
          .choices(["project", "local"])
          .default("project"),
      );
  const identify = (args: { project?: string; scope: RecoveryScope }): Target => ({
    cwd: args.project ?? cwd(),
    scope: args.scope,
  });
  const output = (value: SettingsRecoveryInspection) =>
    write(JSON.stringify(value, null, 2) + "\n");
  target(
    command
      .command("inspect")
      .description(
        "Read status and revisions without printing configuration values or writing files",
      ),
  )
    .option(
      "--from <file>",
      "Also validate a proposed complete settings JSON file and report its SHA-256",
    )
    .action(async (args) =>
      output((await operations()).inspect({ ...identify(args), candidatePath: args.from })),
    );
  target(
    command
      .command("repair")
      .description(
        "Back up original bytes, then atomically install the reviewed complete JSON document",
      ),
  )
    .requiredOption("--from <file>", "Reviewed complete settings JSON file")
    .requiredOption("--expected-revision <sha256>", "Project revision from inspect")
    .requiredOption("--candidate-sha256 <sha256>", "Candidate hash from inspect")
    .action(async (args) =>
      output(
        (await operations()).repair({
          ...identify(args),
          candidatePath: args.from,
          expectedRevision: args.expectedRevision,
          candidateSha256: args.candidateSha256,
        }),
      ),
    );
  target(
    command
      .command("restore")
      .description(
        "Back up current configuration and restore exact earlier bytes; the earlier file may still be damaged",
      ),
  )
    .requiredOption("--backup-id <id>", "Backup ID returned by an earlier repair/restore")
    .requiredOption("--expected-revision <sha256>", "Current project revision from inspect")
    .action(async (args) =>
      output(
        (await operations()).restore({
          ...identify(args),
          backupId: args.backupId,
          expectedRevision: args.expectedRevision,
        }),
      ),
    );
  return command;
}
