/**
 * UpdateBanner — top-of-app notice when a newer code-shell version is on npm.
 *
 * Behavior:
 *   - Triggers an initial check on mount.
 *   - Re-checks every 30 minutes.
 *   - If the npm global prefix is writable, schedules a detached
 *     `npm i -g` to fire on process exit; the user sees "will update on exit".
 *   - If not writable, shows the manual `sudo npm i -g` command.
 *   - Silent when up-to-date or auto-update is disabled.
 */
import { useEffect, useState } from "react";
import { Box, Text } from "../../render/index.js";
import {
  checkForUpdate,
  getCurrentVersion,
  getUpdateAvailable,
  scheduleAutoInstallOnExit,
  type UpdateInfo,
} from "../../cli/updater.js";

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const PACKAGE_NAME = "@cjhyy/code-shell";

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | undefined>(getUpdateAvailable());

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      // checkForUpdate() is fire-and-forget; result lands in module state.
      // Poll the state shortly after so the banner updates.
      checkForUpdate();
      setTimeout(() => {
        if (cancelled) return;
        const next = getUpdateAvailable();
        setInfo(next);
        if (next?.canAutoInstall) scheduleAutoInstallOnExit();
      }, 6_000);
    };

    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!info) return null;

  const current = getCurrentVersion();
  const command = info.canAutoInstall
    ? null
    : `sudo npm install -g ${PACKAGE_NAME}@${info.latestVersion}`;

  return (
    <Box marginLeft={1} marginY={0} flexDirection="column">
      <Text color="ansi:yellow">
        {`✦ Update available: v${current} → v${info.latestVersion}`}
      </Text>
      {info.canAutoInstall ? (
        <Text dim>{`  Will install in the background when you exit.`}</Text>
      ) : (
        <Text dim>{`  Run: `}<Text bold>{command!}</Text></Text>
      )}
    </Box>
  );
}
