import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const scenarios = {
  "menu-preview": "shows account actions without mounting a form or contacting the service",
  "menu-logout": "signs out directly from the account menu and restores focus",
  "menu-logout-unconfirmed": "explains unconfirmed revocation after signing out from the menu",
  "menu-logout-stale": "ignores a late menu revocation notice after a new account signs in",
  "menu-logout-pending": "disables pending sign-out and prevents duplicate menu requests",
  "menu-logout-failure": "explains sign-out failures and allows another attempt",
  "settings-logout-unconfirmed":
    "keeps a revocation notice after signing out from account settings",
  "settings-logout-stale": "ignores a late settings revocation notice after a new account signs in",
  "storage-logout-unconfirmed":
    "explains unconfirmed revocation after clearing unavailable account storage",
  "settings-logout-failure":
    "preserves settings account state on sign-out failure and allows retry",
  "profile-read-pending": "gates updates while loading and compares edits to the latest profile",
  "profile-name-only": "preserves a username changed remotely when saving only the nickname",
  "profile-username-only": "preserves a nickname changed remotely when saving only the username",
  "profile-success":
    "keeps nickname and sign-in username separate and updates the avatar after saving",
  "profile-failure": "preserves profile drafts and explains a username conflict without IPC noise",
  "profile-stale": "ignores a late profile response after switching accounts",
  "profile-unavailable": "disables profile editing for services without the capability",
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
  "registration-validation":
    "rejects invalid registration names, short passwords, and mismatched confirmation",
  "registration-success":
    "registers once and signs in automatically with matching password confirmation",
  "login-enter": "submits password login from the credential form with Enter",
  "register-enter": "submits registration from the credential form with Enter",
  "registration-pending":
    "disables inputs and prevents duplicate registration submissions while pending",
  "github-registration-closed":
    "keeps GitHub sign-in available when password registration is closed",
  "github-automatic-account":
    "signs in a first-time GitHub account without entering password credentials",
  "github-login-only-default": "signs in with GitHub by default while preserving existing Links",
  "github-connect-optin": "requests a GitHub connection only after opting in and shows its result",
  "github-connect-repeat": "resets the connection choice after sign-in and allows a fresh opt-in",
  "github-connect-optout": "keeps GitHub login available when the connection choice is unchecked",
  "github-connect-unavailable": "disables unsupported GitHub connections without blocking sign-in",
  "github-connect-legacy": "treats missing connection support as unavailable for older services",
  "github-connect-failed": "keeps the cloud account signed in when its GitHub connection fails",
  "github-connect-skipped":
    "keeps the cloud account signed in when its GitHub connection is cancelled",
  "github-bind-only": "binds the GitHub sign-in identity without connecting GitHub data",
  "github-connect-late-status":
    "preserves completed GitHub connections when an older status snapshot arrives",
  "github-connect-late-failure":
    "preserves completed GitHub connections when an older status request fails",
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
