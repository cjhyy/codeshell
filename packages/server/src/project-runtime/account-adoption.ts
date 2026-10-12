import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HubAuthStore } from "../hub/auth-store.js";
import {
  CLOUD_ADOPTION_PENDING,
  isCloudAccountBinding,
  isCloudAccountOrigin,
  type CloudAccountBinding,
} from "./account-binding.js";
import { ProjectRegistry } from "./registry.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const FORMAT = "codeshell.cloud-account-adoption";
const SOURCES = [
  "project-control/registry.json",
  "project-control/initialized",
  "hub/auth.json",
] as const;
interface Receipt {
  format: typeof FORMAT;
  version: 1;
  source: string;
  sourceDev: number;
  sourceIno: number;
  controllerDev: number;
  controllerIno: number;
  installationId: string;
  binding: CloudAccountBinding;
  originals: Record<string, string>;
  registryAfter: string;
  authAfter: string;
}
export interface CloudAccountAdoptionOptions {
  dataDir: string;
  /** A new private directory outside the source. Authority evidence contains password hashes. */
  evidenceDirectory: string;
  accountOrigin: string;
  accountId: string;
  /** Both identities must be explicitly reviewed from the existing offline installation. */
  installationId: string;
  ownerId: string;
  legacyUsername: string;
  /** Fault seam; no user request can configure these hooks. */
  io?: { fsync?: typeof fsyncSync };
}

function privateBytes(file: string, maximum = 1024 * 1024): Buffer {
  const before = lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.mode & 0o077 ||
    before.size > maximum
  )
    throw new Error("Adoption evidence must be a bounded private regular file.");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.size !== before.size
    )
      throw new Error("Adoption source changed while opening.");
    const bytes = readFileSync(fd);
    if (bytes.length !== before.size || bytes.length > maximum)
      throw new Error("Adoption source changed while reading.");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function ordinaryDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("Adoption requires private ordinary directories.");
  return stat;
}

/** Read-only operator review; private runtime passwords and Hub hashes are excluded. */
export function inspectCloudAccountAdoption(dataDir: string) {
  const source = realpathSync(dataDir);
  if (source !== resolve(dataDir)) throw new Error("Adoption source must be canonical.");
  ordinaryDirectory(source);
  for (const name of SOURCES) privateBytes(join(source, name));
  const registry = new ProjectRegistry(source, Date.now, { offlineAccountAdoption: true });
  try {
    const data = JSON.parse(privateBytes(join(source, SOURCES[0])).toString("utf8"));
    return {
      installationId: registry.installationId,
      owners: data.owners,
      accountBinding: registry.accountBinding ?? null,
      projects: registry.all().map(({ id, status, generation }) => ({ id, status, generation })),
      pending: existsSync(join(source, "project-control", CLOUD_ADOPTION_PENDING)),
    };
  } finally {
    registry.close();
  }
}

/** Offline, explicit adoption. Never rolls back or guesses authority from a username. */
export function adoptCloudAccount(options: CloudAccountAdoptionOptions): {
  binding: CloudAccountBinding;
  evidenceDirectory: string;
} {
  if (
    !isCloudAccountOrigin(options.accountOrigin) ||
    !UUID.test(options.accountId) ||
    !UUID.test(options.ownerId) ||
    !UUID.test(options.installationId)
  )
    throw new Error("Explicit Cloud/Account UUIDs and exact Account origin are required.");
  const source = realpathSync(options.dataDir);
  if (source !== resolve(options.dataDir)) throw new Error("Adoption source must be canonical.");
  const sourceStat = ordinaryDirectory(source);
  const control = join(source, "project-control");
  const controlStat = ordinaryDirectory(control);
  ordinaryDirectory(join(source, "hub"));
  const destination = resolve(options.evidenceDirectory);
  const parent = realpathSync(dirname(destination));
  ordinaryDirectory(parent);
  if (parent !== dirname(destination))
    throw new Error("Evidence destination must have a canonical parent.");
  const rel = relative(source, destination);
  if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
    throw new Error("Preserve evidence outside the installation.");
  // Never initialize a missing/wrong installation while performing adoption.
  for (const name of SOURCES) privateBytes(join(source, name));
  const flush = options.io?.fsync ?? fsyncSync;
  const sync = (path: string) => {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      flush(fd);
    } finally {
      closeSync(fd);
    }
  };
  const save = (file: string, bytes: Buffer) => {
    if (existsSync(file)) {
      if (!privateBytes(file).equals(bytes))
        throw new Error("Adoption evidence changed; preserve it for diagnosis.");
    } else {
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeFileSync(fd, bytes);
        flush(fd);
      } finally {
        closeSync(fd);
      }
    }
    sync(file);
    sync(dirname(file));
  };
  const registry = new ProjectRegistry(source, Date.now, {
    fsync: flush,
    offlineAccountAdoption: true,
  });
  try {
    if (
      registry.installationId !== options.installationId ||
      registry.all().some((project) => project.status !== "stopped")
    )
      throw new Error("Adoption requires the reviewed installation with all projects stopped.");
    if (!existsSync(destination)) {
      mkdirSync(destination, { mode: 0o700 });
      sync(parent);
    }
    ordinaryDirectory(destination);
    const receiptPath = join(destination, "receipt.json");
    let receipt: Receipt;
    if (existsSync(receiptPath)) {
      receipt = JSON.parse(privateBytes(receiptPath).toString("utf8"));
      if (
        receipt.format !== FORMAT ||
        receipt.version !== 1 ||
        !isCloudAccountBinding(receipt.binding) ||
        receipt.source !== source ||
        receipt.sourceDev !== sourceStat.dev ||
        receipt.sourceIno !== sourceStat.ino ||
        receipt.controllerDev !== controlStat.dev ||
        receipt.controllerIno !== controlStat.ino ||
        receipt.installationId !== options.installationId ||
        receipt.binding.accountOrigin !== options.accountOrigin ||
        receipt.binding.accountId !== options.accountId ||
        receipt.binding.ownerId !== options.ownerId
      )
        throw new Error("Adoption receipt does not match this explicit source and destination.");
    } else {
      if (registry.accountBinding)
        throw new Error("Bound Cloud requires its original adoption receipt.");
      const originalRegistry = privateBytes(join(source, SOURCES[0]));
      const data = JSON.parse(originalRegistry.toString("utf8"));
      const auth = privateBytes(join(source, SOURCES[2]));
      const authData = JSON.parse(auth.toString("utf8"));
      const hub = new HubAuthStore({ dataDir: source });
      if (
        !hub.isInitialized() ||
        data.version !== 1 ||
        data.owners.length !== 1 ||
        data.owners[0].id !== options.ownerId ||
        data.owners[0].username !== options.legacyUsername ||
        authData.account?.username !== options.legacyUsername
      )
        throw new Error("Explicit legacy owner must match the sole initialized operator.");
      const binding: CloudAccountBinding = {
        version: 1,
        accountOrigin: options.accountOrigin,
        accountId: options.accountId,
        ownerId: options.ownerId,
        managementEpoch: randomUUID(),
        createdAt: Date.now(),
      };
      const bound = { ...data, version: 2, accountBinding: binding };
      const revoked = { ...authData, sessions: [] };
      receipt = {
        format: FORMAT,
        version: 1,
        source,
        sourceDev: sourceStat.dev,
        sourceIno: sourceStat.ino,
        controllerDev: controlStat.dev,
        controllerIno: controlStat.ino,
        installationId: options.installationId,
        binding,
        originals: {},
        registryAfter: sha(Buffer.from(JSON.stringify(bound, null, 2) + "\n")),
        authAfter: sha(Buffer.from(JSON.stringify(revoked, null, 2))),
      };
      for (const name of SOURCES) {
        const bytes = privateBytes(join(source, name));
        receipt.originals[name] = sha(bytes);
        save(join(destination, name.replaceAll("/", "--")), bytes);
      }
      // Original evidence is fully flushed before publishing any adoption barrier.
      save(receiptPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
    }
    for (const name of SOURCES) {
      const original = privateBytes(join(destination, name.replaceAll("/", "--")));
      if (sha(original) !== receipt.originals[name])
        throw new Error("Adoption evidence checksum mismatch.");
    }
    const originalData = JSON.parse(
      privateBytes(join(destination, SOURCES[0].replaceAll("/", "--"))).toString("utf8"),
    );
    const originalAuth = JSON.parse(
      privateBytes(join(destination, SOURCES[2].replaceAll("/", "--"))).toString("utf8"),
    );
    if (
      originalData.version !== 1 ||
      originalData.installationId !== options.installationId ||
      originalData.owners?.length !== 1 ||
      originalData.owners[0].id !== options.ownerId ||
      originalData.owners[0].username !== options.legacyUsername ||
      originalAuth.account?.username !== options.legacyUsername ||
      receipt.registryAfter !==
        sha(
          Buffer.from(
            JSON.stringify(
              { ...originalData, version: 2, accountBinding: receipt.binding },
              null,
              2,
            ) + "\n",
          ),
        ) ||
      receipt.authAfter !==
        sha(Buffer.from(JSON.stringify({ ...originalAuth, sessions: [] }, null, 2)))
    )
      throw new Error(
        "Adoption receipt does not preserve the explicitly reviewed legacy authority.",
      );
    sync(receiptPath);
    sync(destination);
    const assertSource = () => {
      const current = ordinaryDirectory(source),
        controller = ordinaryDirectory(control);
      if (
        current.dev !== receipt.sourceDev ||
        current.ino !== receipt.sourceIno ||
        controller.dev !== receipt.controllerDev ||
        controller.ino !== receipt.controllerIno
      )
        throw new Error("Adoption source directory changed.");
      for (const name of SOURCES) {
        const value = sha(privateBytes(join(source, name)));
        const allowed = [
          receipt.originals[name],
          name === SOURCES[0]
            ? receipt.registryAfter
            : name === SOURCES[2]
              ? receipt.authAfter
              : undefined,
        ];
        if (!allowed.includes(value))
          throw new Error(
            "Adoption source changed; preserve evidence and diagnose before retrying.",
          );
      }
    };
    assertSource();
    const pending = join(control, CLOUD_ADOPTION_PENDING);
    const marker = Buffer.from(
      JSON.stringify({
        format: FORMAT,
        version: 1,
        evidenceDirectory: destination,
        receipt: sha(privateBytes(receiptPath)),
      }) + "\n",
    );
    save(pending, marker);
    assertSource();
    if (!registry.accountBinding) registry.bindAccount(receipt.binding);
    if (
      JSON.stringify(registry.accountBinding) !== JSON.stringify(receipt.binding) ||
      sha(privateBytes(join(source, SOURCES[0]))) !== receipt.registryAfter
    )
      throw new Error("Cloud adoption binding changed.");
    sync(join(source, SOURCES[0]));
    sync(control);
    assertSource();
    new HubAuthStore({ dataDir: source }).revokeAllSessions();
    sync(join(source, SOURCES[2]));
    sync(join(source, "hub"));
    assertSource();
    save(
      join(destination, "completed.json"),
      Buffer.from(
        JSON.stringify({
          format: FORMAT,
          receipt: sha(privateBytes(receiptPath)),
          registry: receipt.registryAfter,
          auth: receipt.authAfter,
        }) + "\n",
      ),
    );
    if (existsSync(pending)) {
      if (!privateBytes(pending).equals(marker))
        throw new Error("Adoption pending marker changed.");
      unlinkSync(pending);
      sync(control);
    }
    return { binding: { ...receipt.binding }, evidenceDirectory: destination };
  } finally {
    registry.close();
  }
}
