import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const scenarios = {
  authentication: "opens account management and keeps login, registration, and logout in sync",
  github: "offers GitHub sign-in and cancellation from the sidebar",
  composition: "preserves account drafts when Escape cancels Chinese input composition",
  "late-response": "keeps live account events when the initial status response arrives late",
  "late-failure": "keeps live account events when the initial status request fails late",
  unavailable: "keeps account management usable when account status cannot be read",
  cleanup: "unsubscribes on dialog close and unmount while status requests are still pending",
  "github-unavailable":
    "explains and disables GitHub sign-in when the server has not configured it",
  "link-unavailable": "disables GitHub linking when the signed-in server has not configured it",
  "capabilities-stale": "invalidates discovery immediately and ignores results from an old server",
  "capabilities-retry": "retries discovery failures while keeping password login available",
  "registration-unavailable":
    "disables closed registration while allowing existing accounts to log in",
};

for (const [scenario, description] of Object.entries(scenarios)) {
  test(description, () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./AccountSidebarEntry.fixture.tsx", import.meta.url)),
        scenario,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });
}
