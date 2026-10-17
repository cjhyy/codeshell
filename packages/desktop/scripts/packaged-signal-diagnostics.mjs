/** Evidence only: the watchdog remains the sole authority and calls this only
 * after its existing fresh-birth check. Never starts or redirects cleanup. */
export function createPackagedSignalDiagnostics(
  signalProcess = (pid, signal) => process.kill(pid, signal),
) {
  const requests = [];
  let truncated = false;
  return {
    request(pid, signal) {
      // Even an observation failure must not interfere with authorized cleanup.
      try {
        if (requests.length < 512) requests.push({ sequence: requests.length + 1, pid, signal });
        else truncated = true;
      } catch {
        truncated = true;
      }
      return signalProcess(pid, signal);
    },
    receipt() {
      return {
        requests: requests.map((row) => ({ ...row })),
        truncated,
        boundary:
          "Observed watchdog signal requests only; not an OS-wide signal audit or proof of delivery",
      };
    },
  };
}
