/** Commands accepted only on the private Main-to-utility pipe. */
export function isPrivateTaskCommand(method: string): boolean {
  return [
    "tasks/snapshot",
    "tasks/get",
    "tasks/reconcile",
    "tasks/observeSessions",
    "tasks/intent",
    "tasks/flush",
  ].includes(method);
}
