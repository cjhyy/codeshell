#!/usr/bin/env node
import {
  adoptCloudAccount,
  inspectCloudAccountAdoption,
} from "../project-runtime/account-adoption.js";

const help = `Usage: code-shell-cloud-account --inspect --data-dir <canonical path>
       code-shell-cloud-account --adopt --data-dir <canonical path>
         --evidence-dir <new private directory outside data-dir>
         --account-origin <exact Account HTTPS origin> --account-id <UUID>
         --installation-id <reviewed UUID> --owner-id <reviewed UUID>
         --legacy-username <reviewed sole operator>

Stop the Cloud controller and all projects first. Adoption durably preserves
original authority files and SHA receipts before retiring legacy login. Evidence
contains private password hashes. Make a full installation/volume backup too.
Retry a failed adoption with exactly the same source, evidence and identities.
This tool never contacts Account, accepts a password/token, or runs Docker.
The bound Account must authenticate through the configured Cloud at first use.`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) console.log(help);
  else {
    const mode = args.shift();
    if (mode !== "--inspect" && mode !== "--adopt") throw new Error("Choose --inspect or --adopt.");
    const names: Record<string, string> = {
      "--data-dir": "dataDir",
      "--evidence-dir": "evidenceDirectory",
      "--account-origin": "accountOrigin",
      "--account-id": "accountId",
      "--installation-id": "installationId",
      "--owner-id": "ownerId",
      "--legacy-username": "legacyUsername",
    };
    const options: Record<string, string> = {};
    while (args.length) {
      const name = args.shift()!,
        key = names[name],
        value = args.shift();
      if (!key || !value || value.startsWith("--") || key in options)
        throw new Error("Unknown, duplicate or incomplete option.");
      options[key] = value;
    }
    if (
      !options.dataDir ||
      (mode === "--inspect"
        ? Object.keys(options).length !== 1
        : Object.keys(options).length !== Object.keys(names).length)
    )
      throw new Error("Supply every reviewed identity; use --help for usage.");
    console.log(
      JSON.stringify(
        mode === "--inspect"
          ? inspectCloudAccountAdoption(options.dataDir)
          : adoptCloudAccount(options as unknown as Parameters<typeof adoptCloudAccount>[0]),
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cloud account adoption failed.");
  process.exitCode = 1;
}
