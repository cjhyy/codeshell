/** Desktop host clients that have no IPC peer in a headless worker. */
const HEADLESS_WORKER_HOST_ENV_KEYS = [
  "CODE_SHELL_REMOTE_LINK_CLIENT_SECRET",
  "CODE_SHELL_OPERATION_BATCH_ACCESS",
  "CODE_SHELL_MODEL_REQUEST_SIGNING",
  "CODE_SHELL_WORKSPACE_ACCESS",
  "CODE_SHELL_HOST_MCP_SERVERS",
] as const;

/** Preserve the caller's environment while disabling Desktop-only host access. */
export function headlessWorkerEnv(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of HEADLESS_WORKER_HOST_ENV_KEYS) env[key] = undefined;
  return { ...env, CODE_SHELL_CREDENTIAL_ACCESS: "local", ...extra };
}
