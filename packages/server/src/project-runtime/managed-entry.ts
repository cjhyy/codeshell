import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { HubAuthStore } from "../hub/auth-store.js";
import { startHeadlessServer, type HeadlessServeOptions } from "../serve/headless-server.js";
import {
  resolveWebAppRoot,
  resolveWorkerCapabilityModules,
  resolveWorkerEntry,
} from "../serve/cli.js";
import { validateProjectPublicOrigin, validateProjectRuntimeRecord } from "./docker-provider.js";
import type { ManagedProjectSecret } from "./types.js";

const MAX_SECRET_BYTES = 16 * 1024;

/** Read one provider-created secret, never a control-plane account or environment dump. */
export async function readManagedProjectSecret(file: string): Promise<ManagedProjectSecret> {
  const entry = await lstat(file);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size > MAX_SECRET_BYTES ||
    entry.mode & 0o222
  )
    throw new Error("Managed project secret must be a small read-only regular file.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      opened.dev !== entry.dev ||
      opened.size > MAX_SECRET_BYTES
    )
      throw new Error("Managed project secret changed while opening it.");
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_SECRET_BYTES) throw new Error("Managed project secret is too large.");
    value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid managed project secret.");
  const secret = value as ManagedProjectSecret;
  if (secret.version !== 1 || secret.generation < 1)
    throw new Error("Unsupported managed project secret version or generation.");
  validateProjectRuntimeRecord({
    id: secret.projectId,
    ownerId: secret.ownerId,
    generation: secret.generation,
    runtimeUsername: secret.username,
    runtimePassword: secret.password,
  });
  validateProjectPublicOrigin(secret.publicOrigin);
  if (secret.publicPathPrefix !== `/p/${secret.projectId}`)
    throw new Error("Invalid managed project public path.");
  return secret;
}

/** Initialize this project's account and invalidate every grant from a previous process. */
export async function initializeManagedProjectAuth(
  secret: ManagedProjectSecret,
  dataDir: string,
): Promise<void> {
  const auth = new HubAuthStore({ dataDir });
  const bootstrap = auth.initialize();
  if (!auth.isInitialized()) {
    if (!bootstrap) throw new Error("Managed project account initialization is incomplete.");
    await auth.setup({
      username: secret.username,
      password: secret.password,
      token: bootstrap,
      deviceName: "Project runtime",
    });
  } else {
    // A persistent volume must still belong to the credential issued for this
    // project. A mismatch never replaces its account or opens public setup.
    await auth.login({
      username: secret.username,
      password: secret.password,
      deviceName: "Project runtime startup",
    });
  }
  for (const session of auth.listSessions()) auth.revoke(session.id);
}

export function managedProjectServerOptions(
  secret: ManagedProjectSecret,
): HeadlessServeOptions & { publicPathPrefix: string } {
  const staticRootDir = resolveWebAppRoot();
  if (!staticRootDir)
    throw new Error("Managed project image is missing its Web application build.");
  return {
    host: "0.0.0.0",
    port: 8790,
    cwd: "/workspace",
    dataDir: "/data",
    authMode: "hub",
    publicOrigin: secret.publicOrigin,
    publicPathPrefix: secret.publicPathPrefix,
    workerEntryPath: resolveWorkerEntry(),
    workerCapabilityModules: resolveWorkerCapabilityModules(),
    staticRootDir,
  };
}

export async function runManagedProjectEntry(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--secret" || !argv[1])
    throw new Error("Managed project entry requires one --secret file.");
  const secret = await readManagedProjectSecret(argv[1]);
  await initializeManagedProjectAuth(secret, "/data");
  const server = await startHeadlessServer(managedProjectServerOptions(secret));
  // The provider reads /health; credentials and setup grants never enter logs.
  console.log(`Managed project ${secret.projectId} generation ${secret.generation} is ready.`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
